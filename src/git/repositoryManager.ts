import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside } from '../paths';
import { config, Debouncer } from '../util';
import { GitCli } from './gitCli';
import { Repository } from './repository';

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'out', 'target', '.idea', '.vscode']);

export class RepositoryManager implements vscode.Disposable {
	private repos: Repository[] = [];
	private disposables: vscode.Disposable[] = [];
	private repoDisposables = new Map<Repository, vscode.Disposable[]>();
	private debouncer = new Debouncer();
	private lastActive?: Repository;

	private readonly onDidChangeRepositoriesEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeRepositories = this.onDidChangeRepositoriesEmitter.event;
	private readonly onDidChangeStateEmitter = new vscode.EventEmitter<Repository>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;
	private readonly onDidChangeRefsEmitter = new vscode.EventEmitter<Repository>();
	readonly onDidChangeRefs = this.onDidChangeRefsEmitter.event;

	constructor(readonly git: GitCli) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.disposables.push(
			watcher,
			watcher.onDidChange((u) => this.onFileEvent(u)),
			watcher.onDidCreate((u) => this.onFileEvent(u)),
			watcher.onDidDelete((u) => this.onFileEvent(u)),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.scan()),
			vscode.workspace.onDidSaveTextDocument((d) => this.onFileEvent(d.uri)),
			vscode.window.onDidChangeWindowState((s) => {
				if (s.focused) {
					for (const r of this.repos) {
						this.scheduleRefresh(r, 100);
					}
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((e) => {
				const repo = e && this.getRepository(e.document.uri);
				if (repo) {
					this.lastActive = repo;
				}
			}),
		);
	}

	get repositories(): readonly Repository[] {
		return this.repos;
	}

	async scan(): Promise<void> {
		const found = new Map<string, Repository>();
		const depth = config<number>('repositoryScanMaxDepth', 1);
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const repo = await Repository.open(this.git, folder.uri.fsPath);
			if (repo) {
				found.set(repo.root, repo);
			}
			await this.scanChildren(folder.uri.fsPath, depth, found);
		}
		const existing = new Map(this.repos.map((r) => [r.root, r]));
		const next: Repository[] = [];
		for (const [root, repo] of found) {
			const old = existing.get(root);
			if (old) {
				next.push(old);
				existing.delete(root);
			} else {
				next.push(repo);
				this.track(repo);
			}
		}
		for (const removed of existing.values()) {
			this.untrack(removed);
		}
		next.sort((a, b) => a.root.localeCompare(b.root));
		const changed = next.length !== this.repos.length || next.some((r, i) => r !== this.repos[i]);
		this.repos = next;
		await Promise.all(this.repos.map((r) => r.refresh().catch(() => undefined)));
		void vscode.commands.executeCommand('setContext', 'changeline.hasRepository', this.repos.length > 0);
		void vscode.commands.executeCommand('setContext', 'changeline.multipleRepositories', this.repos.length > 1);
		if (changed) {
			this.onDidChangeRepositoriesEmitter.fire();
		}
	}

