import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { detectEol, diffWords, rangesInLine, splitLines, stripEol, TextRange } from '../../src/shared/diff';
import { ChangeBlock, computeMerge, MergeBlock, resolveSimpleConflict } from '../../src/shared/diff3';
import { Icon, IconButton, PopupMenu, useKeys } from '../common/components';
import { LinkedPanes } from '../common/linkedPanes';
import { highlightLines, languageFor, renderSegments, Segment } from '../common/highlight';
import { call } from '../common/rpc';
import { plural, t } from '../common/l10n';

interface MergeSettings {
	whitespace: 'none' | 'trim' | 'all';
	highlight: 'words' | 'lines' | 'none';
	softWrap: boolean;
}

interface MergeData {
	settings: MergeSettings;
	title: string;
	path: string;
	base: string;
	left: string;
	right: string;
	leftTitle: string;
	rightTitle: string;
}

type SideState = 'pending' | 'applied' | 'ignored' | 'none';

interface BlockState {
	left: SideState;
	right: SideState;
	order: ('left' | 'right')[];
	edited?: string;
}

const CONTEXT = 3;

function initialState(b: ChangeBlock): BlockState {
	switch (b.kind) {
		case 'left':
			return { left: 'pending', right: 'none', order: [] };
		case 'right':
			return { left: 'none', right: 'pending', order: [] };
		default:
			return { left: 'pending', right: 'pending', order: [] };
	}
}

function isResolved(s: BlockState): boolean {
	return s.edited !== undefined || (s.left !== 'pending' && s.right !== 'pending');
}

/** Changed characters of each side line against the base, split per line. */
function sideMarks(base: string[], side: string[]): TextRange[][] {
	const baseText = base.map(stripEol).join('\n');
	const sideLines = side.map(stripEol);
	const ranges = diffWords(baseText, sideLines.join('\n')).newRanges;
	let offset = 0;
	return sideLines.map((line) => {
		const out = rangesInLine(ranges, offset, offset + line.length);
		offset += line.length + 1;
		return out;
	});
}

