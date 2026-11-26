import MarkdownIt from 'markdown-it';
import { chunkKey, DiffChunk, diffLines, diffWords, HighlightMode, rangesInLine, splitChunks, splitLines, stripEol, WhitespaceMode } from '../../src/shared/diff';
import type { LineChange } from '../../src/shared/lineChanges';
import type { IssueRule } from '../../src/shared/issueLinks';
import { highlightLines, languageFor, renderSegments, Segment } from './highlight';
import { language, plural, t } from './l10n';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export interface ReviewComment {
	id: string;
	author: string;
	createdAt: string;
	body: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	thread?: string;
	resolved?: boolean;
	pending?: boolean;
}

export type Threads = Map<string, ReviewComment[]>;

export function buildThreads(comments: ReviewComment[] | undefined): Threads {
	const map: Threads = new Map();
	for (const c of comments ?? []) {
		const key = `${c.side}:${c.line}`;
		const arr = map.get(key) ?? [];
		arr.push(c);
		map.set(key, arr);
	}
	return map;
}

export function threadHtml(item: Threads, side: 'LEFT' | 'RIGHT', from: number, to: number): string {
	const parts: string[] = [];
	for (let line = from; line <= to; line++) {
		const list = item.get(`${side}:${line}`);
		if (!list) {
			continue;
		}
		const threads = new Map<string, ReviewComment[]>();
		for (const c of list) {
			const key = c.thread ?? c.id;
			threads.set(key, [...(threads.get(key) ?? []), c]);
		}
		for (const [thread, comments] of threads) {
			const pending = comments.every((c) => c.pending);
			const resolvable = comments.some((c) => c.resolved !== undefined);
			const resolved = comments.some((c) => c.resolved);
			const items = comments
				.map((c) => {
					const badge = c.pending ? `<span class="badge pending">${escapeHtml(t('Pending'))}</span> ` : '';
					const suggestion = !c.pending && /```suggestion\b/.test(c.body) ? `<button class="jg-link apply-suggestion" data-suggest="${escapeHtml(c.id)}">${escapeHtml(t('Apply Suggestion'))}</button>` : '';
					return `<div class="cmt${c.pending ? ' pending' : ''}"><div class="cmt-head"><b>${escapeHtml(c.author)}</b> ${badge}<span class="cmt-meta">${escapeHtml(t('line {0}', c.line))} · ${escapeHtml(new Date(c.createdAt).toLocaleString(language))}</span></div><div class="cmt-body">${md.render(c.body)}</div>${suggestion}</div>`;
				})
				.join('');
			const reply = `<button class="jg-link reply" data-reply="${escapeHtml(thread)}" data-rline="${line}" data-rside="${side}">${escapeHtml(t('Reply'))}</button>`;
			const resolve = resolvable ? `<button class="jg-link resolve" data-resolve="${escapeHtml(thread)}" data-resolved="${resolved ? '0' : '1'}">${escapeHtml(resolved ? t('Unresolve') : t('Resolve'))}</button>` : '';
			const actions = pending ? '' : `<div class="thread-actions">${reply}${resolve}</div>`;
			if (resolved) {
				const first = comments[0];
				parts.push(`<details class="thread resolved"><summary>${escapeHtml(t('Resolved'))} · <b>${escapeHtml(first.author)}</b>: ${escapeHtml(first.body.split('\n')[0].slice(0, 120))}</summary>${items}${actions}</details>`);
			} else {
				parts.push(`<div class="thread${pending ? ' pending' : ''}">${items}${actions}</div>`);
			}
		}
	}
	return parts.join('');
}

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface Settings {
	whitespace: WhitespaceMode;
	sideBySide: boolean;
	softWrap: boolean;
	collapse: boolean;
	highlight: HighlightMode;
	context: number;
}

export interface DiffData {
	path: string;
	repoName: string;
	leftTitle: string;
	rightTitle: string;
	status: string;
	left: string | null;
	right: string | null;
	leftMissing: boolean;
	rightMissing: boolean;
	binary: boolean;
	tooLarge: boolean;
	mode: 'local' | 'staged' | 'unstaged' | 'readonly';
	capabilities: { revert: boolean; include: boolean; stage: boolean; unstage: boolean; source: boolean };
	included: boolean;
	excluded: string[];
	fileIndex: number;
	files: { path: string; status: string }[];
	settings: Settings;
	review?: { title: string; comments: ReviewComment[]; pending: number };
	fileList?: string;
	chunkLists?: Record<string, string>;
	focus?: { change: LineChange; id: number };
	commit?: { hash: string; subject: string; body: string; author: string; authorEmail: string; authorDate: number; issueRules: IssueRule[] };
}

export interface Model {
	oldLines: string[];
	newLines: string[];
	chunks: DiffChunk[];
	keys: string[];
	hlOld: Segment[][];
	hlNew: Segment[][];
	words: Map<number, { oldRanges: { start: number; end: number }[]; newRanges: { start: number; end: number }[]; oldOffsets: number[]; newOffsets: number[] }>;
}

export function buildModel(d: DiffData, s: Settings): Model {
	const oldLines = splitLines(d.left ?? '');
	const newLines = splitLines(d.right ?? '');
	const lineChunks = diffLines(oldLines, newLines, { whitespace: s.whitespace });
	const chunks = s.highlight === 'split' ? splitChunks(lineChunks) : lineChunks;
	const keys = chunks.map((c) => chunkKey(c, oldLines, newLines));
	const lang = languageFor(d.path);
	const hlOld = highlightLines(d.left ?? '', lang, oldLines.length);
	const hlNew = highlightLines(d.right ?? '', lang, newLines.length);
	const words: Model['words'] = new Map();
	if (s.highlight === 'words' || s.highlight === 'split' || s.highlight === 'chars') {
		chunks.forEach((c, i) => {
			if (c.oldEnd === c.oldStart || c.newEnd === c.newStart || c.oldEnd - c.oldStart + c.newEnd - c.newStart > 400) {
				return;
			}
			const oldPart = oldLines.slice(c.oldStart, c.oldEnd).map(stripEol);
			const newPart = newLines.slice(c.newStart, c.newEnd).map(stripEol);
			const offsets = (lines: string[]) => {
				const out: number[] = [];
				let pos = 0;
				for (const l of lines) {
					out.push(pos);
					pos += l.length + 1;
				}
				return out;
			};
			const r = diffWords(oldPart.join('\n'), newPart.join('\n'), s.whitespace !== 'none', s.highlight === 'chars');
			words.set(i, { ...r, oldOffsets: offsets(oldPart), newOffsets: offsets(newPart) });
		});
	}
	return { oldLines, newLines, chunks, keys, hlOld, hlNew, words };
}

export const markClass = (el: HTMLElement) => ['ins', 'del', 'mod', 'excluded', 'current'].filter((c) => el.classList.contains(c)).join(' ');

export function chunkKind(c: DiffChunk): 'ins' | 'del' | 'mod' {
	if (c.oldStart === c.oldEnd) {
		return 'ins';
	}
	if (c.newStart === c.newEnd) {
		return 'del';
	}
	return 'mod';
}

export function lineHtml(m: Model, side: 'old' | 'new', lineIndex: number, chunkIndex?: number): string {
	const segs = side === 'old' ? m.hlOld[lineIndex] ?? [] : m.hlNew[lineIndex] ?? [];
	let marks: { start: number; end: number }[] = [];
	if (chunkIndex !== undefined) {
		const w = m.words.get(chunkIndex);
		if (w) {
			const c = m.chunks[chunkIndex];
			const k = side === 'old' ? lineIndex - c.oldStart : lineIndex - c.newStart;
			const offsets = side === 'old' ? w.oldOffsets : w.newOffsets;
			const lines = side === 'old' ? m.oldLines : m.newLines;
			const start = offsets[k];
			marks = rangesInLine(side === 'old' ? w.oldRanges : w.newRanges, start, start + stripEol(lines[lineIndex]).length);
		}
	}
	const html = renderSegments(segs, marks);
	return html || '&#8203;';
}

export type Block = { type: 'equal'; oldStart: number; newStart: number; oldCount: number; newCount: number } | { type: 'fold'; oldStart: number; newStart: number; count: number } | { type: 'chunk'; index: number };

export function buildBlocks(m: Model, collapse: boolean, context: number, expanded: Set<number>): Block[] {
	const blocks: Block[] = [];
	let oldPos = 0;
	let newPos = 0;
	const pushEqual = (oldCount: number, newCount: number, atStart: boolean, atEnd: boolean) => {
		if (oldCount <= 0 && newCount <= 0) {
			return;
		}
		const count = oldCount;
		const head = atStart ? 0 : context;
		const tail = atEnd ? 0 : context;
		if (!collapse || oldCount !== newCount || count <= head + tail + 2 || expanded.has(oldPos)) {
			blocks.push({ type: 'equal', oldStart: oldPos, newStart: newPos, oldCount, newCount });
		} else {
			if (head) {
				blocks.push({ type: 'equal', oldStart: oldPos, newStart: newPos, oldCount: head, newCount: head });
			}
			const hidden = count - head - tail;
			blocks.push({ type: 'fold', oldStart: oldPos, newStart: newPos, count: hidden });
			if (tail) {
				blocks.push({ type: 'equal', oldStart: oldPos + head + hidden, newStart: newPos + head + hidden, oldCount: tail, newCount: tail });
			}
		}
		oldPos += oldCount;
		newPos += newCount;
	};
	m.chunks.forEach((c, i) => {
		pushEqual(c.oldStart - oldPos, c.newStart - newPos, oldPos === 0, false);
		oldPos = c.oldEnd;
		newPos = c.newEnd;
		blocks.push({ type: 'chunk', index: i });
	});
	pushEqual(m.oldLines.length - oldPos, m.newLines.length - newPos, oldPos === 0, true);
	return blocks;
}

export interface SidesHtml {
	left: string;
	right: string;
	actions: string;
	bands: Map<number, string>;
}

export function renderSides(m: Model, blocks: Block[], d: DiffData, s: Settings, current: number): SidesHtml {
	const left: string[] = [];
	const right: string[] = [];
	const actions: string[] = [];
	const bands = new Map<number, string>();
	const threads = buildThreads(d.review?.comments);
	const caps = d.capabilities;
	const excluded = new Set(d.excluded);
	const includeEnabled = caps.include && s.whitespace === 'none' && s.highlight !== 'split';
	for (const b of blocks) {
		if (b.type === 'equal') {
			for (let o = b.oldStart; o < b.oldStart + b.oldCount; o++) {
				left.push(`<div class="line"><span class="ln" data-oline="${o + 1}">${o + 1}</span><span class="code">${lineHtml(m, 'old', o)}</span></div>`);
				if (threads.size) {
					left.push(threadHtml(threads, 'LEFT', o + 1, o + 1));
				}
			}
			for (let n = b.newStart; n < b.newStart + b.newCount; n++) {
				right.push(`<div class="line"><span class="ln" data-line="${n + 1}">${n + 1}</span><span class="code">${lineHtml(m, 'new', n)}</span></div>`);
				if (threads.size) {
					right.push(threadHtml(threads, 'RIGHT', n + 1, n + 1));
				}
			}
		} else if (b.type === 'fold') {
			const fold = `<div class="fold" data-fold="${b.oldStart}"><span class="fold-label"><span class="codicon codicon-unfold"></span> ${escapeHtml(plural(b.count, '{0} unchanged line', '{0} unchanged lines'))}</span></div>`;
			left.push(fold);
			right.push(fold);
		} else {
			const c = m.chunks[b.index];
			const key = m.keys[b.index];
			const isExcluded = includeEnabled && (!d.included || excluded.has(key));
			const cls = `ch ${chunkKind(c)}${isExcluded ? ' excluded' : ''}${b.index === current ? ' current' : ''}`;
			bands.set(b.index, `band ${chunkKind(c)}${isExcluded ? ' excluded' : ''}${b.index === current ? ' current' : ''}`);
			const oldLines: string[] = [];
			for (let i = c.oldStart; i < c.oldEnd; i++) {
				oldLines.push(`<div class="line"><span class="ln" data-oline="${i + 1}">${i + 1}</span><span class="code">${lineHtml(m, 'old', i, b.index)}</span></div>`);
			}
			const newLines: string[] = [];
			for (let i = c.newStart; i < c.newEnd; i++) {
				newLines.push(`<div class="line"><span class="ln" data-line="${i + 1}">${i + 1}</span><span class="code">${lineHtml(m, 'new', i, b.index)}</span></div>`);
			}
			const listName = d.chunkLists?.[key];
			const listLabel = listName && listName !== d.fileList ? `<div class="chunk-cl"><span class="codicon codicon-list-unordered"></span> ${escapeHtml(listName)}</div>` : '';
			left.push(`<div class="${cls}" data-chunk="${b.index}">${oldLines.join('')}</div>`);
			right.push(`<div class="${cls}${listLabel ? ' other-list' : ''}" data-chunk="${b.index}">${listLabel}${newLines.join('')}</div>`);
			if (threads.size) {
				left.push(threadHtml(threads, 'LEFT', c.oldStart + 1, c.oldEnd));
				right.push(threadHtml(threads, 'RIGHT', c.newStart + 1, c.newEnd));
			}
			const leftActs: string[] = [];
			const rightActs: string[] = [];
			if (caps.revert) {
				leftActs.push(`<button class="act" data-action="revert" data-key="${key}" title="${escapeHtml(t('Revert'))}">&raquo;</button>`);
			}
			if (caps.stage) {
				leftActs.push(`<button class="act" data-action="stage" data-key="${key}" title="${escapeHtml(t('Stage this change'))}"><span class="codicon codicon-add"></span></button>`);
			}
			if (caps.unstage) {
				leftActs.push(`<button class="act" data-action="unstage" data-key="${key}" title="${escapeHtml(t('Unstage this change'))}"><span class="codicon codicon-remove"></span></button>`);
			}
			if (includeEnabled) {
				rightActs.push(`<input type="checkbox" class="inc" data-key="${key}" title="${escapeHtml(t('Include into commit'))}" ${isExcluded ? '' : 'checked'}>`);
			}
			if (caps.include) {
				rightActs.push(`<button class="act move" data-action="move" data-key="${key}" title="${escapeHtml(listName ? t('Move to Another Changelist (now: {0})', listName) : t('Move to Another Changelist'))}"><span class="codicon codicon-arrow-swap"></span></button>`);
			}
			if (leftActs.length) {
				actions.push(`<div class="acts l" data-acts="${b.index}" data-pane="0">${leftActs.join('')}</div>`);
			}
			if (rightActs.length) {
				actions.push(`<div class="acts r" data-acts="${b.index}" data-pane="1">${rightActs.join('')}</div>`);
			}
		}
	}
	return { left: `<div class="content">${left.join('')}</div>`, right: `<div class="content">${right.join('')}</div>`, actions: actions.join(''), bands };
}

export function renderUnified(m: Model, blocks: Block[], d: DiffData, s: Settings, current: number): string {
	const out: string[] = [];
	const threads = buildThreads(d.review?.comments);
	const caps = d.capabilities;
	const excluded = new Set(d.excluded);
	const includeEnabled = caps.include && s.whitespace === 'none' && s.highlight !== 'split';
	for (const b of blocks) {
		if (b.type === 'equal') {
			for (let k = 0; k < b.newCount; k++) {
				const o = b.oldStart + k;
				const n = b.newStart + k;
				const oldNumber = b.oldCount === b.newCount ? `<span class="ln" data-oline="${o + 1}">${o + 1}</span>` : '<span class="ln"></span>';
				out.push(`<div class="u-line eq">${oldNumber}<span class="ln" data-line="${n + 1}">${n + 1}</span><span class="code">${lineHtml(m, 'new', n)}</span></div>`);
				if (threads.size) {
					out.push(threadHtml(threads, 'LEFT', o + 1, o + 1) + threadHtml(threads, 'RIGHT', n + 1, n + 1));
				}
			}
		} else if (b.type === 'fold') {
			out.push(`<div class="fold" data-fold="${b.oldStart}"><span class="fold-label"><span class="codicon codicon-unfold"></span> ${escapeHtml(plural(b.count, '{0} unchanged line', '{0} unchanged lines'))}</span></div>`);
		} else {
			const c = m.chunks[b.index];
			const key = m.keys[b.index];
			const isExcluded = includeEnabled && (!d.included || excluded.has(key));
			const actions: string[] = [];
			if (caps.revert) {
				actions.push(`<button class="act" data-action="revert" data-key="${key}" title="${escapeHtml(t('Revert'))}">&raquo; ${escapeHtml(t('Revert'))}</button>`);
			}
			if (caps.stage) {
				actions.push(`<button class="act" data-action="stage" data-key="${key}" title="${escapeHtml(t('Stage this change'))}">+ ${escapeHtml(t('Stage'))}</button>`);
			}
			if (caps.unstage) {
				actions.push(`<button class="act" data-action="unstage" data-key="${key}" title="${escapeHtml(t('Unstage this change'))}">− ${escapeHtml(t('Unstage'))}</button>`);
			}
			if (includeEnabled) {
				actions.push(`<label class="inc-label"><input type="checkbox" class="inc" data-key="${key}" ${isExcluded ? '' : 'checked'}> ${escapeHtml(t('Include'))}</label>`);
			}
			if (caps.include) {
				const listName = d.chunkLists?.[key];
				actions.push(`<button class="act" data-action="move" data-key="${key}" title="${escapeHtml(t('Move to Another Changelist'))}">⇄ ${listName ? escapeHtml(listName) : escapeHtml(t('Changelist'))}</button>`);
			}
			const lines: string[] = [];
			for (let i = c.oldStart; i < c.oldEnd; i++) {
				lines.push(`<div class="u-line del"><span class="ln" data-oline="${i + 1}">${i + 1}</span><span class="ln"></span><span class="code">${lineHtml(m, 'old', i, b.index)}</span></div>`);
				lines.push(threadHtml(threads, 'LEFT', i + 1, i + 1));
			}
			for (let i = c.newStart; i < c.newEnd; i++) {
				lines.push(`<div class="u-line ins"><span class="ln"></span><span class="ln" data-line="${i + 1}">${i + 1}</span><span class="code">${lineHtml(m, 'new', i, b.index)}</span></div>`);
				lines.push(threadHtml(threads, 'RIGHT', i + 1, i + 1));
			}
			out.push(
				`<div class="u-chunk ${chunkKind(c)}${isExcluded ? ' excluded' : ''}${b.index === current ? ' current' : ''}" data-chunk="${b.index}">` +
					(actions.length ? `<div class="u-actions">${actions.join('')}</div>` : '') +
					lines.join('') +
					`</div>`,
			);
		}
	}
	return `<div class="content">${out.join('')}</div>`;
}
