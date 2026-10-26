import '../common/base.css';
import './style.css';
import MarkdownIt from 'markdown-it';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FileTree, Icon, IconButton, PopupMenu, useSplitter } from '../common/components';
import { formatDate } from '../common/format';
import { call, on } from '../common/rpc';
import { plural, t, tx } from '../common/l10n';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

type PrState = 'open' | 'closed' | 'merged';

interface PrUser {
	login: string;
}

interface PullRequest {
	number: number;
	title: string;
	state: PrState;
	draft: boolean;
	author: PrUser;
	createdAt: string;
	updatedAt: string;
	url: string;
	headRef: string;
	baseRef: string;
	labels: string[];
	commentsCount?: number;
}

interface TimelineItem {
	id: string;
	kind: 'comment' | 'review' | 'reviewComment' | 'commit' | 'event';
	author?: PrUser;
	createdAt: string;
	body?: string;
	state?: string;
	path?: string;
	line?: number;
	diffHunk?: string;
	sha?: string;
}

interface Details extends PullRequest {
	body: string;
	mergeable?: boolean;
	reviewers: { user: PrUser; state: string }[];
	timeline: TimelineItem[];
	commits: { sha: string; message: string; author: string; date: string }[];
	files: { path: string; origPath?: string; status: string; additions: number; deletions: number }[];
	checks?: { state: string; total?: number; pipeline?: string };
	commentsHidden?: boolean;
}

interface Init {
	repos: { root: string; name: string }[];
	repoRoot?: string;
	hosting?: { name: string; webUrl: string; kind: string };
	error?: string;
	branch?: string;
}

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function emptyListText(kind: string, state: PrState | 'all'): string {
	const gitlab = kind === 'gitlab';
	switch (state) {
		case 'open':
			return gitlab ? t('No open merge requests') : t('No open pull requests');
		case 'merged':
			return gitlab ? t('No merged merge requests') : t('No merged pull requests');
		case 'closed':
			return gitlab ? t('No closed merge requests') : t('No closed pull requests');
		default:
			return gitlab ? t('No merge requests') : t('No pull requests');
	}
}

function checksLabel(checks: { state: string; total?: number; pipeline?: string }): string {
	if (checks.pipeline) {
		return t('Pipeline {0}', checks.pipeline);
	}
	if (checks.total) {
		return plural(checks.total, '{0} status check', '{0} status checks');
	}
	return checks.state === 'success' ? t('Checks passed') : checks.state === 'failure' ? t('Checks failed') : t('Checks pending');
}

function stateIcon(p: PullRequest): { icon: string; cls: string; label: string } {
	if (p.state === 'merged') {
		return { icon: 'git-merge', cls: 'merged', label: t('Merged') };
	}
	if (p.state === 'closed') {
		return { icon: 'git-pull-request-closed', cls: 'closed', label: t('Closed') };
	}
	if (p.draft) {
		return { icon: 'git-pull-request-draft', cls: 'draft', label: t('Draft') };
	}
	return { icon: 'git-pull-request', cls: 'open', label: t('Open') };
}

