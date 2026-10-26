import * as vscode from 'vscode';
import { GitError } from '../git/gitCli';
import type { OperationOutcome, Repository } from '../git/repository';
import { services } from '../services';
import type { RefInfo, RefType } from '../shared/types';
import { config, isValidBranchName, plural } from '../util';
import { ComparePanel } from '../webviews/comparePanel';
import { showDialog } from '../webviews/dialogPanel';
import { showBranchesPopup } from './branches';
import { checkoutRef, checkoutRemoteBranch } from './branches';
import { confirm, withSmartStash } from './common';

export interface CommonRef {
	name: string;
	type: RefType;
	refs: Map<Repository, RefInfo>;
}

export function syncControlEnabled(): boolean {
	return services().repos.repositories.length > 1 && config('branches.syncControl', true);
}

/** Refs that exist (by short name and type) in every repository. */
export async function commonRefs(repos: readonly Repository[]): Promise<CommonRef[]> {
	const perRepo = await Promise.all(repos.map((r) => r.getRefs()));
	const map = new Map<string, CommonRef>();
	perRepo.forEach((refs, i) => {
		for (const ref of refs) {
			const key = `${ref.type}:${ref.shortName}`;
			let c = map.get(key);
			if (!c) {
				c = { name: ref.shortName, type: ref.type, refs: new Map() };
				map.set(key, c);
			}
			c.refs.set(repos[i], ref);
		}
	});
	return [...map.values()].filter((c) => c.refs.size === repos.length).sort((a, b) => a.name.localeCompare(b.name));
}

export async function showMultiRepoBranchesPopup(): Promise<void> {
	const repos = [...services().repos.repositories];
	await Promise.all(repos.map((r) => r.refresh()));
	const common = await commonRefs(repos);
	type Item = vscode.QuickPickItem & { action?: string; repo?: Repository; common?: CommonRef };
	const branchesOf = repos.map((r) => r.state.branch ?? 'detached');
	const sameBranch = branchesOf.every((b) => b === branchesOf[0]);
	const items: Item[] = [
		{ label: vscode.l10n.t('$(arrow-down) Update Project...'), description: '⌘T', action: 'update', alwaysShow: true },
		{ label: vscode.l10n.t('$(check) Commit...'), description: '⌘K', action: 'commit', alwaysShow: true },
		{ label: vscode.l10n.t('$(arrow-up) Push...'), description: '⇧⌘K', action: 'push', alwaysShow: true },
		{ label: vscode.l10n.t('$(add) New Branch...'), description: vscode.l10n.t('in all {0} repositories', repos.length), action: 'newBranch', alwaysShow: true },
		{ label: vscode.l10n.t('Repositories'), kind: vscode.QuickPickItemKind.Separator },
		...repos.map((r) => ({ label: `$(repo) ${r.name}`, description: `${r.state.branch ?? 'detached'}  ›`, detail: undefined, action: 'repo', repo: r, alwaysShow: true })),
	];
	const label = (c: CommonRef) => {
		const currentIn = [...c.refs.values()].filter((r) => r.current).length;
		const ahead = [...c.refs.values()].reduce((n, r) => n + (r.ahead ?? 0), 0);
		const behind = [...c.refs.values()].reduce((n, r) => n + (r.behind ?? 0), 0);
		const parts = [currentIn === repos.length ? 'current' : currentIn ? `current in ${currentIn} of ${repos.length}` : ''];
		if (behind) {
			parts.push(`↓${behind}`);
		}
		if (ahead) {
			parts.push(`↑${ahead}`);
		}
		return parts.filter(Boolean).join('  ');
	};
	const section = (title: string, type: RefType, icon: string) => {
		const list = common.filter((c) => c.type === type);
		if (list.length) {
			items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
			items.push(...list.map((c) => ({ label: `$(${icon}) ${c.name}`, description: label(c), common: c })));
		}
	};
	section(vscode.l10n.t('Common Local Branches'), 'head', 'git-branch');
	section(vscode.l10n.t('Common Remote Branches'), 'remote', 'cloud');
	section(vscode.l10n.t('Common Tags'), 'tag', 'tag');
	const pick = await vscode.window.showQuickPick(items, {
		title: sameBranch
			? vscode.l10n.t('Git Branches · {0} repositories · {1} · synchronous branch control', repos.length, branchesOf[0])
			: vscode.l10n.t('Git Branches · {0} repositories · synchronous branch control', repos.length),
		placeHolder: vscode.l10n.t('Branch operations are executed in all repositories'),
		matchOnDescription: true,
	});
	if (!pick) {
		return;
	}
	switch (pick.action) {
		case 'update':
			return void vscode.commands.executeCommand('changeline.updateProject');
		case 'commit':
			return void vscode.commands.executeCommand('changeline.commit');
		case 'push':
			return void vscode.commands.executeCommand('changeline.push');
		case 'newBranch':
			return newBranchInAll(repos);
		case 'repo':
			return showBranchesPopup(pick.repo, true);
	}
	if (pick.common) {
		await commonRefActions(repos, pick.common);
	}
}

