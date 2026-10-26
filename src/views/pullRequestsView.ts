import * as vscode from 'vscode';
import { checkoutRef, checkoutRemoteBranch } from '../commands/branches';
import { DiffTarget, openDiff, ReviewComment, revisionTarget } from '../diff';
import type { Repository } from '../git/repository';
import { fetchPullRequest, forgetHosting, Hosting, hostingFor, setToken } from '../hosting/service';
import type { PrDetails, PrState, PrTimelineItem } from '../hosting/types';
import { services } from '../services';
import type { FileChange } from '../shared/types';
import { errorMessage, showError } from '../util';
import { showDialog } from '../webviews/dialogPanel';
import { renderWebviewHtml, RpcChannel, webviewOptions } from '../webviews/host';

function reviewComments(details: PrDetails, path: string): ReviewComment[] {
	return details.timeline
		.filter((t): t is PrTimelineItem & { path: string; line: number } => t.kind === 'reviewComment' && t.path === path && typeof t.line === 'number')
		.map((t) => ({ id: t.id, author: t.author?.login ?? '', createdAt: t.createdAt, body: t.body ?? '', line: t.line, side: t.side ?? 'RIGHT', inReplyTo: t.inReplyTo, thread: t.thread }));
}

export class PullRequestsView implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'changeline.pullRequests';
	private view?: vscode.WebviewView;
	private rpc?: RpcChannel;
	private repoRoot?: string;
	private details = new Map<number, PrDetails>();

	constructor(private readonly extensionUri: vscode.Uri) {}

	private get repo(): Repository | undefined {
		const s = services();
		return (this.repoRoot && s.repos.getByRoot(this.repoRoot)) || s.repos.current();
	}

	private async hosting(interactive = true): Promise<Hosting> {
		const repo = this.repo;
		if (!repo) {
			throw new Error(vscode.l10n.t('No Git repository.'));
		}
		const h = await hostingFor(repo, interactive);
		if (!h) {
			throw new Error(vscode.l10n.t('The remotes of this repository are not on GitHub or GitLab. Add hosts in the settings changeline.github.enterpriseHosts / changeline.gitlab.hosts.'));
		}
		return h;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = webviewOptions(this.extensionUri);
		this.rpc?.dispose();
		this.rpc = new RpcChannel(view.webview, {
			init: async () => {
				const s = services();
				const repo = this.repo;
				this.repoRoot = repo?.root;
				let hosting: { name: string; webUrl: string; kind: string } | undefined;
				let error: string | undefined;
				if (repo) {
					try {
						const h = await this.hosting(false);
						hosting = { name: h.provider.displayName, webUrl: h.target.webUrl, kind: h.target.kind };
					} catch (e) {
						error = errorMessage(e);
					}
				}
				return { repos: s.repos.repositories.map((r) => ({ root: r.root, name: r.name })), repoRoot: repo?.root, hosting, error, branch: repo?.state.branch };
			},
			setRepo: (p: { root: string }) => {
				this.repoRoot = p.root;
				this.details.clear();
			},
			signIn: async () => {
				const h = await this.hosting(true);
				const user = await h.provider.currentUser();
				return { login: user.login };
			},
			user: async () => {
				const h = await this.hosting(false);
				try {
					return (await h.provider.currentUser()).login;
				} catch {
					return undefined;
				}
			},
			list: async (p: { state: PrState | 'all' }) => {
				const h = await this.hosting(true);
				return h.provider.list(p.state);
			},
			details: async (p: { number: number }) => {
				const h = await this.hosting(true);
				const d = await h.provider.details(p.number);
				this.details.set(p.number, d);
				return d;
			},
			checkout: (p: { number: number }) => this.checkout(p.number),
			open: (p: { url: string }) => vscode.env.openExternal(vscode.Uri.parse(p.url)),
			merge: async (p: { number: number; method: 'merge' | 'squash' | 'rebase' }) => {
				const h = await this.hosting();
				const d = this.details.get(p.number);
				const method = p.method === 'squash' ? vscode.l10n.t('Squash and merge') : p.method === 'rebase' ? vscode.l10n.t('Rebase and merge') : vscode.l10n.t('Merge');
				const question = d ? vscode.l10n.t('{0} #{1} "{2}" into {3}?', method, p.number, d.title, d.baseRef) : vscode.l10n.t('{0} #{1} into the base branch?', method, p.number);
				const ok = await vscode.window.showWarningMessage(question, { modal: true }, vscode.l10n.t('Merge'));
				if (!ok) {
					return false;
				}
				await h.provider.merge(p.number, p.method);
				void vscode.window.showInformationMessage(vscode.l10n.t('Merged #{0}.', p.number));
				return true;
			},
			setState: async (p: { number: number; state: 'open' | 'closed' }) => {
				const h = await this.hosting();
				await h.provider.setState(p.number, p.state);
			},
			comment: async (p: { number: number; body: string }) => {
				const h = await this.hosting();
				await h.provider.comment(p.number, p.body);
			},
			review: async (p: { number: number; verdict: 'approve' | 'request_changes' | 'comment'; body: string }) => {
				const h = await this.hosting();
				await h.provider.review(p.number, p.verdict, p.body);
			},
			openFile: (p: { number: number; path: string }) => this.openFiles(p.number, p.path),
			openCommit: (p: { number: number; sha: string }) => this.openCommit(p.number, p.sha),
			create: () => vscode.commands.executeCommand('changeline.pullRequests.create', this.repo),
			setToken: async () => {
				const h = await this.hosting(false).catch(() => undefined);
				if (h) {
					await setToken(h.target, undefined);
					forgetHosting(this.repo);
				}
				await this.hosting(true).then((x) => x.provider.currentUser());
			},
		});
		view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'pullRequests', { title: vscode.l10n.t('Pull Requests') });
		view.onDidDispose(() => {
			this.rpc?.dispose();
			this.rpc = undefined;
		});
	}

	refresh(): void {
		this.rpc?.emit('refresh');
	}

	private async checkout(n: number): Promise<void> {
		const repo = this.repo!;
		const h = await this.hosting();
		const d = this.details.get(n) ?? (await h.provider.details(n));
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking out #{0}...', n) }, async () => {
			if (!d.headRepoUrl) {
				await repo.fetch(h.target.remote);
				await repo.getRefs();
				const remoteRef = repo.refs.find((r) => r.type === 'remote' && r.shortName === `${h.target.remote}/${d.headRef}`);
				if (remoteRef) {
					await checkoutRemoteBranch(repo, remoteRef);
					return;
				}
			}
			const local = `pr/${n}-${d.headRef}`.replace(/[^\w./-]+/g, '-');
			await repo.run(['fetch', '--no-tags', h.target.remote, `+${h.provider.headRefSpec(n)}:refs/heads/${local}`], { log: true });
			await checkoutRef(repo, local);
		});
	}

	/** Diff of all files of a request, with review comments shown and addable in the diff viewer. */
	private async openFiles(n: number, path: string): Promise<void> {
		const { targets, files } = await this.reviewTargets(n);
		const index = Math.max(0, files.findIndex((f) => f.path === path));
		await openDiff({ targets, index });
	}

	/** Fetches the request and builds one diff target per changed file. */
	async reviewTargets(n: number): Promise<{ targets: DiffTarget[]; files: PrDetails['files'] }> {
		const repo = this.repo!;
		const h = await this.hosting();
		let d = this.details.get(n) ?? (await h.provider.details(n));
		const head = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Fetching #{0}', n) }, () => fetchPullRequest(repo, h, n));
		const headSha = (await repo.revParse(head)) ?? d.headSha;
		if (!(await repo.revParse(d.baseSha))) {
			await repo.fetch(h.target.remote).catch(() => undefined);
		}
		const base = (await repo.mergeBase(d.baseSha, headSha)) ?? d.baseSha;
		const targets: DiffTarget[] = d.files.map((f) => {
			const file: FileChange = { path: f.path, origPath: f.origPath, status: f.status };
			const t = revisionTarget(repo, base, headSha, file);
			return {
				...t,
				leftTitle: `${d.baseRef} (${base.slice(0, 8)})`,
				rightTitle: `#${n} ${d.headRef} (${headSha.slice(0, 8)})`,
				review: {
					title: `#${n} ${d.title}`,
					comments: reviewComments(d, f.path),
					submit: async (c) => {
						await h.provider.lineComment(n, { body: c.body, path: f.path, line: c.line, side: c.side, commitSha: headSha, baseSha: base, inReplyTo: c.inReplyTo });
						d = await h.provider.details(n);
						this.details.set(n, d);
						this.rpc?.emit('updated', n);
						return reviewComments(d, f.path);
					},
				},
			};
		});
		return { targets, files: d.files };
	}

	private async openCommit(n: number, sha: string): Promise<void> {
		const repo = this.repo!;
		const h = await this.hosting();
		if (!(await repo.revParse(sha))) {
			await fetchPullRequest(repo, h, n);
		}
		await vscode.commands.executeCommand('changeline.log.showCommitDiff', { repo: repo.root, hash: sha });
	}

	dispose(): void {
		this.rpc?.dispose();
	}
}

