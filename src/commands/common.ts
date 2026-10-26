import * as fs from 'fs';
import * as vscode from 'vscode';
import { GitError } from '../git/gitCli';
import type { OperationOutcome, Repository } from '../git/repository';
import { services } from '../services';
import { plural, safe, showError } from '../util';
import { LogController } from '../views/logController';
import { DialogOverlay, dialogOrigin, withDialogOrigin } from '../webviews/dialogOverlay';

export interface CommandContext {
	register(id: string, fn: (...args: any[]) => unknown, errorPrefix?: string): void;
}

export type DialogOverlayResolver = (command: string, args: unknown[]) => DialogOverlay | undefined;

export function makeRegistrar(context: vscode.ExtensionContext, overlayFor: DialogOverlayResolver = () => undefined): CommandContext {
	return {
		register(id, fn, errorPrefix) {
			const run = safe(fn, errorPrefix);
			context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => (dialogOrigin() ? run(...args) : withDialogOrigin(overlayFor(id, args), () => run(...args)))));
		},
	};
}

const COMMIT_VIEW_COMMAND = /^changeline\.(changes|shelf|stash)\.|^changeline\.(applyPatch|stashChanges|unstashChanges)$/;

/** The webview whose overlay shows a command's dialogs: the log of a webview context menu, or the Commit tool window for its own commands. */
export function commandDialogOverlay(command: string, args: unknown[], commitView: DialogOverlay): DialogOverlay | undefined {
	const logId = (args[0] as { logId?: unknown } | undefined)?.logId;
	if (typeof logId === 'string') {
		return LogController.get(logId)?.dialogs;
	}
	return COMMIT_VIEW_COMMAND.test(command) ? commitView : undefined;
}

/**
 * Finds the repository a command applies to from whatever the caller
 * passed: a Repository, a file URI, a tree node, a webview context, or
 * nothing (then the active editor's repository or a picker).
 */
export async function resolveRepo(arg?: unknown): Promise<Repository | undefined> {
	const s = services();
	if (arg && typeof arg === 'object') {
		const a = arg as Record<string, any>;
		if (typeof a.refresh === 'function' && typeof a.root === 'string' && a.git) {
			return a as unknown as Repository;
		}
		if (arg instanceof vscode.Uri) {
			return s.repos.getRepository(arg) ?? s.repos.pick();
		}
		if (a.repo && typeof a.repo === 'object' && typeof a.repo.root === 'string') {
			return a.repo as Repository;
		}
		if (typeof a.repo === 'string') {
			return s.repos.getByRoot(a.repo);
		}
		if (typeof a.root === 'string') {
			return s.repos.getByRoot(a.root);
		}
		if (typeof a.logId === 'string') {
			return LogController.get(a.logId)?.repo;
		}
		if (a.resourceUri instanceof vscode.Uri) {
			return s.repos.getRepository(a.resourceUri);
		}
	}
	return s.repos.pick();
}

export function uriOf(arg: unknown): vscode.Uri | undefined {
	if (arg instanceof vscode.Uri) {
		return arg.scheme === 'changeline' ? vscode.Uri.file(arg.path) : arg;
	}
	if (arg && typeof arg === 'object') {
		const a = arg as Record<string, any>;
		if (a.resourceUri instanceof vscode.Uri) {
			return a.resourceUri;
		}
		if (typeof a.abs === 'string') {
			return vscode.Uri.file(a.abs);
		}
	}
	return vscode.window.activeTextEditor?.document.uri;
}

export function hasLocalChanges(repo: Repository): boolean {
	return repo.state.changes.length > 0 || repo.state.staged.length > 0;
}

const OVERWRITE_RE = /Your local changes to the following files would be overwritten|would be overwritten by (checkout|merge)|Please commit your changes or stash them|cannot (rebase|pull with rebase): You have unstaged changes|Your index contains uncommitted changes/;

export function isLocalChangesError(e: unknown): boolean {
	return e instanceof GitError && OVERWRITE_RE.test(e.stderr + e.stdout);
}

/**
 * Runs an operation that may be blocked by local changes. When git refuses,
 * offers JetBrains' "Smart" variant: stash, run, unstash.
 */
