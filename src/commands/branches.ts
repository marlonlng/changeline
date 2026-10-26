import * as fs from 'fs';
import * as vscode from 'vscode';
import { GitError } from '../git/gitCli';
import type { Repository } from '../git/repository';
import { services } from '../services';
import type { RefInfo } from '../shared/types';
import { capitalize, config, isValidBranchName, plural, shortHash } from '../util';
import { ComparePanel } from '../webviews/comparePanel';
import { showDialog } from '../webviews/dialogPanel';
import { favoriteBranches, LogController, toggleFavoriteBranch } from '../views/logController';
import { CommandContext, confirm, handleOutcome, resolveRepo, withSmartStash } from './common';

interface BranchItem extends vscode.QuickPickItem {
	action?: string;
	ref?: RefInfo;
}

function trackInfo(r: RefInfo): string {
	const parts: string[] = [];
	if (r.behind) {
		parts.push(`↓${r.behind}`);
	}
	if (r.ahead) {
		parts.push(`↑${r.ahead}`);
	}
	if (r.upstreamGone) {
		parts.push(vscode.l10n.t('upstream gone'));
	}
	return parts.join(' ');
}

const STAR = new vscode.ThemeIcon('star-full');
const STAR_EMPTY = new vscode.ThemeIcon('star-empty');

/** JetBrains "Git Branches" popup. */
export async function showBranchesPopup(arg?: unknown, singleRepository = false): Promise<void> {
	if (!arg && !singleRepository && services().repos.repositories.length > 1 && config('branches.syncControl', true)) {
		const { showMultiRepoBranchesPopup } = await import('./multiBranch');
		await showMultiRepoBranchesPopup();
		return;
	}
	let repo = await resolveRepo(arg);
	if (!repo) {
		return;
	}
	const s = services();
	await repo.refresh();
	const qp = vscode.window.createQuickPick<BranchItem>();
	qp.matchOnDescription = true;
	const build = async (r: Repository) => {
		const refs = await r.getRefs();
		const favorites = new Set(favoriteBranches(r));
		const recent = await r.getRecentBranches(5);
		const current = r.state.branch;
		const items: BranchItem[] = [];
		if (s.repos.repositories.length > 1) {
			items.push({ label: `$(repo) ${r.name}`, description: vscode.l10n.t('Switch repository...'), action: 'switchRepo', alwaysShow: true });
		}
		if (r.state.operation !== 'none') {
			items.push({ label: vscode.l10n.t('$(debug-continue) Continue {0}', capitalize(r.state.operation)), action: 'continue', alwaysShow: true });
			items.push({ label: vscode.l10n.t('$(debug-stop) Abort {0}', capitalize(r.state.operation)), action: 'abort', alwaysShow: true });
		}
		items.push(
			{ label: vscode.l10n.t('$(arrow-down) Update Project...'), description: '⌘T', action: 'update', alwaysShow: true },
			{ label: vscode.l10n.t('$(check) Commit...'), description: '⌘K', action: 'commit', alwaysShow: true },
			{ label: vscode.l10n.t('$(arrow-up) Push...'), description: '⇧⌘K', action: 'push', alwaysShow: true },
			{ label: vscode.l10n.t('$(add) New Branch...'), action: 'newBranch', alwaysShow: true },
			{ label: vscode.l10n.t('$(tag) Checkout Tag or Revision...'), action: 'checkoutRevision', alwaysShow: true },
		);
		const local = refs.filter((x) => x.type === 'head');
		const byName = new Map(local.map((x) => [x.shortName, x]));
		const branchItem = (x: RefInfo): BranchItem => {
			const fav = favorites.has(x.shortName);
			return {
				label: `${x.current ? '$(tag)' : x.type === 'remote' ? '$(cloud)' : x.type === 'tag' ? '$(tag)' : '$(git-branch)'} ${x.shortName}`,
				description: [x.current ? 'current' : '', x.upstream && x.type === 'head' ? `→ ${x.upstream}` : '', trackInfo(x)].filter(Boolean).join('  '),
				ref: x,
				buttons: x.type !== 'tag' ? [{ iconPath: fav ? STAR : STAR_EMPTY, tooltip: fav ? vscode.l10n.t('Remove from Favorites') : vscode.l10n.t('Add to Favorites') }] : [],
			};
		};
		const sortFav = (a: RefInfo, b: RefInfo) => Number(favorites.has(b.shortName)) - Number(favorites.has(a.shortName)) || Number(!!b.current) - Number(!!a.current) || a.shortName.localeCompare(b.shortName);
		const recentRefs = recent.map((n) => byName.get(n)).filter((x): x is RefInfo => !!x);
		if (recentRefs.length) {
			items.push({ label: vscode.l10n.t('Recent'), kind: vscode.QuickPickItemKind.Separator });
			items.push(...recentRefs.map(branchItem));
		}
		items.push({ label: vscode.l10n.t('Local'), kind: vscode.QuickPickItemKind.Separator });
		items.push(...local.sort(sortFav).map(branchItem));
		const remote = refs.filter((x) => x.type === 'remote').sort(sortFav);
		if (remote.length) {
			items.push({ label: vscode.l10n.t('Remote'), kind: vscode.QuickPickItemKind.Separator });
			items.push(...remote.map(branchItem));
		}
		const tags = refs.filter((x) => x.type === 'tag').sort((a, b) => b.shortName.localeCompare(a.shortName, undefined, { numeric: true }));
		if (tags.length) {
			items.push({ label: vscode.l10n.t('Tags'), kind: vscode.QuickPickItemKind.Separator });
			items.push(...tags.map(branchItem));
		}
		qp.title = current ? vscode.l10n.t('Git Branches · {0} · {1}', r.name, current) : r.state.head ? vscode.l10n.t('Git Branches · {0} · detached at {1}', r.name, shortHash(r.state.head)) : vscode.l10n.t('Git Branches · {0}', r.name);
		qp.placeholder = vscode.l10n.t('Search for branches and actions');
		qp.items = items;
	};
	await build(repo);
	qp.onDidTriggerItemButton(async (e) => {
		if (e.item.ref) {
			await toggleFavoriteBranch(repo!, e.item.ref.shortName);
			await build(repo!);
		}
	});
	qp.onDidAccept(async () => {
		const item = qp.selectedItems[0];
		if (!item) {
			return;
		}
		if (item.action === 'switchRepo') {
			const r = await services().repos.pick(vscode.l10n.t('Select repository'), false);
			if (r) {
				repo = r;
				await build(r);
			}
			qp.show();
			return;
		}
		qp.hide();
		const r = repo!;
		switch (item.action) {
			case 'update':
				return void vscode.commands.executeCommand('changeline.updateProject');
			case 'commit':
				return void vscode.commands.executeCommand('changeline.commit');
			case 'push':
				return void vscode.commands.executeCommand('changeline.push', r);
			case 'newBranch':
				return void newBranch(r);
			case 'checkoutRevision':
				return void checkoutRevision(r);
			case 'continue':
				return void vscode.commands.executeCommand('changeline.continueOperation', r);
			case 'abort':
				return void vscode.commands.executeCommand('changeline.abortOperation', r);
		}
		if (item.ref) {
			await branchActions(r, item.ref);
		}
	});
	qp.onDidHide(() => qp.dispose());
	qp.show();
}


