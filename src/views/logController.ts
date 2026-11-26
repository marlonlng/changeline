import * as vscode from 'vscode';
import { commitFileTarget, openDiff, revisionTarget } from '../diff';
import type { LogQuery, Repository } from '../git/repository';
import { services } from '../services';
import type { CommitInfo, FileChange } from '../shared/types';
import { isBinary } from '../shared/diff';
import { mergeByDate } from '../shared/logMerge';
import { issueRules } from '../issueLinks';
import { config, escapeRegex, shortHash } from '../util';
import { DialogOverlay, DialogSurface, withDialogOrigin } from '../webviews/dialogOverlay';
import { renderWebviewHtml, RpcChannel, webviewOptions } from '../webviews/host';

export interface LogFilters {
	branches?: string[];
	users?: string[];
	since?: string;
	until?: string;
	dateLabel?: string;
	paths?: string[];
	text?: string;
	regex?: boolean;
	matchCase?: boolean;
}

export interface LogScope {
	kind: 'log' | 'history';
	repoRoot?: string;
	path?: string;
	lineRange?: { start: number; end: number };
	revisions?: string[];
	title?: string;
	filters?: LogFilters;
}

const FAVORITES_KEY = 'changeline.favoriteBranches';

export function favoriteBranches(repo: Repository): string[] {
	const all = services().context.workspaceState.get<Record<string, string[]>>(FAVORITES_KEY, {});
	return all[repo.root] ?? ['main', 'master'];
}

export async function toggleFavoriteBranch(repo: Repository, name: string): Promise<void> {
	const st = services().context.workspaceState;
	const all = st.get<Record<string, string[]>>(FAVORITES_KEY, {});
	const list = new Set(all[repo.root] ?? ['main', 'master']);
	if (list.has(name)) {
		list.delete(name);
	} else {
		list.add(name);
	}
	all[repo.root] = [...list];
	await st.update(FAVORITES_KEY, all);
	LogController.refreshAll(repo);
}

const PREVIEW_LIMIT = 2_000_000;

/** repoRoot of a log that shows all repositories of the workspace, like JetBrains' multi-root log. */
export const ALL_REPOS = '*';


export class LogController implements vscode.Disposable {
	private static registry = new Map<string, LogController>();
	private static lastFocused?: LogController;
	private static counter = 0;

	readonly id: string;
	readonly dialogs: DialogOverlay;
	private rpc: RpcChannel;
	private disposables: vscode.Disposable[] = [];
	selection: string[] = [];
	private selectionCommits: CommitInfo[] = [];
	repoRoot?: string;
	private focusRoot?: string;
	private resolveReady!: () => void;
	readonly ready = new Promise<void>((r) => (this.resolveReady = r));

	static get(id?: string): LogController | undefined {
		return (id && LogController.registry.get(id)) || LogController.lastFocused;
	}

	static refreshAll(repo?: Repository): void {
		for (const c of LogController.registry.values()) {
			if (!repo || c.repoRoot === repo.root || c.repoRoot === ALL_REPOS) {
				c.rpc.emit('refresh');
			}
		}
	}

	constructor(private readonly webview: vscode.Webview, readonly scope: LogScope, surface: DialogSurface) {
		this.id = `log-${++LogController.counter}`;
		this.repoRoot = scope.repoRoot ?? (scope.kind === 'log' && services().repos.repositories.length > 1 ? ALL_REPOS : services().repos.current()?.root);
		LogController.registry.set(this.id, this);
		LogController.lastFocused = this;
		this.dialogs = new DialogOverlay((name, data) => this.rpc.emit(name, data), surface);
		this.rpc = new RpcChannel(webview, { ...this.handlers(), ...this.dialogs.handlers() }, (fn) => withDialogOrigin(this.dialogs, fn));
		const s = services();
		this.disposables.push(
			s.repos.onDidChangeRefs((repo) => {
				if (repo.root === this.repoRoot || this.allRepos) {
					this.rpc.emit('refresh');
				}
			}),
			s.repos.onDidChangeRepositories(() => {
				if (this.allRepos && s.repos.repositories.length < 2) {
					this.repoRoot = s.repos.current()?.root;
				}
				if (!this.repoRoot || (!this.allRepos && !s.repos.getByRoot(this.repoRoot))) {
					this.repoRoot = s.repos.current()?.root;
				}
				this.rpc.emit('repos', this.reposInfo());
			}),
		);
	}

	get allRepos(): boolean {
		return this.repoRoot === ALL_REPOS;
	}

