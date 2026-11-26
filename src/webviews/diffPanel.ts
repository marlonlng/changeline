import * as fs from 'fs';
import * as vscode from 'vscode';
import { moveChunkToChangelist } from '../commands/changelistPicker';
import { DiffContext, DiffSide, DiffTarget, openNativeDiff } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { applyChunks, chunkKey, diffLines, HighlightMode, isBinary, splitChunks, splitLines, WhitespaceMode } from '../shared/diff';
import type { LineChange } from '../shared/lineChanges';
import { basename, config, samePath } from '../util';
import { RpcHandlers, WebviewPanelBase } from './host';
import { issueRules } from '../issueLinks';

const MAX_SIZE = 4 * 1024 * 1024;
const SETTINGS_KEY = 'changeline.diff.viewSettings';

export interface DiffViewSettings {
	whitespace: WhitespaceMode;
	sideBySide: boolean;
	softWrap: boolean;
	collapse: boolean;
	highlight: HighlightMode;
	context: number;
}

export async function readSide(repo: Repository, side: DiffSide): Promise<Buffer | undefined> {
	switch (side.kind) {
		case 'git':
			return repo.getContentOrEmpty(side.ref, side.path, { filters: true });
		case 'working': {
			const abs = repo.absolutePath(side.path);
			const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs));
			if (doc && doc.isDirty) {
				return Buffer.from(doc.getText(), 'utf8');
			}
			try {
				return await fs.promises.readFile(abs);
			} catch {
				return undefined;
			}
		}
		case 'text':
			return Buffer.from(side.text, 'utf8');
		default:
			return undefined;
	}
}

/** Writes new working tree content, through the open document if there is one. */
export async function writeWorkingFile(abs: string, text: string): Promise<void> {
	const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs));
	if (doc) {
		const wasDirty = doc.isDirty;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
		await vscode.workspace.applyEdit(edit);
		if (!wasDirty) {
			await doc.save();
		}
		return;
	}
	await fs.promises.writeFile(abs, text, 'utf8');
}

export class DiffPanel extends WebviewPanelBase {
	private static current?: DiffPanel;
	private ctx!: DiffContext;
	private focus?: { change: LineChange; id: number };
	private static focusCounter = 0;
	private reloadTimer?: NodeJS.Timeout;

	/** The open diff window, if any. */
	static get open(): DiffPanel | undefined {
		return DiffPanel.current && !DiffPanel.current.isDisposed ? DiffPanel.current : undefined;
	}

	static show(ctx: DiffContext): void {
		if (DiffPanel.current && !DiffPanel.current.isDisposed) {
			DiffPanel.current.setContext(ctx);
			DiffPanel.current.panel.reveal(undefined, false);
			return;
		}
		DiffPanel.current = new DiffPanel(ctx);
	}

	private constructor(ctx: DiffContext) {
		super(services().context.extensionUri, 'changeline.diff', titleOf(ctx), 'diff', null, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
		this.ctx = ctx;
		this.focus = ctx.focus && { change: ctx.focus, id: ++DiffPanel.focusCounter };
		const s = services();
		this.disposables.push(
			s.repos.onDidChangeState((repo) => {
				if (repo === this.target.repo && this.target.mode !== 'readonly') {
					this.scheduleReload();
				}
			}),
			s.changelists.onDidChange(() => this.scheduleReload()),
			vscode.workspace.onDidChangeTextDocument((e) => {
				const t = this.target;
				if (t.right.kind === 'working' && e.document.uri.scheme === 'file' && samePath(e.document.uri.fsPath, t.repo.absolutePath(t.right.path))) {
					this.scheduleReload(300);
				}
			}),
		);
	}

	private get target(): DiffTarget {
		return this.ctx.targets[this.ctx.index];
	}

	setContext(ctx: DiffContext): void {
		this.ctx = ctx;
		this.focus = ctx.focus && { change: ctx.focus, id: ++DiffPanel.focusCounter };
		this.panel.title = titleOf(ctx);
		void this.reload();
	}

	private scheduleReload(delay = 150): void {
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
		}
		this.reloadTimer = setTimeout(() => void this.reload(), delay);
	}