/** Second level of the branches popup. */
export async function branchActions(repo: Repository, ref: RefInfo): Promise<void> {
	const current = repo.state.branch ?? 'HEAD';
	const name = ref.shortName;
	const items: (vscode.QuickPickItem & { id?: string })[] = [];
	const isCurrent = ref.type === 'head' && ref.current;
	if (!isCurrent) {
		items.push({ label: vscode.l10n.t('$(check) Checkout'), id: 'checkout' });
	}
	items.push({ label: vscode.l10n.t('$(add) New Branch from \'{0}\'...', name), id: 'newFrom' });
	if (!isCurrent) {
		if (ref.type !== 'tag') {
			items.push({ label: vscode.l10n.t('$(git-pull-request) Checkout and Rebase onto \'{0}\'', current), id: 'checkoutRebase' });
		}
		items.push(
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(git-compare) Compare with \'{0}\'', current), id: 'compare' },
			{ label: vscode.l10n.t('$(diff) Show Diff with Working Tree'), id: 'diffWorking' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(git-pull-request) Rebase \'{0}\' onto \'{1}\'', current, name), id: 'rebaseOnto' },
			{ label: vscode.l10n.t('$(git-merge) Merge \'{0}\' into \'{1}\'', name, current), id: 'merge' },
		);
	}
	if (ref.type === 'remote') {
		items.push({ label: vscode.l10n.t('$(arrow-down) Pull into \'{0}\' Using Rebase', current), id: 'pullRebase' }, { label: vscode.l10n.t('$(arrow-down) Pull into \'{0}\' Using Merge', current), id: 'pullMerge' });
	}
	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	if (ref.type === 'head') {
		if (ref.upstream) {
			items.push({ label: vscode.l10n.t('$(arrow-down) Update'), id: 'update' });
		}
		items.push({ label: vscode.l10n.t('$(arrow-up) Push...'), id: 'push' }, { label: vscode.l10n.t('$(edit) Rename...'), id: 'rename' }, { label: vscode.l10n.t('$(link) Edit Tracking...'), id: 'tracking' });
	}
	if (ref.type === 'tag') {
		items.push({ label: vscode.l10n.t('$(arrow-up) Push Tag'), id: 'pushTag' });
	}
	items.push({ label: vscode.l10n.t('$(history) Show in Log'), id: 'showInLog' }, { label: vscode.l10n.t('$(window) Show in New Log Tab'), id: 'newLogTab' });
	if (!isCurrent) {
		items.push({ label: vscode.l10n.t('$(trash) Delete'), id: 'delete' });
	}
	const choice = await vscode.window.showQuickPick(items, { title: ref.type === 'tag' ? vscode.l10n.t("Tag '{0}'", name) : ref.type === 'remote' ? vscode.l10n.t("Remote branch '{0}'", name) : vscode.l10n.t("Branch '{0}'", name), placeHolder: vscode.l10n.t('Choose an action') });
	if (!choice?.id) {
		return;
	}
	await runBranchAction(repo, ref, choice.id);
}