	/** The repository the log works on; with all repositories shown, the one of the selected commit. */
	get repo(): Repository | undefined {
		const s = services();
		if (this.allRepos) {
			return (this.focusRoot && s.repos.getByRoot(this.focusRoot)) || s.repos.current() || s.repos.repositories[0];
		}
		return this.repoRoot ? s.repos.getByRoot(this.repoRoot) : undefined;
	}

	private repoFor(root?: string): Repository | undefined {
		return root ? services().repos.getByRoot(root) : this.repo;
	}

	markFocused(): void {
		LogController.lastFocused = this;
	}

	/** Commits currently selected in the webview (newest first). */
	get selectedCommits(): CommitInfo[] {
		return this.selectionCommits;
	}

	/** Sets the selection like the webview does (newest first). */
	setSelection(commits: CommitInfo[]): void {
		this.selection = commits.map((c) => c.hash);
		this.selectionCommits = commits;
		if (commits[0]?.root) {
			this.focusRoot = commits[0].root;
		}
		LogController.lastFocused = this;
	}

	selectCommit(hash: string): void {
		this.rpc.emit('select', { hash });
	}

	setFilters(filters: LogFilters): void {
		this.rpc.emit('filters', filters);
	}

	refresh(): void {
		this.rpc.emit('refresh');
	}

	private reposInfo() {
		return {
			repos: services().repos.repositories.map((r) => ({ root: r.root, name: r.name })),
			repoRoot: this.repoRoot,
		};
	}

	private refsPayload(repo: Repository) {
		const st = repo.state;
		const all = this.allRepos ? services().repos.repositories : [repo];
		const seen = new Set<string>();
		const refs = all.flatMap((r) =>
			r.refs.filter((ref) => {
				const key = `${ref.type}:${ref.shortName}:${ref.hash}`;
				const fresh = !seen.has(key);
				seen.add(key);
				return fresh;
			}),
		);
		return {
			refs,
			head: st.head,
			branch: st.branch,
			detached: st.detached,
			favorites: favoriteBranches(repo),
		};
	}

	private query(filters: LogFilters, skip: number, limit: number, order?: 'date' | 'topo', graph: { firstParent?: boolean; noMerges?: boolean } = {}): LogQuery {
		const q: LogQuery = { skip, limit, order: order ?? config<'date' | 'topo'>('log.order', 'date'), firstParent: graph.firstParent, noMerges: graph.noMerges };
		if (this.scope.revisions) {
			q.revisions = this.scope.revisions;
		} else if (filters.branches && filters.branches.length) {
			q.revisions = filters.branches;
		}
		if (this.scope.kind === 'history' && this.scope.path) {
			if (this.scope.lineRange) {
				q.lineRange = { ...this.scope.lineRange, path: this.scope.path };
			} else {
				q.paths = [this.scope.path];
				q.follow = !filters.paths?.length;
			}
			if (!filters.branches?.length && !this.scope.revisions) {
				q.revisions = ['HEAD'];
			}
		} else if (filters.paths && filters.paths.length) {
			q.paths = filters.paths;
		}
		if (filters.users && filters.users.length) {
			q.authors = filters.users.map((u) => escapeRegex(u));
		}
		if (filters.text && !/^[0-9a-f]{7,40}$/i.test(filters.text.trim())) {
			q.text = filters.text;
			q.regex = filters.regex;
			q.matchCase = filters.matchCase;
		}
		q.since = filters.since;
		q.until = filters.until;
		return q;
	}

