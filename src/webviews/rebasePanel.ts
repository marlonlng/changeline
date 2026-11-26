import * as vscode from 'vscode';
import type { RebaseTodoEntry, Repository } from '../git/repository';
import { services } from '../services';
import type { CommitInfo } from '../shared/types';
import { config, showError } from '../util';
import { saveLocalChanges } from '../commands/common';
import { RpcHandlers, WebviewPanelBase } from './host';

export interface RebaseRequest {
	repo: Repository;
	base?: string;
	commits: (CommitInfo & { body: string })[];
	preset?: Record<string, { action: RebaseTodoEntry['action']; message?: string }>;
	silent?: boolean;
}

export async function runInteractiveRebase(repo: Repository, base: string | undefined, entries: RebaseTodoEntry[]): Promise<boolean> {
	const shelve = config<'stash' | 'shelve'>('saveChanges', 'stash') === 'shelve';
	if (repo.state.changes.length || repo.state.staged.length) {
		const go = shelve ? vscode.l10n.t('Shelve and Rebase') : vscode.l10n.t('Stash and Rebase');
		const choice = await vscode.window.showWarningMessage(shelve ? vscode.l10n.t('You have local changes. They will be shelved before rebasing and restored afterwards.') : vscode.l10n.t('You have local changes. They will be stashed before rebasing and restored afterwards.'), { modal: true }, go);
		if (choice !== go) {
			return false;
		}
	}
	const saved = repo.state.changes.length || repo.state.staged.length ? await saveLocalChanges(repo, vscode.l10n.t('Rebase'), { includeUntracked: false }) : undefined;
	try {
		const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rebasing...') }, () =>
			repo.rebaseInteractive(base, entries, services().scriptsDir),
		);
		await repo.refresh();
		if (outcome.conflicts) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Rebase stopped because of conflicts. Resolve them and continue the rebase.'), vscode.l10n.t('Resolve...')).then((c) => {
				if (c) {
					void vscode.commands.executeCommand('changeline.resolveConflicts');
				}
			});
			void vscode.commands.executeCommand('changeline.resolveConflicts');
			return false;
		}
		if (repo.state.operation === 'rebase') {
			const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Rebase stopped for editing. Make your changes, amend the commit, then continue.'), vscode.l10n.t('Continue Rebase'));
			if (choice) {
				await vscode.commands.executeCommand('changeline.continueOperation', repo);
			}
			return true;
		}
		void vscode.window.showInformationMessage(vscode.l10n.t('Rebase completed successfully.'));
		return true;
	} catch (e) {
		await showError(e, vscode.l10n.t('Rebase failed'));
		return false;
	} finally {
		if (saved && repo.state.operation === 'none') {
			await saved.restore();
		} else if (saved) {
			void vscode.window.showInformationMessage(saved.kind === 'shelf' ? vscode.l10n.t('Your local changes were shelved before the rebase. Unshelve them when the rebase is done.') : vscode.l10n.t('Your local changes were stashed before the rebase ("Changeline: uncommitted changes before rebase"). Unstash them when the rebase is done.'));
		}
	}
}

export class RebasePanel extends WebviewPanelBase {
	static async show(req: RebaseRequest): Promise<void> {
		if (req.silent && req.preset) {
			const entries = [...req.commits].reverse().map((c) => ({
				hash: c.hash,
				subject: c.subject,
				action: req.preset![c.hash]?.action ?? 'pick',
				message: req.preset![c.hash]?.message,
			}));
			await runInteractiveRebase(req.repo, req.base, entries);
			return;
		}
		new RebasePanel(req);
	}

	private constructor(private readonly req: RebaseRequest) {
		super(services().context.extensionUri, 'changeline.rebase', vscode.l10n.t('Rebasing {0}', req.repo.state.branch ?? 'HEAD'), 'rebase', null, vscode.ViewColumn.Active);
	}

	protected handlers(): RpcHandlers {
		return {
			ready: () => ({
				branch: this.req.repo.state.branch ?? 'HEAD',
				base: this.req.base,
				commits: this.req.commits,
				preset: this.req.preset ?? {},
			}),
			files: async (p: { hash: string }) => {
				const c = this.req.commits.find((x) => x.hash === p.hash);
				return c ? this.req.repo.getCommitFiles(c.hash, c.parents) : [];
			},
			start: async (p: { entries: RebaseTodoEntry[] }) => {
				this.dispose();
				await runInteractiveRebase(this.req.repo, this.req.base, p.entries);
			},
			cancel: () => this.dispose(),
		};
	}
}
