import '../common/base.css';
import './style.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { CommitInfo, FileChange } from '../../src/shared/types';
import { Checkbox, FileTree, Icon, PopupMenu, useKeys, useSplitter } from '../common/components';
import { formatDate } from '../common/format';
import { call } from '../common/rpc';
import { t } from '../common/l10n';

interface Target {
	root: string;
	name: string;
	branch?: string;
	source: string;
	sourceLabel: string;
	remotes: string[];
	remote?: string;
	remoteBranch: string;
	exists: boolean;
	hasUpstream: boolean;
	commits: CommitInfo[];
	selected: boolean;
	error?: string;
}

interface Data {
	targets: Target[];
	protectedBranches: string[];
	pushTags: 'none' | 'all' | 'follow';
	runHooks: boolean;
}

function App() {
	const [data, setData] = useState<Data | null>(null);
	const [targets, setTargets] = useState<Target[]>([]);
	const [selectedCommit, setSelectedCommit] = useState<{ root: string; hash: string } | null>(null);
	const [files, setFiles] = useState<FileChange[]>([]);
	const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [tagsEnabled, setTagsEnabled] = useState(false);
	const [tags, setTags] = useState<'all' | 'follow'>('all');
	const [runHooks, setRunHooks] = useState(true);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [leftWidth, onSplit] = useSplitter('push', 480, { min: 260 });

	useEffect(() => {
		call<Data>('ready').then((d) => {
			setData(d);
			setTargets(d.targets);
			setTagsEnabled(d.pushTags !== 'none');
			setTags(d.pushTags === 'follow' ? 'follow' : 'all');
			setRunHooks(d.runHooks);
			const first = d.targets.find((target) => target.commits.length);
			if (first) {
				selectCommit(first.root, first.commits[0].hash);
			}
		});
	}, []);

	const selectCommit = async (root: string, hash: string) => {
		setSelectedCommit({ root, hash });
		setFiles(await call<FileChange[]>('files', { root, hash }));
	};

	const update = (target: Target) => setTargets((ts) => ts.map((x) => (x.root === target.root ? target : x)));

	const retarget = async (target: Target, remote: string, remoteBranch: string) => {
		setEditing(null);
		update(await call<Target>('retarget', { root: target.root, remote, remoteBranch }));
	};

	const push = async (force?: 'lease') => {
		setBusy(true);
		try {
			await call('push', {
				targets: targets.map((target) => ({ root: target.root, remote: target.remote, remoteBranch: target.remoteBranch, selected: target.selected && !!target.remote })),
				force,
				tags: tagsEnabled ? tags : 'none',
				runHooks,
			});
		} finally {
			setBusy(false);
		}
	};

	useKeys((e) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void push();
		} else if (e.key === 'Escape' && !editing) {
			void call('cancel');
		}
	});

	if (!data) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	const anySelected = targets.some((target) => target.selected && target.remote);
	const isProtected = (name: string) => data.protectedBranches.some((p) => new RegExp('^' + p.split('*').join('.*') + '$').test(name));
	const forceBlocked = targets.some((target) => target.selected && isProtected(target.remoteBranch));

	return (
		<div class="push-view">
			<div class="jg-split-h body">
				<div class="left" style={{ width: `${leftWidth}px` }}>
					{targets.map((target) => (
						<div class="target">
							<div class="target-head">
								<Checkbox checked={target.selected} disabled={!target.remote} onChange={(v) => update({ ...target, selected: v })} />
								<Icon name="repo" />
								{targets.length > 1 && <span class="repo-name">{target.name}</span>}
								<span class="branch">{target.sourceLabel}</span>
								<span class="arrow">→</span>
								{editing === target.root ? (
									<TargetEditor target={target} onDone={(r, b) => retarget(target, r, b)} onCancel={() => setEditing(null)} />
								) : target.remote ? (
									<a class="jg-link target-link" title={t('Click to edit the push target')} onClick={() => setEditing(target.root)}>
										{target.remote} : {target.remoteBranch}
									</a>
								) : (
									<a
										class="jg-link"
										onClick={async () => {
											const nt = await call<Target | undefined>('defineRemote', { root: target.root });
											if (nt) {
												update(nt);
											}
										}}
									>
										{t('Define remote')}
									</a>
								)}
								{target.remote && !target.exists && <span class="new-badge">{t('New')}</span>}
							</div>
							{target.error && <div class="jg-error target-error">{target.error}</div>}
							{target.commits.length === 0 && target.remote && !target.error && <div class="jg-muted no-commits">{target.exists ? t('Nothing to push') : t('No new commits; the branch will be created on the remote')}</div>}
							<div class="commits jg-focus-within" tabIndex={0}>
								{target.commits.map((c) => (
									<div
										class={`jg-row commit${selectedCommit?.hash === c.hash ? ' selected' : ''}`}
										onClick={() => selectCommit(target.root, c.hash)}
										title={`${c.hash}\n${c.author}\n${new Date(c.authorDate * 1000).toLocaleString()}`}
									>
										<Icon name="git-commit" />
										<span class="name">{c.subject}</span>
										<span class="detail">{c.author}</span>
										<span class="detail">{formatDate(c.authorDate, 'relative')}</span>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
				<div class="jg-splitter-v" onMouseDown={onSplit as any} />
				<div class="right jg-scroll">
					{selectedCommit ? (
						<FileTree
							files={files}
							groupByDir={true}
							selected={selectedFiles}
							onSelect={setSelectedFiles}
							onOpen={(f) => call('diff', { root: selectedCommit.root, hash: selectedCommit.hash, path: f.path })}
						/>
					) : (
						<div class="jg-empty">{t('Select a commit to see its changes')}</div>
					)}
				</div>
			</div>
			<div class="footer">
				<Checkbox checked={tagsEnabled} onChange={setTagsEnabled} label={t('Push tags:')} />
				<select disabled={!tagsEnabled} value={tags} onChange={(e) => setTags((e.target as HTMLSelectElement).value as 'all' | 'follow')}>
					<option value="all">{t('All')}</option>
					<option value="follow">{t('Current Branch')}</option>
				</select>
				<Checkbox checked={runHooks} onChange={setRunHooks} label={t('Run Git hooks')} />
				<span class="spacer" />
				<button class="jg-btn" disabled={busy} onClick={() => call('cancel')}>
					{t('Cancel')}
				</button>
				<span class="jg-split-btn">
					<button class="jg-btn primary" disabled={busy || !anySelected} onClick={() => push()} title={t('Push (⌘↩)')}>
						{t('Push')}
					</button>
					<button
						class="jg-btn primary"
						disabled={busy || !anySelected}
						title={t('More push options')}
						onClick={(e) => {
							const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
							setMenu({ x: r.right - 200, y: r.top - 40 });
						}}
					>
						<Icon name="chevron-down" />
					</button>
				</span>
			</div>
			{menu && (
				<PopupMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					items={[
						forceBlocked
							? { label: t('Force Push (blocked for protected branch)'), onClick: () => undefined }
							: { label: t('Force Push (--force-with-lease)'), icon: 'warning', onClick: () => push('lease') },
					]}
				/>
			)}
		</div>
	);
}

function TargetEditor(props: { target: Target; onDone: (remote: string, branch: string) => void; onCancel: () => void }) {
	const [remote, setRemote] = useState(props.target.remote ?? props.target.remotes[0] ?? 'origin');
	const [branch, setBranch] = useState(props.target.remoteBranch);
	return (
		<span class="target-editor">
			<select value={remote} onChange={(e) => setRemote((e.target as HTMLSelectElement).value)}>
				{props.target.remotes.map((r) => (
					<option value={r}>{r}</option>
				))}
			</select>
			<span>:</span>
			<input
				type="text"
				value={branch}
				ref={(el) => {
					if (el) {
						setTimeout(() => el.focus(), 0);
					}
				}}
				onInput={(e) => setBranch((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						e.stopPropagation();
						props.onDone(remote, branch.trim());
					} else if (e.key === 'Escape') {
						e.stopPropagation();
						props.onCancel();
					}
				}}
				onBlur={() => props.onDone(remote, branch.trim())}
			/>
		</span>
	);
}

render(<App />, document.getElementById('app')!);
