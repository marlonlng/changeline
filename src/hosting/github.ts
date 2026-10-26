import { CreatePrParams, Fetcher, HostingProvider, LineCommentParams, PrDetails, PrFile, PrReviewer, PrState, PrTimelineItem, PrUser, PullRequest, request } from './types';


function user(u: any): PrUser {
	return { login: u?.login ?? 'ghost', name: u?.name ?? undefined, avatarUrl: u?.avatar_url };
}

function pr(p: any): PullRequest {
	return {
		number: p.number,
		title: p.title,
		state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
		draft: !!p.draft,
		author: user(p.user),
		createdAt: p.created_at,
		updatedAt: p.updated_at,
		url: p.html_url,
		headRef: p.head?.ref,
		headSha: p.head?.sha,
		headRepoUrl: p.head?.repo && p.base?.repo && p.head.repo.full_name !== p.base.repo.full_name ? p.head.repo.clone_url : undefined,
		baseRef: p.base?.ref,
		labels: (p.labels ?? []).map((l: any) => l.name),
		commentsCount: p.comments,
	};
}

function fileStatus(s: string): PrFile['status'] {
	return s === 'added' ? 'A' : s === 'removed' ? 'D' : s === 'renamed' ? 'R' : 'M';
}

export class GitHubProvider implements HostingProvider {
	readonly kind = 'github';
	readonly displayName: string;

	constructor(
		private readonly apiUrl: string,
		readonly webUrl: string,
		private readonly owner: string,
		private readonly repo: string,
		private readonly token: () => Promise<string>,
		private readonly fetcher: Fetcher,
	) {
		this.displayName = /github\.com/.test(webUrl) ? 'GitHub' : 'GitHub Enterprise';
	}

	private async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
		const token = await this.token();
		const headers: Record<string, string> = { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Changeline', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
		return request<T>(this.fetcher, `${this.apiUrl}${path}`, headers, method, body);
	}

	private get base(): string {
		return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
	}

	async currentUser(): Promise<PrUser> {
		return user(await this.call<any>('/user'));
	}

	async list(state: PrState | 'all'): Promise<PullRequest[]> {
		const apiState = state === 'open' ? 'open' : state === 'all' ? 'all' : 'closed';
		const list = await this.call<any[]>(`${this.base}/pulls?state=${apiState}&per_page=100&sort=updated&direction=desc`);
		const prs = list.map(pr);
		if (state === 'merged') {
			return prs.filter((p) => p.state === 'merged');
		}
		if (state === 'closed') {
			return prs.filter((p) => p.state === 'closed');
		}
		return prs;
	}

	async details(n: number): Promise<PrDetails> {
		const [p, commits, files, comments, reviews, reviewComments, requested] = await Promise.all([
			this.call<any>(`${this.base}/pulls/${n}`),
			this.call<any[]>(`${this.base}/pulls/${n}/commits?per_page=250`),
			this.call<any[]>(`${this.base}/pulls/${n}/files?per_page=300`),
			this.call<any[]>(`${this.base}/issues/${n}/comments?per_page=100`),
			this.call<any[]>(`${this.base}/pulls/${n}/reviews?per_page=100`),
			this.call<any[]>(`${this.base}/pulls/${n}/comments?per_page=300`),
			this.call<any>(`${this.base}/pulls/${n}/requested_reviewers`).catch(() => ({ users: [] })),
		]);
		let checks: PrDetails['checks'];
		try {
			const status = await this.call<any>(`${this.base}/commits/${p.head.sha}/status`);
			checks = { state: status.total_count ? status.state : 'none', total: status.total_count || undefined };
		} catch {
			checks = undefined;
		}
		const reviewerMap = new Map<string, PrReviewer>();
		for (const u of requested.users ?? []) {
			reviewerMap.set(u.login, { user: user(u), state: 'pending' });
		}
		for (const r of reviews) {
			const st = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes_requested' : r.state === 'DISMISSED' ? 'dismissed' : 'commented';
			const prev = reviewerMap.get(r.user?.login);
			if (!prev || st !== 'commented' || prev.state === 'pending') {
				reviewerMap.set(r.user?.login, { user: user(r.user), state: st });
			}
		}
		const timeline: PrTimelineItem[] = [
			...comments.map((c) => ({ id: `c${c.id}`, kind: 'comment' as const, author: user(c.user), createdAt: c.created_at, body: c.body ?? '' })),
			...reviews.filter((r) => r.state !== 'PENDING').map((r) => ({ id: `r${r.id}`, kind: 'review' as const, author: user(r.user), createdAt: r.submitted_at ?? r.created_at, body: r.body ?? '', state: r.state })),
			...reviewComments.map((c) => ({
				id: String(c.id),
				kind: 'reviewComment' as const,
				author: user(c.user),
				createdAt: c.created_at,
				body: c.body ?? '',
				path: c.path,
				line: c.line ?? c.original_line ?? undefined,
				side: (c.side ?? 'RIGHT') as 'LEFT' | 'RIGHT',
				diffHunk: c.diff_hunk,
				inReplyTo: c.in_reply_to_id ? String(c.in_reply_to_id) : undefined,
				thread: String(c.in_reply_to_id ?? c.id),
			})),
			...commits.map((c) => ({ id: `k${c.sha}`, kind: 'commit' as const, author: { login: c.author?.login ?? c.commit?.author?.name ?? '' }, createdAt: c.commit?.author?.date, body: c.commit?.message, sha: c.sha })),
		].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
		return {
			...pr(p),
			body: p.body ?? '',
			baseSha: p.base?.sha,
			mergeable: p.mergeable ?? undefined,
			reviewers: [...reviewerMap.values()],
			timeline,
			commits: commits.map((c) => ({ sha: c.sha, message: c.commit?.message ?? '', author: c.commit?.author?.name ?? '', date: c.commit?.author?.date ?? '' })),
			files: files.map((f) => ({ path: f.filename, origPath: f.previous_filename, status: fileStatus(f.status), additions: f.additions, deletions: f.deletions })),
			checks,
		};
	}