	private handlers() {
		return {
			init: async () => {
				setTimeout(() => this.resolveReady(), 0);
				const repo = this.repo;
				const user = repo ? await repo.getUser() : {};
				return {
					id: this.id,
					scope: this.scope,
					...this.reposInfo(),
					user,
					...(repo ? this.refsPayload(repo) : { refs: [] }),
					settings: {
						dateFormat: config('log.dateFormat', 'relative'),
						pageSize: config('log.pageSize', 1000),
						showHash: config('log.showHashColumn', false),
						order: config<'date' | 'topo'>('log.order', 'date'),
					},
					issueRules: await issueRules(repo),
				};
			},
			refs: () => {
				const repo = this.repo;
				return repo ? this.refsPayload(repo) : { refs: [] };
			},
			setRepo: (p: { root: string }) => {
				this.repoRoot = p.root;
				const repo = this.repo;
				if (repo && !this.allRepos) {
					services().repos.setLastActive(repo);
				}
				return repo ? this.refsPayload(repo) : { refs: [] };
			},
			load: async (p: { filters: LogFilters; skip: number; limit: number; order?: 'date' | 'topo'; firstParent?: boolean; noMerges?: boolean; skipByRoot?: Record<string, number> }) => {
				if (this.allRepos) {
					const repos = services().repos.repositories;
					const lists = await Promise.all(
						repos.map(async (r) => (await r.log(this.query(p.filters, p.skipByRoot?.[r.root] ?? 0, p.limit, p.order, p)).catch(() => [])).map((c) => ({ ...c, root: r.root }))),
					);
					const commits = mergeByDate(lists, p.limit);
					return { commits, hasMore: lists.some((l) => l.length >= p.limit) || commits.length >= p.limit };
				}
				const repo = this.repo;
				if (!repo) {
					return { commits: [], hasMore: false };
				}
				const q = this.query(p.filters, p.skip, p.limit, p.order, p);
				let commits: CommitInfo[] = await repo.log(q);
				const text = p.filters.text?.trim();
				if (p.skip === 0 && text && /^[0-9a-f]{7,40}$/i.test(text)) {
					const hash = await repo.revParse(text);
					const byText = await repo.log({ ...q, text, regex: false, matchCase: false, paths: q.paths });
					commits = byText;
					if (hash && !commits.some((c) => c.hash === hash)) {
						try {
							commits.unshift(await repo.getCommit(hash));
						} catch {
						}
					}
				}
				if (q.follow || q.lineRange) {
					commits = commits.map((c, i) => ({ ...c, parents: commits[i + 1] ? [commits[i + 1].hash] : [] }));
				}
				return { commits, hasMore: commits.length >= p.limit };
			},
			details: async (p: { hashes: string[]; parentIndex?: number; root?: string }) => {
				const repo = this.repoFor(p.root);
				if (!repo || !p.hashes.length) {
					return undefined;
				}
				const commits = await Promise.all(p.hashes.slice(0, 50).map((h) => repo.getCommit(h)));
				let files: FileChange[];
				if (commits.length === 1) {
					files = await repo.getCommitFiles(commits[0].hash, commits[0].parents, p.parentIndex ?? 0);
				} else {
					const oldest = commits[commits.length - 1];
					const newest = commits[0];
					files = oldest.parents.length
						? await repo.diffFiles(oldest.parents[0], newest.hash)
						: await repo.getCommitFiles(newest.hash, []);
				}
				return { commits, files, root: repo.root };
			},
			containing: async (p: { hash: string; root?: string }) => {
				const repo = this.repoFor(p.root);
				if (!repo) {
					return { branches: [], tags: [] };
				}
				const [branches, tags] = await Promise.all([repo.getBranchesContaining(p.hash), repo.getTagsContaining(p.hash)]);
				return { branches, tags };
			},
			selection: (p: { hashes: string[]; commits: CommitInfo[] }) => {
				this.setSelection(p.commits);
				this.selection = p.hashes;
			},
			pickBranches: async (p: { current?: string[] }) => this.pickBranches(p.current ?? []),
			pickUsers: async (p: { current?: string[]; authors: string[] }) => this.pickUsers(p.current ?? [], p.authors),
			pickDate: async () => this.pickDate(),
			pickPaths: async (p: { current?: string[] }) => this.pickPaths(p.current ?? []),
			openDiff: async (p: { hashes: string[]; path: string; files: FileChange[]; parentIndex?: number; root?: string }) => {
				const repo = this.repoFor(p.root);
				if (!repo) {
					return;
				}
				const commits = await Promise.all(p.hashes.map((h) => repo.getCommit(h)));
				const index = Math.max(0, p.files.findIndex((f) => f.path === p.path));
				if (commits.length === 1) {
					await openDiff({ targets: p.files.map((f) => commitFileTarget(repo, commits[0], f, p.parentIndex ?? 0)), index });
				} else {
					const oldest = commits[commits.length - 1];
					const base = oldest.parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
					await openDiff({ targets: p.files.map((f) => revisionTarget(repo, base, commits[0].hash, f)), index });
				}
			},
			notCherryPicked: async (p: { branch: string }) => {
				const repo = this.repo;
				if (!repo) {
					return [];
				}
				const out = await repo.run(['cherry', 'HEAD', p.branch]).catch(() => ({ stdout: '' }));
				return out.stdout.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim());
			},
			openUrl: (p: { url: string }) => {
				if (/^https?:\/\//i.test(p.url)) {
					void vscode.env.openExternal(vscode.Uri.parse(p.url));
				}
			},
			fileDiff: async (p: { hashes: string[]; path: string; origPath?: string; status: string; parentIndex?: number; root?: string }) => {
				const repo = this.repoFor(p.root);
				if (!repo || !p.hashes.length) {
					return undefined;
				}
				const commits = await Promise.all(p.hashes.map((h) => repo.getCommit(h)));
				const newest = commits[0];
				const base = commits.length === 1 ? newest.parents[Math.min(p.parentIndex ?? 0, Math.max(0, newest.parents.length - 1))] : commits[commits.length - 1].parents[0];
				const [left, right] = await Promise.all([
					base && p.status !== 'A' ? repo.getContentOrEmpty(base, p.origPath ?? p.path) : undefined,
					p.status !== 'D' ? repo.getContentOrEmpty(newest.hash, p.path) : undefined,
				]);
				const binary = [left, right].some((b) => !!b && (isBinary(b) || b.length > PREVIEW_LIMIT));
				const text = (b: Buffer | undefined) => (b && !binary ? b.toString('utf8') : null);
				return { path: p.path, left: text(left), right: text(right), leftTitle: base ? shortHash(base) : vscode.l10n.t('Empty'), rightTitle: shortHash(newest.hash), binary };
			},
			openCommitDiffForPath: async (p: { hash: string }) => {
				const repo = this.repo;
				if (!repo || !this.scope.path) {
					return;
				}
				const commit = await repo.getCommit(p.hash);
				const files = await repo.getCommitFiles(commit.hash, commit.parents);
				const file = files.find((f) => f.path === this.scope.path || f.origPath === this.scope.path) ?? files[0];
				if (file) {
					await openDiff({ targets: [commitFileTarget(repo, commit, file)], index: 0 });
				}
			},
			openFile: async (p: { hash?: string; path: string }) => {
				const repo = this.repo;
				if (!repo) {
					return;
				}
				const { toGitUri } = await import('../content');
				const uri = p.hash ? toGitUri(repo, p.hash, p.path) : vscode.Uri.file(repo.absolutePath(p.path));
				await vscode.window.showTextDocument(uri, { preview: true });
			},
			branchClick: async (p: { ref: string }) => {
				const repos = this.allRepos ? [this.repo, ...services().repos.repositories] : [this.repo];
				for (const repo of repos) {
					const hash = repo && (await repo.revParse(p.ref));
					if (hash) {
						return hash;
					}
				}
				return undefined;
			},
			command: (p: { command: string; args?: unknown[] }) => {
				if (!/^changeline\./.test(p.command)) {
					throw new Error(vscode.l10n.t('Command {0} is not allowed', p.command));
				}
				return vscode.commands.executeCommand(p.command, ...(p.args ?? []));
			},
			focus: () => {
				LogController.lastFocused = this;
			},
		};
	}

	private async pickBranches(current: string[]): Promise<string[] | undefined> {
		const repo = this.repo;
		if (!repo) {
			return undefined;
		}
		const refs = repo.refs;
		const items: (vscode.QuickPickItem & { ref?: string })[] = [
			{ label: 'HEAD', description: vscode.l10n.t('Current branch'), ref: 'HEAD', picked: current.includes('HEAD') },
			{ label: vscode.l10n.t('Local'), kind: vscode.QuickPickItemKind.Separator },
			...refs.filter((r) => r.type === 'head').map((r) => ({ label: r.shortName, description: r.current ? 'current' : undefined, ref: r.shortName, picked: current.includes(r.shortName), iconPath: new vscode.ThemeIcon('git-branch') })),
			{ label: vscode.l10n.t('Remote'), kind: vscode.QuickPickItemKind.Separator },
			...refs.filter((r) => r.type === 'remote').map((r) => ({ label: r.shortName, ref: r.shortName, picked: current.includes(r.shortName), iconPath: new vscode.ThemeIcon('cloud') })),
			{ label: vscode.l10n.t('Tags'), kind: vscode.QuickPickItemKind.Separator },
			...refs.filter((r) => r.type === 'tag').map((r) => ({ label: r.shortName, ref: `refs/tags/${r.shortName}`, picked: current.includes(`refs/tags/${r.shortName}`), iconPath: new vscode.ThemeIcon('tag') })),
		];
		const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: vscode.l10n.t('Filter log by branches (none selected = all)'), matchOnDescription: true });
		if (!picked) {
			return undefined;
		}
		return picked.filter((p) => p.ref).map((p) => p.ref!);
	}

	private async pickUsers(current: string[], authors: string[]): Promise<string[] | undefined> {
		const repo = this.repo;
		const me = repo ? (await repo.getUser()).name : undefined;
		const names = [...new Set(authors)].sort((a, b) => a.localeCompare(b));
		const items: vscode.QuickPickItem[] = [];
		if (me) {
			items.push({ label: me, description: 'me', picked: current.includes(me) });
		}
		for (const n of names) {
			if (n !== me) {
				items.push({ label: n, picked: current.includes(n) });
			}
		}
		const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: vscode.l10n.t('Filter log by users (none selected = all)') });
		return picked ? picked.map((p) => p.label) : undefined;
	}

	private async pickDate(): Promise<{ since?: string; until?: string; label?: string } | undefined> {
		const choice = await vscode.window.showQuickPick(
			[
				{ label: vscode.l10n.t('All'), value: {} },
				{ label: vscode.l10n.t('Last 24 hours'), value: { since: '24 hours ago', label: vscode.l10n.t('Last 24 hours') } },
				{ label: vscode.l10n.t('Last 7 days'), value: { since: '7 days ago', label: vscode.l10n.t('Last 7 days') } },
				{ label: vscode.l10n.t('Last 30 days'), value: { since: '30 days ago', label: vscode.l10n.t('Last 30 days') } },
				{ label: vscode.l10n.t('Last year'), value: { since: '1 year ago', label: vscode.l10n.t('Last year') } },
				{ label: vscode.l10n.t('Select...'), value: undefined },
			],
			{ placeHolder: vscode.l10n.t('Filter log by date') },
		);
		if (!choice) {
			return undefined;
		}
		if (choice.value) {
			return choice.value;
		}
		const since = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Since (e.g. 2024-01-31 or "2 weeks ago"), leave empty for no lower bound') });
		if (since === undefined) {
			return undefined;
		}
		const until = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Until (e.g. 2024-02-28), leave empty for no upper bound') });
		if (until === undefined) {
			return undefined;
		}
		return { since: since || undefined, until: until || undefined, label: [since && `after ${since}`, until && `before ${until}`].filter(Boolean).join(', ') || undefined };
	}

	private async pickPaths(current: string[]): Promise<string[] | undefined> {
		const repo = this.repo;
		if (!repo) {
			return undefined;
		}
		const choice = await vscode.window.showQuickPick(
			[
				{ label: vscode.l10n.t('$(folder-opened) Select Folders or Files...'), id: 'browse' },
				{ label: vscode.l10n.t('$(edit) Enter Paths...'), id: 'enter' },
				...(current.length ? [{ label: vscode.l10n.t('$(clear-all) Clear Paths Filter'), id: 'clear' }] : []),
			],
			{ placeHolder: current.length ? vscode.l10n.t('Current: {0}', current.join(', ')) : vscode.l10n.t('Filter log by paths') },
		);
		if (!choice) {
			return undefined;
		}
		if (choice.id === 'clear') {
			return [];
		}
		if (choice.id === 'enter') {
			const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Repository relative paths, separated by commas'), value: current.join(', ') });
			return value === undefined ? undefined : value.split(',').map((s) => s.trim()).filter(Boolean);
		}
		const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(repo.root) });
		return uris ? uris.map((u) => repo.relativePath(u.fsPath) || '.') : undefined;
	}

	dispose(): void {
		LogController.registry.delete(this.id);
		if (LogController.lastFocused === this) {
			LogController.lastFocused = [...LogController.registry.values()][0];
		}
		this.dialogs.dispose();
		this.rpc.dispose();
		this.disposables.forEach((d) => d.dispose());
	}
}

