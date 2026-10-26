import * as vscode from 'vscode';
import { openDiff } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { basename, config } from '../util';
import { CommandContext, handleOutcome, resolveRepo, uriOf, withSmartStash } from './common';
import { openLogPanel } from './history';

/** "Compare with Clipboard" for the current file or selection. */
async function compareWithClipboard(arg?: unknown): Promise<void> {
	const uri = uriOf(arg);
	if (!uri || uri.scheme !== 'file') {
		return;
	}
	const repo = services().repos.getRepository(uri);
	if (!repo) {
		void vscode.window.showWarningMessage(vscode.l10n.t('The file is not in a Git repository.'));
		return;
	}
	const clip = await vscode.env.clipboard.readText();
	const rel = repo.relativePath(uri.fsPath);
	await openDiff({
		targets: [{ repo, path: rel, status: 'M', left: { kind: 'text', text: clip }, right: { kind: 'working', path: rel }, leftTitle: vscode.l10n.t('Clipboard'), rightTitle: basename(rel), mode: 'readonly' }],
		index: 0,
	});
}

/** GitHub "Sync Fork": fetch upstream and rebase the current branch onto its default branch. */
async function syncFork(repo: Repository): Promise<void> {
	const remotes = await repo.getRemotes();
	let upstream = remotes.find((r) => r.name === 'upstream')?.name;
	if (!upstream) {
		const url = await vscode.window.showInputBox({ title: vscode.l10n.t('Sync Fork'), prompt: vscode.l10n.t('URL of the original (upstream) repository; it is added as remote "upstream"'), ignoreFocusOut: true });
		if (!url) {
			return;
		}
		await repo.addRemote('upstream', url.trim());
		upstream = 'upstream';
	}
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Fetching upstream...') }, () => repo.fetch(upstream));
	const head = (await repo.run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${upstream}/HEAD`], { acceptExitCodes: [1, 128] })).stdout.trim();
	const refs = await repo.getRefs();
	const base = head || ['main', 'master'].map((b) => `${upstream}/${b}`).find((b) => refs.some((r) => r.shortName === b));
	if (!base) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Cannot find the default branch of {0}.', upstream));
		return;
	}
	const useRebase = config<string>('update.method', 'ask') !== 'merge';
	const outcome = await withSmartStash(repo, useRebase ? vscode.l10n.t('Rebase') : vscode.l10n.t('Merge'), () => (useRebase ? repo.rebase(base) : repo.merge(base)));
	if (await handleOutcome(repo, outcome, vscode.l10n.t('Synced {0} with {1}', repo.state.branch ?? 'HEAD', base))) {
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t('{0} is up to date with {1}. Push it to your fork?', repo.state.branch ?? 'HEAD', base), vscode.l10n.t('Push...'));
		if (choice) {
			await vscode.commands.executeCommand('changeline.push', repo);
		}
	}
}

export function registerExtraCommands(ctx: CommandContext): void {
	ctx.register('changeline.compareWithClipboard', compareWithClipboard);
	ctx.register('changeline.github.syncFork', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await syncFork(repo);
		}
	});
	ctx.register('changeline.showLogInNewTab', async (arg?: { repo?: string; branches?: string[] }) => {
		const repo = arg?.repo ? services().repos.getByRoot(arg.repo) : await resolveRepo();
		if (!repo) {
			return;
		}
		const title = vscode.l10n.t('Log: {0}', arg?.branches?.length ? arg.branches.join(', ') : repo.name);
		openLogPanel({ kind: 'log', repoRoot: repo.root, title, filters: arg?.branches ? { branches: arg.branches } : undefined }, title);
	});
	ctx.register('changeline.testGit', async () => {
		const git = services().git;
		const r = await git.exec(process.cwd(), ['--version']);
		void vscode.window.showInformationMessage(`${r.stdout.trim()} — ${git.path}`);
	});
}