	private async reload(): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		try {
			this.rpc.emit('data', await this.data());
		} catch (e) {
			this.rpc.emit('error', String(e));
		}
	}

	private settings(): DiffViewSettings {
		const stored = services().context.globalState.get<Partial<DiffViewSettings>>(SETTINGS_KEY, {});
		return {
			whitespace: stored.whitespace ?? config<WhitespaceMode>('diff.ignoreWhitespace', 'none'),
			sideBySide: stored.sideBySide ?? config('diff.sideBySide', true),
			softWrap: stored.softWrap ?? config('diff.softWraps', false),
			collapse: stored.collapse ?? config('diff.collapseUnchanged', false),
			highlight: stored.highlight ?? ((stored as { highlightWords?: boolean }).highlightWords === false ? 'lines' : config<HighlightMode>('diff.highlighting', 'words')),
			context: config('diff.contextLines', 4),
		};
	}

	private async data() {
		const t = this.target;
		const s = services();
		const focus = this.focus;
		const [leftBuf, rightBuf, commit, rules] = await Promise.all([readSide(t.repo, t.left), readSide(t.repo, t.right), t.commit ? t.repo.getCommit(t.commit).catch(() => undefined) : undefined, t.commit ? issueRules(t.repo) : []]);
		const binary = (!!leftBuf && isBinary(leftBuf)) || (!!rightBuf && isBinary(rightBuf));
		const tooLarge = (leftBuf?.length ?? 0) > MAX_SIZE || (rightBuf?.length ?? 0) > MAX_SIZE;
		const abs = t.repo.absolutePath(t.path);
		const staging = config('commit.useStagingArea', false);
		const canEdit = !binary && !tooLarge && !!leftBuf && !!rightBuf;
		const includeCapable = t.mode === 'local' && !staging && t.status === 'M' && canEdit;
		const left = binary || tooLarge ? null : leftBuf?.toString('utf8') ?? null;
		const right = binary || tooLarge ? null : rightBuf?.toString('utf8') ?? null;
		if (includeCapable && left !== null && right !== null) {
			const ol = splitLines(left);
			const nl = splitLines(right);
			s.changelists.pruneChunks(abs, diffLines(ol, nl).map((c) => chunkKey(c, ol, nl)));
		}
		let excluded = [...s.changelists.getExcludedChunks(abs)];
		let chunkLists: Record<string, string> | undefined;
		if (includeCapable && left !== null && right !== null) {
			const ol = splitLines(left);
			const nl = splitLines(right);
			const keys = diffLines(ol, nl).map((c) => chunkKey(c, ol, nl));
			const ex = s.changelists.getExcludedChunks(abs);
			excluded = keys.filter((k) => ex.has(k) || !s.changelists.isPartIncluded(abs, s.changelists.chunkListOf(abs, k)));
			if (s.changelists.all.length > 1) {
				chunkLists = Object.fromEntries(keys.map((k) => [k, s.changelists.get(s.changelists.chunkListOf(abs, k))?.name ?? '']));
			}
		}
		return {
			path: t.path,
			repoName: t.repo.name,
			fileList: includeCapable ? s.changelists.listOf(abs).name : undefined,
			chunkLists,
			leftTitle: t.leftTitle,
			rightTitle: t.rightTitle,
			status: t.status,
			left,
			right,
			leftMissing: !leftBuf,
			rightMissing: !rightBuf,
			binary,
			tooLarge,
			mode: t.mode,
			capabilities: {
				revert: (t.mode === 'local' || t.mode === 'unstaged') && canEdit,
				include: includeCapable,
				stage: t.mode === 'unstaged' && canEdit,
				unstage: t.mode === 'staged' && canEdit,
				source: t.right.kind === 'working' || t.right.kind === 'git',
			},
			included: s.changelists.isAnyPartIncluded(abs),
			excluded,
			fileIndex: this.ctx.index,
			files: this.ctx.targets.map((x) => ({ path: x.path, status: x.status })),
			settings: this.settings(),
			review: t.review ? { title: t.review.title, comments: t.review.comments, pending: t.review.pending() } : undefined,
			commit: commit && { hash: commit.hash, subject: commit.subject, body: commit.body, author: commit.author, authorEmail: commit.authorEmail, authorDate: commit.authorDate, issueRules: rules },
			focus,
		};
	}

	/** Recomputes chunks on the current content with the webview's options. */
	private async chunks(whitespace: WhitespaceMode, split = false) {
		const t = this.target;
		const [l, r] = await Promise.all([readSide(t.repo, t.left), readSide(t.repo, t.right)]);
		const oldLines = splitLines(l?.toString('utf8') ?? '');
		const newLines = splitLines(r?.toString('utf8') ?? '');
		const lineChunks = diffLines(oldLines, newLines, { whitespace });
		const chunks = split ? splitChunks(lineChunks) : lineChunks;
		return { oldLines, newLines, chunks, find: (key: string) => chunks.find((c) => chunkKey(c, oldLines, newLines) === key) };
	}

	protected handlers(): RpcHandlers {
		return {
			ready: () => this.data(),
			navigate: async (p: { index: number }) => {
				if (p.index >= 0 && p.index < this.ctx.targets.length) {
					this.ctx = { ...this.ctx, index: p.index };
					this.focus = undefined;
					this.panel.title = titleOf(this.ctx);
					return this.data();
				}
				return undefined;
			},
			saveSettings: async (p: Partial<DiffViewSettings>) => {
				const current = services().context.globalState.get<Partial<DiffViewSettings>>(SETTINGS_KEY, {});
				await services().context.globalState.update(SETTINGS_KEY, { ...current, ...p });
			},
			revertChunk: async (p: { key: string; whitespace: WhitespaceMode; split?: boolean }) => {
				const t = this.target;
				const { oldLines, newLines, chunks, find } = await this.chunks(p.whitespace, p.split);
				const target = find(p.key);
				if (!target) {
					throw new Error(vscode.l10n.t('The change no longer exists.'));
				}
				const text = applyChunks(oldLines, newLines, chunks, (c) => c !== target);
				await writeWorkingFile(t.repo.absolutePath(t.path), text);
				await t.repo.refresh();
				await this.reload();
			},
			toggleChunk: async (p: { key: string; included: boolean; whitespace: WhitespaceMode }) => {
				const t = this.target;
				const { oldLines, newLines, chunks } = await this.chunks('none');
				services().changelists.setChunkInclusion(t.repo.absolutePath(t.path), p.key, p.included, chunks.map((c) => chunkKey(c, oldLines, newLines)));
			},
			moveChunk: (p: { key: string }) => moveChunkToChangelist(this.target.repo.absolutePath(this.target.path), p.key),
			includeFile: (p: { included: boolean }) => {
				services().changelists.setIncluded([this.target.repo.absolutePath(this.target.path)], p.included);
			},
			stageChunk: async (p: { key: string; whitespace: WhitespaceMode; split?: boolean }) => {
				const t = this.target;
				const { oldLines, newLines, chunks, find } = await this.chunks(p.whitespace, p.split);
				const target = find(p.key);
				if (!target) {
					throw new Error(vscode.l10n.t('The change no longer exists.'));
				}
				await t.repo.writeIndexContent(t.path, applyChunks(oldLines, newLines, chunks, (c) => c === target));
				await this.reload();
			},
			unstageChunk: async (p: { key: string; whitespace: WhitespaceMode; split?: boolean }) => {
				const t = this.target;
				const { oldLines, newLines, chunks, find } = await this.chunks(p.whitespace, p.split);
				const target = find(p.key);
				if (!target) {
					throw new Error(vscode.l10n.t('The change no longer exists.'));
				}
				await t.repo.writeIndexContent(t.path, applyChunks(oldLines, newLines, chunks, (c) => c !== target));
				await this.reload();
			},
			openSource: async (p: { line?: number; side?: 'left' | 'right' }) => {
				const t = this.target;
				const side = p.side === 'left' ? t.left : t.right;
				const { sideUri } = await import('../diff');
				const uri = side.kind === 'empty' ? vscode.Uri.file(t.repo.absolutePath(t.path)) : sideUri(t.repo, side, t.path);
				const line = Math.max(0, (p.line ?? 1) - 1);
				await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: false, viewColumn: vscode.ViewColumn.Active });
			},
			openNative: () => openNativeDiff(this.target),
			addComment: async (p: { line: number; side: 'LEFT' | 'RIGHT'; body: string; inReplyTo?: string; mode?: 'single' | 'review' }) => {
				const review = this.target.review;
				if (!review) {
					return;
				}
				review.comments = await review.submit(p, p.mode);
				await this.reload();
			},
			resolveThread: async (p: { thread: string; resolved: boolean }) => {
				const review = this.target.review;
				if (review?.resolve) {
					review.comments = await review.resolve(p.thread, p.resolved);
					await this.reload();
				}
			},
			openUrl: (p: { url: string }) => {
				if (/^https?:\/\//i.test(p.url)) {
					void vscode.env.openExternal(vscode.Uri.parse(p.url));
				}
			},
			applySuggestion: async (p: { id: string }) => {
				await this.target.review?.applySuggestion?.(p.id);
			},
			refresh: () => this.data(),
			showHistory: () => vscode.commands.executeCommand('changeline.showHistory', vscode.Uri.file(this.target.repo.absolutePath(this.target.path))),
		};
	}

	override dispose(): void {
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
		}
		if (DiffPanel.current === this) {
			DiffPanel.current = undefined;
		}
		super.dispose();
	}
}

function titleOf(ctx: DiffContext): string {
	const t = ctx.targets[ctx.index];
	return t ? vscode.l10n.t('Diff: {0}', basename(t.path)) : vscode.l10n.t('Diff');
}

