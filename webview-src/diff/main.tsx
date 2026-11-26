import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { chunkKey, DiffChunk, diffLines, diffWords, HighlightMode, rangesInLine, splitChunks, splitLines, stripEol, WhitespaceMode } from '../../src/shared/diff';
import { chunkForLineChange, LineChange } from '../../src/shared/lineChanges';
import { Checkbox, Icon, IconButton, useKeys } from '../common/components';
import { basename, dirname, fullDate } from '../common/format';
import { highlightLines, languageFor, renderSegments, Segment } from '../common/highlight';
import { call, on } from '../common/rpc';
import MarkdownIt from 'markdown-it';
import { language, plural, t } from '../common/l10n';
import { LinkedPanes } from '../common/linkedPanes';
import { measureMarks, OverviewRuler } from '../common/overview';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

interface ReviewComment {
	id: string;
	author: string;
	createdAt: string;
	body: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	thread?: string;
}

type Threads = Map<string, ReviewComment[]>;

function buildThreads(comments: ReviewComment[] | undefined): Threads {
	const map: Threads = new Map();
	for (const c of comments ?? []) {
		const key = `${c.side}:${c.line}`;
		const arr = map.get(key) ?? [];
		arr.push(c);
		map.set(key, arr);
	}
	return map;
}

