import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import type { HostingProvider, LineCommentParams, PrDetails, PrTimelineItem } from '../hosting/types';

export interface PrEditorReview {
	n: number;
	repo: Repository;
	details: PrDetails;
	provider: HostingProvider;
	pending: () => LineCommentParams[];
	addPending: (c: LineCommentParams) => Promise<void>;
	reload: () => Promise<void>;
}

/**
 * Review comments of the checked out pull request in the editor, like JetBrains shows them while the branch of a
 * request is checked out: threads at their lines, replies, new single or review comments and resolving threads.
 */
export class PrEditorComments implements vscode.Disposable {
	private controller?: vscode.CommentController;
	private threads: vscode.CommentThread[] = [];
	private readonly ids = new WeakMap<vscode.CommentThread, string>();
	private review?: PrEditorReview;

	get active(): PrEditorReview | undefined {
		return this.review;
	}

	show(review: PrEditorReview): void {
		this.review = review;
		const controller = this.ensureController();
		this.clearThreads();
		const byThread = new Map<string, PrTimelineItem[]>();
		for (const item of review.details.timeline) {
			if (item.kind === 'reviewComment' && item.path && item.line && (item.side ?? 'RIGHT') === 'RIGHT') {
				const key = item.thread ?? item.id;
				byThread.set(key, [...(byThread.get(key) ?? []), item]);
			}
		}
		for (const [id, items] of byThread) {
			const first = items[0];
			const thread = controller.createCommentThread(this.uri(first.path!), this.lineRange(first.line!), items.map((c) => this.comment(c.author?.login ?? '', c.body ?? '', c.createdAt)));
			thread.canReply = true;
			thread.contextValue = first.resolved ? 'changeline-resolved' : first.resolved === false ? 'changeline-unresolved' : 'changeline-thread';
			if (first.resolved !== undefined) {
				thread.state = first.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
			}
			thread.collapsibleState = first.resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
			this.ids.set(thread, id);
			this.threads.push(thread);
		}
		for (const c of review.pending()) {
			const thread = controller.createCommentThread(this.uri(c.path), this.lineRange(c.line), [this.comment(vscode.l10n.t('Pending'), c.body)]);
			thread.canReply = false;
			thread.contextValue = 'changeline-pending';
			thread.label = vscode.l10n.t('Pending review comment');
			this.threads.push(thread);
		}
	}

	hide(): void {
		this.review = undefined;
		this.clearThreads();
	}

	/** Posts the text of a reply box: a reply to an existing thread, or a new single comment or review comment. */
	async submit(reply: vscode.CommentReply, mode: 'single' | 'review'): Promise<void> {
		const r = this.review;
		const text = reply.text.trim();
		if (!r || !text) {
			return;
		}
		const line = (reply.thread.range?.end.line ?? 0) + 1;
		const params: LineCommentParams = { body: text, path: r.repo.relativePath(reply.thread.uri.fsPath), line, side: 'RIGHT', commitSha: r.details.headSha, baseSha: r.details.baseSha, inReplyTo: this.ids.get(reply.thread) };
		if (mode === 'review' && !params.inReplyTo) {
			await r.addPending(params);
		} else {
			await r.provider.lineComment(r.n, params);
		}
		if (!this.ids.has(reply.thread)) {
			reply.thread.dispose();
		}
		await r.reload();
	}

	async resolve(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
		const r = this.review;
		const id = this.ids.get(thread);
		if (r && id) {
			await r.provider.resolveThread(r.n, id, resolved);
			await r.reload();
		}
	}

	dispose(): void {
		this.clearThreads();
		this.controller?.dispose();
	}

	private ensureController(): vscode.CommentController {
		if (!this.controller) {
			this.controller = vscode.comments.createCommentController('changeline.pr', vscode.l10n.t('Pull Request'));
			this.controller.options = { placeHolder: vscode.l10n.t('Leave a comment'), prompt: vscode.l10n.t('Comment on the pull request') };
			this.controller.commentingRangeProvider = {
				provideCommentingRanges: (doc) => {
					const r = this.review;
					if (!r || doc.uri.scheme !== 'file' || !r.repo.contains(doc.uri.fsPath)) {
						return [];
					}
					const rel = r.repo.relativePath(doc.uri.fsPath);
					return r.details.files.some((f) => f.path === rel && f.status !== 'D') ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
				},
			};
		}
		return this.controller;
	}

	private clearThreads(): void {
		this.threads.forEach((t) => t.dispose());
		this.threads = [];
	}

	private uri(path: string): vscode.Uri {
		return vscode.Uri.file(this.review!.repo.absolutePath(path));
	}

	private lineRange(line: number): vscode.Range {
		return new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);
	}

	private comment(author: string, body: string, createdAt?: string): vscode.Comment {
		return { author: { name: author }, body: new vscode.MarkdownString(body), mode: vscode.CommentMode.Preview, timestamp: createdAt ? new Date(createdAt) : undefined };
	}
}