function Markdown({ text }: { text: string }) {
	const html = useMemo(() => md.render(text || ''), [text]);
	return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function App() {
	const [init, setInit] = useState<Init | null>(null);
	const [state, setState] = useState<PrState | 'all'>('open');
	const [query, setQuery] = useState('');
	const [mineOnly, setMineOnly] = useState(false);
	const [me, setMe] = useState<string | undefined>();
	const [list, setList] = useState<PullRequest[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [selected, setSelected] = useState<number | undefined>();
	const [details, setDetails] = useState<Details | undefined>();
	const [tab, setTab] = useState<'overview' | 'commits' | 'files'>('overview');
	const [comment, setComment] = useState('');
	const [busy, setBusy] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const [selFiles, setSelFiles] = useState<string[]>([]);
	const [listWidth, onSplit] = useSplitter('prs', 380, { min: 240, max: 800 });

	const stateRef = useRef(state);
	stateRef.current = state;
	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	const load = async (st = stateRef.current) => {
		setLoading(true);
		setError(undefined);
		try {
			setList(await call<PullRequest[]>('list', { state: st }));
		} catch (e) {
			setError(String((e as Error).message));
		} finally {
			setLoading(false);
		}
	};

	const loadDetails = async (n: number) => {
		setSelected(n);
		try {
			setDetails(await call<Details>('details', { number: n }));
		} catch (e) {
			setError(String((e as Error).message));
		}
	};

	const start = () =>
		call<Init>('init').then((d) => {
			setInit(d);
			if (d.hosting) {
				void load();
				call<string | undefined>('user').then(setMe);
			}
		});

	useEffect(() => {
		void start();
		const offs = [
			on('refresh', () => void start()),
			on<number>('updated', (n) => {
				if (n === selectedRef.current) {
					void loadDetails(n);
				}
			}),
		];
		return () => offs.forEach((o) => o());
	}, []);

	const act = async (method: string, params: unknown, reload = true) => {
		setBusy(true);
		try {
			await call(method, params);
			if (reload && selected) {
				await loadDetails(selected);
				await load();
			}
		} catch (e) {
			setError(String((e as Error).message));
		} finally {
			setBusy(false);
		}
	};

	if (!init) {
		return <div class="jg-empty">{t('Loading…')}</div>;
	}
	if (!init.repoRoot) {
		return <div class="jg-empty">{t('No Git repository.')}</div>;
	}
	if (!init.hosting) {
		return (
			<div class="jg-empty">
				<p>{init.error ?? t('This repository is not hosted on GitHub or GitLab.')}</p>
			</div>
		);
	}

	const q = query.trim().toLowerCase();
	const shown = list.filter((p) => (!mineOnly || p.author.login === me) && (!q || p.title.toLowerCase().includes(q) || `#${p.number}`.includes(q) || p.author.login.toLowerCase().includes(q) || p.headRef.toLowerCase().includes(q)));
	const prefix = init.hosting.kind === 'gitlab' ? '!' : '#';
	const reviewComments = (path: string) => (details?.timeline ?? []).filter((entry) => entry.kind === 'reviewComment' && entry.path === path).length;

	return (
		<div class="pr-view">
			<div class="jg-toolbar">
				{init.repos.length > 1 && (
					<select
						value={init.repoRoot}
						onChange={async (e) => {
							const root = (e.target as HTMLSelectElement).value;
							await call('setRepo', { root });
							setDetails(undefined);
							setSelected(undefined);
							setInit(await call<Init>('init'));
							void load();
						}}
					>
						{init.repos.map((r) => (
							<option value={r.root}>{r.name}</option>
						))}
					</select>
				)}
				<select value={state} onChange={(e) => {
					const v = (e.target as HTMLSelectElement).value as PrState | 'all';
					setState(v);
					void load(v);
				}}>
					<option value="open">{t('Open')}</option>
					<option value="merged">{t('Merged')}</option>
					<option value="closed">{t('Closed')}</option>
					<option value="all">{t('All')}</option>
				</select>
				<span class="search">
					<Icon name="search" />
					<input type="search" placeholder={t('Search title, number, author, branch')} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
				</span>
				<IconButton icon="person" title={t('Only my pull requests')} active={mineOnly} onClick={() => setMineOnly(!mineOnly)} />
				<span class="spacer" />
				{loading && <span class="codicon codicon-loading codicon-modifier-spin" />}
				<IconButton icon="refresh" title={t('Refresh')} onClick={() => void load()} />
				<IconButton icon="add" title={t('Create {0} Request...', init.hosting.kind === 'gitlab' ? 'Merge' : 'Pull')} onClick={() => call('create')} />
				<IconButton icon="link-external" title={t('Open {0}', init.hosting.name)} onClick={() => call('open', { url: init.hosting!.webUrl })} />
			</div>
			{error && (
				<div class="banner jg-error">
					{error}{' '}
					{/401|403|token|sign/i.test(error) && (
						<button class="jg-link" onClick={() => act('setToken', {}, false).then(() => load())}>
							{t('Sign in again')}
						</button>
					)}
				</div>
			)}
			<div class="jg-split-h">
				<div class="pr-list jg-focus-within" tabIndex={0} style={{ width: `${listWidth}px` }}>
					{!loading && !shown.length && <div class="jg-empty">{emptyListText(init.hosting.kind, state)}</div>}
					{shown.map((p) => {
						const s = stateIcon(p);
						return (
							<div class={`pr-item${selected === p.number ? ' selected' : ''}`} onClick={() => loadDetails(p.number)}>
								<Icon name={s.icon} className={`state-icon ${s.cls}`} title={s.label} />
								<div class="pr-main">
									<div class="pr-title">
										<span class="num">{prefix}{p.number}</span> {p.title}
									</div>
									<div class="pr-meta jg-muted">
										{p.author.login} · {formatDate(unix(p.updatedAt), 'relative')} · {p.headRef} → {p.baseRef}
										{p.commentsCount ? (
											<span>
												{' '}
												· <Icon name="comment" /> {p.commentsCount}
											</span>
										) : null}
									</div>
									{p.labels.length > 0 && (
										<div class="labels">
											{p.labels.map((l) => (
												<span class="label">{l}</span>
											))}
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
				<div class="jg-splitter-v" onMouseDown={onSplit as any} />
				<div class="pr-details">
					{!details ? (
						<div class="jg-empty">{init.hosting.kind === 'gitlab' ? t('Select a merge request') : t('Select a pull request')}</div>
					) : (
						<>
							<div class="pr-header">
								<div class="pr-heading">
									<span class={`state-badge ${stateIcon(details).cls}`}>
										<Icon name={stateIcon(details).icon} /> {stateIcon(details).label}
									</span>
									<span class="title">{details.title}</span>
									<span class="jg-muted">
										{prefix}
										{details.number}
									</span>
								</div>
								<div class="jg-muted sub">
									{tx('{0} wants to merge {1} into {2} · opened {3}', <b>{details.author.login}</b>, <code>{details.headRef}</code>, <code>{details.baseRef}</code>, formatDate(unix(details.createdAt), 'relative'))}
									{details.checks && details.checks.state !== 'none' && (
										<span class={`checks ${details.checks.state}`}>
											{' '}
											· <Icon name={details.checks.state === 'success' ? 'pass-filled' : details.checks.state === 'failure' ? 'error' : 'clock'} /> {checksLabel(details.checks)}
										</span>
									)}
								</div>
								<div class="actions">
									<button class="jg-btn" disabled={busy} onClick={() => act('checkout', { number: details.number }, false)}>
										<Icon name="git-branch" /> {t('Checkout')}
									</button>
									<button class="jg-btn" onClick={() => call('open', { url: details.url })}>
										<Icon name="link-external" /> {t('Open in Browser')}
									</button>
									{details.state === 'open' && (
										<span class="jg-split-btn">
											<button class="jg-btn primary" disabled={busy || details.draft} title={details.mergeable === false ? t('Not mergeable (conflicts?)') : undefined} onClick={() => act('merge', { number: details.number, method: 'merge' })}>
												<Icon name="git-merge" /> {t('Merge')}
											</button>
											<button
												class="jg-btn primary"
												disabled={busy || details.draft}
												onClick={(e) => {
													const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
													setMenu({ x: r.left - 120, y: r.bottom + 2 });
												}}
											>
												<Icon name="chevron-down" />
											</button>
										</span>
									)}
									{details.state === 'open' ? (
										<button class="jg-btn" disabled={busy} onClick={() => act('setState', { number: details.number, state: 'closed' })}>
											{t('Close')}
										</button>
									) : details.state === 'closed' ? (
										<button class="jg-btn" disabled={busy} onClick={() => act('setState', { number: details.number, state: 'open' })}>
											{t('Reopen')}
										</button>
									) : null}
									<IconButton icon="refresh" title={t('Refresh')} onClick={() => loadDetails(details.number)} />
								</div>
								<div class="tabs">
									<button class={`tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>
										{t('Overview')}
									</button>
									<button class={`tab${tab === 'commits' ? ' active' : ''}`} onClick={() => setTab('commits')}>
										{t('Commits ({0})', details.commits.length)}
									</button>
									<button class={`tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
										{t('Files ({0})', details.files.length)}
									</button>
								</div>
							</div>
							<div class="pr-body jg-scroll">
								{tab === 'overview' && (
									<div class="overview">
										{details.body.trim() ? <Markdown text={details.body} /> : <p class="jg-muted">{t('No description provided.')}</p>}
										{details.reviewers.length > 0 && (
											<div class="reviewers">
												<div class="section-title">{t('Reviewers')}</div>
												{details.reviewers.map((r) => (
													<div class={`reviewer ${r.state}`}>
														<Icon name={r.state === 'approved' ? 'pass-filled' : r.state === 'changes_requested' ? 'error' : r.state === 'pending' ? 'clock' : 'comment'} /> {r.user.login}{' '}
														<span class="jg-muted">{r.state.replace('_', ' ')}</span>
													</div>
												))}
											</div>
										)}
										<div class="section-title">{t('Timeline')}</div>
										{details.commentsHidden && (
											<p class="notice">
												<Icon name="info" /> {t('Comments are only visible to signed-in users. Sign in to GitLab to see and add them.')}
											</p>
										)}
										<div class="timeline">
											{details.timeline.map((timelineItem) => (
												<div class={`tl-item ${timelineItem.kind}`}>
													<div class="tl-head">
														<Icon name={timelineItem.kind === 'commit' ? 'git-commit' : timelineItem.kind === 'review' ? (timelineItem.state === 'APPROVED' ? 'pass-filled' : timelineItem.state === 'CHANGES_REQUESTED' ? 'error' : 'eye') : timelineItem.kind === 'reviewComment' ? 'comment-discussion' : timelineItem.kind === 'event' ? 'info' : 'comment'} />
														<b>{timelineItem.author?.login}</b>
														<span class="jg-muted">
															{timelineItem.kind === 'commit'
																? t('added a commit')
																: timelineItem.kind === 'review'
																	? timelineItem.state === 'APPROVED'
																		? t('approved these changes')
																		: timelineItem.state === 'CHANGES_REQUESTED'
																			? t('requested changes')
																			: t('reviewed')
																	: timelineItem.kind === 'reviewComment'
																		? t('commented on {0}', `${timelineItem.path}${timelineItem.line ? `:${timelineItem.line}` : ''}`)
																		: t('commented')}{' '}
															· {formatDate(unix(timelineItem.createdAt), 'relative')}
														</span>
														{timelineItem.kind === 'commit' && timelineItem.sha && (
															<a class="jg-link mono" onClick={() => call('openCommit', { number: details.number, sha: timelineItem.sha })}>
																{timelineItem.sha.slice(0, 8)}
															</a>
														)}
														{timelineItem.kind === 'reviewComment' && timelineItem.path && (
															<a class="jg-link" onClick={() => call('openFile', { number: details.number, path: timelineItem.path })}>
																{t('Show in diff')}
															</a>
														)}
													</div>
													{timelineItem.kind === 'commit' ? <div class="tl-commit">{(timelineItem.body ?? '').split('\n')[0]}</div> : timelineItem.body ? <Markdown text={timelineItem.body} /> : null}
													{timelineItem.diffHunk && <pre class="hunk">{timelineItem.diffHunk.split('\n').slice(-4).join('\n')}</pre>}
												</div>
											))}
										</div>
										<div class="composer">
											<textarea placeholder={t('Leave a comment')} rows={4} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
											<div class="composer-buttons">
												<button class="jg-btn" disabled={busy || !comment.trim()} onClick={() => act('comment', { number: details.number, body: comment }).then(() => setComment(''))}>
													{t('Comment')}
												</button>
												<span class="spacer" />
												<button class="jg-btn" disabled={busy} onClick={() => act('review', { number: details.number, verdict: 'request_changes', body: comment }).then(() => setComment(''))}>
													{t('Request Changes')}
												</button>
												<button class="jg-btn primary" disabled={busy} onClick={() => act('review', { number: details.number, verdict: 'approve', body: comment }).then(() => setComment(''))}>
													{t('Approve')}
												</button>
											</div>
										</div>
									</div>
								)}
								{tab === 'commits' && (
									<div class="commits">
										{details.commits.map((c) => (
											<div class="jg-row" onDblClick={() => call('openCommit', { number: details.number, sha: c.sha })} title={t('Double-click to show the changes')}>
												<Icon name="git-commit" />
												<span class="mono jg-muted">{c.sha.slice(0, 8)}</span>
												<span class="name">{c.message.split('\n')[0]}</span>
												<span class="detail">{c.author}</span>
												<span class="detail">{c.date ? formatDate(unix(c.date), 'relative') : ''}</span>
											</div>
										))}
									</div>
								)}
								{tab === 'files' && (
									<div class="files">
										<FileTree
											files={details.files.map((f) => ({ path: f.path, origPath: f.origPath, status: f.status }))}
											groupByDir={true}
											selected={selFiles}
											onSelect={setSelFiles}
											onOpen={(f) => call('openFile', { number: details.number, path: f.path })}
										/>
										<div class="file-stats jg-muted">
											{t('{0} additions, {1} deletions', details.files.reduce((n, f) => n + f.additions, 0), details.files.reduce((n, f) => n + f.deletions, 0))} ·{' '}
											{details.files
												.filter((f) => reviewComments(f.path))
												.map((f) => `${f.path.split('/').pop()} (${plural(reviewComments(f.path), '{0} comment', '{0} comments')})`)
												.join(', ') || t('no review comments')}{' '}
											· {t('double-click a file to review it')}
										</div>
									</div>
								)}
							</div>
						</>
					)}
				</div>
			</div>
			{menu && details && (
				<PopupMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					items={[
						{ label: t('Create a Merge Commit'), icon: 'git-merge', onClick: () => act('merge', { number: details.number, method: 'merge' }) },
						{ label: t('Squash and Merge'), icon: 'fold', onClick: () => act('merge', { number: details.number, method: 'squash' }) },
						{ label: t('Rebase and Merge'), icon: 'git-pull-request', onClick: () => act('merge', { number: details.number, method: 'rebase' }) },
					]}
				/>
			)}
		</div>
	);
}

render(<App />, document.getElementById('app')!);