export class LogViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'changeline.log';
	private controller?: LogController;
	private view?: vscode.WebviewView;
	private pending: ((c: LogController) => void)[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = webviewOptions(this.extensionUri);
		this.controller?.dispose();
		this.controller = new LogController(view.webview, { kind: 'log' }, { visible: () => view.visible, reveal: () => view.show(false) });
		view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'log', { title: vscode.l10n.t('Log') });
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.controller?.markFocused();
			}
		});
		view.onDidDispose(() => {
			this.controller?.dispose();
			this.controller = undefined;
			this.view = undefined;
		});
		const c = this.controller;
		const pending = this.pending;
		this.pending = [];
		void c.ready.then(() => pending.forEach((fn) => fn(c)));
	}

	/** Reveals the log and runs `fn` once it is ready. */
	async show(fn?: (c: LogController) => void): Promise<void> {
		if (this.view && this.controller) {
			this.view.show(false);
			this.controller.markFocused();
			if (fn) {
				const c = this.controller;
				void c.ready.then(() => fn(c));
			}
			return;
		}
		if (fn) {
			this.pending.push(fn);
		}
		await vscode.commands.executeCommand('changeline.log.focus');
	}

	get current(): LogController | undefined {
		return this.controller;
	}

	dispose(): void {
		this.controller?.dispose();
	}
}

