import * as vscode from 'vscode';
import { commitFileTarget, openDiff } from '../diff';
import type { PushParams, Repository } from '../git/repository';
import { services } from '../services';
import type { CommitInfo } from '../shared/types';
import { config, errorMessage, plural, showError } from '../util';
import { RpcHandlers, WebviewPanelBase } from './host';

interface PushTarget {
	root: string;
	name: string;
	branch?: string;
	source: string;
	sourceLabel: string;
	remotes: string[];
	remote?: string;
	remoteBranch: string;
	exists: boolean;
	hasUpstream: boolean;
	commits: CommitInfo[];
	selected: boolean;
	error?: string;
}

export interface PushRequest {
	repos: Repository[];
	source?: string;
}

async function buildTarget(repo: Repository, source?: string, remote?: string, remoteBranch?: string): Promise<PushTarget> {
	const st = repo.state;
	const remotes = (await repo.getRemotes()).map((r) => r.name);
	const branch = st.branch;
	let upstreamRemote: string | undefined;
	let upstreamBranch: string | undefined;
	if (st.upstream) {
		const i = st.upstream.indexOf('/');
		upstreamRemote = st.upstream.slice(0, i);
		upstreamBranch = st.upstream.slice(i + 1);
	}
	const pushDefault = branch ? await repo.getConfig(`branch.${branch}.pushRemote`) ?? (await repo.getConfig('remote.pushDefault')) : undefined;
	const r = remote ?? pushDefault ?? upstreamRemote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
	const rb = remoteBranch ?? (upstreamRemote === r && upstreamBranch ? upstreamBranch : branch ?? 'main');
	const target: PushTarget = {
		root: repo.root,
		name: repo.name,
		branch,
		source: source ?? 'HEAD',
		sourceLabel: source ? source.slice(0, 8) : branch ?? 'HEAD',
		remotes,
		remote: r,
		remoteBranch: rb,
		exists: false,
		hasUpstream: !!st.upstream,
		commits: [],
		selected: true,
	};
	if (!r) {
		target.error = vscode.l10n.t('No remotes defined. Use "Define remote" to add one.');
		target.selected = false;
		return target;
	}
	target.exists = await repo.refExists(`refs/remotes/${r}/${rb}`);
	try {
		target.commits = await repo.getOutgoingCommits(target.source, r, rb);
	} catch (e) {
		target.error = errorMessage(e);
	}
	if (!target.commits.length && target.exists) {
		target.selected = false;
	}
	return target;
}

export class PushPanel extends WebviewPanelBase {
	private static current?: PushPanel;
	private targets: PushTarget[] = [];

	static async show(req: PushRequest): Promise<void> {
		PushPanel.current?.dispose();
		const targets = await Promise.all(req.repos.map((r) => buildTarget(r, req.source)));
		PushPanel.current = new PushPanel(targets);
	}

	private constructor(targets: PushTarget[]) {
		super(services().context.extensionUri, 'changeline.push', targets.length === 1 ? vscode.l10n.t('Push Commits to {0}', targets[0].name) : vscode.l10n.t('Push Commits'), 'push', null, vscode.ViewColumn.Active);
		this.targets = targets;
	}

	private repo(root: string): Repository {
		const r = services().repos.getByRoot(root);
		if (!r) {
			throw new Error(vscode.l10n.t('Repository not found'));
		}
		return r;
	}