export async function runBranchAction(repo: Repository, ref: RefInfo, id: string): Promise<void> {
	const current = repo.state.branch ?? 'HEAD';
	const name = ref.type === 'tag' ? `refs/tags/${ref.shortName}` : ref.shortName;
	switch (id) {
		case 'checkout':
			if (ref.type === 'remote') {
				await checkoutRemoteBranch(repo, ref);
			} else if (ref.type === 'tag') {
				await checkoutRef(repo, name, { detach: true });
			} else {
				await checkoutRef(repo, ref.shortName);
			}
			return;
		case 'newFrom':
			return newBranch(repo, name, ref.type === 'remote' ? ref.shortName.slice((ref.remote?.length ?? 0) + 1) : undefined);
		case 'checkoutRebase': {
			const target = current;
			const branch = ref.type === 'remote' ? await ensureLocalFor(repo, ref) : ref.shortName;
			if (!branch) {
				return;
			}
			const outcome = await withSmartStash(repo, vscode.l10n.t('Rebase'), () => repo.rebase(target, { branch }));
			await handleOutcome(repo, outcome, vscode.l10n.t('Rebased {0} onto {1}', branch, target));
			return;
		}
		case 'compare':
			return ComparePanel.show({ repo, title: vscode.l10n.t('Compare {0} with {1}', current, ref.shortName), left: 'HEAD', right: name, leftLabel: current, rightLabel: ref.shortName, swappable: true, withCommits: true });
		case 'diffWorking':
			return ComparePanel.show({ repo, title: vscode.l10n.t('Diff between {0} and working tree', ref.shortName), left: name, right: undefined, leftLabel: ref.shortName, rightLabel: vscode.l10n.t('Working Tree') });
		case 'rebaseOnto': {
			const outcome = await withSmartStash(repo, vscode.l10n.t('Rebase'), () => repo.rebase(name));
			await handleOutcome(repo, outcome, vscode.l10n.t('Rebased {0} onto {1}', current, ref.shortName));
			return;
		}
		case 'merge': {
			const outcome = await withSmartStash(repo, vscode.l10n.t('Merge'), () => repo.merge(name));
			await handleOutcome(repo, outcome, vscode.l10n.t('Merged {0} into {1}', ref.shortName, current));
			return;
		}
		case 'pullRebase':
		case 'pullMerge': {
			const remote = ref.remote!;
			const branch = ref.shortName.slice(remote.length + 1);
			const outcome = await withSmartStash(repo, vscode.l10n.t('Pull'), () => repo.pull(remote, [branch], { rebase: id === 'pullRebase' }));
			await handleOutcome(repo, outcome, vscode.l10n.t('Pulled {0} into {1}', ref.shortName, current));
			return;
		}
		case 'update':
			return updateBranch(repo, ref);
		case 'push':
			if (!ref.current) {
				const { PushPanel } = await import('../webviews/pushPanel');
				await PushPanel.show({ repos: [repo], source: ref.shortName });
				return;
			}
			return void vscode.commands.executeCommand('changeline.push', repo);
		case 'rename':
			return renameBranch(repo, ref.shortName);
		case 'tracking':
			return editTracking(repo, ref);
		case 'pushTag': {
			const remote = await pickRemote(repo);
			if (remote) {
				await repo.pushTag(remote, ref.shortName);
				void vscode.window.showInformationMessage(vscode.l10n.t('Pushed tag {0} to {1}.', ref.shortName, remote));
			}
			return;
		}
		case 'showInLog':
			await vscode.commands.executeCommand('changeline.showLog', { repo: repo.root, hash: ref.hash });
			return;
		case 'newLogTab':
			await vscode.commands.executeCommand('changeline.showLogInNewTab', { repo: repo.root, branches: [name] });
			return;
		case 'delete':
			if (ref.type === 'tag') {
				return deleteTag(repo, ref.shortName);
			}
			if (ref.type === 'remote') {
				return deleteRemoteBranch(repo, ref);
			}
			return deleteBranch(repo, ref.shortName);
	}
}

