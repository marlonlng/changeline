import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommitController } from '../commit';
import { groupByRepo } from '../commit';
import { localChangeTarget, openDiff } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { basename, config, plural } from '../util';
import type { ChangeNode, ChangesView, FileNode } from '../views/changesView';
import { stageFiles, unstageFiles } from '../views/changesView';
import type { CommitMessageView } from '../views/commitMessageView';
import { showDialog } from '../webviews/dialogPanel';
import { CommandContext, confirm, savePatch } from './common';

/** Opens the diff for a file of the Local Changes tree, navigable through all files of its group. */
export async function openChangeDiff(view: ChangesView, node: FileNode, native = false): Promise<void> {
	if (node.group === 'conflicts') {
		const conflict = node.repo.state.conflicts.find((c) => c.path === node.change.path);
		if (conflict && conflict.ours !== 'deleted' && conflict.theirs !== 'deleted') {
			const { openGitConflictMerge } = await import('../webviews/mergePanel');
			await openGitConflictMerge(node.repo, conflict);
		} else {
			await vscode.commands.executeCommand('changeline.resolveConflicts');
		}
		return;
	}
	if (config<string>('commit.clickAction', 'diff') === 'source' && !native) {
		await vscode.window.showTextDocument(vscode.Uri.file(node.abs), { preview: true, preserveFocus: true });
		return;
	}
	const group = view.groups.find((g) => g.files.some((f) => f.id === node.id));
	const siblings = group ? group.files : [node];
	const targets = siblings.map((f) => localChangeTarget(f.repo, f.change, f.group));
	const index = Math.max(0, siblings.findIndex((f) => f.id === node.id));
	await openDiff({ targets, index }, native);
}

/** Changed files at or below the given files / folders (from the explorer or an editor). */
export function changedFilesUnder(view: ChangesView, uris: vscode.Uri[]): FileNode[] {
	const targets = uris.flatMap((u) => {
		const repo = services().repos.getRepository(u);
		return repo ? [{ repo, rel: repo.relativePath(u.fsPath) }] : [];
	});
	return view.allFiles().filter((f) => targets.some((t) => t.repo === f.repo && (t.rel === '' || f.change.path === t.rel || f.change.path.startsWith(t.rel + '/'))));
}

/** JetBrains "Rollback Changes" dialog. */
export async function rollbackDialog(view: ChangesView, files: FileNode[]): Promise<void> {
	const candidates = files.filter((f) => f.group !== 'unversioned' && f.group !== 'ignored' && f.group !== 'conflicts');
	if (!candidates.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No changes to roll back.'));
		return;
	}
	const hasAdded = candidates.some((f) => f.change.status === 'A');
	const result = await showDialog({
		title: vscode.l10n.t('Rollback Changes'),
		fields: [
			{
				id: 'files',
				type: 'checklist',
				label: plural(candidates.length, '{0} file', '{0} files'),
				options: candidates.map((f) => ({ value: f.id, label: basename(f.change.path), description: `${f.change.status} · ${path.dirname(f.change.path) === '.' ? f.repo.name : path.dirname(f.change.path)}` })),
			},
			...(hasAdded ? [{ id: 'deleteAdded', type: 'checkbox' as const, label: vscode.l10n.t('Delete local copies of added files'), value: false }] : []),
		],
		okLabel: vscode.l10n.t('Rollback'),
		width: 640,
	});
	if (!result) {
		return;
	}
	const chosen = new Set(result.values.files as string[]);
	const selected = candidates.filter((f) => chosen.has(f.id));
	if (!selected.length) {
		return;
	}
	for (const [repo, list] of groupByRepo(selected)) {
		if (list.some((f) => f.group === 'staged')) {
			await repo.unstage(list.filter((f) => f.group === 'staged').map((f) => f.change.path));
		}
		if (view.stagingMode && list.every((f) => f.group === 'unstaged')) {
			await repo.discardWorktreeChanges(list.filter((f) => f.change.status !== 'A').map((f) => f.change.path));
			continue;
		}
		await repo.rollback(list.map((f) => f.change), result.values.deleteAdded === true);
	}
	void vscode.window.showInformationMessage(vscode.l10n.t('Rolled back {0}.', plural(selected.length, '{0} file', '{0} files')));
}

