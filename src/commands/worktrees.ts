import * as path from 'path';
import * as vscode from 'vscode';
import { GitError } from '../git/gitCli';
import type { Repository } from '../git/repository';
import { isValidBranchName, shortHash } from '../util';
import { showDialog } from '../webviews/dialogPanel';
import { CommandContext, confirm, resolveRepo } from './common';

async function newWorktree(repo: Repository): Promise<void> {
	const branches = repo.refs.filter((r) => r.type !== 'tag');
	const result = await showDialog({
		title: vscode.l10n.t('Create Worktree'),
		fields: [
			{ id: 'ref', type: 'combo', label: vscode.l10n.t('Branch or revision:'), options: branches.map((b) => ({ value: b.shortName, label: b.shortName })), required: true, focus: true },
			{ id: 'createBranch', type: 'checkbox', label: vscode.l10n.t('Create a new branch'), value: true },
			{ id: 'branch', type: 'text', label: vscode.l10n.t('New branch name:'), visibleWhen: 'createBranch' },
			{ id: 'dir', type: 'text', label: vscode.l10n.t('Directory:'), value: path.join(path.dirname(repo.root), `${repo.name}-worktree`), required: true },
		],
		okLabel: vscode.l10n.t('Create'),
		width: 620,
	}, (v) => {
		const name = String(v.branch ?? '').trim();
		return v.createBranch && name ? { branch: isValidBranchName(name) } : {};
	});
	if (!result) {
		return;
	}
	const v = result.values;
	const dir = String(v.dir).trim();
	const newBranch = v.createBranch ? String(v.branch ?? '').trim() || undefined : undefined;
	await repo.addWorktree(dir, String(v.ref).trim(), newBranch);
	const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Created worktree in {0}.', dir), vscode.l10n.t('Open in New Window'), vscode.l10n.t('Add to Workspace'));
	if (choice === vscode.l10n.t('Open in New Window')) {
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), true);
	} else if (choice === vscode.l10n.t('Add to Workspace')) {
		vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(dir) });
	}
}

export async function manageWorktrees(repo: Repository): Promise<void> {
	for (;;) {
		const worktrees = await repo.listWorktrees();
		const open = { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: vscode.l10n.t('Open in New Window') };
		const remove = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Remove Worktree') };
		const items: (vscode.QuickPickItem & { dir?: string; add?: boolean })[] = worktrees.map((w, i) => ({
			label: `${i === 0 ? '$(home)' : '$(folder)'} ${w.branch ?? (w.head ? `detached at ${shortHash(w.head)}` : 'bare')}`,
			description: w.path,
			detail: [i === 0 ? 'main worktree' : '', w.locked ? 'locked' : '', w.prunable ? 'prunable (directory missing)' : ''].filter(Boolean).join(' · ') || undefined,
			dir: w.path,
			buttons: i === 0 ? [open] : [open, remove],
		}));
		items.push({ label: vscode.l10n.t('$(add) New Worktree...'), add: true });
		const qp = vscode.window.createQuickPick<(typeof items)[number]>();
		qp.title = vscode.l10n.t('Worktrees · {0}', repo.name);
		qp.items = items;
		const action = await new Promise<{ type: 'add' | 'open' | 'remove'; dir?: string } | undefined>((resolve) => {
			qp.onDidAccept(() => {
				const it = qp.selectedItems[0];
				resolve(it?.add ? { type: 'add' } : it?.dir ? { type: 'open', dir: it.dir } : undefined);
				qp.hide();
			});
			qp.onDidTriggerItemButton((e) => {
				resolve({ type: e.button === remove ? 'remove' : 'open', dir: e.item.dir });
				qp.hide();
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
		});
		qp.dispose();
		if (!action) {
			return;
		}
		if (action.type === 'add') {
			await newWorktree(repo);
			return;
		}
		if (action.type === 'open' && action.dir) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(action.dir), true);
			return;
		}
		if (action.type === 'remove' && action.dir) {
			if (!(await confirm(vscode.l10n.t('Remove the worktree in {0}?', action.dir), vscode.l10n.t('Remove')))) {
				continue;
			}
			try {
				await repo.removeWorktree(action.dir);
			} catch (e) {
				if (e instanceof GitError && /contains modified or untracked files|is dirty/.test(e.stderr)) {
					if (await confirm(vscode.l10n.t('The worktree has local changes. Remove it anyway?'), vscode.l10n.t('Force Remove'), vscode.l10n.t('Local changes in the worktree are lost.'))) {
						await repo.removeWorktree(action.dir, true);
					}
				} else {
					throw e;
				}
			}
		}
	}
}

export function registerWorktreeCommands(ctx: CommandContext): void {
	ctx.register('changeline.worktrees', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await manageWorktrees(repo);
		}
	});
}