async function commonRefActions(repos: Repository[], c: CommonRef): Promise<void> {
	const allCurrent = [...c.refs.values()].every((r) => r.current);
	const items: (vscode.QuickPickItem & { id?: string })[] = [];
	if (!allCurrent) {
		items.push({ label: vscode.l10n.t('$(check) Checkout'), id: 'checkout' });
	}
	items.push({ label: vscode.l10n.t('$(add) New Branch from \'{0}\'...', c.name), id: 'newFrom' });
	if (!allCurrent) {
		items.push(
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(git-compare) Compare with Current'), id: 'compare' },
			{ label: vscode.l10n.t('$(git-pull-request) Rebase Current onto \'{0}\'', c.name), id: 'rebaseOnto' },
			{ label: vscode.l10n.t('$(git-merge) Merge \'{0}\' into Current', c.name), id: 'merge' },
		);
	}
	if (c.type === 'remote') {
		items.push({ label: vscode.l10n.t('$(arrow-down) Pull into Current Using Rebase'), id: 'pullRebase' }, { label: vscode.l10n.t('$(arrow-down) Pull into Current Using Merge'), id: 'pullMerge' });
	}
	if (c.type === 'head') {
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: vscode.l10n.t('$(edit) Rename...'), id: 'rename' });
		if (!allCurrent) {
			items.push({ label: vscode.l10n.t('$(trash) Delete'), id: 'delete' });
		}
	}
	const choice = await vscode.window.showQuickPick(items, { title: `'${c.name}' in ${plural(repos.length, '{0} repository', '{0} repositories')}` });
	if (choice?.id) {
		await runCommonAction(repos, c, choice.id);
	}
}