/** Checkout with JetBrains' smart checkout and untracked-files handling. */
export async function checkoutRef(repo: Repository, ref: string, opts: { detach?: boolean; newBranch?: string; track?: boolean; force?: boolean; forceNewBranch?: boolean } = {}): Promise<boolean> {
	const run = () => repo.checkout(ref, opts);
	try {
		const done = await withSmartStash(repo, vscode.l10n.t('Checkout'), async () => {
			await run();
			return true;
		}, async () => {
			await repo.checkout(ref, { ...opts, force: true });
			return true;
		});
		if (done) {
			const target = opts.newBranch ?? ref.replace(/^refs\/tags\//, '');
			vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Checked out {0}', target), 4000);
		}
		return !!done;
	} catch (e) {
		if (e instanceof GitError && /untracked working tree files would be overwritten/.test(e.stderr)) {
			const files = await repo.getUntrackedOverwrittenFiles(e.stderr);
			const ok = await confirm(
				vscode.l10n.t('Untracked files would be overwritten by checkout:\n{0}{1}', files.slice(0, 15).join('\n'), files.length > 15 ? '\n…' : ''),
				vscode.l10n.t('Delete Files and Checkout'),
				vscode.l10n.t('The files are deleted from the working tree. This cannot be undone.'),
			);
			if (!ok) {
				return false;
			}
			for (const f of files) {
				await fs.promises.rm(repo.absolutePath(f), { force: true });
			}
			await run();
			return true;
		}
		throw e;
	}
}

async function ensureLocalFor(repo: Repository, ref: RefInfo): Promise<string | undefined> {
	const local = ref.shortName.slice((ref.remote?.length ?? 0) + 1);
	if (repo.refs.some((r) => r.type === 'head' && r.shortName === local)) {
		return local;
	}
	await repo.createBranch(local, ref.shortName);
	await repo.setUpstream(local, ref.shortName);
	return local;
}

export async function checkoutRemoteBranch(repo: Repository, ref: RefInfo): Promise<void> {
	const local = ref.shortName.slice((ref.remote?.length ?? 0) + 1);
	const existing = repo.refs.find((r) => r.type === 'head' && r.shortName === local);
	if (!existing) {
		await checkoutRef(repo, ref.shortName, { newBranch: local, track: true });
		return;
	}
	if (existing.hash === ref.hash) {
		await checkoutRef(repo, local);
		return;
	}
	const behind = await repo.isAncestor(existing.hash, ref.hash);
	const choice = await vscode.window.showWarningMessage(
		behind ? vscode.l10n.t('Local branch \'{0}\' already exists and is behind \'{1}\'.', local, ref.shortName) : vscode.l10n.t('Local branch \'{0}\' already exists and has diverged from \'{1}\'.', local, ref.shortName),
		{ modal: true },
		behind ? vscode.l10n.t('Checkout and Update') : vscode.l10n.t('Checkout and Rebase'),
		vscode.l10n.t('Checkout Local'),
		vscode.l10n.t('Reset Local to Remote'),
	);
	if (choice === vscode.l10n.t('Checkout Local')) {
		await checkoutRef(repo, local);
	} else if (choice === vscode.l10n.t('Checkout and Update')) {
		if (await checkoutRef(repo, local)) {
			await handleOutcome(repo, await repo.merge(ref.shortName, { fastForwardOnly: true }), vscode.l10n.t('Updated {0}', local));
		}
	} else if (choice === vscode.l10n.t('Checkout and Rebase')) {
		if (await checkoutRef(repo, local)) {
			await handleOutcome(repo, await repo.rebase(ref.shortName), vscode.l10n.t('Rebased {0} onto {1}', local, ref.shortName));
		}
	} else if (choice === vscode.l10n.t('Reset Local to Remote')) {
		await checkoutRef(repo, ref.shortName, { newBranch: local, track: true, forceNewBranch: true });
	}
}

export async function newBranch(repo: Repository, startPoint?: string, suggested?: string): Promise<void> {
	const base = startPoint ?? repo.state.branch ?? 'HEAD';
	const existing = new Set(repo.refs.filter((r) => r.type === 'head').map((r) => r.shortName));
	const result = await showDialog(
		{
			title: vscode.l10n.t('Create New Branch from {0}', base.replace(/^refs\/tags\//, '')),
			fields: [
				{ id: 'name', type: 'text', label: vscode.l10n.t('New branch name:'), value: suggested ?? '', required: true, focus: true },
				{ id: 'checkout', type: 'checkbox', label: vscode.l10n.t('Checkout branch'), value: true },
				{ id: 'overwrite', type: 'checkbox', label: vscode.l10n.t('Overwrite existing branch'), value: false },
			],
			okLabel: vscode.l10n.t('Create'),
			liveValidation: true,
			width: 520,
		},
		(v) => {
			const name = String(v.name ?? '').trim();
			if (!name) {
				return {};
			}
			const invalid = isValidBranchName(name);
			if (invalid) {
				return { name: invalid };
			}
			if (existing.has(name) && !v.overwrite) {
				return { name: vscode.l10n.t("Branch '{0}' already exists", name) };
			}
			return {};
		},
	);
	if (!result) {
		return;
	}
	const name = String(result.values.name).trim();
	const force = result.values.overwrite === true;
	if (result.values.checkout) {
		await checkoutRef(repo, startPoint ?? 'HEAD', { newBranch: name, forceNewBranch: force });
	} else {
		await repo.createBranch(name, startPoint, { force });
		void vscode.window.showInformationMessage(vscode.l10n.t('Branch \'{0}\' created.', name));
	}
}

export async function checkoutRevision(repo: Repository): Promise<void> {
	const refs = repo.refs;
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { ref?: string }>();
	qp.title = vscode.l10n.t('Checkout Tag or Revision');
	qp.placeholder = vscode.l10n.t('Enter a reference (branch, tag) or commit hash');
	const base: (vscode.QuickPickItem & { ref?: string })[] = [
		...refs.filter((r) => r.type === 'tag').map((r) => ({ label: `$(tag) ${r.shortName}`, ref: `refs/tags/${r.shortName}` })),
		...refs.filter((r) => r.type !== 'tag').map((r) => ({ label: `$(git-branch) ${r.shortName}`, ref: r.shortName })),
	];
	qp.items = base;
	qp.onDidChangeValue((v) => {
		qp.items = v.trim() ? [{ label: v.trim(), description: 'revision', ref: v.trim(), alwaysShow: true }, ...base] : base;
	});
	const picked = await new Promise<string | undefined>((resolve) => {
		qp.onDidAccept(() => {
			resolve(qp.selectedItems[0]?.ref ?? (qp.value.trim() || undefined));
			qp.hide();
		});
		qp.onDidHide(() => resolve(undefined));
		qp.show();
	});
	qp.dispose();
	if (!picked) {
		return;
	}
	const hash = await repo.revParse(picked);
	if (!hash) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Unknown revision \'{0}\'.', picked));
		return;
	}
	await checkoutRef(repo, picked, { detach: true });
}

