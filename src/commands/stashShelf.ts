import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { commitFileTarget, openDiff } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import type { ShelvedList } from '../shelf';
import { config, plural, showError } from '../util';
import type { ShelfNode, ShelfView } from '../views/shelfView';
import type { StashNode, StashView } from '../views/stashView';
import { showDialog } from '../webviews/dialogPanel';
import { MergePanel } from '../webviews/mergePanel';
import { CommandContext, confirm, handleOutcome, resolveRepo, savePatch } from './common';

export async function stashDialog(repo: Repository): Promise<void> {
	if (!repo.state.changes.length && !repo.state.untracked.length && !repo.state.staged.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No local changes to stash.'));
		return;
	}
	const result = await showDialog({
		title: vscode.l10n.t('Stash'),
		description: vscode.l10n.t('Stash local changes of {0} on {1}', repo.name, repo.state.branch ?? 'HEAD'),
		fields: [
			{ id: 'message', type: 'text', label: vscode.l10n.t('Message:'), focus: true, placeholder: vscode.l10n.t('Optional description') },
			{ id: 'keepIndex', type: 'checkbox', label: vscode.l10n.t('Keep index (--keep-index)') },
			{ id: 'untracked', type: 'checkbox', label: vscode.l10n.t('Include untracked files (--include-untracked)') },
			{ id: 'staged', type: 'checkbox', label: vscode.l10n.t('Stash only staged changes (--staged)') },
		],
		okLabel: vscode.l10n.t('Create Stash'),
		width: 520,
	});
	if (!result) {
		return;
	}
	const ok = await repo.stash({
		message: String(result.values.message ?? '').trim() || undefined,
		keepIndex: result.values.keepIndex === true,
		includeUntracked: result.values.untracked === true,
		staged: result.values.staged === true,
	});
	void vscode.window.showInformationMessage(ok ? vscode.l10n.t('Local changes stashed.') : vscode.l10n.t('No local changes to save.'));
}

/** "Unstash Changes" dialog: list of stashes with View/Pop/Apply/Drop/Clear/Branch. */
export async function unstashDialog(repo: Repository): Promise<void> {
	const stashes = await repo.getStashes();
	if (!stashes.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('No stashes.'));
		return;
	}
	const result = await showDialog({
		title: vscode.l10n.t('Unstash Changes'),
		description: vscode.l10n.t('{0} · current branch: {1}', repo.name, repo.state.branch ?? 'HEAD'),
		fields: [
			{
				id: 'stash',
				type: 'radio',
				label: vscode.l10n.t('Stashes:'),
				value: stashes[0].ref,
				options: stashes.map((s) => ({ value: s.ref, label: `${s.ref}: ${s.message}`, description: `on ${s.branch ?? '?'} · ${new Date(s.date * 1000).toLocaleString()}` })),
			},
			{ id: 'pop', type: 'checkbox', label: vscode.l10n.t('Pop stash (drop it after applying)'), value: true },
			{ id: 'index', type: 'checkbox', label: vscode.l10n.t('Reinstate index (--index)') },
			{ id: 'asBranch', type: 'checkbox', label: vscode.l10n.t('As new branch') },
			{ id: 'branch', type: 'text', label: vscode.l10n.t('Branch name:'), visibleWhen: 'asBranch' },
		],
		okLabel: vscode.l10n.t('Apply Stash'),
		extraButtons: [
			{ id: 'view', label: vscode.l10n.t('View') },
			{ id: 'drop', label: vscode.l10n.t('Drop') },
			{ id: 'clear', label: vscode.l10n.t('Clear') },
		],
		width: 640,
	});
	if (!result) {
		return;
	}
	const ref = String(result.values.stash);
	const stash = stashes.find((s) => s.ref === ref)!;
	switch (result.button) {
		case 'view':
			await viewStash(repo, stash);
			return;
		case 'drop':
			if (await confirm(vscode.l10n.t('Drop {0}?', ref), vscode.l10n.t('Drop'))) {
				await repo.stashDrop(ref);
			}
			return;
		case 'clear':
			if (await confirm(vscode.l10n.t('Remove all stashes? This cannot be undone.'), vscode.l10n.t('Clear'))) {
				await repo.stashClear();
			}
			return;
	}
	if (result.values.asBranch) {
		const name = String(result.values.branch ?? '').trim();
		if (!name) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Specify a branch name.'));
			return;
		}
		await handleOutcome(repo, await repo.stashBranch(name, ref), vscode.l10n.t('Created branch {0} from {1}', name, ref));
		return;
	}
	await handleOutcome(repo, await repo.stashApply(ref, { pop: result.values.pop === true, index: result.values.index === true }), vscode.l10n.t('Applied {0}', ref));
}

