
export type PrState = 'open' | 'closed' | 'merged';

export interface PrUser {
	login: string;
	name?: string;
	avatarUrl?: string;
}

export interface PullRequest {
	number: number;
	title: string;
	state: PrState;
	draft: boolean;
	author: PrUser;
	createdAt: string;
	updatedAt: string;
	url: string;
	headRef: string;
	headSha: string;
	headRepoUrl?: string;
	baseRef: string;
	labels: string[];
	commentsCount?: number;
}

export interface PrReviewer {
	user: PrUser;
	state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';
}

export interface PrTimelineItem {
	id: string;
	kind: 'comment' | 'review' | 'reviewComment' | 'commit' | 'event';
	author?: PrUser;
	createdAt: string;
	body?: string;
	state?: string;
	path?: string;
	line?: number;
	side?: 'LEFT' | 'RIGHT';
	diffHunk?: string;
	inReplyTo?: string;
	thread?: string;
	sha?: string;
}

export interface PrFile {
	path: string;
	origPath?: string;
	status: 'A' | 'M' | 'D' | 'R';
	additions: number;
	deletions: number;
}

export interface PrCommit {
	sha: string;
	message: string;
	author: string;
	date: string;
}

export interface PrDetails extends PullRequest {
	body: string;
	baseSha: string;
	mergeable?: boolean;
	reviewers: PrReviewer[];
	timeline: PrTimelineItem[];
	commits: PrCommit[];
	files: PrFile[];
	checks?: { state: 'success' | 'failure' | 'pending' | 'none'; total?: number; pipeline?: string };
	commentsHidden?: boolean;
}

export interface CreatePrParams {
	title: string;
	body: string;
	head: string;
	base: string;
	draft: boolean;
	reviewers: string[];
}

export interface LineCommentParams {
	body: string;
	path: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	commitSha: string;
	baseSha: string;
	inReplyTo?: string;
}

export interface HostingProvider {
	readonly kind: 'github' | 'gitlab';
	readonly displayName: string;
	readonly webUrl: string;
	currentUser(): Promise<PrUser>;
	list(state: PrState | 'all'): Promise<PullRequest[]>;
	details(n: number): Promise<PrDetails>;
	create(params: CreatePrParams): Promise<PullRequest>;
	merge(n: number, method: 'merge' | 'squash' | 'rebase', commitTitle?: string): Promise<void>;
	setState(n: number, state: 'open' | 'closed'): Promise<void>;
	comment(n: number, body: string): Promise<void>;
	review(n: number, verdict: 'approve' | 'request_changes' | 'comment', body: string): Promise<void>;
	lineComment(n: number, params: LineCommentParams): Promise<void>;
	/** Ref name that contains the head of the request on the base remote. */
	headRefSpec(n: number): string;
}

export class HostingError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** Resolves to `fallback` when the server refuses the request for lack of permissions (401 / 403). */
export function unlessForbidden<T>(p: Promise<T>, fallback: T): Promise<T> {
	return p.catch((e) => {
		if (e instanceof HostingError && (e.status === 401 || e.status === 403)) {
			return fallback;
		}
		throw e;
	});
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export async function request<T>(fetcher: Fetcher, url: string, headers: Record<string, string>, method = 'GET', body?: unknown): Promise<T> {
	const res = await fetcher(url, { method, headers: { Accept: 'application/json', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
	if (res.status >= 400) {
		let message = `${res.status}`;
		try {
			const j = (await res.json()) as { message?: string; error?: string; errors?: { message?: string }[] };
			message = j.message ?? j.error ?? message;
			if (j.errors?.length) {
				message += ': ' + j.errors.map((e) => e.message ?? JSON.stringify(e)).join(', ');
			}
		} catch {
		}
		throw new HostingError(`${method} ${new URL(url).pathname} failed: ${message}`, res.status);
	}
	if (res.status === 204) {
		return undefined as T;
	}
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