export async function renameBranch(repo: Repository, oldName?: string): Promise<void> {
	const name = oldName ?? repo.state.branch;
	if (!name) {
		return;
	}
	const existing = new Set(repo.refs.filter((r) => r.type === 'head').map((r) => r.shortName));
	const newName = await vscode.window.showInputBox({
		title: vscode.l10n.t('Rename Branch \'{0}\'', name),
		prompt: vscode.l10n.t('New branch name'),
		value: name,
		valueSelection: [name.lastIndexOf('/') + 1, name.length],
		validateInput: (v) => (v.trim() === name ? undefined : isValidBranchName(v.trim()) ?? (existing.has(v.trim()) ? vscode.l10n.t("Branch '{0}' already exists", v.trim()) : undefined)),
	});
	if (!newName || newName.trim() === name) {
		return;
	}
	await repo.renameBranch(name, newName.trim());
	void vscode.window.showInformationMessage(vscode.l10n.t('Branch \'{0}\' renamed to \'{1}\'.', name, newName.trim()));
}

export async function deleteBranch(repo: Repository, name: string): Promise<void> {
	const ref = repo.refs.find((r) => r.type === 'head' && r.shortName === name);
	if (!ref) {
		return;
	}
	if (ref.current) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Cannot delete the current branch \'{0}\'. Checkout another branch first.', name));
		return;
	}
	const hash = ref.hash;
	try {
		await repo.deleteBranch(name, false);
	} catch (e) {
		if (e instanceof GitError && /not fully merged/.test(e.stderr)) {
			const ok = await confirm(vscode.l10n.t('Branch \'{0}\' is not fully merged.', name), vscode.l10n.t('Delete Anyway'), vscode.l10n.t('Commits only reachable from \'{0}\' will be lost (they can be restored right after deleting).', name));
			if (!ok) {
				return;
			}
			await repo.deleteBranch(name, true);
		} else {
			throw e;
		}
	}
	const buttons = [vscode.l10n.t('Restore')];
	if (ref.upstream) {
		buttons.push(vscode.l10n.t('Delete Tracked Branch'));
	}
	void vscode.window.showInformationMessage(vscode.l10n.t('Deleted branch {0}', name), ...buttons).then(async (c) => {
		if (c === vscode.l10n.t('Restore')) {
			await repo.createBranch(name, hash);
			if (ref.upstream) {
				await repo.setUpstream(name, ref.upstream);
			}
			void vscode.window.showInformationMessage(vscode.l10n.t('Restored branch {0}', name));
		} else if (c === vscode.l10n.t('Delete Tracked Branch') && ref.upstream) {
			const [remote, ...rest] = ref.upstream.split('/');
			await repo.deleteRemoteBranch(remote, rest.join('/'));
			void vscode.window.showInformationMessage(vscode.l10n.t('Deleted remote branch {0}', ref.upstream));
		}
	});
}

export async function deleteRemoteBranch(repo: Repository, ref: RefInfo): Promise<void> {
	const remote = ref.remote!;
	const branch = ref.shortName.slice(remote.length + 1);
	const tracking = repo.refs.filter((r) => r.type === 'head' && r.upstream === ref.shortName);
	const ok = await confirm(vscode.l10n.t('Delete remote branch \'{0}\'?', ref.shortName), vscode.l10n.t('Delete'), tracking.length ? vscode.l10n.t('Tracked by local {0}: {1}', plural(tracking.length, '{0} branch', '{0} branches'), tracking.map((t) => t.shortName).join(', ')) : undefined);
	if (!ok) {
		return;
	}
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Deleting {0}...', ref.shortName) }, () => repo.deleteRemoteBranch(remote, branch));
	void vscode.window.showInformationMessage(vscode.l10n.t('Deleted remote branch {0}', ref.shortName));
}