async function viewStash(repo: Repository, stash: Awaited<ReturnType<Repository['getStashes']>>[number]): Promise<void> {
	const files = await repo.getStashFiles(stash);
	const pick = await vscode.window.showQuickPick(files.map((f) => ({ label: f.path, description: f.status, file: f })), { title: `${stash.ref}: ${stash.message}`, placeHolder: vscode.l10n.t('Select a file to view the diff') });
	if (pick) {
		await openStashDiff(repo, stash, pick.file, files);
	}
}

async function openStashDiff(repo: Repository, stash: Awaited<ReturnType<Repository['getStashes']>>[number], file: import('../shared/types').FileChange, files: import('../shared/types').FileChange[]): Promise<void> {
	const targets = files.map((f) => {
		const untracked = stash.parents[2] && f.status === 'A' && !stash.parents[1];
		const commit = { hash: untracked ? stash.parents[2] : stash.hash, parents: [stash.parents[0]] };
		const t = commitFileTarget(repo, commit, f);
		return { ...t, leftTitle: vscode.l10n.t('Base ({0})', stash.parents[0].slice(0, 8)), rightTitle: stash.ref };
	});
	await openDiff({ targets, index: Math.max(0, files.indexOf(file)) });
}

export async function unshelveList(list: ShelvedList, only?: Set<string>): Promise<void> {
	const s = services();
	const result = await s.shelf.unshelve(list, (root) => s.repos.getByRoot(root), only);
	for (const c of result.conflicts) {
		const applied = await MergePanel.show({
			title: vscode.l10n.t('Unshelve {0}', list.name),
			path: c.repo.absolutePath(c.file.path),
			base: c.base,
			left: c.local,
			right: c.shelved,
			leftTitle: vscode.l10n.t('Local changes'),
			rightTitle: vscode.l10n.t('Shelved: {0}', list.name),
			apply: async (text) => {
				await fs.promises.writeFile(c.repo.absolutePath(c.file.path), text, 'utf8');
				await c.repo.refresh();
			},
		});
		if (applied) {
			result.applied++;
		} else {
			result.skipped.push(c.file.path);
		}
	}
	const applied = new Set<string>();
	list.repos.forEach((r, ri) => {
		for (const f of r.files) {
			const key = `${ri}:${f.path}`;
			if ((!only || only.has(key)) && !result.skipped.includes(f.path)) {
				applied.add(key);
			}
		}
	});
	if (config('shelf.removeAfterUnshelve', true) && applied.size) {
		await s.shelf.removeFiles(list, applied);
	}
	if (result.skipped.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Unshelved {0}; {1} skipped: {2}', plural(result.applied, '{0} file', '{0} files'), plural(result.skipped.length, '{0} file', '{0} files'), result.skipped.slice(0, 5).join(', ')));
	} else {
		void vscode.window.showInformationMessage(vscode.l10n.t('Unshelved {0} from \'{1}\'.', plural(result.applied, '{0} file', '{0} files'), list.name));
	}
}