export async function withSmartStash<T>(repo: Repository, label: string, run: () => Promise<T>, forceRun?: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch (e) {
		if (!isLocalChangesError(e)) {
			throw e;
		}
		const files = /overwritten by \w+:\n([\s\S]*?)\n(?:Please|Aborting)/.exec((e as GitError).stderr)?.[1]?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
		const smart = vscode.l10n.t('Smart {0}', label);
		const force = vscode.l10n.t('Force {0}', label);
		const buttons = forceRun ? [smart, force] : [smart];
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Your local changes would be overwritten by {0}.', label) +
				(files.length ? `\n\n${files.slice(0, 15).join('\n')}${files.length > 15 ? '\n…' : ''}` : '') +
				'\n\n' +
				vscode.l10n.t('{0} stashes them, runs the operation and restores them afterwards.', smart),
			{ modal: true },
			...buttons,
		);
		if (choice === force && forceRun) {
			return forceRun();
		}
		if (choice !== smart) {
			return undefined;
		}
		const stashed = await repo.stash({ message: vscode.l10n.t('Changeline: uncommitted changes before {0}', label.toLowerCase()) });
		let result: T;
		try {
			result = await run();
		} catch (err) {
			if (stashed) {
				await repo.stashApply('stash@{0}', { pop: true });
			}
			throw err;
		}
		if (stashed) {
			await restoreStash(repo);
		}
		return result;
	}
}

export async function restoreStash(repo: Repository): Promise<void> {
	if (repo.state.operation !== 'none' && repo.state.conflicts.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Your local changes were stashed. Unstash them after resolving the conflicts.'), vscode.l10n.t('Unstash...')).then((c) => {
			if (c) {
				void vscode.commands.executeCommand('changeline.unstashChanges', repo);
			}
		});
		return;
	}
	const pop = await repo.stashApply('stash@{0}', { pop: true });
	if (!pop.ok) {
		if (pop.conflicts) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Restoring your local changes produced conflicts. The stash was kept.'), vscode.l10n.t('Resolve...')).then((c) => {
				if (c) {
					void vscode.commands.executeCommand('changeline.resolveConflicts');
				}
			});
		} else {
			void vscode.window.showWarningMessage(vscode.l10n.t('Your local changes could not be restored automatically and are kept in the stash.'));
		}
	}
}

/** Reports the result of merge-like operations, opening the conflicts dialog when needed. */
export async function handleOutcome(repo: Repository, outcome: OperationOutcome | undefined, success: string): Promise<boolean> {
	if (!outcome) {
		return false;
	}
	await repo.refresh();
	if (outcome.ok) {
		if (/Already up to date|Current branch .* is up to date/i.test(outcome.output)) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Already up to date.'));
		} else {
			void vscode.window.showInformationMessage(success);
		}
		return true;
	}
	if (outcome.conflicts || repo.state.conflicts.length) {
		void vscode.commands.executeCommand('changeline.resolveConflicts');
		return false;
	}
	if (outcome.error) {
		await showError(outcome.error);
	}
	return false;
}

export async function withProgress<T>(title: string, fn: (report: (msg: string) => void, token: vscode.CancellationToken) => Promise<T>, cancellable = false): Promise<T> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, (progress, token) =>
		fn((msg) => progress.report({ message: msg }), token),
	);
}

/** Progress parser for git's --progress output. */
export function gitProgress(report: (msg: string) => void): (chunk: string) => void {
	return (chunk) => {
		const lines = chunk.split(/[\r\n]+/).filter(Boolean);
		const last = lines[lines.length - 1];
		if (last) {
			const m = /([A-Za-z ]+):\s+(\d+)%/.exec(last);
			report(m ? `${m[1].trim()} ${m[2]}%` : last.slice(0, 80));
		}
	};
}

export async function confirm(message: string, action: string, detail?: string): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
	return choice === action;
}

export async function savePatch(content: string, defaultName: string): Promise<void> {
	const choice = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Save to File...'), id: 'file' }, { label: vscode.l10n.t('Copy to Clipboard'), id: 'clip' }], { placeHolder: vscode.l10n.t('Create Patch') });
	if (!choice) {
		return;
	}
	if (choice.id === 'clip') {
		await vscode.env.clipboard.writeText(content);
		void vscode.window.showInformationMessage(vscode.l10n.t('Patch copied to the clipboard.'));
		return;
	}
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	const uri = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, defaultName) : undefined, filters: { Patch: ['patch', 'diff'] } });
	if (uri) {
		await fs.promises.writeFile(uri.fsPath, content, 'utf8');
		void vscode.window.showInformationMessage(vscode.l10n.t('Patch saved to {0}', uri.fsPath));
	}
}

export function describeFiles(n: number): string {
	return plural(n, '{0} file', '{0} files');
}