	protected handlers(): RpcHandlers {
		return {
			ready: () => ({
				targets: this.targets,
				protectedBranches: config<string[]>('push.protectedBranches', ['master', 'main']),
				pushTags: services().context.workspaceState.get('changeline.push.tags', 'none'),
				runHooks: services().context.workspaceState.get('changeline.push.runHooks', true),
			}),
			retarget: async (p: { root: string; remote: string; remoteBranch: string }) => {
				const idx = this.targets.findIndex((t) => t.root === p.root);
				const old = this.targets[idx];
				const t = await buildTarget(this.repo(p.root), old.source === 'HEAD' ? undefined : old.source, p.remote, p.remoteBranch);
				t.selected = old.selected || t.commits.length > 0;
				this.targets[idx] = t;
				return t;
			},
			files: async (p: { root: string; hash: string }) => {
				const repo = this.repo(p.root);
				const c = await repo.getCommit(p.hash);
				return repo.getCommitFiles(c.hash, c.parents);
			},
			diff: async (p: { root: string; hash: string; path: string }) => {
				const repo = this.repo(p.root);
				const c = await repo.getCommit(p.hash);
				const files = await repo.getCommitFiles(c.hash, c.parents);
				await openDiff({ targets: files.map((f) => commitFileTarget(repo, c, f)), index: Math.max(0, files.findIndex((f) => f.path === p.path)) });
			},
			defineRemote: async (p: { root: string }) => {
				const url = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Remote URL'), placeHolder: vscode.l10n.t('https://github.com/user/repo.git or git@github.com:user/repo.git'), ignoreFocusOut: true });
				if (!url) {
					return undefined;
				}
				const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Remote name'), value: 'origin', ignoreFocusOut: true });
				if (!name) {
					return undefined;
				}
				const repo = this.repo(p.root);
				await repo.addRemote(name, url);
				const idx = this.targets.findIndex((t) => t.root === p.root);
				this.targets[idx] = await buildTarget(repo, undefined, name);
				return this.targets[idx];
			},
			push: async (p: { targets: { root: string; remote: string; remoteBranch: string; selected: boolean }[]; force?: 'lease' | 'force'; tags: 'none' | 'all' | 'follow'; runHooks: boolean }) => {
				await services().context.workspaceState.update('changeline.push.tags', p.tags);
				await services().context.workspaceState.update('changeline.push.runHooks', p.runHooks);
				const jobs = p.targets.filter((t) => t.selected).map((t) => ({ ...t, base: this.targets.find((x) => x.root === t.root)! }));
				if (!jobs.length) {
					return false;
				}
				if (p.force) {
					const protectedBranches = config<string[]>('push.protectedBranches', ['master', 'main']);
					const blocked = jobs.find((j) => protectedBranches.some((pb) => matchBranch(pb, j.remoteBranch)));
					if (blocked) {
						void vscode.window.showErrorMessage(vscode.l10n.t('Force push to the protected branch \'{0}\' is not allowed (setting changeline.push.protectedBranches).', blocked.remoteBranch));
						return false;
					}
					const choice = await vscode.window.showWarningMessage(
						vscode.l10n.t('Force push {0}? Commits on the remote that are not in your branch will be lost.', jobs.map((j) => `${j.base.sourceLabel} to ${j.remote}/${j.remoteBranch}`).join(', ')),
						{ modal: true },
						vscode.l10n.t('Force Push'),
					);
					if (choice !== vscode.l10n.t('Force Push')) {
						return false;
					}
				}
				this.dispose();
				for (const j of jobs) {
					const repo = this.repo(j.root);
					await pushWithProgress(repo, {
						remote: j.remote,
						source: j.base.source,
						remoteBranch: j.remoteBranch,
						force: p.force,
						setUpstream: !j.base.hasUpstream && j.base.source === 'HEAD' && !!j.base.branch,
						tags: p.tags,
						noVerify: !p.runHooks,
					}, j.base.commits.length);
				}
				return true;
			},
			cancel: () => this.dispose(),
		};
	}

	override dispose(): void {
		if (PushPanel.current === this) {
			PushPanel.current = undefined;
		}
		super.dispose();
	}
}

function matchBranch(pattern: string, name: string): boolean {
	const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
	return re.test(name);
}

export async function pushWithProgress(repo: Repository, params: PushParams, commitCount?: number): Promise<boolean> {
	const target = `${params.remote}/${params.remoteBranch}`;
	try {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing to {0}', target), cancellable: false },
			async (progress) => repo.push(params, (line) => {
				const m = /(Writing objects|Compressing objects|Counting objects):\s+(\d+)%/.exec(line);
				if (m) {
					progress.report({ message: `${m[1]} ${m[2]}%` });
				}
			}),
		);
		if (result.rejected) {
			const auto = config<'ask' | 'merge' | 'rebase'>('push.autoUpdateOnReject', 'ask');
			const choice = auto !== 'ask' ? (auto === 'rebase' ? vscode.l10n.t('Rebase') : vscode.l10n.t('Merge')) : await vscode.window.showWarningMessage(
				vscode.l10n.t('Push of {0} to {1} was rejected: the remote contains commits that you do not have locally. Update your branch first.', repo.state.branch ?? params.source, target),
				{ modal: true },
				vscode.l10n.t('Rebase'),
				vscode.l10n.t('Merge'),
			);
			if (!choice) {
				return false;
			}
			const pull = await repo.pull(params.remote, [params.remoteBranch], { rebase: choice === vscode.l10n.t('Rebase') });
			if (!pull.ok) {
				if (pull.conflicts) {
					void vscode.commands.executeCommand('changeline.resolveConflicts');
				} else if (pull.error) {
					await showError(pull.error, vscode.l10n.t('Update failed'));
				}
				return false;
			}
			return pushWithProgress(repo, params, commitCount);
		}
		const upToDate = result.refs.every((r) => r.flag === '=');
		if (upToDate) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Everything is up to date ({0}).', target));
		} else {
			const what = commitCount ? plural(commitCount, '{0} commit', '{0} commits') : params.tags === 'all' ? vscode.l10n.t('tags') : vscode.l10n.t('changes');
			void vscode.window.showInformationMessage(params.setUpstream ? vscode.l10n.t('Pushed {0} to {1} (new branch, tracking set up).', what, target) : vscode.l10n.t('Pushed {0} to {1}.', what, target));
		}
		return true;
	} catch (e) {
		await showError(e, vscode.l10n.t('Push failed'));
		return false;
	}
}
