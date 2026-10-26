import { useMemo, useState } from 'preact/hooks';
import { Icon, IconButton } from '../common/components';
import { getState, patchState } from '../common/rpc';
import type { RefInfo, RefsPayload } from './types';
import { t } from '../common/l10n';

interface Node {
	key: string;
	label: string;
	depth: number;
	kind: 'section' | 'folder' | 'ref' | 'head';
	ref?: RefInfo;
	count?: number;
}

function folderTree(refs: RefInfo[], prefix: string, depth: number, collapsed: Set<string>, nameOf: (r: RefInfo) => string, group: boolean): Node[] {
	if (!group) {
		return refs.map((r) => ({ key: r.name, label: nameOf(r), depth, kind: 'ref', ref: r }));
	}
	const folders = new Map<string, RefInfo[]>();
	const leaves: RefInfo[] = [];
	for (const r of refs) {
		const name = nameOf(r);
		const i = name.indexOf('/');
		if (i > 0) {
			const f = name.slice(0, i);
			const arr = folders.get(f) ?? [];
			arr.push(r);
			folders.set(f, arr);
		} else {
			leaves.push(r);
		}
	}
	const out: Node[] = [];
	for (const [f, list] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const key = `${prefix}/${f}`;
		out.push({ key, label: f, depth, kind: 'folder', count: list.length });
		if (!collapsed.has(key)) {
			out.push(...folderTree(list, key, depth + 1, collapsed, (r) => nameOf(r).slice(f.length + 1), group));
		}
	}
	for (const r of leaves.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
		out.push({ key: r.name, label: nameOf(r), depth, kind: 'ref', ref: r });
	}
	return out;
}

