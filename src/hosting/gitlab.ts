import { CreatePrParams, Fetcher, HostingProvider, LineCommentParams, PrDetails, PrFile, PrReviewer, PrState, PrTimelineItem, PrUser, PullRequest, request, unlessForbidden } from './types';


function user(u: any): PrUser {
	return { login: u?.username ?? 'ghost', name: u?.name, avatarUrl: u?.avatar_url };
}

function mr(m: any): PullRequest {
	return {
		number: m.iid,
		title: m.title,
		state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed',
		draft: !!(m.draft ?? m.work_in_progress),
		author: user(m.author),
		createdAt: m.created_at,
		updatedAt: m.updated_at,
		url: m.web_url,
		headRef: m.source_branch,
		headSha: m.sha,
		baseRef: m.target_branch,
		labels: m.labels ?? [],
		commentsCount: m.user_notes_count,
	};
}

export class GitLabProvider implements HostingProvider {
	readonly kind = 'gitlab';
	readonly displayName = 'GitLab';

	constructor(
		private readonly apiUrl: string,
		readonly webUrl: string,
		private readonly projectPath: string,
		private readonly token: () => Promise<string>,
		private readonly fetcher: Fetcher,
	) {}

	private async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
		const token = await this.token();
		return request<T>(this.fetcher, `${this.apiUrl}${path}`, token ? { 'PRIVATE-TOKEN': token } : {}, method, body);
	}

	private get base(): string {
		return `/projects/${encodeURIComponent(this.projectPath)}`;
	}

	async currentUser(): Promise<PrUser> {
		return user(await this.call<any>('/user'));
	}

	async list(state: PrState | 'all'): Promise<PullRequest[]> {
		const apiState = state === 'open' ? 'opened' : state;
		return (await this.call<any[]>(`${this.base}/merge_requests?state=${apiState}&per_page=100&order_by=updated_at`)).map(mr);
	}

	async details(n: number): Promise<PrDetails> {
		const [m, commits, changes, notes, approvals, discussions] = await Promise.all([
			this.call<any>(`${this.base}/merge_requests/${n}`),
			this.call<any[]>(`${this.base}/merge_requests/${n}/commits?per_page=100`),
			this.call<any>(`${this.base}/merge_requests/${n}/changes`),
			unlessForbidden(this.call<any[]>(`${this.base}/merge_requests/${n}/notes?sort=asc&per_page=100`), undefined),
			this.call<any>(`${this.base}/merge_requests/${n}/approvals`).catch(() => ({ approved_by: [] })),
			this.call<any[]>(`${this.base}/merge_requests/${n}/discussions?per_page=100`).catch(() => []),
		]);
		const reviewers: PrReviewer[] = (m.reviewers ?? []).map((r: any) => ({ user: user(r), state: 'pending' as const }));
		for (const a of approvals.approved_by ?? []) {
			const existing = reviewers.find((r) => r.user.login === a.user?.username);
			if (existing) {
				existing.state = 'approved';
			} else {
				reviewers.push({ user: user(a.user), state: 'approved' });
			}
		}
		const positioned = new Map<string, any>();
		for (const d of discussions) {
			for (const note of d.notes ?? []) {
				if (note.position) {
					positioned.set(String(note.id), { ...note, discussionId: d.id, first: d.notes[0].id });
				}
			}
		}
		const timeline: PrTimelineItem[] = (notes ?? []).map((n: any) => {
			const pos = positioned.get(String(n.id));
			if (pos) {
				return {
					id: String(n.id),
					kind: 'reviewComment' as const,
					author: user(n.author),
					createdAt: n.created_at,
					body: n.body,
					path: pos.position.new_path ?? pos.position.old_path,
					line: pos.position.new_line ?? pos.position.old_line,
					side: pos.position.new_line ? ('RIGHT' as const) : ('LEFT' as const),
					inReplyTo: pos.first !== n.id ? `d:${pos.discussionId}` : undefined,
					thread: `d:${pos.discussionId}`,
				};
			}
			return { id: String(n.id), kind: n.system ? ('event' as const) : ('comment' as const), author: user(n.author), createdAt: n.created_at, body: n.body };
		});
		for (const c of commits) {
			timeline.push({ id: `k${c.id}`, kind: 'commit', author: { login: c.author_name }, createdAt: c.created_at, body: c.message, sha: c.id });
		}
		timeline.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
		const files: PrFile[] = (changes.changes ?? []).map((c: any) => ({
			path: c.new_path,
			origPath: c.renamed_file ? c.old_path : undefined,
			status: c.new_file ? 'A' : c.deleted_file ? 'D' : c.renamed_file ? 'R' : 'M',
			additions: (c.diff?.match(/^\+(?!\+\+)/gm) ?? []).length,
			deletions: (c.diff?.match(/^-(?!--)/gm) ?? []).length,
		}));
		const pipeline = m.head_pipeline ?? m.pipeline;
		return {
			...mr(m),
			body: m.description ?? '',
			baseSha: m.diff_refs?.base_sha ?? '',
			mergeable: m.merge_status ? m.merge_status === 'can_be_merged' : undefined,
			reviewers,
			timeline,
			commits: commits.map((c: any) => ({ sha: c.id, message: c.message, author: c.author_name, date: c.created_at })),
			files,
			checks: pipeline ? { state: pipeline.status === 'success' ? 'success' : pipeline.status === 'failed' ? 'failure' : 'pending', pipeline: pipeline.status } : { state: 'none' },
			commentsHidden: notes ? undefined : true,
		};
	}

	async create(params: CreatePrParams): Promise<PullRequest> {
		let reviewerIds: number[] = [];
		if (params.reviewers.length) {
			const users = await Promise.all(params.reviewers.map((u) => this.call<any[]>(`/users?username=${encodeURIComponent(u)}`)));
			reviewerIds = users.map((list) => list[0]?.id).filter((id): id is number => typeof id === 'number');
		}
		const m = await this.call<any>(`${this.base}/merge_requests`, 'POST', {
			source_branch: params.head,
			target_branch: params.base,
			title: params.draft && !/^draft:/i.test(params.title) ? `Draft: ${params.title}` : params.title,
			description: params.body,
			reviewer_ids: reviewerIds.length ? reviewerIds : undefined,
		});
		return mr(m);
	}

	async merge(n: number, method: 'merge' | 'squash' | 'rebase', commitTitle?: string): Promise<void> {
		if (method === 'rebase') {
			await this.call(`${this.base}/merge_requests/${n}/rebase`, 'PUT');
		}
		await this.call(`${this.base}/merge_requests/${n}/merge`, 'PUT', { squash: method === 'squash', ...(commitTitle ? { squash_commit_message: commitTitle } : {}) });
	}

	async setState(n: number, state: 'open' | 'closed'): Promise<void> {
		await this.call(`${this.base}/merge_requests/${n}`, 'PUT', { state_event: state === 'open' ? 'reopen' : 'close' });
	}

	async comment(n: number, body: string): Promise<void> {
		await this.call(`${this.base}/merge_requests/${n}/notes`, 'POST', { body });
	}

	async review(n: number, verdict: 'approve' | 'request_changes' | 'comment', body: string): Promise<void> {
		if (verdict === 'approve') {
			await this.call(`${this.base}/merge_requests/${n}/approve`, 'POST');
		} else if (verdict === 'request_changes') {
			await this.call(`${this.base}/merge_requests/${n}/unapprove`, 'POST').catch(() => undefined);
		}
		if (body.trim() || verdict === 'request_changes') {
			await this.comment(n, body.trim() || 'Changes requested.');
		}
	}

	async lineComment(n: number, p: LineCommentParams): Promise<void> {
		if (p.inReplyTo?.startsWith('d:')) {
			await this.call(`${this.base}/merge_requests/${n}/discussions/${p.inReplyTo.slice(2)}/notes`, 'POST', { body: p.body });
			return;
		}
		const m = await this.call<any>(`${this.base}/merge_requests/${n}`);
		await this.call(`${this.base}/merge_requests/${n}/discussions`, 'POST', {
			body: p.body,
			position: {
				position_type: 'text',
				base_sha: m.diff_refs?.base_sha ?? p.baseSha,
				start_sha: m.diff_refs?.start_sha ?? p.baseSha,
				head_sha: m.diff_refs?.head_sha ?? p.commitSha,
				new_path: p.path,
				old_path: p.path,
				...(p.side === 'RIGHT' ? { new_line: p.line } : { old_line: p.line }),
			},
		});
	}

	headRefSpec(n: number): string {
		return `refs/merge-requests/${n}/head`;
	}
}
