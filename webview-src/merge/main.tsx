import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { detectEol, splitLines } from '../../src/shared/diff';
import { ChangeBlock, computeMerge, MergeBlock, resolveSimpleConflict } from '../../src/shared/diff3';
import { Icon, IconButton, PopupMenu, useKeys } from '../common/components';
import { highlightLines, languageFor, renderSegments, Segment } from '../common/highlight';
import { call } from '../common/rpc';
import { plural, t } from '../common/l10n';

interface MergeData {
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

function Code({ segs }: { segs: Segment[] }) {
	return <span class="code" dangerouslySetInnerHTML={{ __html: renderSegments(segs) || '&#8203;' }} />;
}

function App() {
	const [data, setData] = useState<MergeData | null>(null);
	const [states, setStates] = useState<Map<number, BlockState>>(new Map());
	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const [current, setCurrent] = useState(-1);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const bodyRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		call<MergeData>('ready').then(setData);
	}, []);

	const model = useMemo(() => {
		if (!data) {
			return null;
		}
		const base = splitLines(data.base);
		const left = splitLines(data.left);
		const right = splitLines(data.right);
		const blocks = computeMerge(base, left, right);
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
	}, [data]);

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
		requestAnimationFrame(() => {
			const el = bodyRef.current?.querySelector(`[data-block="${target}"]`) as HTMLElement | null;
			if (el && bodyRef.current) {
				bodyRef.current.scrollTop = el.offsetTop - bodyRef.current.clientHeight / 3;
			}
		});
	};

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

	if (!data || !model) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}

	const lnw = `${Math.max(3, String(Math.max(model.left.length, model.right.length)).length) + 1}ch`;

	const renderStable = (b: MergeBlock & { type: 'stable' }, i: number) => {
		const n = b.baseEnd - b.baseStart;
		const isFirst = i === 0;
		const isLast = i === model.blocks.length - 1;
		const head = isFirst ? 0 : CONTEXT;
		const tail = isLast ? 0 : CONTEXT;
		const rows: preact.JSX.Element[] = [];
		const line = (k: number) => (
			<div class="m-row stable" key={`s${i}-${k}`}>
				<div class="pane l">
					<span class="ln">{b.leftStart + k + 1}</span>
					<Code segs={model.hlLeft[b.leftStart + k]} />
				</div>
				<div class="gut" />
				<div class="pane c">
					<span class="ln">{b.baseStart + k + 1}</span>
					<Code segs={model.hlLeft[b.leftStart + k]} />
				</div>
				<div class="gut" />
				<div class="pane r">
					<span class="ln">{b.rightStart + k + 1}</span>
					<Code segs={model.hlRight[b.rightStart + k]} />
				</div>
			</div>
		);
		if (n > head + tail + 2 && !expanded.has(i)) {
			for (let k = 0; k < head; k++) {
				rows.push(line(k));
			}
			rows.push(
				<div class="m-row fold" key={`f${i}`} onClick={() => setExpanded(new Set([...expanded, i]))}>
					<Icon name="unfold" /> {plural(n - head - tail, '{0} unchanged line', '{0} unchanged lines')}
				</div>,
			);
			for (let k = n - tail; k < n; k++) {
				rows.push(line(k));
			}
		} else {
			for (let k = 0; k < n; k++) {
				rows.push(line(k));
			}
		}
		return rows;
	};

	const renderChange = (b: ChangeBlock, i: number) => {
		const s = states.get(i);
		if (!s) {
			return null;
		}
		const resolved = isResolved(s);
		const text = resultText(i);
		const leftLines: preact.JSX.Element[] = [];
		for (let k = b.leftStart; k < b.leftEnd; k++) {
			leftLines.push(
				<div class="line">
					<span class="ln">{k + 1}</span>
					<Code segs={model.hlLeft[k]} />
				</div>,
			);
		}
		const rightLines: preact.JSX.Element[] = [];
		for (let k = b.rightStart; k < b.rightEnd; k++) {
			rightLines.push(
				<div class="line">
					<span class="ln">{k + 1}</span>
					<Code segs={model.hlRight[k]} />
				</div>,
			);
		}
		const rows = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
		return (
			<div
				class={`m-row change kind-${b.kind}${resolved ? ' resolved' : ''}${current === i ? ' current' : ''}`}
				data-block={i}
				key={`c${i}`}
				onClick={() => setCurrent(i)}
			>
				<div class={`pane l side-${s.left}`}>{leftLines.length ? leftLines : <div class="filler" />}</div>
				<div class="gut">
					{s.left === 'pending' && (
						<>
							<button class="act" title={t('Accept left change')} onClick={(e) => (e.stopPropagation(), apply(i, 'left'))}>
								&raquo;
							</button>
							<button class="act ignore" title={t('Ignore left change')} onClick={(e) => (e.stopPropagation(), ignore(i, 'left'))}>
								<Icon name="close" />
							</button>
						</>
					)}
				</div>
				<div class="pane c">
					<textarea
						class="result jg-code"
						rows={rows}
						spellcheck={false}
						value={stripTrailingEol(text)}
						onInput={(e) => {
							const v = (e.target as HTMLTextAreaElement).value;
							update(i, (st) => ({ ...st, edited: v.length ? v.replace(/\r?\n/g, model.eol) + model.eol : '' }));
						}}
					/>
				</div>
				<div class="gut">
					{s.right === 'pending' && (
						<>
							<button class="act" title={t('Accept right change')} onClick={(e) => (e.stopPropagation(), apply(i, 'right'))}>
								&laquo;
							</button>
							<button class="act ignore" title={t('Ignore right change')} onClick={(e) => (e.stopPropagation(), ignore(i, 'right'))}>
								<Icon name="close" />
							</button>
						</>
					)}
				</div>
				<div class={`pane r side-${s.right}`}>{rightLines.length ? rightLines : <div class="filler" />}</div>
			</div>
		);
	};

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
			<div ref={bodyRef} class="m-body jg-code" style={{ '--lnw': lnw } as any}>
				{model.blocks.map((b, i) => (b.type === 'stable' ? renderStable(b, i) : renderChange(b, i)))}
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