/** JetBrains "Create Pull Request" dialog. */
export async function createPullRequest(repo: Repository): Promise<void> {
	const h = await hostingFor(repo, true);
	if (!h) {
		void vscode.window.showWarningMessage(vscode.l10n.t('The remotes of this repository are not on GitHub or GitLab.'));
		return;
	}
	const branch = repo.state.branch;
	if (!branch || repo.state.detached) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Checkout a branch to create a pull request.'));
		return;
	}
	const pushRemote = repo.state.upstream?.split('/')[0] ?? h.target.remote;
	const remoteBranches = repo.refs.filter((r) => r.type === 'remote' && r.remote === h.target.remote).map((r) => r.shortName.slice(h.target.remote.length + 1));
	const headRef = (await repo.run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${h.target.remote}/HEAD`], { acceptExitCodes: [1, 128] })).stdout.trim();
	const defaultBase = headRef ? headRef.slice(h.target.remote.length + 1) : remoteBranches.find((b) => b === 'main' || b === 'master') ?? remoteBranches[0] ?? 'main';
	const commits = await repo.log({ revisions: [`${h.target.remote}/${defaultBase}..HEAD`], limit: 50 }).catch(() => []);
	const result = await showDialog({
		title: h.target.kind === 'gitlab' ? vscode.l10n.t('Create Merge Request') : vscode.l10n.t('Create Pull Request'),
		description: vscode.l10n.t('{0} · {1} → base branch', h.target.path, branch),
		fields: [
			{ id: 'base', type: 'combo', label: vscode.l10n.t('Base branch:'), value: defaultBase, options: remoteBranches.map((b) => ({ value: b, label: b })), required: true },
			{ id: 'title', type: 'text', label: vscode.l10n.t('Title:'), value: commits.length === 1 ? commits[0].subject : branch.replace(/^[^/]+\//, '').replace(/[-_]/g, ' '), required: true, focus: true },
			{ id: 'body', type: 'textarea', label: vscode.l10n.t('Description:'), rows: 8, value: commits.length > 1 ? commits.map((c) => `- ${c.subject}`).reverse().join('\n') : '' },
			{ id: 'reviewers', type: 'text', label: vscode.l10n.t('Reviewers:'), placeholder: vscode.l10n.t('user names, comma separated') },
			{ id: 'draft', type: 'checkbox', label: vscode.l10n.t('Create as draft') },
		],
		okLabel: vscode.l10n.t('Create'),
		width: 680,
	});
	if (!result) {
		return;
	}
	const v = result.values;
	if (!repo.state.upstream || repo.state.ahead > 0) {
		const push = await repo.push({ remote: pushRemote, source: 'HEAD', remoteBranch: branch, setUpstream: !repo.state.upstream });
		if (push.rejected) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Push of {0} was rejected. Update the branch and try again.', branch));
			return;
		}
	}
	let head = branch;
	if (h.target.kind === 'github' && pushRemote !== h.target.remote) {
		const remotes = await repo.getRemotes();
		const url = remotes.find((r) => r.name === pushRemote)?.fetchUrl ?? '';
		const owner = /[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(url)?.[1];
		if (owner) {
			head = `${owner}:${branch}`;
		}
	}
	try {
		const pr = await h.provider.create({
			title: String(v.title).trim(),
			body: String(v.body ?? ''),
			head,
			base: String(v.base).trim(),
			draft: v.draft === true,
			reviewers: String(v.reviewers ?? '').split(',').map((x) => x.trim()).filter(Boolean),
		});
		const choice = await vscode.window.showInformationMessage(h.target.kind === 'gitlab' ? vscode.l10n.t('Created merge request !{0}: {1}', pr.number, pr.title) : vscode.l10n.t('Created pull request #{0}: {1}', pr.number, pr.title), vscode.l10n.t('Open in Browser'), vscode.l10n.t('Show Pull Requests'));
		if (choice === vscode.l10n.t('Open in Browser')) {
			await vscode.env.openExternal(vscode.Uri.parse(pr.url));
		} else if (choice === vscode.l10n.t('Show Pull Requests')) {
			await vscode.commands.executeCommand('changeline.pullRequests.focus');
		}
	} catch (e) {
		await showError(e, vscode.l10n.t('Creating the pull request failed'));
	}
}