export async function deleteTag(repo: Repository, tag: string): Promise<void> {
	if (!(await confirm(vscode.l10n.t('Delete tag \'{0}\'?', tag), vscode.l10n.t('Delete')))) {
		return;
	}
	const hash = repo.refs.find((r) => r.type === 'tag' && r.shortName === tag)?.hash;
	await repo.deleteTag(tag);
	void vscode.window.showInformationMessage(vscode.l10n.t('Deleted tag {0}', tag), vscode.l10n.t('Restore'), vscode.l10n.t('Delete on Remote')).then(async (c) => {
		if (c === vscode.l10n.t('Restore') && hash) {
			await repo.createTag(tag, hash);
		} else if (c === vscode.l10n.t('Delete on Remote')) {
			const remote = await pickRemote(repo);
			if (remote) {
				await repo.pushTag(remote, tag, true);
			}
		}
	});
}

export async function newTag(repo: Repository, ref = 'HEAD'): Promise<void> {
	const existing = new Set(repo.refs.filter((r) => r.type === 'tag').map((r) => r.shortName));
	const result = await showDialog(
		{
			title: vscode.l10n.t('Create New Tag'),
			description: vscode.l10n.t('Tag commit {0}', ref === 'HEAD' ? `HEAD (${repo.state.branch ?? shortHash(repo.state.head ?? '')})` : shortHash(ref)),
			fields: [
				{ id: 'name', type: 'text', label: vscode.l10n.t('Tag name:'), required: true, focus: true },
				{ id: 'force', type: 'checkbox', label: vscode.l10n.t('Force (replace an existing tag)'), value: false },
				{ id: 'message', type: 'textarea', label: vscode.l10n.t('Message (creates an annotated tag):'), rows: 4 },
			],
			okLabel: vscode.l10n.t('Create Tag'),
			liveValidation: true,
			width: 520,
		},
		(v) => {
			const name = String(v.name ?? '').trim();
			if (!name) {
				return {};
			}
			if (isValidBranchName(name)) {
				return { name: vscode.l10n.t("'{0}' is not a valid tag name", name) };
			}
			if (existing.has(name) && !v.force) {
				return { name: vscode.l10n.t("Tag '{0}' already exists", name) };
			}
			return {};
		},
	);
	if (!result) {
		return;
	}
	const name = String(result.values.name).trim();
	await repo.createTag(name, ref, String(result.values.message ?? '').trim() || undefined, result.values.force === true);
	void vscode.window.showInformationMessage(vscode.l10n.t('Created tag {0}', name), vscode.l10n.t('Push Tag')).then(async (c) => {
		if (c) {
			const remote = await pickRemote(repo);
			if (remote) {
				await repo.pushTag(remote, name);
				void vscode.window.showInformationMessage(vscode.l10n.t('Pushed tag {0} to {1}', name, remote));
			}
		}
	});
}

export async function pickRemote(repo: Repository): Promise<string | undefined> {
	const remotes = await repo.getRemotes();
	if (!remotes.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured.'));
		return undefined;
	}
	if (remotes.length === 1) {
		return remotes[0].name;
	}
	return (await vscode.window.showQuickPick(remotes.map((r) => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl }))))?.label;
}

async function editTracking(repo: Repository, ref: RefInfo): Promise<void> {
	const remotes = repo.refs.filter((r) => r.type === 'remote');
	const items: (vscode.QuickPickItem & { value?: string | null })[] = [
		...remotes.map((r) => ({ label: r.shortName, description: r.shortName === ref.upstream ? 'current' : undefined, value: r.shortName })),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: vscode.l10n.t('$(close) Do not track'), value: null },
	];
	const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Tracked branch for \'{0}\'', ref.shortName), placeHolder: ref.upstream ? vscode.l10n.t('Currently tracking {0}', ref.upstream) : vscode.l10n.t('Not tracking a remote branch') });
	if (!pick || pick.value === undefined) {
		return;
	}
	await repo.setUpstream(ref.shortName, pick.value ?? undefined);
}

/** Fast-forwards a (non-current) branch to its upstream or updates the current one. */
async function updateBranch(repo: Repository, ref: RefInfo): Promise<void> {
	if (ref.current) {
		await vscode.commands.executeCommand('changeline.updateProject', repo);
		return;
	}
	const [remote, ...rest] = ref.upstream!.split('/');
	const remoteBranch = rest.join('/');
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Updating {0}...', ref.shortName) }, async () => {
		await repo.fetch(remote, { refspec: `${remoteBranch}:${ref.shortName}` }).catch(async (e) => {
			if (e instanceof GitError && /non-fast-forward|rejected/.test(e.stderr)) {
				void vscode.window.showWarningMessage(vscode.l10n.t('\'{0}\' has diverged from \'{1}\' and cannot be fast-forwarded. Checkout it and update.', ref.shortName, ref.upstream ?? ''));
				return;
			}
			throw e;
		});
	});
	await repo.refresh();
	void vscode.window.showInformationMessage(vscode.l10n.t('Updated {0}', ref.shortName));
}

