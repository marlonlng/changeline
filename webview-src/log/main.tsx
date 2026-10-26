import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { collapseLinearBranches, GraphRow, layoutGraph } from '../../src/shared/graph';
import { Icon, IconButton, PopupMenu, useSplitter } from '../common/components';
import { formatDate, fullDate } from '../common/format';
import { call, getState, on, patchState } from '../common/rpc';
import { BranchesPane } from './branches';
import { DetailsPane } from './details';
import { GraphCell, ROW_HEIGHT } from './graph';
import type { CommitInfo, Details, Filters, InitData, RefLabel, RefsPayload } from './types';
import { plural, t } from '../common/l10n';
import { mountDialogLayer } from '../common/dialog';

interface ViewOptions {
	showBranches: boolean;
	showDetails: boolean;
	showHash: boolean;
	highlightCurrent: boolean;
	highlightMine: boolean;
	collapseLinear: boolean;
	dateFormat: 'relative' | 'absolute';
	colAuthor: number;
	colDate: number;
	colHash: number;
}

function buildLabels(p: RefsPayload): Map<string, RefLabel[]> {
	const map = new Map<string, RefLabel[]>();
	const add = (hash: string, l: RefLabel, front = false) => {
		const arr = map.get(hash) ?? [];
		if (front) {
			arr.unshift(l);
		} else {
			arr.push(l);
		}
		map.set(hash, arr);
	};
	const remotes = new Map(p.refs.filter((r) => r.type === 'remote').map((r) => [r.shortName, r]));
	const consumed = new Set<string>();
	for (const h of p.refs.filter((r) => r.type === 'head')) {
		let text = h.shortName;
		let title = t('Local branch {0}', h.shortName);
		if (h.upstream) {
			const u = remotes.get(h.upstream);
			if (u && u.hash === h.hash && u.shortName === `${u.remote}/${h.shortName}`) {
				text = `${u.remote} & ${h.shortName}`;
				title = t('Local branch {0} and {1}', h.shortName, u.shortName);
				consumed.add(u.shortName);
			}
		}
		add(h.hash, { text, kind: h.current ? 'current' : 'local', title }, h.current);
	}
	for (const r of remotes.values()) {
		if (!consumed.has(r.shortName)) {
			add(r.hash, { text: r.shortName, kind: 'remote', title: t('Remote branch {0}', r.shortName) });
		}
	}
	for (const item of p.refs.filter((r) => r.type === 'tag')) {
		add(item.hash, { text: item.shortName, kind: 'tag', title: t('Tag {0}', item.shortName) });
	}
	if (p.detached && p.head) {
		add(p.head, { text: 'HEAD', kind: 'head', title: t('Detached HEAD') }, true);
	}
	return map;
}

function reachableFrom(head: string | undefined, commits: CommitInfo[]): Set<string> {
	const set = new Set<string>();
	if (!head) {
		return set;
	}
	const byHash = new Map(commits.map((c) => [c.hash, c]));
	const stack = [head];
	while (stack.length) {
		const h = stack.pop()!;
		if (set.has(h)) {
			continue;
		}
		set.add(h);
		const c = byHash.get(h);
		if (c) {
			stack.push(...c.parents);
		}
	}
	return set;
}

function FilterButton(props: { label: string; icon: string; compact: boolean; value?: string; onClick: () => void; onClear: () => void }) {
	return (
		<span class={`filter-btn${props.value ? ' active' : ''}`}>
			<button class="filter-main" onClick={props.onClick} title={props.value ? `${props.label}: ${props.value}` : t('Filter by {0}', props.label)}>
				{props.compact ? <Icon name={props.icon} /> : props.label}
				{props.value && !props.compact ? `: ${props.value}` : ''} <Icon name="chevron-down" />
			</button>
			{props.value && (
				<button class="filter-clear" title={t('Clear')} onClick={props.onClear}>
					<Icon name="close" />
				</button>
			)}
		</span>
	);
}