function threadHtml(item: Threads, side: 'LEFT' | 'RIGHT', from: number, to: number): string {
	const parts: string[] = [];
	for (let line = from; line <= to; line++) {
		const list = item.get(`${side}:${line}`);
		if (!list) {
			continue;
		}
		const items = list
			.map((c) => `<div class="cmt"><div class="cmt-head"><b>${escapeHtml(c.author)}</b> <span class="cmt-meta">${escapeHtml(t('line {0}', c.line))} · ${escapeHtml(new Date(c.createdAt).toLocaleString(language))}</span></div><div class="cmt-body">${md.render(c.body)}</div></div>`)
			.join('');
		const root = list[0];
		parts.push(`<div class="thread">${items}<button class="jg-link reply" data-reply="${escapeHtml(root.thread ?? root.id)}" data-rline="${line}" data-rside="${side}">${escapeHtml(t('Reply'))}</button></div>`);
	}
	return parts.join('');
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

interface Settings {
	whitespace: WhitespaceMode;
	sideBySide: boolean;
	softWrap: boolean;
	collapse: boolean;
	highlight: HighlightMode;
	context: number;
}

interface DiffData {
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
	review?: { title: string; comments: ReviewComment[] };
	fileList?: string;
	chunkLists?: Record<string, string>;
	focus?: LineChange;
	commit?: { hash: string; subject: string; body: string; author: string; authorEmail: string; authorDate: number };
}

interface Model {
	oldLines: string[];
	newLines: string[];
	chunks: DiffChunk[];
	keys: string[];
	hlOld: Segment[][];
	hlNew: Segment[][];
	words: Map<number, { oldRanges: { start: number; end: number }[]; newRanges: { start: number; end: number }[]; oldOffsets: number[]; newOffsets: number[] }>;
}

function buildModel(d: DiffData, s: Settings): Model {
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

const markClass = (el: HTMLElement) => ['ins', 'del', 'mod', 'excluded', 'current'].filter((c) => el.classList.contains(c)).join(' ');

function chunkKind(c: DiffChunk): 'ins' | 'del' | 'mod' {
	if (c.oldStart === c.oldEnd) {
		return 'ins';
	}
	if (c.newStart === c.newEnd) {
		return 'del';
	}
	return 'mod';
}

function lineHtml(m: Model, side: 'old' | 'new', lineIndex: number, chunkIndex?: number): string {
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

type Block = { type: 'equal'; oldStart: number; newStart: number; oldCount: number; newCount: number } | { type: 'fold'; oldStart: number; newStart: number; count: number } | { type: 'chunk'; index: number };

function buildBlocks(m: Model, collapse: boolean, context: number, expanded: Set<number>): Block[] {
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

interface SidesHtml {
	left: string;
	right: string;
	actions: string;
	bands: Map<number, string>;
}

function renderSides(m: Model, blocks: Block[], d: DiffData, s: Settings, current: number): SidesHtml {
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

function renderUnified(m: Model, blocks: Block[], d: DiffData, s: Settings, current: number): string {
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

function App() {
	const [data, setData] = useState<DiffData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [settings, setSettings] = useState<Settings | null>(null);
	const [current, setCurrent] = useState(0);
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const bodyRef = useRef<HTMLDivElement>(null);
	const leftRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const actsRef = useRef<HTMLDivElement>(null);
	const linksRef = useRef<LinkedPanes | undefined>(undefined);
	const bandsRef = useRef<Map<number, string>>(new Map());
	const focusRef = useRef<LineChange | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [composer, setComposer] = useState<{ line: number; side: 'LEFT' | 'RIGHT'; inReplyTo?: string; text: string } | null>(null);

	useEffect(() => {
		const apply = (d: DiffData) => {
			if (d.focus) {
				focusRef.current = d.focus;
			}
			setData((prev) => {
				if (!prev || prev.path !== d.path || prev.fileIndex !== d.fileIndex) {
					setExpanded(new Set());
					setCurrent(0);
					if (bodyRef.current) {
						bodyRef.current.scrollTop = 0;
					}
				}
				return d;
			});
			setSettings((s) => s ?? d.settings);
			setError(null);
		};
		const off1 = on<DiffData>('data', apply);
		const off2 = on<string>('error', setError);
		call<DiffData>('ready').then(apply, (e) => setError(String(e)));
		return () => {
			off1();
			off2();
		};
	}, []);

	const s = settings ?? data?.settings;
	const model = useMemo(() => (data && s && !data.binary && !data.tooLarge ? buildModel(data, s) : null), [data, s?.whitespace, s?.highlight]);
	const blocks = useMemo(() => (model && s ? buildBlocks(model, s.collapse, s.context, expanded) : []), [model, s?.collapse, s?.context, expanded]);
	const html = useMemo(() => {
		if (!model || !data || !s) {
			return '';
		}
		return s.sideBySide ? renderSides(model, blocks, data, s, current) : renderUnified(model, blocks, data, s, current);
	}, [model, blocks, data, s?.sideBySide, current]);

	const placeActions = () => {
		const links = linksRef.current;
		const layer = actsRef.current;
		if (!links || !layer) {
			return;
		}
		for (const el of layer.querySelectorAll<HTMLElement>('.acts')) {
			const box = links.visibleBox(Number(el.dataset.pane), Number(el.dataset.acts));
			const visible = !!box && box.top + 24 > 0 && box.top < layer.clientHeight;
			el.style.display = visible ? '' : 'none';
			if (box) {
				el.style.top = `${Math.max(0, box.top)}px`;
			}
		}
	};

	useEffect(() => {
		const master = bodyRef.current;
		if (!master) {
			return;
		}
		const top = master.scrollTop;
		if (typeof html === 'string') {
			master.innerHTML = html;
		} else {
			master.innerHTML = html.right;
			if (leftRef.current) {
				leftRef.current.innerHTML = html.left;
			}
			if (actsRef.current) {
				actsRef.current.innerHTML = html.actions;
			}
			bandsRef.current = html.bands;
		}
		master.scrollTop = top;
		linksRef.current?.refresh();
	}, [html]);

	const sideBySide = !!s?.sideBySide;
	const loaded = !!data && !!s;
	useEffect(() => {
		const master = bodyRef.current;
		if (!master) {
			return;
		}
		const panes = sideBySide && leftRef.current ? [leftRef.current, master] : [master];
		const dividers = sideBySide && svgRef.current ? [svgRef.current] : [];
		const links = new LinkedPanes(panes, dividers, (_k, i) => bandsRef.current.get(i), placeActions);
		linksRef.current = links;
		links.refresh();
		return () => {
			links.dispose();
			linksRef.current = undefined;
		};
	}, [sideBySide, loaded]);

	const update = (patch: Partial<Settings>) => {
		const next = { ...s!, ...patch };
		setSettings(next);
		void call('saveSettings', patch);
	};

	const act = async (method: string, params: unknown) => {
		setBusy(true);
		try {
			await call(method, params);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	};

	const scrollToChunk = (i: number) => {
		linksRef.current?.reveal(i);
	};

	const go = (delta: number) => {
		if (!model || !model.chunks.length) {
			return;
		}
		const next = current + delta;
		if (next < 0 || next >= model.chunks.length) {
			if (data && data.files.length > 1) {
				const f = data.fileIndex + delta;
				if (f >= 0 && f < data.files.length) {
					void navigate(f);
				}
			}
			return;
		}
		setCurrent(next);
		setTimeout(() => scrollToChunk(next), 0);
	};

	const navigate = async (index: number) => {
		const d = await call<DiffData | undefined>('navigate', { index });
		if (d) {
			setData(d);
			setExpanded(new Set());
			setCurrent(0);
			if (bodyRef.current) {
				bodyRef.current.scrollTop = 0;
			}
		}
	};

	useEffect(() => {
		if (model && model.chunks.length) {
			setTimeout(() => scrollToChunk(Math.min(current, model.chunks.length - 1)), 0);
		}
	}, [data?.path, data?.fileIndex]);

	useEffect(() => {
		const focus = focusRef.current;
		if (!focus || !model) {
			return;
		}
		focusRef.current = undefined;
		const i = chunkForLineChange(model.chunks, focus);
		if (i >= 0) {
			setCurrent(i);
			setTimeout(() => scrollToChunk(i), 0);
		}
	}, [model]);

	useKeys(
		(e) => {
			if (e.key === 'F7') {
				e.preventDefault();
				go(e.shiftKey ? -1 : 1);
			} else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && data) {
				e.preventDefault();
				const f = data.fileIndex + (e.key === 'ArrowRight' ? 1 : -1);
				if (f >= 0 && f < data.files.length) {
					void navigate(f);
				}
			} else if (e.key === 'F4' || (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey))) {
				e.preventDefault();
				void call('openSource', { line: model && model.chunks[current] ? model.chunks[current].newStart + 1 : 1 });
			}
		},
	);

	const onBodyClick = (e: MouseEvent) => {
		const entry = e.target as HTMLElement;
		if (data?.review) {
			const reply = entry.closest('[data-reply]') as HTMLElement | null;
			if (reply) {
				setComposer({ line: Number(reply.dataset.rline), side: reply.dataset.rside as 'LEFT' | 'RIGHT', inReplyTo: reply.dataset.reply, text: '' });
				return;
			}
			const ln = entry.closest('.ln') as HTMLElement | null;
			if (ln && (ln.dataset.line || ln.dataset.oline)) {
				setComposer({ line: Number(ln.dataset.line ?? ln.dataset.oline), side: ln.dataset.line ? 'RIGHT' : 'LEFT', text: '' });
				return;
			}
		}
		const fold = entry.closest('[data-fold]') as HTMLElement | null;
		if (fold) {
			const next = new Set(expanded);
			next.add(Number(fold.dataset.fold));
			setExpanded(next);
			return;
		}
		const btn = entry.closest('[data-action]') as HTMLElement | null;
		if (btn && !busy) {
			const action = btn.dataset.action!;
			const key = btn.dataset.key!;
			if (action === 'move') {
				void act('moveChunk', { key });
				return;
			}
			void act(action === 'revert' ? 'revertChunk' : action === 'stage' ? 'stageChunk' : 'unstageChunk', { key, whitespace: s!.whitespace, split: s!.highlight === 'split' });
			return;
		}
		if (entry instanceof HTMLInputElement && entry.classList.contains('inc')) {
			void act('toggleChunk', { key: entry.dataset.key, included: entry.checked, whitespace: s!.whitespace, split: s!.highlight === 'split' });
			return;
		}
		const chunk = entry.closest('[data-chunk]') as HTMLElement | null;
		if (chunk) {
			setCurrent(Number(chunk.dataset.chunk));
		}
	};

	const onBodyDblClick = (e: MouseEvent) => {
		const element = e.target as HTMLElement;
		const line = element.closest('.line, .u-line') as HTMLElement | null;
		const ln = line?.querySelector('[data-line]') as HTMLElement | null;
		if (ln && data?.capabilities.source) {
			void call('openSource', { line: Number(ln.dataset.line) });
		}
	};

	if (error && !data) {
		return <div class="jg-empty jg-error">{error}</div>;
	}
	if (!data || !s) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	const chunkCount = model?.chunks.length ?? 0;
	const identical = model && chunkCount === 0;
	const eolOnly = identical && data.left !== data.right && !data.leftMissing && !data.rightMissing;
	const lineCount = Math.max(model?.oldLines.length ?? 0, model?.newLines.length ?? 0);
	const lnWidth = `${Math.max(3, String(lineCount).length) + 1}ch`;
	const file = data.files[data.fileIndex];

	return (
		<div class="diff-view">
			<div class="jg-toolbar">
				<IconButton icon="arrow-up" title={t('Previous Difference (Shift+F7)')} disabled={!chunkCount} onClick={() => go(-1)} />
				<IconButton icon="arrow-down" title={t('Next Difference (F7)')} disabled={!chunkCount} onClick={() => go(1)} />
				{data.files.length > 1 && (
					<>
						<span class="sep" />
						<IconButton icon="arrow-left" title={t('Previous File (Alt+Left)')} disabled={data.fileIndex === 0} onClick={() => navigate(data.fileIndex - 1)} />
						<select class="file-select" value={data.fileIndex} onChange={(e) => navigate(Number((e.target as HTMLSelectElement).value))}>
							{data.files.map((f, i) => (
								<option value={i}>
									{basename(f.path)} {dirname(f.path) ? `(${dirname(f.path)})` : ''}
								</option>
							))}
						</select>
						<IconButton icon="arrow-right" title={t('Next File (Alt+Right)')} disabled={data.fileIndex >= data.files.length - 1} onClick={() => navigate(data.fileIndex + 1)} />
						<span class="jg-muted counter">
							{data.fileIndex + 1}/{data.files.length}
						</span>
					</>
				)}
				<span class="sep" />
				<select title={t('Viewer')} value={s.sideBySide ? 'side' : 'unified'} onChange={(e) => update({ sideBySide: (e.target as HTMLSelectElement).value === 'side' })}>
					<option value="side">{t('Side-by-side viewer')}</option>
					<option value="unified">{t('Unified viewer')}</option>
				</select>
				<select title={t('Whitespace')} value={s.whitespace} onChange={(e) => update({ whitespace: (e.target as HTMLSelectElement).value as WhitespaceMode })}>
					<option value="none">{t('Do not ignore')}</option>
					<option value="trim">{t('Trim whitespaces')}</option>
					<option value="all">{t('Ignore whitespaces')}</option>
					<option value="emptyLines">{t('Ignore whitespaces and empty lines')}</option>
				</select>
				<select title={t('Highlighting')} value={s.highlight} onChange={(e) => update({ highlight: (e.target as HTMLSelectElement).value as HighlightMode })}>
					<option value="words">{t('Highlight words')}</option>
					<option value="lines">{t('Highlight lines')}</option>
					<option value="split">{t('Highlight split changes')}</option>
					<option value="chars">{t('Highlight characters')}</option>
					<option value="none">{t('Do not highlight')}</option>
				</select>
				<IconButton icon="fold" title={t('Collapse unchanged fragments')} active={s.collapse} onClick={() => update({ collapse: !s.collapse })} />
				<IconButton icon="word-wrap" title={t('Use soft wraps')} active={s.softWrap} onClick={() => update({ softWrap: !s.softWrap })} />
				<span class="spacer" />
				{data.capabilities.include && (
					<Checkbox checked={data.included} onChange={(v) => act('includeFile', { included: v })} label={t('Include into commit')} />
				)}
				<span class="jg-muted counter">{data.binary ? t('binary') : identical ? t('no differences') : plural(chunkCount, '{0} difference', '{0} differences')}</span>
				<IconButton icon="go-to-file" title={t('Jump to Source (F4)')} disabled={!data.capabilities.source} onClick={() => call('openSource', { line: model && model.chunks[current] ? model.chunks[current].newStart + 1 : 1 })} />
				<IconButton icon="history" title={t('Show History')} onClick={() => call('showHistory')} />
				<IconButton icon="split-horizontal" title={t('Open in VS Code Diff Editor')} onClick={() => call('openNative')} />
			</div>
			{error && <div class="banner jg-error">{error}</div>}
			{data.commit && (
				<div class="commit-info">
					<div class="commit-message">{data.commit.body.trim() ? `${data.commit.subject}\n\n${data.commit.body.trim()}` : data.commit.subject}</div>
					<div class="jg-muted commit-meta">
						<Icon name="account" /> {data.commit.author} &lt;{data.commit.authorEmail}&gt; · {fullDate(data.commit.authorDate)} · <span class="commit-hash">{data.commit.hash}</span>
					</div>
				</div>
			)}
			<div class="titles" style={{ '--lnw': lnWidth } as any}>
				{s.sideBySide ? (
					<>
						<div class="title l" title={data.leftTitle}>
							<Icon name="git-commit" /> {data.leftMissing ? `${data.leftTitle} (file did not exist)` : data.leftTitle}
						</div>
						<div class="title gutter-title" />
						<div class="title r" title={file?.path}>
							<Icon name={data.mode === 'local' || data.mode === 'unstaged' ? 'edit' : 'git-commit'} /> {data.rightMissing ? `${data.rightTitle} (deleted)` : data.rightTitle}
							<span class="jg-muted path"> {data.path}</span>
						</div>
					</>
				) : (
					<div class="title">
						{data.leftTitle} → {data.rightTitle} <span class="jg-muted path">{data.path}</span>
					</div>
				)}
			</div>
			{data.binary || data.tooLarge ? (
				<div class="jg-empty">
					<p>{data.binary ? t('Binary files differ') : t('File is too large for the diff viewer.')}</p>
					<button class="jg-btn" onClick={() => call('openNative')}>
						{t('Open in VS Code')}
					</button>
				</div>
			) : identical ? (
				<div class="jg-empty">{eolOnly ? t('Contents are identical (only line separators differ)') : data.leftMissing && data.rightMissing ? t('No content') : t('Contents are identical')}</div>
			) : null}
			<div class="diff-scroll" style={{ display: data.binary || data.tooLarge || identical ? 'none' : undefined }} onClick={onBodyClick as any} onDblClick={onBodyDblClick as any}>
				{s.sideBySide ? (
					<div class={`diff-body side jg-code${s.highlight === 'none' ? ' hl-none' : ''}${busy ? ' busy' : ''}${data.review ? ' review' : ''}${s.softWrap ? ' wrap' : ''}`} style={{ '--lnw': lnWidth } as any}>
						<div ref={leftRef} class="pane l" tabIndex={0} />
						<div class="divider">
							<svg ref={svgRef} class="bands" />
							<div ref={actsRef} class="acts-layer" />
						</div>
						<div ref={bodyRef} class="pane r" tabIndex={0} />
					</div>
				) : (
					<div ref={bodyRef} class={`diff-body unified pane jg-code${s.highlight === 'none' ? ' hl-none' : ''}${busy ? ' busy' : ''}${data.review ? ' review' : ''}${s.softWrap ? ' wrap' : ''}`} style={{ '--lnw': lnWidth } as any} tabIndex={0} />
				)}
				<OverviewRuler
					target={bodyRef}
					revision={html}
					measure={(el) => measureMarks(el, '[data-chunk]', markClass)}
					onMark={(i) => {
						setCurrent(i);
						scrollToChunk(i);
					}}
				/>
			</div>
			{data.review && (
				<div class="review-bar">
					{composer ? (
						<div class="composer">
							<div class="composer-title">
								{composer.inReplyTo
									? composer.side === 'RIGHT'
										? t('Reply on line {0} (new version)', composer.line)
										: t('Reply on line {0} (old version)', composer.line)
									: composer.side === 'RIGHT'
										? t('New comment on line {0} (new version)', composer.line)
										: t('New comment on line {0} (old version)', composer.line)}{' '}
								· {data.review.title}
							</div>
							<textarea
								rows={4}
								value={composer.text}
								ref={(el) => {
									if (el && !composer.text) {
										setTimeout(() => el.focus(), 0);
									}
								}}
								onInput={(e) => setComposer({ ...composer, text: (e.target as HTMLTextAreaElement).value })}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && composer.text.trim()) {
										e.preventDefault();
										void act('addComment', { line: composer.line, side: composer.side, body: composer.text, inReplyTo: composer.inReplyTo }).then(() => setComposer(null));
									} else if (e.key === 'Escape') {
										setComposer(null);
									}
								}}
							/>
							<div class="composer-buttons">
								<button class="jg-btn" onClick={() => setComposer(null)}>
									{t('Cancel')}
								</button>
								<button
									class="jg-btn primary"
									disabled={busy || !composer.text.trim()}
									onClick={() => act('addComment', { line: composer.line, side: composer.side, body: composer.text, inReplyTo: composer.inReplyTo }).then(() => setComposer(null))}
								>
									{composer.inReplyTo ? t('Reply') : t('Add Comment')}
								</button>
							</div>
						</div>
					) : (
						<span class="jg-muted">
							<Icon name="comment-discussion" /> {data.review.title} · {plural(data.review.comments.length, '{0} comment in this file', '{0} comments in this file')} · {t('click a line number to comment')}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

render(<App />, document.getElementById('app')!);
