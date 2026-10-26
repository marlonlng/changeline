import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getState, patchState } from './rpc';
import { basename, dirname } from './format';
import { plural, t } from './l10n';

export function Icon({ name, className, title, style }: { name: string; className?: string; title?: string; style?: JSX.CSSProperties }) {
	return <i class={`codicon codicon-${name}${className ? ' ' + className : ''}`} title={title} style={style} />;
}

export function IconButton(props: { icon: string; title: string; onClick?: (e: MouseEvent) => void; disabled?: boolean; active?: boolean; className?: string }) {
	return (
		<button
			class={`jg-icon-btn${props.active ? ' active' : ''}${props.className ? ' ' + props.className : ''}`}
			title={props.title}
			aria-label={props.title}
			aria-pressed={props.active}
			disabled={props.disabled}
			onClick={(e) => props.onClick?.(e as unknown as MouseEvent)}
		>
			<Icon name={props.icon} />
		</button>
	);
}

export function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void; label?: ComponentChildren; disabled?: boolean; title?: string; indeterminate?: boolean }) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) {
			ref.current.indeterminate = !!props.indeterminate;
		}
	}, [props.indeterminate]);
	return (
		<label class="jg-check" title={props.title}>
			<input ref={ref} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
			{props.label}
		</label>
	);
}

/**
 * Persistent resizable size for split panes. Returns the size and a
 * mousedown handler for the splitter element.
 */
export function useSplitter(key: string, initial: number, opts: { min?: number; max?: number; vertical?: boolean; invert?: boolean } = {}) {
	const saved = (getState<Record<string, number>>() as Record<string, number>)[`split:${key}`];
	const [size, setSize] = useState<number>(typeof saved === 'number' ? saved : initial);
	const onMouseDown = (e: MouseEvent) => {
		e.preventDefault();
		const start = opts.vertical ? e.clientY : e.clientX;
		const startSize = size;
		let current = startSize;
		const move = (ev: MouseEvent) => {
			const delta = (opts.vertical ? ev.clientY : ev.clientX) - start;
			current = Math.max(opts.min ?? 80, Math.min(opts.max ?? 4000, startSize + (opts.invert ? -delta : delta)));
			setSize(current);
		};
		const up = () => {
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', up);
			document.body.style.cursor = '';
			patchState({ [`split:${key}`]: current });
		};
		document.body.style.cursor = opts.vertical ? 'row-resize' : 'col-resize';
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', up);
	};
	return [size, onMouseDown] as const;
}

export interface FileItem {
	path: string;
	origPath?: string;
	status: string;
}

interface TreeRow {
	kind: 'dir' | 'file';
	key: string;
	label: string;
	depth: number;
	file?: FileItem;
	count?: number;
	detail?: string;
}

function buildRows(files: FileItem[], groupByDir: boolean, collapsed: Set<string>): TreeRow[] {
	const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
	if (!groupByDir) {
		return sorted.map((f) => ({ kind: 'file', key: f.path, label: basename(f.path), depth: 0, file: f, detail: dirname(f.path) }));
	}
	interface Node {
		dirs: Map<string, Node>;
		files: FileItem[];
	}
	const root: Node = { dirs: new Map(), files: [] };
	for (const f of sorted) {
		const segs = f.path.split('/');
		segs.pop();
		let n = root;
		for (const s of segs) {
			let next = n.dirs.get(s);
			if (!next) {
				next = { dirs: new Map(), files: [] };
				n.dirs.set(s, next);
			}
			n = next;
		}
		n.files.push(f);
	}
	const count = (n: Node): number => n.files.length + [...n.dirs.values()].reduce((a, d) => a + count(d), 0);
	const rows: TreeRow[] = [];
	const walk = (n: Node, prefix: string, depth: number) => {
		for (const [name, sub] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			let label = name;
			let node = sub;
			let key = prefix ? `${prefix}/${name}` : name;
			while (node.files.length === 0 && node.dirs.size === 1) {
				const [cn, c] = [...node.dirs.entries()][0];
				label += '/' + cn;
				key += '/' + cn;
				node = c;
			}
			rows.push({ kind: 'dir', key: 'dir:' + key, label, depth, count: count(node) });
			if (!collapsed.has('dir:' + key)) {
				walk(node, key, depth + 1);
			}
		}
		for (const f of n.files) {
			rows.push({ kind: 'file', key: f.path, label: basename(f.path), depth, file: f });
		}
	};
	walk(root, '', 0);
	return rows;
}