/** VCS > Git > Merge... dialog. */
export async function mergeDialog(repo: Repository): Promise<void> {
	const current = repo.state.branch ?? 'HEAD';
	const branches = repo.refs.filter((r) => r.type !== 'tag' && !r.current);
	const result = await showDialog({
		title: vscode.l10n.t('Merge into {0}', current),
		fields: [
			{ id: 'branch', type: 'combo', label: vscode.l10n.t('Branch to merge:'), options: branches.map((b) => ({ value: b.shortName, label: b.shortName })), required: true, focus: true },
			{ id: 'noff', type: 'checkbox', label: vscode.l10n.t('Create a merge commit (--no-ff)') },
			{ id: 'ffonly', type: 'checkbox', label: vscode.l10n.t('Fast-forward only (--ff-only)') },
			{ id: 'squash', type: 'checkbox', label: vscode.l10n.t('Squash commits (--squash)') },
			{ id: 'nocommit', type: 'checkbox', label: vscode.l10n.t('Do not commit (--no-commit)') },
			{ id: 'noverify', type: 'checkbox', label: vscode.l10n.t('Bypass pre-merge and commit-msg hooks (--no-verify)') },
			{ id: 'unrelated', type: 'checkbox', label: vscode.l10n.t('Allow unrelated histories (--allow-unrelated-histories)') },
			{ id: 'setMessage', type: 'checkbox', label: vscode.l10n.t('Specify commit message (-m)') },
			{ id: 'message', type: 'textarea', label: vscode.l10n.t('Commit message:'), rows: 4, visibleWhen: 'setMessage' },
		],
		okLabel: vscode.l10n.t('Merge'),
	});
	if (!result) {
		return;
	}
	const v = result.values;
	const branch = String(v.branch).trim();
	const outcome = await withSmartStash(repo, vscode.l10n.t('Merge'), () =>
		repo.merge(branch, {
			noFastForward: v.noff === true,
			fastForwardOnly: v.ffonly === true,
			squash: v.squash === true,
			noCommit: v.nocommit === true,
			noVerify: v.noverify === true,
			allowUnrelated: v.unrelated === true,
			message: v.setMessage ? String(v.message ?? '').trim() || undefined : undefined,
		}),
	);
	if (await handleOutcome(repo, outcome, vscode.l10n.t('Merged {0} into {1}', branch, current))) {
		if (v.squash || v.nocommit) {
			void vscode.commands.executeCommand('changeline.commit');
		}
	}
}

/** VCS > Git > Rebase... dialog. */
export async function rebaseDialog(repo: Repository): Promise<void> {
	const current = repo.state.branch ?? 'HEAD';
	const refs = repo.refs.filter((r) => !r.current);
	const result = await showDialog({
		title: vscode.l10n.t('Rebase {0}', current),
		fields: [
			{ id: 'onto', type: 'combo', label: vscode.l10n.t('Onto:'), options: refs.map((b) => ({ value: b.type === 'tag' ? `refs/tags/${b.shortName}` : b.shortName, label: b.shortName })), required: true, focus: true },
			{ id: 'interactive', type: 'checkbox', label: vscode.l10n.t('Interactive (--interactive)') },
			{ id: 'rebaseMerges', type: 'checkbox', label: vscode.l10n.t('Rebase merges (--rebase-merges)') },
			{ id: 'keepEmpty', type: 'checkbox', label: vscode.l10n.t('Keep empty commits (--keep-empty)') },
			{ id: 'updateRefs', type: 'checkbox', label: vscode.l10n.t('Update refs (--update-refs)') },
			{ id: 'useOnto', type: 'checkbox', label: vscode.l10n.t('Select another base (--onto)') },
			{ id: 'newBase', type: 'combo', label: vscode.l10n.t('New base:'), options: refs.map((b) => ({ value: b.shortName, label: b.shortName })), visibleWhen: 'useOnto' },
		],
		okLabel: vscode.l10n.t('Rebase'),
	});
	if (!result) {
		return;
	}
	const v = result.values;
	const onto = String(v.onto).trim();
	if (v.interactive) {
		const base = await repo.mergeBase('HEAD', onto);
		await vscode.commands.executeCommand('changeline.interactiveRebase', { repo: repo.root, base: base, onto });
		return;
	}
	const outcome = await withSmartStash(repo, vscode.l10n.t('Rebase'), () =>
		repo.rebase(onto, {
			rebaseMerges: v.rebaseMerges === true,
			keepEmpty: v.keepEmpty === true,
			updateRefs: v.updateRefs === true,
			newBase: v.useOnto ? String(v.newBase ?? '').trim() || undefined : undefined,
		}),
	);
	await handleOutcome(repo, outcome, vscode.l10n.t('Rebased {0} onto {1}', current, onto));
}