function App() {
	const [init, setInit] = useState<InitData | null>(null);
	const [refs, setRefs] = useState<RefsPayload>({ refs: [] });
	const [filters, setFilters] = useState<Filters>({});
	const [text, setText] = useState('');
	const [allCommits, setCommits] = useState<CommitInfo[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [selected, setSelected] = useState<string[]>([]);
	const [details, setDetails] = useState<Details | undefined>();
	const [parentIndex, setParentIndex] = useState(0);
	const [detailsLoading, setDetailsLoading] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const saved = getState<ViewOptions>();
	const [opts, setOpts] = useState<ViewOptions>({
		showBranches: saved.showBranches ?? true,
		showDetails: saved.showDetails ?? true,
		showHash: saved.showHash ?? false,
		highlightCurrent: saved.highlightCurrent ?? false,
		highlightMine: saved.highlightMine ?? false,
		collapseLinear: saved.collapseLinear ?? false,
		dateFormat: saved.dateFormat ?? 'relative',
		colAuthor: saved.colAuthor ?? 130,
		colDate: saved.colDate ?? 130,
		colHash: saved.colHash ?? 80,
	});
	const [branchWidth, onBranchSplit] = useSplitter('branches', 200, { min: 120, max: 600 });
	const [detailsWidth, onDetailsSplit] = useSplitter('details', 340, { min: 180, max: 900, invert: true });
	const tableRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [totalWidth, setTotalWidth] = useState(window.innerWidth);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewport, setViewport] = useState(400);
	const anchor = useRef<string | undefined>(undefined);
	const pendingSelect = useRef<string | undefined>(undefined);
	const loadToken = useRef(0);
	const detailsTimer = useRef<number | undefined>(undefined);

	const isHistory = init?.scope.kind === 'history';
	const pageSize = init?.settings.pageSize ?? 1000;

	const setOpt = (patch: Partial<ViewOptions>) => {
		const next = { ...opts, ...patch };
		setOpts(next);
		patchState(patch);
	};

	const load = useCallback(async (f: Filters, append: boolean, current: CommitInfo[]) => {
		const token = ++loadToken.current;
		setLoading(true);
		try {
			const res = await call<{ commits: CommitInfo[]; hasMore: boolean }>('load', { filters: f, skip: append ? current.length : 0, limit: pageSize });
			if (token !== loadToken.current) {
				return;
			}
			const next = append ? [...current, ...res.commits] : res.commits;
			setCommits(next);
			setHasMore(res.hasMore);
			setError(undefined);
			const want = pendingSelect.current;
			if (want) {
				const found = next.find((c) => c.hash.startsWith(want));
				if (found) {
					pendingSelect.current = undefined;
					select([found.hash], next);
					scrollToHash(found.hash);
				} else if (res.hasMore && next.length < pageSize * 10) {
					void load(f, true, next);
					return;
				}
			}
		} catch (e) {
			if (token === loadToken.current) {
				setError(String((e as Error).message ?? e));
			}
		} finally {
			if (token === loadToken.current) {
				setLoading(false);
			}
		}
	}, [pageSize]);

	useEffect(() => {
		call<InitData>('init').then((d) => {
			setInit(d);
			setRefs(d);
			const f: Filters = d.scope.filters ?? {};
			setFilters(f);
			setText(f.text ?? '');
			if (d.scope.kind === 'history') {
				setOpts((o) => ({ ...o, showBranches: false }));
			}
			void load(f, false, []);
		});
	}, []);

	const filtersRef = useRef(filters);
	filtersRef.current = filters;
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const commitsRef = useRef(allCommits);
	commitsRef.current = allCommits;

	useEffect(() => {
		const offs = [
			on('refresh', async () => {
				setRefs(await call<RefsPayload>('refs'));
				pendingSelect.current = selectedRef.current[0];
				void load(filtersRef.current, false, []);
			}),
			on<{ hash: string }>('select', ({ hash }) => {
				const cs = commitsRef.current;
				const found = cs.find((c) => c.hash.startsWith(hash));
				if (found) {
					pendingSelect.current = undefined;
					anchor.current = found.hash;
					select([found.hash], cs);
					scrollToHash(found.hash);
				} else {
					pendingSelect.current = hash;
					void load(filtersRef.current, cs.length > 0, cs);
				}
			}),
			on<Filters>('filters', (f) => {
				setFilters(f);
				setText(f.text ?? '');
				void load(f, false, []);
			}),
			on<{ repos: InitData['repos']; repoRoot?: string }>('repos', (r) => setInit((i) => (i ? { ...i, ...r } : i))),
		];
		return () => offs.forEach((o) => o());
	}, [load]);

	const applyFilters = (patch: Partial<Filters>) => {
		const next = { ...filters, ...patch };
		setFilters(next);
		void load(next, false, []);
	};

	useEffect(() => {
		if (!init || (filters.text ?? '') === text) {
			return;
		}
		const entry = window.setTimeout(() => applyFilters({ text: text || undefined }), 450);
		return () => window.clearTimeout(entry);
	}, [text]);

	const graphEnabled = !filters.users?.length && !filters.text && !filters.since && !filters.until;
	const labels = useMemo(() => buildLabels(refs), [refs]);
	const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
	const collapsed = useMemo(() => (opts.collapseLinear && graphEnabled ? collapseLinearBranches(allCommits, labels, refs.head, expandedRuns) : undefined), [allCommits, labels, refs.head, opts.collapseLinear, graphEnabled, expandedRuns]);
	const commits = useMemo(() => (collapsed ? collapsed.visible : allCommits), [collapsed, allCommits]);
	const graph = useMemo<GraphRow[]>(() => (graphEnabled ? layoutGraph(commits) : []), [commits, graphEnabled]);
	const visibleRef = useRef(commits);
	visibleRef.current = commits;
	const inHead = useMemo(() => reachableFrom(refs.head, commits), [refs.head, commits]);
	const authors = useMemo(() => [...new Set(commits.map((c) => c.author))], [commits]);
	const index = useMemo(() => new Map(commits.map((c, i) => [c.hash, i])), [commits]);

	const select = (hashes: string[], list = commits) => {
		setSelected(hashes);
		const sel = hashes.map((h) => list.find((c) => c.hash === h)).filter(Boolean) as CommitInfo[];
		sel.sort((a, b) => list.indexOf(a) - list.indexOf(b));
		void call('selection', { hashes: sel.map((c) => c.hash), commits: sel });
		window.clearTimeout(detailsTimer.current);
		if (!sel.length) {
			setDetails(undefined);
			return;
		}
		setDetailsLoading(true);
		setParentIndex(0);
		detailsTimer.current = window.setTimeout(async () => {
			try {
				const d = await call<Details>('details', { hashes: sel.map((c) => c.hash) });
				setDetails(d);
			} catch (e) {
				setDetails(undefined);
			} finally {
				setDetailsLoading(false);
			}
		}, 120);
	};

	/** Scrolls to a commit by hash, using the currently visible (possibly collapsed) list. */
	const scrollToHash = (hash: string) => {
		requestAnimationFrame(() => {
			const i = visibleRef.current.findIndex((c) => c.hash === hash);
			if (i >= 0) {
				scrollTo(i);
			}
		});
	};

	const scrollTo = (i: number) => {
		requestAnimationFrame(() => {
			const el = tableRef.current;
			if (!el || i < 0) {
				return;
			}
			const top = i * ROW_HEIGHT;
			if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
				el.scrollTop = Math.max(0, top - el.clientHeight / 3);
			}
		});
	};

	useLayoutEffect(() => {
		const el = tableRef.current;
		const root = rootRef.current;
		if (!el || !root) {
			return;
		}
		const ro = new ResizeObserver(() => {
			setViewport(el.clientHeight);
			setTotalWidth(root.clientWidth);
		});
		ro.observe(el);
		ro.observe(root);
		setViewport(el.clientHeight);
		setTotalWidth(root.clientWidth);
		return () => ro.disconnect();
	}, [init]);

	const onScroll = (e: Event) => {
		const el = e.target as HTMLDivElement;
		setScrollTop(el.scrollTop);
		if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_HEIGHT * 20) {
			void load(filters, true, allCommits);
		}
	};

	const rowClick = (c: CommitInfo, e: MouseEvent) => {
		if (e.shiftKey && anchor.current && index.has(anchor.current)) {
			const a = index.get(anchor.current)!;
			const b = index.get(c.hash)!;
			const [lo, hi] = a < b ? [a, b] : [b, a];
			select(commits.slice(lo, hi + 1).map((x) => x.hash));
		} else if (e.metaKey || e.ctrlKey) {
			anchor.current = c.hash;
			select(selected.includes(c.hash) ? selected.filter((h) => h !== c.hash) : [...selected, c.hash]);
		} else {
			anchor.current = c.hash;
			select([c.hash]);
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!commits.length) {
			return;
		}
		const cur = selected.length ? index.get(selected[selected.length - 1]) ?? 0 : -1;
		let next = cur;
		const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
		switch (e.key) {
			case 'ArrowDown':
				next = Math.min(commits.length - 1, cur + 1);
				break;
			case 'ArrowUp':
				next = Math.max(0, cur - 1);
				break;
			case 'PageDown':
				next = Math.min(commits.length - 1, cur + page);
				break;
			case 'PageUp':
				next = Math.max(0, cur - page);
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = commits.length - 1;
				break;
			case 'Enter':
				if (isHistory && selected[0]) {
					void call('openCommitDiffForPath', { hash: selected[0] });
				}
				return;
			case 'a':
				if (e.metaKey || e.ctrlKey) {
					e.preventDefault();
					select(commits.map((c) => c.hash));
				}
				return;
			default:
				return;
		}
		e.preventDefault();
		if (e.shiftKey && anchor.current && index.has(anchor.current)) {
			const a = index.get(anchor.current)!;
			const [lo, hi] = a < next ? [a, next] : [next, a];
			select(commits.slice(lo, hi + 1).map((x) => x.hash));
		} else {
			anchor.current = commits[next].hash;
			select([commits[next].hash]);
		}
		scrollTo(next);
	};

	const navigateTo = async (ref: string) => {
		const hash = await call<string | undefined>('branchClick', { ref });
		if (!hash) {
			return;
		}
		const i = index.get(hash);
		if (i !== undefined) {
			anchor.current = hash;
			select([hash]);
			scrollTo(i);
		} else {
			pendingSelect.current = hash;
			void load(filters, true, allCommits);
		}
	};

	const colResize = (key: 'colAuthor' | 'colDate' | 'colHash') => (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const start = opts[key];
		let cur = start;
		const move = (ev: MouseEvent) => {
			cur = Math.max(50, Math.min(500, start - (ev.clientX - startX)));
			setOpts((o) => ({ ...o, [key]: cur }));
		};
		const up = () => {
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', up);
			patchState({ [key]: cur });
		};
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', up);
	};

	if (!init) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	if (!init.repoRoot) {
		return <div class="jg-empty">{t('No Git repository found in the workspace.')}</div>;
	}

	const total = commits.length;
	const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 15);
	const last = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + 15);
	const visible = commits.slice(first, last);
	const selectedSet = new Set(selected);
	const me = init.user.name;
	const showBranches = opts.showBranches && !isHistory;
	const bw = Math.min(branchWidth, Math.max(120, totalWidth * 0.24));
	const dw = Math.min(detailsWidth, Math.max(180, totalWidth * 0.36));
	const centerWidth = totalWidth - (showBranches ? bw : 0) - (opts.showDetails ? dw : 0);
	const showAuthor = centerWidth > 470;
	const showDate = centerWidth > 360;
	const showHashCol = opts.showHash && centerWidth > 600;
	const compact = centerWidth < 640;
	const gridCols = `minmax(0, 1fr)${showAuthor ? ` ${opts.colAuthor}px` : ''}${showDate ? ` ${opts.colDate}px` : ''}${showHashCol ? ` ${opts.colHash}px` : ''}`;
	const branchLabel = filters.branches?.length ? filters.branches.join(', ') : undefined;

	return (
		<div class="log-view" ref={rootRef}>
			<div class="jg-split-h">
				{showBranches && (
					<>
						<div class="left-pane" style={{ width: `${bw}px` }}>
							<BranchesPane
								refs={refs}
								logId={init.id}
								selected={filters.branches?.length === 1 ? filters.branches[0] : undefined}
								onClick={(ref) => void navigateTo(ref)}
								onDoubleClick={(ref) => applyFilters({ branches: [ref] })}
								onCommand={(command, args) => void call('command', { command, args })}
							/>
						</div>
						<div class="jg-splitter-v" onMouseDown={onBranchSplit as any} />
					</>
				)}
				<div class="center-pane">
					<div class="jg-toolbar filter-bar">
						{!isHistory && (
							<IconButton icon="layout-sidebar-left" title={t('Show Branches')} active={opts.showBranches} onClick={() => setOpt({ showBranches: !opts.showBranches })} />
						)}
						{init.repos.length > 1 && !isHistory && (
							<select
								class="repo-select"
								value={init.repoRoot}
								title={t('Repository')}
								onChange={async (e) => {
									const root = (e.target as HTMLSelectElement).value;
									setInit({ ...init, repoRoot: root });
									setRefs(await call<RefsPayload>('setRepo', { root }));
									setSelected([]);
									setDetails(undefined);
									void load(filters, false, []);
								}}
							>
								{init.repos.map((r) => (
									<option value={r.root}>{r.name}</option>
								))}
							</select>
						)}
						{isHistory && (
							<span class="history-title" title={init.scope.path}>
								<Icon name="history" /> {init.scope.title ?? init.scope.path}
							</span>
						)}
						<span class="search">
							<Icon name="search" />
							<input type="search" placeholder={t('Text or hash')} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && applyFilters({ text: text || undefined })} />
							<IconButton icon="regex" title={t('Regex')} active={!!filters.regex} onClick={() => applyFilters({ regex: !filters.regex })} />
							<IconButton icon="case-sensitive" title={t('Match Case')} active={!!filters.matchCase} onClick={() => applyFilters({ matchCase: !filters.matchCase })} />
						</span>
						{!init.scope.revisions && (
							<FilterButton
								label={t('Branch')}
								icon="git-branch"
								compact={compact}
								value={branchLabel}
								onClick={async () => {
									const r = await call<string[] | undefined>('pickBranches', { current: filters.branches });
									if (r) {
										applyFilters({ branches: r.length ? r : undefined });
									}
								}}
								onClear={() => applyFilters({ branches: undefined })}
							/>
						)}
						<FilterButton
							label={t('User')}
							icon="person"
							compact={compact}
							value={filters.users?.length ? filters.users.join(', ') : undefined}
							onClick={async () => {
								const r = await call<string[] | undefined>('pickUsers', { current: filters.users, authors });
								if (r) {
									applyFilters({ users: r.length ? r : undefined });
								}
							}}
							onClear={() => applyFilters({ users: undefined })}
						/>
						<FilterButton
							label={t('Date')}
							icon="calendar"
							compact={compact}
							value={filters.dateLabel}
							onClick={async () => {
								const r = await call<{ since?: string; until?: string; label?: string } | undefined>('pickDate');
								if (r) {
									applyFilters({ since: r.since, until: r.until, dateLabel: r.label });
								}
							}}
							onClear={() => applyFilters({ since: undefined, until: undefined, dateLabel: undefined })}
						/>
						{!isHistory && (
							<FilterButton
								label={t('Paths')}
								icon="folder"
								compact={compact}
								value={filters.paths?.length ? filters.paths.join(', ') : undefined}
								onClick={async () => {
									const r = await call<string[] | undefined>('pickPaths', { current: filters.paths });
									if (r) {
										applyFilters({ paths: r.length ? r : undefined });
									}
								}}
								onClear={() => applyFilters({ paths: undefined })}
							/>
						)}
						<span class="spacer" />
						{loading && <span class="codicon codicon-loading codicon-modifier-spin" title={t('Loading')} />}
						<IconButton icon="refresh" title={t('Refresh')} onClick={() => void load(filters, false, [])} />
						<IconButton
							icon="git-pull-request-go-to-changes"
							title="Cherry-Pick"
							disabled={!selected.length}
							onClick={() => call('command', { command: 'changeline.log.cherryPick', args: [{ logId: init.id }] })}
						/>
						<IconButton
							icon="settings-gear"
							title={t('View Options')}
							onClick={(e) => {
								const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
								setMenu({ x: Math.max(0, r.right - 240), y: r.bottom + 2 });
							}}
						/>
						<IconButton icon="layout-sidebar-right" title={t('Show Details')} active={opts.showDetails} onClick={() => setOpt({ showDetails: !opts.showDetails })} />
					</div>
					{error && <div class="banner jg-error">{error}</div>}
					<div class="table-header" style={{ gridTemplateColumns: gridCols }}>
						<div class="th">{t('Subject')}</div>
						{showAuthor && (
							<div class="th">
								<span class="resizer" onMouseDown={colResize('colAuthor') as any} />
								{t('Author')}
							</div>
						)}
						{showDate && (
							<div class="th">
								<span class="resizer" onMouseDown={colResize('colDate') as any} />
								{t('Date')}
							</div>
						)}
						{showHashCol && (
							<div class="th">
								<span class="resizer" onMouseDown={colResize('colHash') as any} />
								{t('Hash')}
							</div>
						)}
					</div>
					<div ref={tableRef} class="table-body jg-focus-within" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown as any}>
						{!loading && total === 0 && <div class="jg-empty">{Object.values(filters).some(Boolean) ? t('No commits matching filters') : t('No commits')}</div>}
						<div style={{ height: `${total * ROW_HEIGHT}px`, position: 'relative' }}>
							{visible.map((c, k) => {
								const i = first + k;
								const row = graph[i];
								const isSel = selectedSet.has(c.hash);
								const dim = opts.highlightCurrent && refs.head !== undefined && !inHead.has(c.hash);
								const mine = opts.highlightMine && !!me && c.author === me;
								const rowLabels = labels.get(c.hash);
								const ctx = JSON.stringify({
									webviewSection: 'commit',
									logId: init.id,
									hash: c.hash,
									isHead: c.hash === refs.head,
									inHead: inHead.has(c.hash),
									isMerge: c.parents.length > 1,
									isRoot: c.parents.length === 0,
									multiple: selected.length > 1 && isSel,
									isHistory,
									preventDefaultContextMenuItems: true,
								});
								return (
									<div
										key={c.hash}
										class={`commit-row${isSel ? ' selected' : ''}${dim ? ' dim' : ''}${mine ? ' mine' : ''}`}
										style={{ top: `${i * ROW_HEIGHT}px`, gridTemplateColumns: gridCols }}
										data-vscode-context={ctx}
										onMouseDown={(e) => {
											if (e.button === 2 && !isSel) {
												anchor.current = c.hash;
												select([c.hash]);
											}
										}}
										onClick={(e) => rowClick(c, e as unknown as MouseEvent)}
										onDblClick={() => isHistory && call('openCommitDiffForPath', { hash: c.hash })}
										title={`${c.subject}\n${c.hash}\n${c.author} <${c.authorEmail}>\n${fullDate(c.authorDate)}`}
									>
										<div class="td subject">
											{row && <GraphCell row={row} isHead={c.hash === refs.head} dimmed={dim} />}
											{!row && <span class="no-graph-dot" />}
											<span class="text">{c.subject}</span>
											{collapsed?.counts.has(c.hash) && (
												<button
													class="collapsed-marker"
													title={t('Expand the collapsed linear branch')}
													onClick={(e) => {
														e.stopPropagation();
														setExpandedRuns(new Set([...expandedRuns, c.hash]));
													}}
												>
													+{collapsed.counts.get(c.hash)}
												</button>
											)}
											{rowLabels && (
												<span class="labels">
													{rowLabels.map((l) => (
														<span class={`ref-label ${l.kind}`} title={l.title}>
															<Icon name={l.kind === 'tag' ? 'tag' : l.kind === 'head' ? 'target' : 'git-branch'} />
															{l.text}
														</span>
													))}
												</span>
											)}
										</div>
										{showAuthor && <div class="td author">{c.author}</div>}
										{showDate && <div class="td date">{formatDate(c.authorDate, opts.dateFormat)}</div>}
										{showHashCol && <div class="td hash">{c.hash.slice(0, 8)}</div>}
									</div>
								);
							})}
						</div>
					</div>
				</div>
				{opts.showDetails && (
					<>
						<div class="jg-splitter-v" onMouseDown={onDetailsSplit as any} />
						<div class="right-pane" style={{ width: `${dw}px` }}>
							<DetailsPane
								details={details}
								loading={detailsLoading}
								logId={init.id}
								highlightPath={isHistory ? init.scope.path : undefined}
								parentIndex={parentIndex}
								onParentChange={async (i) => {
									setParentIndex(i);
									setDetails(await call<Details>('details', { hashes: selected, parentIndex: i }));
								}}
								onNavigate={(hash) => {
									const i = index.get(hash);
									if (i !== undefined) {
										anchor.current = hash;
										select([hash]);
										scrollTo(i);
									} else {
										pendingSelect.current = hash;
										void load(filters, true, allCommits);
									}
								}}
							/>
						</div>
					</>
				)}
			</div>
			{menu && (
				<PopupMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					items={[
						{ label: `${opts.showHash ? '✓ ' : '   '}Show Hash Column`, onClick: () => setOpt({ showHash: !opts.showHash }) },
						{ label: `${opts.dateFormat === 'relative' ? '✓ ' : '   '}Relative Dates`, onClick: () => setOpt({ dateFormat: opts.dateFormat === 'relative' ? 'absolute' : 'relative' }) },
						'sep',
						{ label: `${opts.highlightCurrent ? '✓ ' : '   '}Highlight Current Branch`, onClick: () => setOpt({ highlightCurrent: !opts.highlightCurrent }) },
						{ label: `${opts.highlightMine ? '✓ ' : '   '}Highlight My Commits`, onClick: () => setOpt({ highlightMine: !opts.highlightMine }) },
						{ label: `${opts.collapseLinear ? '✓ ' : '   '}Collapse Linear Branches`, onClick: () => {
							setExpandedRuns(new Set());
							setOpt({ collapseLinear: !opts.collapseLinear });
						} },
						'sep',
						{ label: t('Go to Hash/Branch/Tag...'), onClick: () => call('command', { command: 'changeline.log.goTo', args: [{ logId: init.id }] }) },
					]}
				/>
			)}
			<div class="status-line jg-muted">
				{plural(total, '{0} commit', '{0} commits')}
				{hasMore ? '+' : ''}
				{selected.length > 1 ? ' · ' + t('{0} selected', selected.length) : ''}
				{!graphEnabled && ' · ' + t('graph hidden while filtering by text, user or date')}
			</div>
		</div>
	);
}

render(<App />, document.getElementById('app')!);
mountDialogLayer();