function App() {
	const [data, setData] = useState<MergeData | null>(null);
	const [states, setStates] = useState<Map<number, BlockState>>(new Map());
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const [current, setCurrent] = useState(-1);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [settings, setSettings] = useState<MergeSettings | null>(null);
	const leftRef = useRef<HTMLDivElement>(null);
	const resultRef = useRef<HTMLDivElement>(null);
	const rightRef = useRef<HTMLDivElement>(null);
	const leftBands = useRef<SVGSVGElement>(null);
	const rightBands = useRef<SVGSVGElement>(null);
	const leftLayer = useRef<HTMLDivElement>(null);
	const rightLayer = useRef<HTMLDivElement>(null);
	const linksRef = useRef<LinkedPanes | undefined>(undefined);
	const bandRef = useRef<(divider: number, index: number) => string | undefined>(() => undefined);

	useEffect(() => {
		call<MergeData>('ready').then((d) => {
			setSettings(d.settings);
			setData(d);
		});
	}, []);

	const updateSettings = (patch: Partial<MergeSettings>) => {
		setSettings((prev) => ({ ...prev!, ...patch }));
		void call('saveSettings', patch);
	};

	const model = useMemo(() => {
		if (!data || !settings) {
			return null;
		}
		const base = splitLines(data.base);
		const left = splitLines(data.left);
		const right = splitLines(data.right);
		const blocks = computeMerge(base, left, right, { whitespace: settings.whitespace });
		const lang = languageFor(data.path);
		return {
			base,
			left,
			right,
			blocks,
			hlLeft: highlightLines(data.left, lang, left.length),
			hlRight: highlightLines(data.right, lang, right.length),
			eol: detectEol(data.left || data.right || data.base),
		};
	}, [data, settings?.whitespace]);

	const marks = useMemo(() => {
		const m = new Map<number, { left: TextRange[][]; right: TextRange[][] }>();
		if (!model || settings?.highlight !== 'words') {
			return m;
		}
		model.blocks.forEach((b, i) => {
			if (b.type === 'change') {
				const base = model.base.slice(b.baseStart, b.baseEnd);
				m.set(i, { left: sideMarks(base, model.left.slice(b.leftStart, b.leftEnd)), right: sideMarks(base, model.right.slice(b.rightStart, b.rightEnd)) });
			}
		});
		return m;
	}, [model, settings?.highlight]);

	useEffect(() => {
		if (!model) {
			return;
		}
		const m = new Map<number, BlockState>();
		model.blocks.forEach((b, i) => {
			if (b.type === 'change') {
				m.set(i, initialState(b));
			}
		});
		setStates(m);
		const firstConflict = model.blocks.findIndex((b) => b.type === 'change');
		setCurrent(firstConflict);
	}, [model]);

	const changeIndexes = useMemo(() => (model ? model.blocks.map((b, i) => (b.type === 'change' ? i : -1)).filter((i) => i >= 0) : []), [model]);
	const unresolved = changeIndexes.filter((i) => states.get(i) && !isResolved(states.get(i)!));
	const conflictsLeft = unresolved.filter((i) => (model!.blocks[i] as ChangeBlock).kind === 'conflict').length;

	const sideText = (b: ChangeBlock, side: 'left' | 'right') =>
		side === 'left' ? model!.left.slice(b.leftStart, b.leftEnd).join('') : model!.right.slice(b.rightStart, b.rightEnd).join('');

	const resultText = (i: number): string => {
		const b = model!.blocks[i] as ChangeBlock;
		const s = states.get(i)!;
		if (s.edited !== undefined) {
			return s.edited;
		}
		if (b.kind === 'both' && (s.left === 'applied' || s.right === 'applied')) {
			return sideText(b, 'left');
		}
		if (!s.order.length) {
			return model!.base.slice(b.baseStart, b.baseEnd).join('');
		}
		return withEols(s.order.map((side) => sideText(b, side)), model!.eol);
	};

	const update = (i: number, fn: (s: BlockState, b: ChangeBlock) => BlockState) => {
		setStates((prev) => {
			const next = new Map(prev);
			next.set(i, fn(prev.get(i)!, model!.blocks[i] as ChangeBlock));
			return next;
		});
	};

	const apply = (i: number, side: 'left' | 'right') =>
		update(i, (s, b) => {
			if (b.kind === 'both') {
				return { left: 'applied', right: 'applied', order: [side] };
			}
			const order = [...s.order.filter((x) => x !== side), side];
			return { ...s, [side]: 'applied', order, edited: undefined };
		});

	const ignore = (i: number, side: 'left' | 'right') =>
		update(i, (s, b) => {
			if (b.kind === 'both') {
				return { left: 'ignored', right: 'ignored', order: [] };
			}
			return { ...s, [side]: 'ignored', order: s.order.filter((x) => x !== side) };
		});

	const applyNonConflicting = (which: 'left' | 'right' | 'all') => {
		setStates((prev) => {
			const next = new Map(prev);
			model!.blocks.forEach((b, i) => {
				if (b.type !== 'change' || b.kind === 'conflict') {
					return;
				}
				const s = next.get(i)!;
				if (isResolved(s)) {
					return;
				}
				if (b.kind === 'both' && which === 'all') {
					next.set(i, { left: 'applied', right: 'applied', order: ['left'] });
				} else if (b.kind === 'left' && which !== 'right') {
					next.set(i, { ...s, left: 'applied', order: ['left'] });
				} else if (b.kind === 'right' && which !== 'left') {
					next.set(i, { ...s, right: 'applied', order: ['right'] });
				}
			});
			return next;
		});
	};

	/** Magic wand: non-conflicting changes plus conflicts that merge on word level. */
	const resolveSimple = () => {
		applyNonConflicting('all');
		setStates((prev) => {
			const next = new Map(prev);
			model!.blocks.forEach((b, i) => {
				if (b.type !== 'change' || b.kind !== 'conflict' || isResolved(next.get(i)!)) {
					return;
				}
				const merged = resolveSimpleConflict(model!.base.slice(b.baseStart, b.baseEnd).join(''), sideText(b, 'left'), sideText(b, 'right'));
				if (merged !== undefined) {
					next.set(i, { left: 'applied', right: 'applied', order: ['left', 'right'], edited: merged });
				}
			});
			return next;
		});
	};

	const composeResult = (): string => {
		const out: string[] = [];
		model!.blocks.forEach((b, i) => {
			if (b.type === 'stable') {
				out.push(...model!.left.slice(b.leftStart, b.leftStart + (b.baseEnd - b.baseStart)));
			} else {
				const item = resultText(i);
				if (item) {
					out.push(item.endsWith('\n') || i === model!.blocks.length - 1 ? item : item + model!.eol);
				}
			}
		});
		return out.join('');
	};

	const changed = changeIndexes.some((i) => {
		const s = states.get(i);
		return s && (s.order.length > 0 || s.edited !== undefined || s.left === 'ignored' || s.right === 'ignored');
	});

	const submit = async (result?: string) => {
		setBusy(true);
		try {
			await call('apply', { result: result ?? composeResult(), unresolved: result !== undefined ? 0 : unresolved.length });
		} finally {
			setBusy(false);
		}
	};

	const goTo = (delta: number) => {
		const list = unresolved.length ? unresolved : changeIndexes;
		if (!list.length) {
			return;
		}
		let idx = list.findIndex((i) => (delta > 0 ? i > current : i >= current));
		if (delta > 0) {
			idx = idx === -1 ? 0 : idx;
		} else {
			idx = idx <= 0 ? list.length - 1 : idx - 1;
		}
		const target = list[idx];
		setCurrent(target);
		requestAnimationFrame(() => linksRef.current?.reveal(target, 1));
	};

	bandRef.current = (divider, i) => {
		const b = model?.blocks[i];
		const s = states.get(i);
		if (!b || b.type !== 'change' || !s) {
			return undefined;
		}
		const side = divider === 0 ? s.left : s.right;
		if (side === 'none') {
			return undefined;
		}
		return `band kind-${b.kind} side-${side}${isResolved(s) ? ' resolved' : ''}${current === i ? ' current' : ''}`;
	};

	const placeActions = () => {
		const links = linksRef.current;
		for (const layer of [leftLayer.current, rightLayer.current]) {
			if (!links || !layer) {
				continue;
			}
			for (const el of layer.querySelectorAll<HTMLElement>('.acts')) {
				const box = links.visibleBox(Number(el.dataset.pane), Number(el.dataset.acts));
				const visible = !!box && box.top + 24 > 0 && box.top < layer.clientHeight;
				el.style.display = visible ? '' : 'none';
				if (box) {
					el.style.top = `${Math.max(0, box.top)}px`;
				}
			}
		}
	};

	const ready = !!model;
	useEffect(() => {
		const panes = [leftRef.current, resultRef.current, rightRef.current];
		const dividers = [leftBands.current, rightBands.current];
		if (panes.some((p) => !p) || dividers.some((d) => !d)) {
			return;
		}
		const links = new LinkedPanes(panes as HTMLElement[], dividers as SVGSVGElement[], (k, i) => bandRef.current(k, i), placeActions);
		linksRef.current = links;
		links.refresh(1);
		return () => {
			links.dispose();
			linksRef.current = undefined;
		};
	}, [ready]);

	useEffect(() => {
		linksRef.current?.refresh(1);
	});

	useKeys(
		(e) => {
			if (e.key === 'F7') {
				e.preventDefault();
				goTo(e.shiftKey ? -1 : 1);
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void submit();
			}
		},
	);

	if (!data || !model || !settings) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}

	const lnw = `${Math.max(3, String(Math.max(model.left.length, model.right.length)).length) + 1}ch`;
	const code = (segs: Segment[] | undefined, marks?: TextRange[]) => <span class="code" dangerouslySetInnerHTML={{ __html: renderSegments(segs ?? [], marks) || '&#8203;' }} />;
	const leftRows: preact.JSX.Element[] = [];
	const resultRows: preact.JSX.Element[] = [];
	const rightRows: preact.JSX.Element[] = [];
	const leftActs: preact.JSX.Element[] = [];
	const rightActs: preact.JSX.Element[] = [];
	let resultLine = 1;
	model.blocks.forEach((b, i) => {
		if (b.type === 'stable') {
			const n = b.baseEnd - b.baseStart;
			const head = i === 0 ? 0 : CONTEXT;
			const tail = i === model.blocks.length - 1 ? 0 : CONTEXT;
			const first = resultLine;
			const lines = (from: number, to: number) => {
				for (let k = from; k < to; k++) {
					leftRows.push(<div class="line" key={`l${i}-${k}`}><span class="ln">{b.leftStart + k + 1}</span>{code(model.hlLeft[b.leftStart + k])}</div>);
					resultRows.push(<div class="line" key={`c${i}-${k}`}><span class="ln">{first + k}</span>{code(model.hlLeft[b.leftStart + k])}</div>);
					rightRows.push(<div class="line" key={`r${i}-${k}`}><span class="ln">{b.rightStart + k + 1}</span>{code(model.hlRight[b.rightStart + k])}</div>);
				}
			};
			if (n > head + tail + 2 && !expanded.has(i)) {
				lines(0, head);
				const fold = (side: string) => (
					<div class="fold" key={`f${side}${i}`} onClick={() => setExpanded(new Set([...expanded, i]))}>
						<span class="fold-label">
							<Icon name="unfold" /> {plural(n - head - tail, '{0} unchanged line', '{0} unchanged lines')}
						</span>
					</div>
				);
				leftRows.push(fold('l'));
				resultRows.push(fold('c'));
				rightRows.push(fold('r'));
				lines(n - tail, n);
			} else {
				lines(0, n);
			}
			resultLine += n;
			return;
		}
		const s = states.get(i);
		if (!s) {
			return;
		}
		const text = resultText(i);
		const count = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
		const cls = `ch kind-${b.kind}${isResolved(s) ? ' resolved' : ''}${current === i ? ' current' : ''}`;
		const m = marks.get(i);
		const sideLines = (side: 'left' | 'right') => {
			const from = side === 'left' ? b.leftStart : b.rightStart;
			const to = side === 'left' ? b.leftEnd : b.rightEnd;
			const hl = side === 'left' ? model.hlLeft : model.hlRight;
			const out: preact.JSX.Element[] = [];
			for (let k = from; k < to; k++) {
				out.push(<div class="line" key={`${side}${k}`}><span class="ln">{k + 1}</span>{code(hl[k], m?.[side][k - from])}</div>);
			}
			return out;
		};
		leftRows.push(<div class={`${cls} side-${s.left}`} data-chunk={i} key={`lc${i}`}>{sideLines('left')}</div>);
		rightRows.push(<div class={`${cls} side-${s.right}`} data-chunk={i} key={`rc${i}`}>{sideLines('right')}</div>);
		const numbers: string[] = [];
		for (let k = 0; k < Math.max(1, count); k++) {
			numbers.push(k < count ? String(resultLine + k) : '');
		}
		resultRows.push(
			<div class={cls} data-chunk={i} key={`cc${i}`}>
				<div class="ta-row">
					<div class="ln-col">{numbers.join('\n')}</div>
					<textarea
						class="result jg-code"
						rows={Math.max(1, count)}
						cols={settings.softWrap ? undefined : Math.max(20, ...text.split('\n').map((l) => l.length + 2))}
						wrap={settings.softWrap ? 'soft' : 'off'}
						spellcheck={false}
						value={stripTrailingEol(text)}
						onInput={(e) => {
							const v = (e.target as HTMLTextAreaElement).value;
							update(i, (st) => ({ ...st, edited: v.length ? v.replace(/\r?\n/g, model.eol) + model.eol : '' }));
						}}
					/>
				</div>
			</div>,
		);
		resultLine += count;
		if (s.left === 'pending') {
			leftActs.push(
				<div class="acts l" data-acts={i} data-pane="0" key={`al${i}`}>
					<button class="act" title={t('Accept left change')} onClick={(e) => (e.stopPropagation(), apply(i, 'left'))}>
						&raquo;
					</button>
					<button class="act ignore" title={t('Ignore left change')} onClick={(e) => (e.stopPropagation(), ignore(i, 'left'))}>
						<Icon name="close" />
					</button>
				</div>,
			);
		}
		if (s.right === 'pending') {
			rightActs.push(
				<div class="acts r" data-acts={i} data-pane="2" key={`ar${i}`}>
					<button class="act ignore" title={t('Ignore right change')} onClick={(e) => (e.stopPropagation(), ignore(i, 'right'))}>
						<Icon name="close" />
					</button>
					<button class="act" title={t('Accept right change')} onClick={(e) => (e.stopPropagation(), apply(i, 'right'))}>
						&laquo;
					</button>
				</div>,
			);
		}
	});

	return (
		<div class="merge-view">
			<div class="jg-toolbar">
				<button
					class="jg-btn"
					title={t('Apply all non-conflicting changes')}
					onClick={(e) => {
						const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
						setMenu({ x: r.left, y: r.bottom + 2 });
					}}
				>
					<Icon name="wand" /> {t('Apply Non-Conflicting Changes')} <Icon name="chevron-down" />
				</button>
				<IconButton icon="sparkle" title={t('Resolve Simple Conflicts (non-conflicting changes and conflicts that merge on word level)')} onClick={resolveSimple} />
				<span class="sep" />
				<IconButton icon="arrow-up" title={t('Previous Change (Shift+F7)')} onClick={() => goTo(-1)} />
				<IconButton icon="arrow-down" title={t('Next Change (F7)')} onClick={() => goTo(1)} />
				<span class="sep" />
				<select title={t('Whitespace')} value={settings.whitespace} disabled={changed} onChange={(e) => updateSettings({ whitespace: (e.target as HTMLSelectElement).value as MergeSettings['whitespace'] })}>
					<option value="none">{t('Do not ignore')}</option>
					<option value="trim">{t('Trim whitespaces')}</option>
					<option value="all">{t('Ignore whitespaces')}</option>
				</select>
				<select title={t('Highlighting')} value={settings.highlight} onChange={(e) => updateSettings({ highlight: (e.target as HTMLSelectElement).value as MergeSettings['highlight'] })}>
					<option value="words">{t('Highlight words')}</option>
					<option value="lines">{t('Highlight lines')}</option>
					<option value="none">{t('Do not highlight')}</option>
				</select>
				<IconButton icon="word-wrap" title={t('Use soft wraps')} active={settings.softWrap} onClick={() => updateSettings({ softWrap: !settings.softWrap })} />
				<span class="spacer" />
				<span class="jg-muted counter">
					{unresolved.length === 0 ? t('All changes have been processed') : `${plural(unresolved.length, '{0} change left', '{0} changes left')} · ${plural(conflictsLeft, '{0} conflict', '{0} conflicts')}`}
				</span>
			</div>
			<div class="m-titles" style={{ '--lnw': lnw } as any}>
				<div class="title">{data.leftTitle}</div>
				<div />
				<div class="title">{t('Result')}</div>
				<div />
				<div class="title">{data.rightTitle}</div>
			</div>
			<div
				class={`m-body jg-code${settings.softWrap ? ' wrap' : ''}${settings.highlight === 'none' ? ' hl-none' : ''}`}
				style={{ '--lnw': lnw } as any}
				onClick={(e) => {
					const el = (e.target as HTMLElement).closest('[data-chunk]') as HTMLElement | null;
					if (el) {
						setCurrent(Number(el.dataset.chunk));
					}
				}}
			>
				<div ref={leftRef} class="pane l" tabIndex={0}>
					<div class="content">{leftRows}</div>
				</div>
				<div class="divider">
					<svg ref={leftBands} class="bands" />
					<div ref={leftLayer} class="acts-layer">
						{leftActs}
					</div>
				</div>
				<div ref={resultRef} class="pane c" tabIndex={0}>
					<div class="content">{resultRows}</div>
				</div>
				<div class="divider">
					<svg ref={rightBands} class="bands" />
					<div ref={rightLayer} class="acts-layer">
						{rightActs}
					</div>
				</div>
				<div ref={rightRef} class="pane r" tabIndex={0}>
					<div class="content">{rightRows}</div>
				</div>
			</div>
			<div class="m-footer">
				<button class="jg-btn" disabled={busy} onClick={() => submit(data.left)} title={t('Use the left version for the whole file')}>
					{t('Accept Left')}
				</button>
				<button class="jg-btn" disabled={busy} onClick={() => submit(data.right)} title={t('Use the right version for the whole file')}>
					{t('Accept Right')}
				</button>
				<span class="spacer" />
				<button class="jg-btn" disabled={busy} onClick={() => call('cancel', { changed })}>
					{t('Cancel')}
				</button>
				<button class="jg-btn primary" disabled={busy} onClick={() => submit()} title={t('Save result and mark as resolved (⌘↩)')}>
					{t('Apply')}
				</button>
			</div>
			{menu && (
				<PopupMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					items={[
						{ label: t('Apply Non-Conflicting Changes from the Left Side'), icon: 'arrow-right', onClick: () => applyNonConflicting('left') },
						{ label: t('Apply All Non-Conflicting Changes'), icon: 'wand', onClick: () => applyNonConflicting('all') },
						{ label: t('Apply Non-Conflicting Changes from the Right Side'), icon: 'arrow-left', onClick: () => applyNonConflicting('right') },
					]}
				/>
			)}
		</div>
	);
}

function stripTrailingEol(s: string): string {
	return s.endsWith('\r\n') ? s.slice(0, -2) : s.endsWith('\n') ? s.slice(0, -1) : s;
}

function withEols(parts: string[], eol: string): string {
	return parts
		.filter((p) => p.length > 0)
		.map((p) => (p.endsWith('\n') ? p : p + eol))
		.join('');
}


render(<App />, document.getElementById('app')!);