export async function moveToChangelist(files: FileNode[]): Promise<void> {
	const cl = services().changelists;
	const items: (vscode.QuickPickItem & { id?: string })[] = [
		...cl.all.map((l) => ({ label: l.name, description: l.id === cl.active.id ? 'active' : undefined, id: l.id })),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: vscode.l10n.t('$(add) New Changelist...'), id: '__new' },
	];
	const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Move {0} to Another Changelist', plural(files.length, '{0} file', '{0} files')) });
	if (!pick?.id) {
		return;
	}
	let id = pick.id;
	if (id === '__new') {
		const list = await newChangelistDialog();
		if (!list) {
			return;
		}
		id = list;
	}
	cl.move(files.filter((f) => f.group === 'changelist').map((f) => f.abs), id);
}

async function newChangelistDialog(): Promise<string | undefined> {
	const cl = services().changelists;
	const result = await showDialog(
		{
			title: vscode.l10n.t('New Changelist'),
			fields: [
				{ id: 'name', type: 'text', label: vscode.l10n.t('Name:'), required: true, focus: true },
				{ id: 'comment', type: 'textarea', label: vscode.l10n.t('Comment:'), rows: 4 },
				{ id: 'active', type: 'checkbox', label: vscode.l10n.t('Set active'), value: false },
			],
			okLabel: 'OK',
			width: 520,
			liveValidation: true,
		},
		(v) => (cl.findByName(String(v.name ?? '').trim()) ? { name: vscode.l10n.t('A changelist with this name already exists') } : {}),
	);
	if (!result) {
		return undefined;
	}
	return cl.create(String(result.values.name).trim(), String(result.values.comment ?? '').trim() || undefined, result.values.active === true).id;
}

export async function shelveDialog(files: { repo: Repository; change: import('../shared/types').FileChange }[], defaultName: string): Promise<void> {
	const tracked = files.filter((f) => f.change.status !== '!');
	if (!tracked.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No changes to shelve.'));
		return;
	}
	const result = await showDialog({
		title: vscode.l10n.t('Shelve Changes'),
		fields: [
			{ id: 'name', type: 'text', label: vscode.l10n.t('Name:'), value: defaultName, required: true, focus: true },
			{
				id: 'files',
				type: 'checklist',
				label: plural(tracked.length, '{0} file', '{0} files'),
				options: tracked.map((f, i) => ({ value: String(i), label: f.change.path, description: `${f.change.status}${services().repos.repositories.length > 1 ? ` · ${f.repo.name}` : ''}` })),
			},
			{ id: 'keep', type: 'checkbox', label: vscode.l10n.t('Keep local changes (shelve silently copies only)'), value: false },
		],
		okLabel: vscode.l10n.t('Shelve Changes'),
		width: 640,
	});
	if (!result) {
		return;
	}
	const chosen = new Set(result.values.files as string[]);
	const selected = tracked.filter((_, i) => chosen.has(String(i)));
	if (!selected.length) {
		return;
	}
	await services().shelf.shelve(String(result.values.name).trim(), selected, result.values.keep === true);
	void vscode.window.showInformationMessage(vscode.l10n.t('Shelved {0}: {1}', plural(selected.length, '{0} file', '{0} files'), String(result.values.name).trim()));
}

async function addToGitignore(files: FileNode[]): Promise<void> {
	for (const [repo, list] of groupByRepo(files)) {
		const choice = await vscode.window.showQuickPick(
			[
				{ label: '.gitignore', description: vscode.l10n.t('repository root'), target: path.join(repo.root, '.gitignore') },
				{ label: '.git/info/exclude', description: vscode.l10n.t('local only, not shared'), target: path.join(repo.commonDir, 'info', 'exclude') },
			],
			{ placeHolder: vscode.l10n.t('Ignore {0} in {1}', plural(list.length, '{0} file', '{0} files'), repo.name) },
		);
		if (!choice) {
			return;
		}
		let content = '';
		try {
			content = await fs.promises.readFile(choice.target, 'utf8');
		} catch {
		}
		const lines = list.map((f) => '/' + f.change.path);
		const prefix = content && !content.endsWith('\n') ? '\n' : '';
		await fs.promises.mkdir(path.dirname(choice.target), { recursive: true });
		await fs.promises.writeFile(choice.target, content + prefix + lines.join('\n') + '\n', 'utf8');
		await repo.refresh();
	}
}