export async function resetDialog(repo: Repository, ref = 'HEAD', label?: string): Promise<void> {
	const result = await showDialog({
		title: vscode.l10n.t('Git Reset'),
		description: vscode.l10n.t('Reset {0} to {1}', repo.state.branch ?? 'HEAD', label ?? ref),
		fields: [
			...(ref === 'HEAD' && !label ? [{ id: 'ref', type: 'text' as const, label: vscode.l10n.t('To commit:'), value: 'HEAD', required: true, focus: true }] : []),
			{
				id: 'mode',
				type: 'radio',
				label: vscode.l10n.t('Reset type:'),
				value: 'mixed',
				options: [
					{ value: 'soft', label: vscode.l10n.t('Soft'), description: vscode.l10n.t('Files will not change, differences will be staged for commit.') },
					{ value: 'mixed', label: vscode.l10n.t('Mixed'), description: vscode.l10n.t('Files will not change, differences will not be staged.') },
					{ value: 'hard', label: vscode.l10n.t('Hard'), description: vscode.l10n.t('Files will be reverted to the state of the selected commit. Local changes will be lost.') },
					{ value: 'keep', label: vscode.l10n.t('Keep'), description: vscode.l10n.t('Files will be reverted to the state of the selected commit, but local changes will be kept intact.') },
				],
			},
		],
		okLabel: vscode.l10n.t('Reset'),
	});
	if (!result) {
		return;
	}
	const target = String(result.values.ref ?? ref).trim();
	const mode = result.values.mode as 'soft' | 'mixed' | 'hard' | 'keep';
	if (mode === 'hard' && (repo.state.changes.length || repo.state.staged.length)) {
		if (!(await confirm(vscode.l10n.t('Hard reset discards all local changes.'), vscode.l10n.t('Reset')))) {
			return;
		}
	}
	const before = repo.state.head;
	await repo.reset(target, mode);
	void vscode.window.showInformationMessage(vscode.l10n.t('Reset {0} to {1}', repo.state.branch ?? 'HEAD', label ?? target), ...(before ? [vscode.l10n.t('Undo')] : [])).then(async (c) => {
		if (c === vscode.l10n.t('Undo') && before) {
			await repo.reset(before, mode === 'hard' ? 'hard' : 'soft');
		}
	});
}

export function registerBranchCommands(ctx: CommandContext): void {
	ctx.register('changeline.branches', (arg?: unknown) => showBranchesPopup(arg));
	ctx.register('changeline.newBranch', async (arg?: unknown) => {
		if (!arg && services().repos.repositories.length > 1 && config('branches.syncControl', true)) {
			const { newBranchInAll } = await import('./multiBranch');
			await newBranchInAll([...services().repos.repositories]);
			return;
		}
		const repo = await resolveRepo(arg);
		if (repo) {
			await newBranch(repo, (arg as { startPoint?: string })?.startPoint);
		}
	});
	ctx.register('changeline.checkoutRevision', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await checkoutRevision(repo);
		}
	});
	ctx.register('changeline.newTag', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await newTag(repo);
		}
	});
	ctx.register('changeline.merge', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await mergeDialog(repo);
		}
	});
	ctx.register('changeline.rebase', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await rebaseDialog(repo);
		}
	});
	ctx.register('changeline.resetHead', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await resetDialog(repo);
		}
	});
	ctx.register('changeline.renameBranch', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await renameBranch(repo);
		}
	});
	ctx.register('changeline.deleteBranch', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (!repo) {
			return;
		}
		const pick = await vscode.window.showQuickPick(repo.refs.filter((r) => r.type === 'head' && !r.current).map((r) => ({ label: r.shortName })), { placeHolder: vscode.l10n.t('Branch to delete') });
		if (pick) {
			await deleteBranch(repo, pick.label);
		}
	});

	const fromLog = (id: string) => async (ctxArg: { logId: string; ref: string; refType: string }) => {
		const repo = LogController.get(ctxArg.logId)?.repo;
		if (!repo) {
			return;
		}
		if (ctxArg.ref === 'HEAD') {
			if (id === 'newFrom') {
				return newBranch(repo);
			}
			if (id === 'push') {
				return void vscode.commands.executeCommand('changeline.push', repo);
			}
			if (id === 'update') {
				return void vscode.commands.executeCommand('changeline.updateProject', repo);
			}
			return;
		}
		const ref = repo.refs.find((r) => r.shortName === ctxArg.ref && r.type === ctxArg.refType);
		if (ref) {
			if (id === 'favorite') {
				return toggleFavoriteBranch(repo, ref.shortName);
			}
			await runBranchAction(repo, ref, id);
		}
	};
	for (const id of ['checkout', 'newFrom', 'checkoutRebase', 'compare', 'diffWorking', 'rebaseOnto', 'merge', 'pullRebase', 'pullMerge', 'update', 'push', 'rename', 'tracking', 'delete', 'pushTag', 'favorite', 'newLogTab']) {
		ctx.register(`changeline.logBranch.${id}`, fromLog(id));
	}
}