export function BranchesPane(props: {
	refs: RefsPayload;
	logId: string;
	selected?: string;
	onClick: (ref: string) => void;
	onDoubleClick: (ref: string) => void;
	onCommand: (cmd: string, args?: unknown[]) => void;
}) {
	const saved = getState<{ branchCollapsed: string[]; branchGroup: boolean }>();
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set(saved.branchCollapsed ?? ['tags']));
	const [group, setGroup] = useState<boolean>(saved.branchGroup ?? true);
	const [filter, setFilter] = useState('');
	const favorites = new Set(props.refs.favorites ?? []);

	const toggle = (key: string) => {
		const next = new Set(collapsed);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		setCollapsed(next);
		patchState({ branchCollapsed: [...next] });
	};

	const nodes = useMemo(() => {
		const f = filter.trim().toLowerCase();
		const match = (r: RefInfo) => !f || r.shortName.toLowerCase().includes(f);
		const sortFav = (a: RefInfo, b: RefInfo) => Number(favorites.has(b.shortName)) - Number(favorites.has(a.shortName)) || a.shortName.localeCompare(b.shortName);
		const out: Node[] = [{ key: 'HEAD', label: props.refs.detached ? t('HEAD (detached)') : t('HEAD (Current Branch)'), depth: 0, kind: 'head' }];
		const local = props.refs.refs.filter((r) => r.type === 'head' && match(r)).sort(sortFav);
		const remote = props.refs.refs.filter((r) => r.type === 'remote' && match(r)).sort(sortFav);
		const tags = props.refs.refs.filter((r) => r.type === 'tag' && match(r));
		out.push({ key: 'local', label: t('Local'), depth: 0, kind: 'section', count: local.length });
		if (!collapsed.has('local') || f) {
			const favs = local.filter((r) => favorites.has(r.shortName));
			const rest = local.filter((r) => !favorites.has(r.shortName));
			out.push(...favs.map((r) => ({ key: r.name, label: r.shortName, depth: 1, kind: 'ref' as const, ref: r })));
			out.push(...folderTree(rest, 'local', 1, collapsed, (r) => r.shortName, group && !f));
		}
		out.push({ key: 'remote', label: t('Remote'), depth: 0, kind: 'section', count: remote.length });
		if (!collapsed.has('remote') || f) {
			const remotes = new Map<string, RefInfo[]>();
			for (const r of remote) {
				const arr = remotes.get(r.remote ?? '') ?? [];
				arr.push(r);
				remotes.set(r.remote ?? '', arr);
			}
			for (const [name, list] of remotes) {
				const key = `remote/${name}`;
				out.push({ key, label: name, depth: 1, kind: 'folder', count: list.length });
				if (!collapsed.has(key) || f) {
					out.push(...folderTree(list, key, 2, collapsed, (r) => r.shortName.slice(name.length + 1), group && !f));
				}
			}
		}
		if (tags.length) {
			out.push({ key: 'tags', label: t('Tags'), depth: 0, kind: 'section', count: tags.length });
			if (!collapsed.has('tags') || f) {
				out.push(...tags.sort((a, b) => b.shortName.localeCompare(a.shortName, undefined, { numeric: true })).map((r) => ({ key: r.name, label: r.shortName, depth: 1, kind: 'ref' as const, ref: r })));
			}
		}
		return out;
	}, [props.refs, collapsed, filter, group]);

	return (
		<div class="branches-pane">
			<div class="jg-toolbar">
				<input type="search" class="branch-filter" placeholder={t('Search branches')} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
				<IconButton icon="add" title={t('New Branch...')} onClick={() => props.onCommand('changeline.newBranch')} />
				<IconButton icon="repo-fetch" title={t('Fetch')} onClick={() => props.onCommand('changeline.fetch')} />
				<IconButton
					icon="list-tree"
					title={t('Group by Directory')}
					active={group}
					onClick={() => {
						setGroup(!group);
						patchState({ branchGroup: !group });
					}}
				/>
			</div>
			<div class="jg-scroll branch-list jg-focus-within" tabIndex={0}>
				{nodes.map((n) => {
					const isRef = n.kind === 'ref' && n.ref;
					const ref = n.ref;
					const refName = n.kind === 'head' ? 'HEAD' : ref?.type === 'tag' ? `refs/tags/${ref.shortName}` : ref?.shortName;
					const ctx = isRef || n.kind === 'head'
						? JSON.stringify({
							webviewSection: 'branch',
							logId: props.logId,
							ref: n.kind === 'head' ? 'HEAD' : ref!.shortName,
							refType: n.kind === 'head' ? 'head' : ref!.type,
							isCurrent: n.kind === 'head' || !!ref?.current,
							isLocal: ref?.type === 'head',
							isRemote: ref?.type === 'remote',
							isTag: ref?.type === 'tag',
							hasUpstream: !!ref?.upstream,
							preventDefaultContextMenuItems: true,
						})
						: undefined;
					return (
						<div
							key={n.key}
							class={`jg-row${props.selected && refName === props.selected ? ' selected' : ''}${n.kind === 'section' ? ' section' : ''}`}
							style={{ paddingLeft: `${4 + n.depth * 14}px` }}
							data-vscode-context={ctx}
							onClick={() => {
								if (n.kind === 'section' || n.kind === 'folder') {
									toggle(n.key);
								} else if (refName) {
									props.onClick(refName);
								}
							}}
							onDblClick={() => refName && props.onDoubleClick(refName)}
							title={ref ? `${ref.shortName}${ref.upstream ? ` → ${ref.upstream}` : ''}` : undefined}
						>
							{n.kind === 'section' || n.kind === 'folder' ? (
								<>
									<Icon name={collapsed.has(n.key) && !filter ? 'chevron-right' : 'chevron-down'} className="twisty" />
									{n.kind === 'folder' && <Icon name={n.depth === 1 && n.key.startsWith('remote/') ? 'cloud' : 'folder'} />}
									<span class="name">{n.label}</span>
								</>
							) : n.kind === 'head' ? (
								<>
									<span class="twisty" />
									<Icon name="target" />
									<span class="name">{n.label}</span>
								</>
							) : (
								<>
									<span class="twisty" />
									{favorites.has(ref!.shortName) && ref!.type !== 'tag' ? (
										<Icon name="star-full" className="fav" title={t('Favorite')} />
									) : (
										<Icon name={ref!.type === 'tag' ? 'tag' : ref!.current ? 'git-branch' : 'git-branch'} className={ref!.current ? 'current-icon' : 'ref-icon'} />
									)}
									<span class={`name${ref!.current ? ' current' : ''}`}>{n.label}</span>
									{ref!.type === 'head' && (ref!.ahead || ref!.behind) ? (
										<span class="track">
											{ref!.behind ? <span class="incoming">↓{ref!.behind}</span> : null}
											{ref!.ahead ? <span class="outgoing">↑{ref!.ahead}</span> : null}
										</span>
									) : null}
									{ref!.upstreamGone && <span class="detail">{t('gone')}</span>}
								</>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