	async create(params: CreatePrParams): Promise<PullRequest> {
		const p = await this.call<any>(`${this.base}/pulls`, 'POST', { title: params.title, body: params.body, head: params.head, base: params.base, draft: params.draft });
		if (params.reviewers.length) {
			await this.call(`${this.base}/pulls/${p.number}/requested_reviewers`, 'POST', { reviewers: params.reviewers });
		}
		return pr(p);
	}

	async merge(n: number, method: 'merge' | 'squash' | 'rebase', commitTitle?: string): Promise<void> {
		await this.call(`${this.base}/pulls/${n}/merge`, 'PUT', { merge_method: method, ...(commitTitle ? { commit_title: commitTitle } : {}) });
	}

	async setState(n: number, state: 'open' | 'closed'): Promise<void> {
		await this.call(`${this.base}/pulls/${n}`, 'PATCH', { state });
	}

	async comment(n: number, body: string): Promise<void> {
		await this.call(`${this.base}/issues/${n}/comments`, 'POST', { body });
	}

	async review(n: number, verdict: 'approve' | 'request_changes' | 'comment', body: string): Promise<void> {
		const event = verdict === 'approve' ? 'APPROVE' : verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
		await this.call(`${this.base}/pulls/${n}/reviews`, 'POST', { event, body });
	}

	async lineComment(n: number, p: LineCommentParams): Promise<void> {
		if (p.inReplyTo) {
			await this.call(`${this.base}/pulls/${n}/comments/${p.inReplyTo}/replies`, 'POST', { body: p.body });
			return;
		}
		await this.call(`${this.base}/pulls/${n}/comments`, 'POST', { body: p.body, commit_id: p.commitSha, path: p.path, line: p.line, side: p.side });
	}

	headRefSpec(n: number): string {
		return `refs/pull/${n}/head`;
	}
}

/** Account level calls used by "Share Project on GitHub", "Create Gist" and the clone dialog. */
export async function createGitHubRepository(apiUrl: string, token: string, fetcher: Fetcher, p: { name: string; description: string; private: boolean; org?: string }): Promise<{ cloneUrl: string; sshUrl: string; htmlUrl: string; fullName: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'Changeline' };
	const path = p.org ? `/orgs/${encodeURIComponent(p.org)}/repos` : '/user/repos';
	const r = await request<any>(fetcher, `${apiUrl}${path}`, headers, 'POST', { name: p.name, description: p.description, private: p.private, auto_init: false });
	return { cloneUrl: r.clone_url, sshUrl: r.ssh_url, htmlUrl: r.html_url, fullName: r.full_name };
}

export async function createGist(apiUrl: string, token: string, fetcher: Fetcher, p: { files: Record<string, string>; description: string; public: boolean }): Promise<string> {
	const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'Changeline' };
	const files = Object.fromEntries(Object.entries(p.files).map(([name, content]) => [name, { content }]));
	const r = await request<any>(fetcher, `${apiUrl}/gists`, headers, 'POST', { description: p.description, public: p.public, files });
	return r.html_url;
}

export async function listUserRepositories(apiUrl: string, token: string, fetcher: Fetcher): Promise<{ fullName: string; cloneUrl: string; sshUrl: string; description?: string; private: boolean; updatedAt: string }[]> {
	const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'Changeline' };
	const all: any[] = [];
	for (let page = 1; page <= 5; page++) {
		const batch = await request<any[]>(fetcher, `${apiUrl}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, headers);
		all.push(...batch);
		if (batch.length < 100) {
			break;
		}
	}
	return all.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, sshUrl: r.ssh_url, description: r.description ?? undefined, private: !!r.private, updatedAt: r.updated_at }));
}