export async function runCommonAction(repos: Repository[], c: CommonRef, id: string): Promise<void> {
	const refName = c.type === 'tag' ? `refs/tags/${c.name}` : c.name;
	const outcomes: { repo: Repository; outcome?: OperationOutcome }[] = [];
	const forEach = async (title: string, fn: (repo: Repository, ref: RefInfo) => Promise<OperationOutcome | void | undefined | boolean>) => {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (progress) => {
			for (const repo of repos) {
				progress.report({ message: repo.name });
				try {
					const r = await fn(repo, c.refs.get(repo)!);
					outcomes.push({ repo, outcome: r && typeof r === 'object' ? r : undefined });
				} catch (e) {
					void vscode.window.showErrorMessage(`${repo.name}: ${e instanceof GitError ? e.summary : (e as Error).message}`);
				}
			}
		});
	};
	switch (id) {
		case 'checkout':
			await forEach(vscode.l10n.t('Checking out {0}...', c.name), (repo, ref) => (ref.type === 'remote' ? checkoutRemoteBranch(repo, ref) : checkoutRef(repo, refName, { detach: ref.type === 'tag' })));
			break;
		case 'newFrom':
			await newBranchInAll(repos, refName);
			return;
		case 'compare':
			for (const repo of repos) {
				await ComparePanel.show({ repo, title: vscode.l10n.t('{0}: compare {1} with {2}', repo.name, repo.state.branch ?? 'HEAD', c.name), left: 'HEAD', right: refName, leftLabel: repo.state.branch ?? 'HEAD', rightLabel: c.name, swappable: true, withCommits: true });
			}
			return;
		case 'rebaseOnto':
			await forEach(vscode.l10n.t('Rebasing onto {0}...', c.name), (repo) => withSmartStash(repo, vscode.l10n.t('Rebase'), () => repo.rebase(refName)));
			break;
		case 'merge':
			await forEach(vscode.l10n.t('Merging {0}...', c.name), (repo) => withSmartStash(repo, vscode.l10n.t('Merge'), () => repo.merge(refName)));
			break;
		case 'pullRebase':
		case 'pullMerge':
			await forEach(vscode.l10n.t('Pulling {0}...', c.name), (repo, ref) => withSmartStash(repo, vscode.l10n.t('Pull'), () => repo.pull(ref.remote!, [ref.shortName.slice(ref.remote!.length + 1)], { rebase: id === 'pullRebase' })));
			break;
		case 'rename': {
			const newName = await vscode.window.showInputBox({
				title: vscode.l10n.t('Rename \'{0}\' in all repositories', c.name),
				value: c.name,
				validateInput: (v) => (v.trim() === c.name ? undefined : isValidBranchName(v.trim()) ?? (repos.some((r) => r.refs.some((x) => x.type === 'head' && x.shortName === v.trim())) ? vscode.l10n.t("Branch '{0}' already exists", v.trim()) : undefined)),
			});
			if (!newName || newName.trim() === c.name) {
				return;
			}
			await forEach(vscode.l10n.t('Renaming...'), (repo) => repo.renameBranch(c.name, newName.trim()));
			break;
		}
		case 'delete': {
			if (!(await confirm(vscode.l10n.t('Delete branch \'{0}\' in {1}?', c.name, plural(repos.length, '{0} repository', '{0} repositories')), vscode.l10n.t('Delete')))) {
				return;
			}
			const unmerged: Repository[] = [];
			await forEach(vscode.l10n.t('Deleting {0}...', c.name), async (repo) => {
				try {
					await repo.deleteBranch(c.name, false);
				} catch (e) {
					if (e instanceof GitError && /not fully merged/.test(e.stderr)) {
						unmerged.push(repo);
						return;
					}
					throw e;
				}
			});
			if (unmerged.length && (await confirm(vscode.l10n.t('\'{0}\' is not fully merged in {1}.', c.name, unmerged.map((r) => r.name).join(', ')), vscode.l10n.t('Delete Anyway')))) {
				for (const r of unmerged) {
					await r.deleteBranch(c.name, true);
				}
			}
			break;
		}
	}
	const conflicts = outcomes.filter((o) => o.outcome?.conflicts);
	const failed = outcomes.filter((o) => o.outcome && !o.outcome.ok && !o.outcome.conflicts);
	for (const f of failed) {
		void vscode.window.showErrorMessage(`${f.repo.name}: ${f.outcome!.error?.summary ?? f.outcome!.output.trim().split('\n')[0]}`);
	}
	if (conflicts.length) {
		void vscode.commands.executeCommand('changeline.resolveConflicts');
	} else if (!failed.length && outcomes.length) {
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Done in {0}', plural(outcomes.length, '{0} repository', '{0} repositories')), 4000);
	}
}

export async function newBranchInAll(repos: Repository[], startPoint?: string): Promise<void> {
	const result = await showDialog(
		{
			title: startPoint ? vscode.l10n.t('Create New Branch from {0} in {1} Repositories', startPoint.replace(/^refs\/tags\//, ''), repos.length) : vscode.l10n.t('Create New Branch in {0} Repositories', repos.length),
			description: repos.map((r) => `${r.name} (${r.state.branch ?? 'detached'})`).join(', '),
			fields: [
				{ id: 'name', type: 'text', label: vscode.l10n.t('New branch name:'), required: true, focus: true },
				{ id: 'checkout', type: 'checkbox', label: vscode.l10n.t('Checkout branch'), value: true },
				{ id: 'overwrite', type: 'checkbox', label: vscode.l10n.t('Overwrite existing branch'), value: false },
			],
			okLabel: vscode.l10n.t('Create'),
			liveValidation: true,
			width: 560,
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
			const existing = repos.filter((r) => r.refs.some((x) => x.type === 'head' && x.shortName === name));
			if (existing.length && !v.overwrite) {
				return { name: vscode.l10n.t("Branch '{0}' already exists in {1}", name, existing.map((r) => r.name).join(', ')) };
			}
			return {};
		},
	);
	if (!result) {
		return;
	}
	const name = String(result.values.name).trim();
	const force = result.values.overwrite === true;
	for (const repo of repos) {
		try {
			if (result.values.checkout) {
				await checkoutRef(repo, startPoint ?? 'HEAD', { newBranch: name, forceNewBranch: force });
			} else {
				await repo.createBranch(name, startPoint, { force });
			}
		} catch (e) {
			void vscode.window.showErrorMessage(`${repo.name}: ${e instanceof GitError ? e.summary : (e as Error).message}`);
		}
	}
	void vscode.window.showInformationMessage(vscode.l10n.t('Branch \'{0}\' created in {1}.', name, plural(repos.length, '{0} repository', '{0} repositories')));
}