export function registerChangesCommands(ctx: CommandContext, view: ChangesView, commit: CommitController, messageView: CommitMessageView): void {
	const sel = (node?: ChangeNode, nodes?: ChangeNode[]) => view.selectedFiles(node, nodes);

	ctx.register('changeline.changes.open', (node: FileNode) => openChangeDiff(view, node));
	ctx.register('changeline.changes.showDiff', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		const files = sel(node, nodes);
		const first = files[0] ?? view.allFiles()[0];
		if (first) {
			await openChangeDiff(view, first, false);
		}
	});
	ctx.register('changeline.changes.showNativeDiff', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		const first = sel(node, nodes)[0];
		if (first) {
			await openChangeDiff(view, first, true);
		}
	});
	ctx.register('changeline.changes.openFile', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		for (const f of sel(node, nodes)) {
			if (f.change.status !== 'D') {
				await vscode.window.showTextDocument(vscode.Uri.file(f.abs), { preview: false });
			}
		}
	});
	ctx.register('changeline.changes.refresh', async () => {
		await Promise.all(services().repos.repositories.map((r) => r.refresh()));
	});
	ctx.register('changeline.changes.rollback', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		let files = sel(node, nodes);
		if (!files.length) {
			files = view.stagingMode ? view.allFiles() : view.includedFiles();
		}
		await rollbackDialog(view, files);
	});
	ctx.register('changeline.changes.moveToChangelist', async (node?: ChangeNode, nodes?: ChangeNode[]) => moveToChangelist(sel(node, nodes)));
	ctx.register('changeline.changes.newChangelist', newChangelistDialog);
	ctx.register('changeline.changes.setActive', (node: ChangeNode) => {
		if (node?.listId) {
			services().changelists.setActive(node.listId);
		}
	});
	ctx.register('changeline.changes.editChangelist', async (node: ChangeNode) => {
		const cl = services().changelists;
		const list = node?.listId ? cl.get(node.listId) : cl.active;
		if (!list) {
			return;
		}
		const result = await showDialog({
			title: vscode.l10n.t('Edit Changelist'),
			fields: [
				{ id: 'name', type: 'text', label: vscode.l10n.t('Name:'), value: list.name, required: true, focus: true },
				{ id: 'comment', type: 'textarea', label: vscode.l10n.t('Comment:'), value: list.comment ?? '', rows: 4, description: vscode.l10n.t('Used as the default commit message for this changelist.') },
				{ id: 'active', type: 'checkbox', label: vscode.l10n.t('Set active'), value: list.id === cl.active.id },
			],
			width: 520,
		});
		if (result) {
			cl.edit(list.id, String(result.values.name).trim(), String(result.values.comment ?? '').trim() || undefined);
			if (result.values.active) {
				cl.setActive(list.id);
			}
		}
	});
	ctx.register('changeline.changes.deleteChangelist', async (node: ChangeNode) => {
		const cl = services().changelists;
		const list = node?.listId ? cl.get(node.listId) : undefined;
		if (!list) {
			return;
		}
		const files = view.groups.find((g) => g.listId === list.id)?.files.length ?? 0;
		if (files && !(await confirm(vscode.l10n.t('Delete changelist \'{0}\'? Its {1} will be moved to the active changelist.', list.name, plural(files, '{0} file', '{0} files')), vscode.l10n.t('Delete')))) {
			return;
		}
		cl.remove(list.id);
	});
	ctx.register('changeline.changes.shelve', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		let files = sel(node, nodes);
		if (!files.length) {
			files = view.includedFiles();
		}
		const name = node?.type === 'group' && node.list ? node.list.name : commit.message.split('\n')[0] || services().changelists.active.name;
		await shelveDialog(files.map((f) => ({ repo: f.repo, change: f.change })), name);
	});
	ctx.register('changeline.changes.shelveSilently', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		let files = sel(node, nodes);
		if (!files.length) {
			files = view.includedFiles();
		}
		if (!files.length) {
			return;
		}
		const name = node?.type === 'group' && node.list ? node.list.name : commit.message.split('\n')[0] || services().changelists.active.name;
		await services().shelf.shelve(name, files.map((f) => ({ repo: f.repo, change: f.change })));
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(inbox) Shelved {0}: {1}', plural(files.length, '{0} file', '{0} files'), name), 4000);
	});
	ctx.register('changeline.changes.addToVcs', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		for (const [repo, list] of groupByRepo(sel(node, nodes).filter((f) => f.group === 'unversioned' || f.group === 'ignored'))) {
			await repo.add(list.map((f) => f.change.path), { force: list.some((f) => f.group === 'ignored') });
		}
	});
	ctx.register('changeline.changes.ignore', async (node?: ChangeNode, nodes?: ChangeNode[]) => addToGitignore(sel(node, nodes)));
	ctx.register('changeline.changes.delete', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		const files = sel(node, nodes).filter((f) => f.change.status !== 'D');
		if (!files.length || !(await confirm(vscode.l10n.t('Delete {0} from disk?', plural(files.length, '{0} file', '{0} files')), vscode.l10n.t('Delete'), files.map((f) => f.change.path).slice(0, 10).join('\n')))) {
			return;
		}
		for (const f of files) {
			await vscode.workspace.fs.delete(vscode.Uri.file(f.abs), { useTrash: true });
		}
	});
	ctx.register('changeline.changes.stage', async (node?: ChangeNode, nodes?: ChangeNode[]) => stageFiles(sel(node, nodes).filter((f) => f.group !== 'staged')));
	ctx.register('changeline.changes.unstage', async (node?: ChangeNode, nodes?: ChangeNode[]) => unstageFiles(sel(node, nodes).filter((f) => f.group === 'staged')));
	ctx.register('changeline.changes.stageAll', async () => stageFiles(view.allFiles().filter((f) => f.group === 'unstaged' || f.group === 'unversioned')));
	ctx.register('changeline.changes.unstageAll', async () => unstageFiles(view.allFiles().filter((f) => f.group === 'staged')));
	ctx.register('changeline.changes.includeAll', () => services().changelists.setIncluded(view.allFiles().filter((f) => f.group === 'changelist').map((f) => f.abs), true));
	ctx.register('changeline.changes.excludeAll', () => services().changelists.setIncluded(view.allFiles().map((f) => f.abs), false));
	ctx.register('changeline.changes.commitSelected', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		const files = sel(node, nodes);
		if (!files.length) {
			return;
		}
		if (view.stagingMode) {
			await stageFiles(files.filter((f) => f.group !== 'staged'));
		} else {
			services().changelists.includeOnly(files.map((f) => f.abs));
		}
		messageView.focus();
	});
	ctx.register('changeline.changes.showHistory', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		const f = sel(node, nodes)[0];
		if (f) {
			await vscode.commands.executeCommand('changeline.showHistory', vscode.Uri.file(f.abs));
		}
	});
	ctx.register('changeline.changes.createPatch', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
		let files = sel(node, nodes);
		if (!files.length) {
			files = view.includedFiles();
		}
		let patch = '';
		for (const [repo, list] of groupByRepo(files)) {
			const tracked = list.filter((f) => f.change.status !== '?').flatMap((f) => (f.change.origPath ? [f.change.path, f.change.origPath] : [f.change.path]));
			if (tracked.length) {
				patch += await repo.createPatch({ from: repo.state.head ? 'HEAD' : undefined, cached: !repo.state.head, paths: tracked });
			}
			for (const f of list.filter((x) => x.change.status === '?')) {
				patch += await repo.createUntrackedPatch(f.change.path);
			}
		}
		await savePatch(patch, 'changes.patch');
	});
	const setGroupBy = (value: string) => vscode.workspace.getConfiguration('changeline').update('changes.groupBy', value, vscode.ConfigurationTarget.Global);
	ctx.register('changeline.changes.groupByDirectory', () => setGroupBy('directory'));
	ctx.register('changeline.changes.groupByNone', () => setGroupBy('none'));
	ctx.register('changeline.changes.expandAll', () => view.expandAll());
	ctx.register('changeline.changes.toggleStagingArea', async () => {
		const current = config('commit.useStagingArea', false);
		await vscode.workspace.getConfiguration('changeline').update('commit.useStagingArea', !current, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(!current ? vscode.l10n.t('Staging area enabled: commit what is staged in the index.') : vscode.l10n.t('Changelists enabled: commit the checked files.'));
	});
	ctx.register('changeline.changes.toggleIgnored', async () => {
		const current = config('changes.showIgnored', false);
		for (const r of services().repos.repositories) {
			r.showIgnored = !current;
			void r.refresh();
		}
		await vscode.workspace.getConfiguration('changeline').update('changes.showIgnored', !current, vscode.ConfigurationTarget.Global);
	});
	ctx.register('changeline.commit', async (arg?: { message?: string } | vscode.Uri) => {
		if (arg && !(arg instanceof vscode.Uri) && typeof arg.message === 'string' && arg.message) {
			commit.setMessage(arg.message);
		}
		await vscode.commands.executeCommand('changeline.changes.focus');
		messageView.focus();
	});
	ctx.register('changeline.commitFile', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
		const files = changedFilesUnder(view, uris && uris.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : []);
		if (!files.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No changes in the selected files.'));
			return;
		}
		if (view.stagingMode) {
			await stageFiles(files.filter((f) => f.group !== 'staged'));
		} else {
			services().changelists.includeOnly(files.map((f) => f.abs));
		}
		await vscode.commands.executeCommand('changeline.changes.focus');
		messageView.focus();
	});
	ctx.register('changeline.commitMessageHistory', () => commit.showMessageHistory());
}