	private async scanChildren(dir: string, depth: number, found: Map<string, Repository>): Promise<void> {
		if (depth <= 0) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) {
				continue;
			}
			const child = path.join(dir, e.name);
			if (fs.existsSync(path.join(child, '.git'))) {
				const repo = await Repository.open(this.git, child);
				if (repo && !found.has(repo.root)) {
					found.set(repo.root, repo);
				}
			}
			await this.scanChildren(child, depth - 1, found);
		}
	}

	/** Adds a repository found outside of the scan (e.g. after init or clone). */
	async openRepository(dir: string): Promise<Repository | undefined> {
		const repo = await Repository.open(this.git, dir);
		if (!repo) {
			return undefined;
		}
		const existing = this.repos.find((r) => r.root === repo.root);
		if (existing) {
			return existing;
		}
		this.track(repo);
		this.repos.push(repo);
		this.repos.sort((a, b) => a.root.localeCompare(b.root));
		await repo.refresh();
		void vscode.commands.executeCommand('setContext', 'changeline.hasRepository', true);
		void vscode.commands.executeCommand('setContext', 'changeline.multipleRepositories', this.repos.length > 1);
		this.onDidChangeRepositoriesEmitter.fire();
		return repo;
	}

	private track(repo: Repository): void {
		const subs: vscode.Disposable[] = [
			repo.onDidChangeState(() => this.onDidChangeStateEmitter.fire(repo)),
			repo.onDidChangeRefs(() => this.onDidChangeRefsEmitter.fire(repo)),
		];
		const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some((f) => isInside(repo.gitDir, f.uri.fsPath));
		if (!inWorkspace) {
			for (const dir of new Set([repo.gitDir, repo.commonDir])) {
				const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,index,ORIG_HEAD,MERGE_HEAD,FETCH_HEAD,refs/**,packed-refs,rebase-merge/**,rebase-apply/**}'));
				subs.push(w, w.onDidChange(() => this.scheduleRefresh(repo)), w.onDidCreate(() => this.scheduleRefresh(repo)), w.onDidDelete(() => this.scheduleRefresh(repo)));
			}
		}
		this.repoDisposables.set(repo, subs);
	}

	private untrack(repo: Repository): void {
		for (const d of this.repoDisposables.get(repo) ?? []) {
			d.dispose();
		}
		this.repoDisposables.delete(repo);
		repo.dispose();
	}

	private onFileEvent(uri: vscode.Uri): void {
		if (uri.scheme !== 'file') {
			return;
		}
		const p = uri.fsPath;
		for (const repo of this.repos) {
			if (isInside(p, repo.gitDir) || isInside(p, repo.commonDir)) {
				const rel = path.relative(repo.commonDir, p).split(path.sep).join('/');
				if (rel.endsWith('.lock') || rel.startsWith('objects/') || rel.startsWith('logs/') || rel.startsWith('changeline-')) {
					return;
				}
				this.scheduleRefresh(repo);
				return;
			}
		}
		const repo = this.getRepository(uri);
		if (repo) {
			this.scheduleRefresh(repo);
		}
	}

	scheduleRefresh(repo: Repository, delay = 400): void {
		this.debouncer.run(repo.root, delay, () => void repo.refresh().catch(() => undefined));
	}

	/** The repository containing the given file (the innermost one). */
	getRepository(uri: vscode.Uri | string): Repository | undefined {
		const p = typeof uri === 'string' ? uri : uri.fsPath;
		let best: Repository | undefined;
		for (const r of this.repos) {
			if (r.contains(p) && (!best || r.root.length > best.root.length)) {
				best = r;
			}
		}
		return best;
	}

	getByRoot(root: string): Repository | undefined {
		return this.repos.find((r) => r.root === root);
	}

	/** Repository of the active editor, the last used one, or the first. */
	current(): Repository | undefined {
		const editor = vscode.window.activeTextEditor;
		const fromEditor = editor && this.getRepository(editor.document.uri);
		return fromEditor ?? (this.lastActive && this.repos.includes(this.lastActive) ? this.lastActive : this.repos[0]);
	}

	setLastActive(repo: Repository): void {
		this.lastActive = repo;
	}

	/** Picks a repository; asks only when several exist and none is implied. */
	async pick(placeHolder = vscode.l10n.t('Select a Git repository'), preferCurrent = true): Promise<Repository | undefined> {
		if (this.repos.length === 0) {
			const choice = await vscode.window.showWarningMessage(vscode.l10n.t('No Git repository found in the workspace.'), vscode.l10n.t('Create Git Repository...'), vscode.l10n.t('Clone...'));
			if (choice === vscode.l10n.t('Create Git Repository...')) {
				void vscode.commands.executeCommand('changeline.init');
			} else if (choice === vscode.l10n.t('Clone...')) {
				void vscode.commands.executeCommand('changeline.clone');
			}
			return undefined;
		}
		if (this.repos.length === 1) {
			return this.repos[0];
		}
		if (preferCurrent) {
			const editor = vscode.window.activeTextEditor;
			const fromEditor = editor && this.getRepository(editor.document.uri);
			if (fromEditor) {
				return fromEditor;
			}
		}
		const item = await vscode.window.showQuickPick(
			this.repos.map((r) => ({ label: r.name, description: r.state.branch ?? r.state.head?.slice(0, 8), detail: r.root, repo: r })),
			{ placeHolder },
		);
		if (item) {
			this.lastActive = item.repo;
		}
		return item?.repo;
	}

	dispose(): void {
		this.debouncer.dispose();
		for (const r of [...this.repos]) {
			this.untrack(r);
		}
		this.disposables.forEach((d) => d.dispose());
		this.onDidChangeRepositoriesEmitter.dispose();
		this.onDidChangeStateEmitter.dispose();
		this.onDidChangeRefsEmitter.dispose();
	}
}