export function FileTree(props: {
	files: FileItem[];
	groupByDir: boolean;
	selected: string[];
	highlight?: string;
	onSelect: (paths: string[]) => void;
	onOpen: (file: FileItem) => void;
	context?: (file: FileItem) => Record<string, unknown>;
	emptyText?: string;
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const rows = useMemo(() => buildRows(props.files, props.groupByDir, collapsed), [props.files, props.groupByDir, collapsed]);
	const anchor = useRef<string | undefined>(undefined);
	const selected = new Set(props.selected);
	const fileRows = rows.filter((r) => r.kind === 'file');

	const click = (row: TreeRow, e: MouseEvent) => {
		if (row.kind === 'dir') {
			const next = new Set(collapsed);
			if (next.has(row.key)) {
				next.delete(row.key);
			} else {
				next.add(row.key);
			}
			setCollapsed(next);
			return;
		}
		const path = row.file!.path;
		if (e.shiftKey && anchor.current) {
			const a = fileRows.findIndex((r) => r.key === anchor.current);
			const b = fileRows.findIndex((r) => r.key === path);
			const [lo, hi] = a < b ? [a, b] : [b, a];
			props.onSelect(fileRows.slice(lo, hi + 1).map((r) => r.key));
		} else if (e.metaKey || e.ctrlKey) {
			const next = new Set(selected);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			anchor.current = path;
			props.onSelect([...next]);
		} else {
			anchor.current = path;
			props.onSelect([path]);
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!fileRows.length) {
			return;
		}
		const idx = fileRows.findIndex((r) => r.key === props.selected[props.selected.length - 1]);
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const next = fileRows[Math.max(0, Math.min(fileRows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
			anchor.current = next.key;
			props.onSelect([next.key]);
		} else if (e.key === 'Enter' && idx >= 0) {
			props.onOpen(fileRows[idx].file!);
		}
	};

	if (!props.files.length) {
		return <div class="jg-empty">{props.emptyText ?? t('No changes')}</div>;
	}
	return (
		<div class="jg-file-tree jg-focus-within" tabIndex={0} onKeyDown={onKeyDown as any}>
			{rows.map((row) => {
				const isSel = row.kind === 'file' && selected.has(row.key);
				const ctx = row.kind === 'file' && props.context ? JSON.stringify({ ...props.context(row.file!), preventDefaultContextMenuItems: true }) : undefined;
				return (
					<div
						key={row.key}
						class={`jg-row${isSel ? ' selected' : ''}${row.file && row.file.path === props.highlight ? ' highlighted' : ''}`}
						style={{ paddingLeft: `${6 + row.depth * 14}px` }}
						data-vscode-context={ctx}
						onMouseDown={(e) => {
							if (e.button === 2 && row.kind === 'file' && !selected.has(row.key)) {
								props.onSelect([row.key]);
							}
						}}
						onClick={(e) => click(row, e as unknown as MouseEvent)}
						onDblClick={() => row.file && props.onOpen(row.file)}
					>
						{row.kind === 'dir' ? (
							<>
								<Icon name={collapsed.has(row.key) ? 'chevron-right' : 'chevron-down'} className="twisty" />
								<Icon name="folder" />
								<span class="name">{row.label}</span>
								<span class="detail">{plural(row.count ?? 0, '{0} file', '{0} files')}</span>
							</>
						) : (
							<>
								{props.groupByDir && <span class="twisty" />}
								<Icon name={fileIcon(row.file!.status)} className={`st-${row.file!.status}`} />
								<span class={`name st-${row.file!.status}`}>{row.label}</span>
								{row.file!.origPath && <span class="detail">← {row.file!.origPath}</span>}
								{row.detail && <span class="detail">{row.detail}</span>}
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}

function fileIcon(status: string): string {
	switch (status) {
		case 'A':
		case '?':
			return 'diff-added';
		case 'D':
			return 'diff-removed';
		case 'R':
			return 'diff-renamed';
		case 'U':
			return 'warning';
		default:
			return 'diff-modified';
	}
}

/** Small popup menu anchored at a position (for split buttons and dropdowns). */
export function PopupMenu(props: { x: number; y: number; items: ({ label: string; onClick: () => void; icon?: string } | 'sep')[]; onClose: () => void }) {
	useEffect(() => {
		const close = () => props.onClose();
		const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
		setTimeout(() => window.addEventListener('mousedown', close), 0);
		window.addEventListener('keydown', key);
		window.addEventListener('blur', close);
		return () => {
			window.removeEventListener('mousedown', close);
			window.removeEventListener('keydown', key);
			window.removeEventListener('blur', close);
		};
	}, []);
	return (
		<div class="jg-menu" style={{ left: `${props.x}px`, top: `${props.y}px` }} onMouseDown={(e) => e.stopPropagation()}>
			{props.items.map((it, i) =>
				it === 'sep' ? (
					<div key={i} class="sep" />
				) : (
					<div
						key={i}
						class="item"
						onClick={() => {
							props.onClose();
							it.onClick();
						}}
					>
						{it.icon && <Icon name={it.icon} />}
						{it.label}
					</div>
				),
			)}
		</div>
	);
}

/**
 * Window keyboard shortcuts. The listener always calls the handler of the
 * latest render: effects run after paint, so re-subscribing per render would
 * let a key pressed right after a click see the state from before the click.
 */
export function useKeys(handler: (e: KeyboardEvent) => void) {
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		const listener = (e: KeyboardEvent) => latest.current(e);
		window.addEventListener('keydown', listener);
		return () => window.removeEventListener('keydown', listener);
	}, []);
}