export function registerStashShelfCommands(ctx: CommandContext, stashView: StashView, shelfView: ShelfView): void {
	ctx.register('changeline.stashChanges', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await stashDialog(repo);
		}
	});
	ctx.register('changeline.unstashChanges', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await unstashDialog(repo);
		}
	});
	ctx.register('changeline.stash.refresh', () => stashView.refresh());
	const stashOf = (n?: StashNode) => {
		const node = stashView.selected(n);
		return node && node.type !== 'repo' ? node : undefined;
	};
	ctx.register('changeline.stash.apply', async (n?: StashNode) => {
		const node = stashOf(n);
		if (node) {
			await handleOutcome(node.repo, await node.repo.stashApply(node.stash.ref), vscode.l10n.t('Applied {0}', node.stash.ref));
		}
	});
	ctx.register('changeline.stash.pop', async (n?: StashNode) => {
		const node = stashOf(n);
		if (node) {
			await handleOutcome(node.repo, await node.repo.stashApply(node.stash.ref, { pop: true }), vscode.l10n.t('Popped {0}', node.stash.ref));
		}
	});
	ctx.register('changeline.stash.applyIndex', async (n?: StashNode) => {
		const node = stashOf(n);
		if (node) {
			await handleOutcome(node.repo, await node.repo.stashApply(node.stash.ref, { index: true }), vscode.l10n.t('Applied {0} with index', node.stash.ref));
		}
	});
	ctx.register('changeline.stash.drop', async (n?: StashNode) => {
		const node = stashOf(n);
		if (node && (await confirm(vscode.l10n.t('Drop {0}: {1}?', node.stash.ref, node.stash.message), vscode.l10n.t('Drop')))) {
			await node.repo.stashDrop(node.stash.ref);
			stashView.refresh();
		}
	});
	ctx.register('changeline.stash.clear', async (n?: StashNode) => {
		const repo = n ? n.repo : await resolveRepo();
		if (repo && (await confirm(vscode.l10n.t('Remove all stashes of {0}? This cannot be undone.', repo.name), vscode.l10n.t('Clear')))) {
			await repo.stashClear();
			stashView.refresh();
		}
	});
	ctx.register('changeline.stash.branch', async (n?: StashNode) => {
		const node = stashOf(n);
		if (!node) {
			return;
		}
		const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Create a branch from {0}', node.stash.ref), placeHolder: vscode.l10n.t('Branch name') });
		if (name) {
			await handleOutcome(node.repo, await node.repo.stashBranch(name.trim(), node.stash.ref), vscode.l10n.t('Created branch {0}', name.trim()));
		}
	});
	ctx.register('changeline.stash.showDiff', async (n?: StashNode) => {
		const node = stashView.selected(n);
		if (node?.type === 'file') {
			const files = await node.repo.getStashFiles(node.stash);
			await openStashDiff(node.repo, node.stash, files.find((f) => f.path === node.file.path) ?? node.file, files);
		}
	});

	ctx.register('changeline.shelveChanges', () => vscode.commands.executeCommand('changeline.changes.shelve'));
	ctx.register('changeline.shelf.refresh', () => shelfView.refresh());
	const listsOf = (n?: ShelfNode, ns?: ShelfNode[]) => {
		const nodes = shelfView.selected(n, ns);
		const lists = new Map<string, { list: ShelvedList; only?: Set<string> }>();
		for (const node of nodes) {
			if (node.type === 'list') {
				lists.set(node.list.id, { list: node.list });
			} else if (node.type === 'file') {
				const entry = lists.get(node.list.id) ?? { list: node.list, only: new Set<string>() };
				entry.only?.add(`${node.repoIndex}:${node.file.path}`);
				lists.set(node.list.id, entry);
			}
		}
		return [...lists.values()];
	};
	ctx.register('changeline.shelf.unshelve', async (n?: ShelfNode, ns?: ShelfNode[]) => {
		for (const { list, only } of listsOf(n, ns)) {
			const result = await showDialog({
				title: vscode.l10n.t('Unshelve Changes'),
				description: vscode.l10n.t('Unshelve \'{0}\' ({1})', list.name, plural(only ? only.size : list.repos.reduce((x, r) => x + r.files.length, 0), '{0} file', '{0} files')),
				fields: [
					{
						id: 'changelist',
						type: 'combo',
						label: vscode.l10n.t('Move to changelist:'),
						value: services().changelists.active.name,
						options: [{ value: list.name, label: list.name }, ...services().changelists.all.map((c) => ({ value: c.name, label: c.name }))],
					},
					{ id: 'remove', type: 'checkbox', label: vscode.l10n.t('Remove successfully applied files from the shelf'), value: config('shelf.removeAfterUnshelve', true) },
				],
				okLabel: vscode.l10n.t('Unshelve'),
				width: 520,
			});
			if (!result) {
				return;
			}
			const cl = services().changelists;
			const target = String(result.values.changelist ?? '').trim();
			await vscode.workspace.getConfiguration('changeline').update('shelf.removeAfterUnshelve', result.values.remove === true, vscode.ConfigurationTarget.Global);
			await unshelveList(list, only);
			if (target) {
				const existing = cl.findByName(target) ?? cl.create(target);
				const paths = list.repos.flatMap((r) => r.files.map((f) => path.join(r.repoRoot, ...f.path.split('/'))));
				cl.move(paths, existing.id);
			}
		}
	});
	ctx.register('changeline.shelf.unshelveSilently', async (n?: ShelfNode, ns?: ShelfNode[]) => {
		for (const { list, only } of listsOf(n, ns)) {
			await unshelveList(list, only);
		}
	});
	ctx.register('changeline.shelf.delete', async (n?: ShelfNode, ns?: ShelfNode[]) => {
		const lists = listsOf(n, ns);
		for (const { list, only } of lists) {
			if (only) {
				await services().shelf.removeFiles(list, only);
			} else if (list.deleted) {
				if (await confirm(vscode.l10n.t('Permanently delete \'{0}\'?', list.name), vscode.l10n.t('Delete'))) {
					await services().shelf.delete(list);
				}
			} else {
				await services().shelf.delete(list);
			}
		}
	});
	ctx.register('changeline.shelf.restore', async (n?: ShelfNode) => {
		if (n?.type === 'list') {
			await services().shelf.restore(n.list);
		}
	});
	ctx.register('changeline.shelf.rename', async (n?: ShelfNode) => {
		if (n?.type !== 'list') {
			return;
		}
		const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Rename shelved changelist'), value: n.list.name });
		if (name) {
			await services().shelf.rename(n.list, name.trim());
		}
	});
	ctx.register('changeline.shelf.emptyDeleted', async () => {
		if (await confirm(vscode.l10n.t('Permanently delete all recently deleted shelved changelists?'), vscode.l10n.t('Delete'))) {
			await services().shelf.emptyRecentlyDeleted();
		}
	});
	ctx.register('changeline.shelf.createPatch', async (n?: ShelfNode) => {
		if (n?.type === 'list') {
			await savePatch(await services().shelf.readPatch(n.list), `${n.list.name.replace(/[^\w.-]+/g, '_')}.patch`);
		}
	});
	ctx.register('changeline.shelf.importPatch', async () => {
		const repo = await resolveRepo();
		if (!repo) {
			return;
		}
		const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Patch: ['patch', 'diff'] } });
		if (!uris?.length) {
			return;
		}
		try {
			const patch = await fs.promises.readFile(uris[0].fsPath, 'utf8');
			await services().shelf.importPatch(repo, uris[0].path.split('/').pop()!.replace(/\.(patch|diff)$/, ''), patch);
		} catch (e) {
			await showError(e, vscode.l10n.t('Import failed'));
		}
	});
	ctx.register('changeline.shelf.showDiff', async (n?: ShelfNode) => {
		const node = n ?? shelfView.selected()[0];
		if (!node || node.type !== 'file') {
			return;
		}
		const s = services();
		const entries = node.list.repos.flatMap((r, ri) => r.files.map((f) => ({ r, ri, f })));
		const targets = [];
		for (const { r, ri, f } of entries) {
			const repo = s.repos.getByRoot(r.repoRoot);
			if (!repo) {
				continue;
			}
			const content = f.status === 'D' ? undefined : await s.shelf.readShelved(node.list, ri, f);
			targets.push({
				repo,
				path: f.path,
				status: f.status,
				left: f.status === 'A' || !r.base ? ({ kind: 'empty' } as const) : ({ kind: 'git', ref: r.base, path: f.origPath ?? f.path } as const),
				right: content ? ({ kind: 'text', text: content.toString('utf8') } as const) : ({ kind: 'empty' } as const),
				leftTitle: r.base ? vscode.l10n.t('Base ({0})', r.base.slice(0, 8)) : vscode.l10n.t('Base'),
				rightTitle: vscode.l10n.t('Shelved: {0}', node.list.name),
				mode: 'readonly' as const,
			});
		}
		const index = entries.findIndex((e) => e.ri === node.repoIndex && e.f.path === node.file.path);
		await openDiff({ targets, index: Math.max(0, index) });
	});
}
