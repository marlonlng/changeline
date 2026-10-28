import * as fs from 'fs';
import * as path from 'path';
import { fromGitPath, isInside, shellPath, toGitPath } from '../paths';
import { Emitter } from '../shared/emitter';
import type { ChangeStatus, CommitDetails, CommitInfo, ConflictInfo, FileChange, RefInfo, RepoOperation } from '../shared/types';
import { ExecOptions, ExecResult, GitCli, GitError } from './gitCli';
import * as P from './parsers';

export interface RebaseState {
	headName?: string;
	onto?: string;
	step?: number;
	total?: number;
	interactive: boolean;
	stoppedSha?: string;
}

export interface RepositoryState {
	head?: string;
	branch?: string;
	detached: boolean;
	upstream?: string;
	ahead: number;
	behind: number;
	changes: FileChange[];
	staged: FileChange[];
	unstaged: FileChange[];
	untracked: FileChange[];
	ignored: FileChange[];
	conflicts: ConflictInfo[];
	operation: RepoOperation;
	rebase?: RebaseState;
	mergeHead?: string;
	cherryPickHead?: string;
	revertHead?: string;
}

const EMPTY_STATE: RepositoryState = {
	detached: false,
	ahead: 0,
	behind: 0,
	changes: [],
	staged: [],
	unstaged: [],
	untracked: [],
	ignored: [],
	conflicts: [],
	operation: 'none',
};

export interface LogQuery {
	revisions?: string[];
	paths?: string[];
	authors?: string[];
	text?: string;
	regex?: boolean;
	matchCase?: boolean;
	since?: string;
	until?: string;
	skip?: number;
	limit?: number;
	order?: 'date' | 'topo';
	follow?: boolean;
	firstParent?: boolean;
	lineRange?: { start: number; end: number; path: string };
}

export interface CommitFile {
	path: string;
	origPath?: string;
	status: ChangeStatus;
	content?: string;
}

export interface CommitParams {
	message: string;
	amend?: boolean;
	signOff?: boolean;
	author?: string;
	noVerify?: boolean;
	gpgSign?: boolean;
	files?: CommitFile[];
	useRealIndex?: boolean;
}

export interface PushParams {
	remote: string;
	source: string;
	remoteBranch: string;
	force?: 'lease' | 'force';
	setUpstream?: boolean;
	tags?: 'none' | 'all' | 'follow';
	noVerify?: boolean;
}

export interface PushResult {
	refs: P.PushRefResult[];
	rejected: boolean;
	output: string;
}

export interface MergeOptions {
	noFastForward?: boolean;
	fastForwardOnly?: boolean;
	squash?: boolean;
	noCommit?: boolean;
	message?: string;
	noVerify?: boolean;
	allowUnrelated?: boolean;
	strategyOption?: string;
}

export interface RebaseOptions {
	interactive?: boolean;
	rebaseMerges?: boolean;
	keepEmpty?: boolean;
	root?: boolean;
	updateRefs?: boolean;
	newBase?: string;
	branch?: string;
	autostash?: boolean;
}

export interface OperationOutcome {
	ok: boolean;
	conflicts: boolean;
	output: string;
	error?: GitError;
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseTodoEntry {
	action: RebaseAction;
	hash: string;
	subject: string;
	message?: string;
}

export class Repository {
	private _state: RepositoryState = EMPTY_STATE;
	private _refs: RefInfo[] = [];
	private refsSignature = '';
	private stateSignature = '';
	private refreshPromise?: Promise<void>;
	private refreshAgain = false;
	private realRoot: string;
	showIgnored = false;

	private readonly onDidChangeStateEmitter = new Emitter<void>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;
	private readonly onDidChangeRefsEmitter = new Emitter<void>();
	readonly onDidChangeRefs = this.onDidChangeRefsEmitter.event;
	private readonly onDidRunOperationEmitter = new Emitter<string>();
	readonly onDidRunOperation = this.onDidRunOperationEmitter.event;

	private constructor(
		readonly git: GitCli,
		readonly root: string,
		readonly gitDir: string,
		readonly commonDir: string,
	) {
		this.realRoot = safeRealpath(root);
	}

	static async open(git: GitCli, dir: string): Promise<Repository | undefined> {
		try {
			const r = await git.exec(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
			const [top, gitDir, common] = r.stdout.split(/\r?\n/);
			if (!top) {
				return undefined;
			}
			const root = path.normalize(top);
			const commonDir = path.isAbsolute(common) ? path.normalize(common) : path.resolve(dir, common);
			return new Repository(git, root, path.normalize(gitDir), commonDir);
		} catch {
			return undefined;
		}
	}

	get name(): string {
		return path.basename(this.root);
	}

	get state(): RepositoryState {
		return this._state;
	}

	get refs(): RefInfo[] {
		return this._refs;
	}

	get currentBranch(): string | undefined {
		return this._state.branch;
	}

	dispose(): void {
		this.onDidChangeStateEmitter.dispose();
		this.onDidChangeRefsEmitter.dispose();
		this.onDidRunOperationEmitter.dispose();
	}


	contains(fsPath: string): boolean {
		const p = path.normalize(fsPath);
		return isInside(p, this.root) || isInside(safeRealpath(p), this.realRoot);
	}

	relativePath(fsPath: string): string {
		const p = path.normalize(fsPath);
		return isInside(p, this.root) ? toGitPath(this.root, p) : toGitPath(this.realRoot, safeRealpath(p));
	}

	absolutePath(relPath: string): string {
		return fromGitPath(this.root, relPath);
	}


	run(args: string[], options?: ExecOptions): Promise<ExecResult> {
		return this.git.exec(this.root, args, options);
	}

	/** Runs a mutating command, logs it and refreshes the state afterwards. */
	async runOp(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
		try {
			return await this.git.exec(this.root, args, { log: true, ...options });
		} finally {
			this.onDidRunOperationEmitter.fire(args[0]);
			await this.refresh();
		}
	}

	/** Paths from git status are passed literally so names with glob characters work. */
	private pathspecArgs(paths: string[]): { args: string[]; input?: string } {
		const literal = paths.map(literalPath);
		if (paths.length > 64 && this.git.versionAtLeast(2, 26)) {
			return { args: ['--pathspec-from-file=-', '--pathspec-file-nul'], input: literal.join('\0') };
		}
		return { args: ['--', ...literal] };
	}


	refresh(): Promise<void> {
		if (this.refreshPromise) {
			this.refreshAgain = true;
			return this.refreshPromise;
		}
		this.refreshPromise = (async () => {
			try {
				do {
					this.refreshAgain = false;
					await this.doRefresh();
				} while (this.refreshAgain);
			} finally {
				this.refreshPromise = undefined;
			}
		})();
		return this.refreshPromise;
	}

	private async doRefresh(): Promise<void> {
		const statusArgs = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'];
		if (this.showIgnored) {
			statusArgs.push('--ignored=matching');
		}
		const [status, refsOut, op] = await Promise.all([
			this.run(statusArgs, { env: { GIT_OPTIONAL_LOCKS: '0' } }),
			this.run(['for-each-ref', `--format=${P.REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash']).catch(() => ({ stdout: '' })),
			this.detectOperation(),
		]);
		const parsed = P.parseStatusV2(status.stdout);
		const classified = P.classifyStatus(parsed.entries);
		const state: RepositoryState = {
			head: parsed.oid,
			branch: parsed.branch,
			detached: !parsed.branch && !!parsed.oid,
			upstream: parsed.upstream,
			ahead: parsed.ahead,
			behind: parsed.behind,
			...classified,
			...op,
		};
		if (op.operation === 'rebase' && !state.branch && op.rebase?.headName) {
			state.branch = op.rebase.headName.replace(/^refs\/heads\//, '');
			state.detached = true;
		}
		const signature = JSON.stringify(state);
		this._state = state;
		if (signature !== this.stateSignature) {
			this.stateSignature = signature;
			this.onDidChangeStateEmitter.fire();
		}
		const refsSignature = refsOut.stdout + '|' + (state.head ?? '') + '|' + (state.branch ?? '');
		if (refsSignature !== this.refsSignature) {
			this.refsSignature = refsSignature;
			this._refs = P.parseRefs(refsOut.stdout);
			this.onDidChangeRefsEmitter.fire();
		}
	}

	private async detectOperation(): Promise<Pick<RepositoryState, 'operation' | 'rebase' | 'mergeHead' | 'cherryPickHead' | 'revertHead'>> {
		const p = (f: string) => path.join(this.gitDir, f);
		const exists = (f: string) => fs.promises.access(p(f)).then(() => true, () => false);
		const read = (f: string) => fs.promises.readFile(p(f), 'utf8').then((s) => s.trim(), () => undefined);
		if (await exists('rebase-merge')) {
			const [headName, onto, step, total, interactive, stoppedSha] = await Promise.all([
				read('rebase-merge/head-name'), read('rebase-merge/onto'), read('rebase-merge/msgnum'), read('rebase-merge/end'),
				exists('rebase-merge/interactive'), read('rebase-merge/stopped-sha'),
			]);
			return { operation: 'rebase', rebase: { headName, onto, step: step ? Number(step) : undefined, total: total ? Number(total) : undefined, interactive, stoppedSha } };
		}
		if (await exists('rebase-apply')) {
			if (await exists('rebase-apply/applying')) {
				return { operation: 'am' };
			}
			const [headName, onto, step, total] = await Promise.all([read('rebase-apply/head-name'), read('rebase-apply/onto'), read('rebase-apply/next'), read('rebase-apply/last')]);
			return { operation: 'rebase', rebase: { headName, onto, step: step ? Number(step) : undefined, total: total ? Number(total) : undefined, interactive: false } };
		}
		const mergeHead = await read('MERGE_HEAD');
		if (mergeHead) {
			return { operation: 'merge', mergeHead: mergeHead.split(/\s+/)[0] };
		}
		const cherryPickHead = await read('CHERRY_PICK_HEAD');
		if (cherryPickHead) {
			return { operation: 'cherry-pick', cherryPickHead };
		}
		const revertHead = await read('REVERT_HEAD');
		if (revertHead) {
			return { operation: 'revert', revertHead };
		}
		if (await exists('BISECT_LOG')) {
			return { operation: 'bisect' };
		}
		return { operation: 'none' };
	}

	async readGitFile(name: string): Promise<string | undefined> {
		try {
			return await fs.promises.readFile(path.join(this.gitDir, name), 'utf8');
		} catch {
			return undefined;
		}
	}


	async getRefs(): Promise<RefInfo[]> {
		const out = await this.run(['for-each-ref', `--format=${P.REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
		this._refs = P.parseRefs(out.stdout);
		return this._refs;
	}

	async revParse(ref: string): Promise<string | undefined> {
		try {
			const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
			return r.stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async refExists(ref: string): Promise<boolean> {
		try {
			await this.run(['show-ref', '--verify', '--quiet', ref]);
			return true;
		} catch {
			return false;
		}
	}

	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		const r = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], { acceptExitCodes: [1] });
		return r.exitCode === 0;
	}

	async mergeBase(a: string, b: string): Promise<string | undefined> {
		try {
			return (await this.run(['merge-base', a, b])).stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async getConfig(key: string): Promise<string | undefined> {
		const r = await this.run(['config', '--get', key], { acceptExitCodes: [1] });
		return r.exitCode === 0 ? r.stdout.trim() : undefined;
	}

	async setConfig(key: string, value: string | undefined): Promise<void> {
		if (value === undefined) {
			await this.runOp(['config', '--unset', key], { acceptExitCodes: [5] });
		} else {
			await this.runOp(['config', key, value]);
		}
	}

	async getUser(): Promise<{ name?: string; email?: string }> {
		const [name, email] = await Promise.all([this.getConfig('user.name'), this.getConfig('user.email')]);
		return { name, email };
	}

	async log(q: LogQuery = {}): Promise<CommitInfo[]> {
		const args = ['log', `--format=${P.LOG_FORMAT}`];
		if (!q.follow && !q.lineRange) {
			args.push(q.order === 'topo' ? '--topo-order' : '--date-order');
		}
		if (q.limit) {
			args.push(`--max-count=${q.limit}`);
		}
		if (q.skip) {
			args.push(`--skip=${q.skip}`);
		}
		for (const a of q.authors ?? []) {
			args.push(`--author=${a}`);
		}
		if (q.text) {
			args.push(`--grep=${q.text}`);
			if (!q.regex) {
				args.push('--fixed-strings');
			} else {
				args.push('--extended-regexp');
			}
			if (!q.matchCase) {
				args.push('--regexp-ignore-case');
			}
		}
		if (q.since) {
			args.push(`--since=${q.since}`);
		}
		if (q.until) {
			args.push(`--until=${q.until}`);
		}
		if (q.follow) {
			args.push('--follow');
		}
		if (q.firstParent) {
			args.push('--first-parent');
		}
		if (q.paths && q.paths.length && !q.follow && !q.lineRange) {
			args.push('--parents');
		}
		if (q.lineRange) {
			args.push(`-L${q.lineRange.start},${q.lineRange.end}:${q.lineRange.path}`, '--no-patch');
		}
		if (q.revisions && q.revisions.length) {
			args.push(...q.revisions);
		} else {
			args.push('--branches', '--remotes', '--tags', 'HEAD');
		}
		if (q.paths && q.paths.length && !q.lineRange) {
			args.push('--', ...q.paths);
		} else {
			args.push('--');
		}
		try {
			const out = await this.run(args);
			return P.parseLog(out.stdout);
		} catch (e) {
			if (e instanceof GitError && /does not have any commits|bad default revision|unknown revision/i.test(e.stderr)) {
				return [];
			}
			throw e;
		}
	}

	/** History of one file including the path it had in each commit. */
	async fileHistory(relPath: string, opts: { limit?: number; skip?: number; revision?: string } = {}): Promise<(CommitInfo & { files: FileChange[] })[]> {
		const args = ['log', '--follow', `--format=${P.LOG_FILES_FORMAT}`, '--name-status', '-z', '-M'];
		if (opts.limit) {
			args.push(`--max-count=${opts.limit}`);
		}
		if (opts.skip) {
			args.push(`--skip=${opts.skip}`);
		}
		args.push(opts.revision ?? 'HEAD', '--', relPath);
		try {
			const out = await this.run(args);
			return P.parseLogWithFiles(out.stdout);
		} catch (e) {
			if (e instanceof GitError && /does not have any commits|bad default revision|unknown revision/i.test(e.stderr)) {
				return [];
			}
			throw e;
		}
	}

	async getCommit(hash: string): Promise<CommitInfo & { body: string }> {
		const out = await this.run(['show', '-s', `--format=${P.LOG_FORMAT_WITH_BODY}`, hash, '--']);
		const [c] = P.parseLogWithBody(out.stdout);
		if (!c) {
			throw new Error(`Commit ${hash} not found`);
		}
		return c;
	}

	async getCommitDetails(hash: string, parentIndex = 0): Promise<CommitDetails> {
		const c = await this.getCommit(hash);
		const files = await this.getCommitFiles(c.hash, c.parents, parentIndex);
		return { ...c, files };
	}

	async getCommitFiles(hash: string, parents: string[], parentIndex = 0): Promise<FileChange[]> {
		const args = parents.length === 0
			? ['diff-tree', '--root', '-r', '-z', '--name-status', '-M', '--no-commit-id', hash]
			: ['diff-tree', '-r', '-z', '--name-status', '-M', parents[Math.min(parentIndex, parents.length - 1)], hash];
		const out = await this.run(args);
		return P.parseNameStatus(out.stdout);
	}

	/** Changed files between two revisions; `to` undefined means the working tree. */
	async diffFiles(from: string, to?: string, paths: string[] = []): Promise<FileChange[]> {
		const args = ['diff', '--name-status', '-z', '-M', from];
		if (to) {
			args.push(to);
		}
		args.push('--', ...paths);
		const out = await this.run(args);
		return P.parseNameStatus(out.stdout);
	}

	async getBranchesContaining(hash: string, limit = 50): Promise<string[]> {
		const out = await this.run(['branch', '-a', '--contains', hash, '--format=%(refname:short)']);
		return out.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD')).slice(0, limit);
	}

	async getTagsContaining(hash: string, limit = 20): Promise<string[]> {
		const out = await this.run(['tag', '--contains', hash]);
		return out.stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, limit);
	}

	/**
	 * Content of a file at a revision. `ref` may be a commit-ish, '' for the
	 * index, or ':1'/':2'/':3' for conflict stages. With `filters` git applies
	 * smudge/eol conversion so the result compares to working tree files.
	 */
	async getContent(ref: string, relPath: string, opts: { filters?: boolean } = {}): Promise<Buffer> {
		const spec = blobSpec(ref, relPath);
		const args = opts.filters && this.git.versionAtLeast(2, 11) ? ['cat-file', '--filters', spec] : ['cat-file', 'blob', spec];
		const r = await this.git.execBuffer(this.root, args);
		return r.stdout;
	}

	/** Whether the file exists at a revision; `ref` as in getContent. */
	async hasFile(ref: string, relPath: string): Promise<boolean> {
		return this.run(['cat-file', '-e', blobSpec(ref, relPath)]).then(
			() => true,
			() => false,
		);
	}

	async getContentOrEmpty(ref: string, relPath: string, opts: { filters?: boolean } = {}): Promise<Buffer | undefined> {
		try {
			return await this.getContent(ref, relPath, opts);
		} catch {
			return undefined;
		}
	}

	async readWorkingFile(relPath: string): Promise<Buffer | undefined> {
		try {
			return await fs.promises.readFile(this.absolutePath(relPath));
		} catch {
			return undefined;
		}
	}

	async listFiles(ref: string): Promise<string[]> {
		const out = await this.run(['ls-tree', '-r', '-z', '--name-only', ref]);
		return out.stdout.split('\0').filter(Boolean);
	}

	async blame(relPath: string, opts: { contents?: string; revision?: string; ignoreWhitespace?: boolean } = {}): Promise<ReturnType<typeof P.parseBlamePorcelain>> {
		const args = ['blame', '--porcelain'];
		if (opts.ignoreWhitespace) {
			args.push('-w');
		}
		if (opts.contents !== undefined) {
			args.push('--contents', '-');
		}
		if (opts.revision) {
			args.push(opts.revision);
		}
		args.push('--', relPath);
		const out = await this.run(args, { input: opts.contents });
		return P.parseBlamePorcelain(out.stdout);
	}

	async getRemotes(): Promise<P.RemoteInfo[]> {
		const out = await this.run(['remote', '-v']);
		return P.parseRemotes(out.stdout);
	}

	async getStashes(): Promise<P.StashEntry[]> {
		try {
			const out = await this.run(['stash', 'list', `--format=${P.STASH_FORMAT}`]);
			return P.parseStashList(out.stdout);
		} catch {
			return [];
		}
	}

	async getStashFiles(stash: P.StashEntry): Promise<FileChange[]> {
		const files = await this.getCommitFiles(stash.hash, stash.parents, 0);
		if (stash.parents.length >= 3) {
			const untracked = await this.run(['ls-tree', '-r', '-z', '--name-only', stash.parents[2]]);
			for (const p of untracked.stdout.split('\0').filter(Boolean)) {
				files.push({ path: p, status: 'A' });
			}
		}
		return files;
	}

	async getRecentBranches(limit = 5): Promise<string[]> {
		try {
			const out = await this.run(['reflog', 'show', '--format=%gs', '-n', '500', 'HEAD', '--']);
			const heads = new Set(this._refs.filter((r) => r.type === 'head').map((r) => r.shortName));
			return P.parseRecentCheckouts(out.stdout).filter((b) => heads.has(b) && b !== this._state.branch).slice(0, limit);
		} catch {
			return [];
		}
	}

	async getOutgoingCommits(source: string, remote: string, remoteBranch: string): Promise<CommitInfo[]> {
		const remoteRef = `refs/remotes/${remote}/${remoteBranch}`;
		const revisions = (await this.refExists(remoteRef)) ? [`${remoteRef}..${source}`] : [source, '--not', `--remotes=${remote}`];
		return this.log({ revisions, limit: 1000, order: 'topo' });
	}

	async getUntrackedOverwrittenFiles(output: string): Promise<string[]> {
		const files: string[] = [];
		const m = /untracked working tree files would be (?:overwritten|removed) by \w+:\n([\s\S]*?)\n(?:Please|Aborting)/.exec(output);
		if (m) {
			for (const l of m[1].split('\n')) {
				if (l.trim()) {
					files.push(l.trim());
				}
			}
		}
		return files;
	}


	async add(paths: string[], opts: { intentToAdd?: boolean; force?: boolean } = {}): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		const args = ['add'];
		if (opts.intentToAdd) {
			args.push('--intent-to-add');
		}
		if (opts.force) {
			args.push('--force');
		}
		await this.runOp([...args, ...spec.args], { input: spec.input });
	}

	/** Stages paths including deletions (`git add -A`). */
	async stage(paths: string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		await this.runOp(['add', '-A', ...spec.args], { input: spec.input });
	}

	async unstage(paths: string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		if (!this._state.head) {
			await this.runOp(['rm', '--cached', '-r', '-q', ...spec.args], { input: spec.input });
			return;
		}
		await this.runOp(['reset', '-q', 'HEAD', ...spec.args], { input: spec.input });
	}

	async removeFromIndex(paths: string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		await this.runOp(['rm', '--cached', '-r', '-q', '--ignore-unmatch', ...spec.args], { input: spec.input });
	}

	async rm(paths: string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		await this.runOp(['rm', '-q', '-r', '--ignore-unmatch', ...spec.args], { input: spec.input });
	}

	/** Restores files (working tree and index) from a revision. */
	async restore(paths: string[], source = 'HEAD', opts: { staged?: boolean; worktree?: boolean } = { staged: true, worktree: true }): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		if (this.git.versionAtLeast(2, 23)) {
			const args = ['restore', `--source=${source}`];
			if (opts.staged) {
				args.push('--staged');
			}
			if (opts.worktree !== false) {
				args.push('--worktree');
			}
			await this.runOp([...args, ...spec.args], { input: spec.input });
		} else {
			await this.runOp(['checkout', source, '--', ...paths]);
		}
	}

	/** Reverts working tree files to their index version (staging area mode). */
	async discardWorktreeChanges(paths: string[]): Promise<void> {
		if (!paths.length) {
			return;
		}
		const spec = this.pathspecArgs(paths);
		if (this.git.versionAtLeast(2, 23)) {
			await this.runOp(['restore', '--worktree', ...spec.args], { input: spec.input });
		} else {
			await this.runOp(['checkout', '--', ...paths]);
		}
	}

	/**
	 * Reverts local changes like JetBrains "Rollback": modified and deleted
	 * files are restored from HEAD, added files become unversioned (or are
	 * deleted when `deleteAdded` is set).
	 */
	async rollback(changes: FileChange[], deleteAdded: boolean): Promise<void> {
		const restore: string[] = [];
		const unversion: string[] = [];
		for (const c of changes) {
			switch (c.status) {
				case 'A':
				case 'C':
					unversion.push(c.path);
					break;
				case 'R':
					unversion.push(c.path);
					if (c.origPath) {
						restore.push(c.origPath);
					}
					break;
				case '?':
				case '!':
					if (deleteAdded) {
						await fs.promises.rm(this.absolutePath(c.path), { force: true, recursive: true });
					}
					break;
				default:
					restore.push(c.path);
			}
		}
		if (unversion.length) {
			await this.removeFromIndex(unversion);
			const renamed = new Set(changes.filter((c) => c.status === 'R').map((c) => c.path));
			for (const p of unversion) {
				if (deleteAdded || renamed.has(p)) {
					await fs.promises.rm(this.absolutePath(p), { force: true });
				}
			}
		}
		if (restore.length && this._state.head) {
			await this.restore(restore, 'HEAD', { staged: true, worktree: true });
		}
		await this.refresh();
	}

	/** Writes `content` as the index version of a file (partial staging). */
	async writeIndexContent(relPath: string, content: string | Buffer, opts: { indexFile?: string } = {}): Promise<void> {
		const env = opts.indexFile ? { GIT_INDEX_FILE: opts.indexFile } : undefined;
		const sha = (await this.run(['hash-object', '-w', '--stdin', `--path=${relPath}`], { input: content })).stdout.trim();
		const mode = await this.fileMode(relPath);
		await this.run(['update-index', '--add', '-z', '--index-info'], { input: `${mode} ${sha}\t${relPath}\0`, env, log: !opts.indexFile });
		if (!opts.indexFile) {
			await this.refresh();
		}
	}

	private async fileMode(relPath: string): Promise<string> {
		if (process.platform !== 'win32') {
			try {
				const st = await fs.promises.lstat(this.absolutePath(relPath));
				if (st.isSymbolicLink()) {
					return '120000';
				}
				return st.mode & 0o111 ? '100755' : '100644';
			} catch {
			}
		}
		try {
			const out = await this.run(['ls-files', '-s', '-z', '--', relPath]);
			const m = /^(\d{6}) /.exec(out.stdout);
			if (m) {
				return m[1];
			}
		} catch {
		}
		return '100644';
	}

	async commit(params: CommitParams): Promise<string> {
		const msgFile = path.join(this.gitDir, 'CHANGELINE_COMMIT_EDITMSG');
		await fs.promises.writeFile(msgFile, params.message, 'utf8');
		const commitArgs = ['commit', '-F', msgFile, '--cleanup=strip'];
		if (params.amend) {
			commitArgs.push('--amend');
		}
		if (params.signOff) {
			commitArgs.push('--signoff');
		}
		if (params.author) {
			commitArgs.push(`--author=${params.author}`);
		}
		if (params.noVerify) {
			commitArgs.push('--no-verify');
		}
		if (params.gpgSign) {
			commitArgs.push('--gpg-sign');
		}
		try {
			if (!params.files) {
				await this.runOp(commitArgs);
			} else if (params.useRealIndex) {
				await this.stageCommitFiles(params.files);
				await this.runOp(commitArgs);
			} else {
				await this.commitWithTemporaryIndex(params.files, commitArgs);
			}
		} finally {
			await fs.promises.rm(msgFile, { force: true });
		}
		const head = await this.revParse('HEAD');
		return head ?? '';
	}

	private async stageCommitFiles(files: CommitFile[]): Promise<void> {
		const plain: string[] = [];
		for (const f of files) {
			if (f.content !== undefined) {
				await this.writeIndexContent(f.path, f.content);
			} else {
				plain.push(f.path);
				if (f.origPath) {
					plain.push(f.origPath);
				}
			}
		}
		await this.stage(plain);
	}

	private async commitWithTemporaryIndex(files: CommitFile[], commitArgs: string[]): Promise<void> {
		const indexFile = path.join(this.gitDir, `changeline-index-${process.pid}-${Date.now()}`);
		const env = { GIT_INDEX_FILE: indexFile };
		const hasHead = !!(await this.revParse('HEAD'));
		try {
			await this.run(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env });
			const removals: string[] = [];
			const additions: string[] = [];
			for (const f of files) {
				if (f.origPath && f.origPath !== f.path) {
					removals.push(f.origPath);
				}
				if (f.status === 'D') {
					removals.push(f.path);
				} else if (f.content !== undefined) {
					await this.writeIndexContent(f.path, f.content, { indexFile });
				} else {
					additions.push(f.path);
				}
			}
			if (removals.length) {
				await this.run(['update-index', '--force-remove', '-z', '--stdin'], { env, input: removals.join('\0') + '\0' });
			}
			if (additions.length) {
				await this.run(['update-index', '--add', '--remove', '-z', '--stdin'], { env, input: additions.join('\0') + '\0' });
			}
			await this.git.exec(this.root, commitArgs, { env, log: true });
		} finally {
			await fs.promises.rm(indexFile, { force: true });
			await fs.promises.rm(indexFile + '.lock', { force: true });
			this.onDidRunOperationEmitter.fire('commit');
		}
		const paths = new Set<string>();
		for (const f of files) {
			paths.add(f.path);
			if (f.origPath) {
				paths.add(f.origPath);
			}
		}
		const spec = this.pathspecArgs([...paths]);
		await this.run(['reset', '-q', 'HEAD', ...spec.args], { input: spec.input, acceptExitCodes: [1] });
		await this.refresh();
	}

	async amendMessage(message: string): Promise<void> {
		const msgFile = path.join(this.gitDir, 'CHANGELINE_COMMIT_EDITMSG');
		await fs.promises.writeFile(msgFile, message, 'utf8');
		try {
			await this.runOp(['commit', '--amend', '--only', '--allow-empty', '--no-verify', '--cleanup=strip', '-F', msgFile]);
		} finally {
			await fs.promises.rm(msgFile, { force: true });
		}
	}


	async checkout(ref: string, opts: { force?: boolean; detach?: boolean; newBranch?: string; track?: boolean; forceNewBranch?: boolean } = {}): Promise<void> {
		const args = ['checkout'];
		if (opts.force) {
			args.push('--force');
		}
		if (opts.newBranch) {
			args.push(opts.forceNewBranch ? '-B' : '-b', opts.newBranch);
		}
		if (opts.track) {
			args.push('--track');
		}
		if (opts.detach) {
			args.push('--detach');
		}
		args.push(ref, '--');
		await this.runOp(args);
	}

	async createBranch(name: string, startPoint: string | undefined, opts: { force?: boolean } = {}): Promise<void> {
		const args = ['branch'];
		if (opts.force) {
			args.push('--force');
		}
		args.push(name);
		if (startPoint) {
			args.push(startPoint);
		}
		await this.runOp(args);
	}

	async deleteBranch(name: string, force = false): Promise<void> {
		await this.runOp(['branch', force ? '-D' : '-d', name]);
	}

	async deleteRemoteBranch(remote: string, branch: string): Promise<void> {
		await this.runOp(['push', remote, '--delete', branch]);
	}

	async renameBranch(oldName: string, newName: string): Promise<void> {
		await this.runOp(['branch', '-m', oldName, newName]);
	}

	async setUpstream(branch: string, upstream: string | undefined): Promise<void> {
		if (upstream) {
			await this.runOp(['branch', `--set-upstream-to=${upstream}`, branch]);
		} else {
			await this.runOp(['branch', '--unset-upstream', branch]);
		}
	}

	async createTag(name: string, ref: string, message?: string, force = false): Promise<void> {
		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (message) {
			args.push('-a', '-m', message);
		}
		args.push(name, ref);
		await this.runOp(args);
	}

	async deleteTag(name: string): Promise<void> {
		await this.runOp(['tag', '-d', name]);
	}


	private outcome(r: ExecResult | GitError): OperationOutcome {
		if (r instanceof GitError) {
			const output = r.stdout + '\n' + r.stderr;
			const conflicts = /CONFLICT|could not apply|after resolving the conflicts|fix conflicts|Merge conflict/i.test(output);
			return { ok: false, conflicts, output, error: r };
		}
		return { ok: true, conflicts: false, output: r.stdout + '\n' + r.stderr };
	}

	private async runOutcome(args: string[], options?: ExecOptions): Promise<OperationOutcome> {
		try {
			return this.outcome(await this.runOp(args, options));
		} catch (e) {
			if (e instanceof GitError) {
				const outcome = this.outcome(e);
				if (!outcome.conflicts) {
					throw e;
				}
				return outcome;
			}
			throw e;
		}
	}

	private editorEnv(): NodeJS.ProcessEnv {
		return { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
	}

	merge(ref: string, opts: MergeOptions = {}): Promise<OperationOutcome> {
		const args = ['merge'];
		if (opts.noFastForward) {
			args.push('--no-ff');
		}
		if (opts.fastForwardOnly) {
			args.push('--ff-only');
		}
		if (opts.squash) {
			args.push('--squash');
		}
		if (opts.noCommit) {
			args.push('--no-commit');
		}
		if (opts.noVerify) {
			args.push('--no-verify');
		}
		if (opts.allowUnrelated) {
			args.push('--allow-unrelated-histories');
		}
		if (opts.strategyOption) {
			args.push(`--strategy-option=${opts.strategyOption}`);
		}
		if (opts.message) {
			args.push('-m', opts.message);
		} else {
			args.push('--no-edit');
		}
		args.push(ref);
		return this.runOutcome(args, { env: this.editorEnv() });
	}

	rebase(upstream: string | undefined, opts: RebaseOptions = {}): Promise<OperationOutcome> {
		const args = ['rebase'];
		if (opts.rebaseMerges) {
			args.push('--rebase-merges');
		}
		if (opts.keepEmpty) {
			args.push('--keep-empty');
		}
		if (opts.updateRefs) {
			args.push('--update-refs');
		}
		if (opts.autostash) {
			args.push('--autostash');
		}
		if (opts.newBase) {
			args.push('--onto', opts.newBase);
		}
		if (opts.root) {
			args.push('--root');
		} else if (upstream) {
			args.push(upstream);
		}
		if (opts.branch) {
			args.push(opts.branch);
		}
		return this.runOutcome(args, { env: this.editorEnv() });
	}

	/**
	 * Runs an interactive rebase with a todo list prepared by the rebase
	 * dialog. Reworded and squashed messages are applied with `exec git
	 * commit --amend` so git never needs an interactive editor.
	 */
	async rebaseInteractive(base: string | undefined, entries: RebaseTodoEntry[], scriptsDir: string): Promise<OperationOutcome> {
		const lines: string[] = [];
		const msgDir = path.join(this.gitDir, 'changeline-rebase');
		await fs.promises.mkdir(msgDir, { recursive: true });
		let msgCounter = 0;
		const writeMsg = async (message: string) => {
			const file = path.join(msgDir, `msg-${msgCounter++}.txt`);
			await fs.promises.writeFile(file, message, 'utf8');
			return shellPath(file);
		};
		const amendExec = (file: string) => `exec git commit --amend --allow-empty --no-verify --cleanup=strip -F "${file.replace(/"/g, '\\"')}"`;
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const subject = e.subject.replace(/\r?\n/g, ' ');
			switch (e.action) {
				case 'drop':
					lines.push(`drop ${e.hash} ${subject}`);
					break;
				case 'reword':
					lines.push(`pick ${e.hash} ${subject}`);
					lines.push(amendExec(await writeMsg(e.message ?? e.subject)));
					break;
				case 'squash':
				case 'fixup':
					lines.push(`fixup ${e.hash} ${subject}`);
					break;
				default:
					lines.push(`${e.action} ${e.hash} ${subject}`);
			}
			const next = entries[i + 1];
			const groupEnds = !next || (next.action !== 'squash' && next.action !== 'fixup');
			if (groupEnds && (e.action === 'squash' || e.action === 'fixup')) {
				let j = i;
				while (j > 0 && (entries[j].action === 'squash' || entries[j].action === 'fixup')) {
					j--;
				}
				let groupMessage: string | undefined;
				for (let k = i; k >= j && groupMessage === undefined; k--) {
					groupMessage = entries[k].message;
				}
				if (groupMessage !== undefined) {
					lines.push(amendExec(await writeMsg(groupMessage)));
				}
			}
		}
		const todoFile = path.join(msgDir, 'todo.txt');
		await fs.promises.writeFile(todoFile, lines.join('\n') + '\n', 'utf8');
		const seqEditor = path.join(scriptsDir, 'sequence-editor.sh');
		const env = {
			GIT_SEQUENCE_EDITOR: `"${shellPath(seqEditor)}"`,
			GIT_EDITOR: 'true',
			CHANGELINE_REBASE_TODO: todoFile,
		};
		const args = ['rebase', '--interactive', '--no-autosquash'];
		if (base) {
			args.push(base);
		} else {
			args.push('--root');
		}
		return this.runOutcome(args, { env });
	}

	async continueOperation(): Promise<OperationOutcome> {
		const op = this._state.operation;
		const env = this.editorEnv();
		switch (op) {
			case 'rebase':
				return this.runOutcome(['rebase', '--continue'], { env });
			case 'cherry-pick':
				return this.runOutcome(['cherry-pick', '--continue'], { env });
			case 'revert':
				return this.runOutcome(['revert', '--continue'], { env });
			case 'merge':
				return this.runOutcome(['commit', '--no-edit'], { env });
			case 'am':
				return this.runOutcome(['am', '--continue'], { env });
			default:
				return { ok: true, conflicts: false, output: '' };
		}
	}

	async abortOperation(): Promise<void> {
		switch (this._state.operation) {
			case 'rebase':
				await this.runOp(['rebase', '--abort']);
				break;
			case 'cherry-pick':
				await this.runOp(['cherry-pick', '--abort']);
				break;
			case 'revert':
				await this.runOp(['revert', '--abort']);
				break;
			case 'merge':
				await this.runOp(['merge', '--abort']);
				break;
			case 'am':
				await this.runOp(['am', '--abort']);
				break;
			case 'bisect':
				await this.runOp(['bisect', 'reset']);
				break;
		}
	}

	async skipOperation(): Promise<OperationOutcome> {
		const env = this.editorEnv();
		switch (this._state.operation) {
			case 'rebase':
				return this.runOutcome(['rebase', '--skip'], { env });
			case 'cherry-pick':
				return this.runOutcome(['cherry-pick', '--skip'], { env });
			case 'revert':
				return this.runOutcome(['revert', '--skip'], { env });
			default:
				return { ok: true, conflicts: false, output: '' };
		}
	}

	cherryPick(hashes: string[], opts: { recordOrigin?: boolean; noCommit?: boolean; mainline?: number } = {}): Promise<OperationOutcome> {
		const args = ['cherry-pick'];
		if (opts.recordOrigin) {
			args.push('-x');
		}
		if (opts.noCommit) {
			args.push('--no-commit');
		}
		if (opts.mainline) {
			args.push('-m', String(opts.mainline));
		}
		args.push(...hashes);
		return this.runOutcome(args, { env: this.editorEnv() });
	}

	revert(hashes: string[], opts: { mainline?: number; noCommit?: boolean } = {}): Promise<OperationOutcome> {
		const args = ['revert', '--no-edit'];
		if (opts.mainline) {
			args.push('-m', String(opts.mainline));
		}
		if (opts.noCommit) {
			args.push('--no-commit');
		}
		args.push(...hashes);
		return this.runOutcome(args, { env: this.editorEnv() });
	}

	async reset(ref: string, mode: 'soft' | 'mixed' | 'hard' | 'keep'): Promise<void> {
		await this.runOp(['reset', `--${mode}`, ref]);
	}


	async fetch(remote?: string, opts: { prune?: boolean; tags?: boolean; refspec?: string; onProgress?: (line: string) => void; cancel?: ExecOptions['cancel'] } = {}): Promise<void> {
		const args = ['fetch', '--progress'];
		if (opts.prune !== false) {
			args.push('--prune');
		}
		if (opts.tags) {
			args.push('--tags');
		}
		if (remote) {
			args.push(remote);
			if (opts.refspec) {
				args.push(opts.refspec);
			}
		} else {
			args.push('--all');
		}
		await this.runOp(args, { onStderr: opts.onProgress, cancel: opts.cancel });
	}

	async pull(remote: string, branches: string[], opts: { rebase?: boolean; ffOnly?: boolean; noFf?: boolean; squash?: boolean; noCommit?: boolean; noVerify?: boolean; onProgress?: (line: string) => void } = {}): Promise<OperationOutcome> {
		const args = ['pull', '--progress'];
		args.push(opts.rebase ? '--rebase' : '--no-rebase');
		if (opts.ffOnly) {
			args.push('--ff-only');
		}
		if (opts.noFf) {
			args.push('--no-ff');
		}
		if (opts.squash) {
			args.push('--squash');
		}
		if (opts.noCommit) {
			args.push('--no-commit');
		}
		if (opts.noVerify) {
			args.push('--no-verify');
		}
		args.push(remote, ...branches);
		return this.runOutcome(args, { env: this.editorEnv(), onStderr: opts.onProgress });
	}

	async push(params: PushParams, onProgress?: (line: string) => void): Promise<PushResult> {
		const args = ['push', '--porcelain', '--progress'];
		if (params.force === 'lease') {
			args.push('--force-with-lease');
		} else if (params.force === 'force') {
			args.push('--force');
		}
		if (params.setUpstream) {
			args.push('--set-upstream');
		}
		if (params.tags === 'all') {
			args.push('--tags');
		} else if (params.tags === 'follow') {
			args.push('--follow-tags');
		}
		if (params.noVerify) {
			args.push('--no-verify');
		}
		args.push(params.remote, `${params.source}:refs/heads/${params.remoteBranch}`);
		try {
			const r = await this.runOp(args, { onStderr: onProgress });
			return { refs: P.parsePushPorcelain(r.stdout), rejected: false, output: r.stdout + r.stderr };
		} catch (e) {
			if (e instanceof GitError) {
				const refs = P.parsePushPorcelain(e.stdout);
				const rejected = refs.some((x) => x.flag === '!') || /\[rejected\]|non-fast-forward|fetch first/.test(e.stderr + e.stdout);
				if (rejected) {
					return { refs, rejected: true, output: e.stdout + e.stderr };
				}
			}
			throw e;
		}
	}

	async pushTag(remote: string, tag: string, del = false): Promise<void> {
		await this.runOp(del ? ['push', remote, '--delete', `refs/tags/${tag}`] : ['push', remote, `refs/tags/${tag}`]);
	}

	async addRemote(name: string, url: string): Promise<void> {
		await this.runOp(['remote', 'add', name, url]);
	}

	async removeRemote(name: string): Promise<void> {
		await this.runOp(['remote', 'remove', name]);
	}

	async renameRemote(oldName: string, newName: string): Promise<void> {
		await this.runOp(['remote', 'rename', oldName, newName]);
	}

	async setRemoteUrl(name: string, url: string): Promise<void> {
		await this.runOp(['remote', 'set-url', name, url]);
	}


	async stash(opts: { message?: string; keepIndex?: boolean; includeUntracked?: boolean; paths?: string[]; staged?: boolean } = {}): Promise<boolean> {
		const before = await this.revParse('refs/stash');
		const args = ['stash', 'push'];
		if (opts.message) {
			args.push('-m', opts.message);
		}
		if (opts.keepIndex) {
			args.push('--keep-index');
		}
		if (opts.includeUntracked) {
			args.push('--include-untracked');
		}
		if (opts.staged) {
			args.push('--staged');
		}
		if (opts.paths && opts.paths.length) {
			args.push('--', ...opts.paths.map(literalPath));
		}
		await this.runOp(args);
		const after = await this.revParse('refs/stash');
		return after !== before;
	}

	stashApply(ref: string, opts: { pop?: boolean; index?: boolean } = {}): Promise<OperationOutcome> {
		const args = ['stash', opts.pop ? 'pop' : 'apply'];
		if (opts.index) {
			args.push('--index');
		}
		args.push(ref);
		return this.runOutcome(args);
	}

	async stashDrop(ref: string): Promise<void> {
		await this.runOp(['stash', 'drop', ref]);
	}

	async stashClear(): Promise<void> {
		await this.runOp(['stash', 'clear']);
	}

	async stashBranch(branch: string, ref: string): Promise<OperationOutcome> {
		return this.runOutcome(['stash', 'branch', branch, ref]);
	}


	async listWorktrees(): Promise<{ path: string; head?: string; branch?: string; bare: boolean; detached: boolean; locked: boolean; prunable: boolean }[]> {
		const out = await this.run(['worktree', 'list', '--porcelain']);
		const result: { path: string; head?: string; branch?: string; bare: boolean; detached: boolean; locked: boolean; prunable: boolean }[] = [];
		let cur: (typeof result)[number] | undefined;
		for (const line of out.stdout.split('\n')) {
			if (line.startsWith('worktree ')) {
				cur = { path: path.normalize(line.slice(9)), bare: false, detached: false, locked: false, prunable: false };
				result.push(cur);
			} else if (cur && line.startsWith('HEAD ')) {
				cur.head = line.slice(5);
			} else if (cur && line.startsWith('branch ')) {
				cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
			} else if (cur && line === 'bare') {
				cur.bare = true;
			} else if (cur && line === 'detached') {
				cur.detached = true;
			} else if (cur && line.startsWith('locked')) {
				cur.locked = true;
			} else if (cur && line.startsWith('prunable')) {
				cur.prunable = true;
			}
		}
		return result;
	}

	async addWorktree(dir: string, ref: string, newBranch?: string): Promise<void> {
		const args = ['worktree', 'add'];
		if (newBranch) {
			args.push('-b', newBranch);
		}
		args.push(dir, ref);
		await this.runOp(args);
	}

	async removeWorktree(dir: string, force = false): Promise<void> {
		await this.runOp(force ? ['worktree', 'remove', '--force', dir] : ['worktree', 'remove', dir]);
	}


	async createPatch(opts: { from?: string; to?: string; paths?: string[]; cached?: boolean; binary?: boolean } = {}): Promise<string> {
		const args = ['diff', '--no-color', '--full-index'];
		if (opts.binary !== false) {
			args.push('--binary');
		}
		if (opts.cached) {
			args.push('--cached');
		}
		if (opts.from) {
			args.push(opts.from);
		}
		if (opts.to) {
			args.push(opts.to);
		}
		args.push('--', ...(opts.paths ?? []).map(literalPath));
		return (await this.run(args)).stdout;
	}

	/** Patch that adds an untracked file. */
	async createUntrackedPatch(relPath: string): Promise<string> {
		const r = await this.run(['diff', '--no-color', '--binary', '--no-index', '--', '/dev/null', relPath], { acceptExitCodes: [1] });
		return r.stdout;
	}

	async formatPatch(hashes: string[]): Promise<string> {
		const parts: string[] = [];
		for (const h of hashes) {
			parts.push((await this.run(['format-patch', '-1', '--stdout', '--binary', h])).stdout);
		}
		return parts.join('');
	}

	async applyPatch(patchFile: string, opts: { check?: boolean; index?: boolean; threeWay?: boolean; reverse?: boolean; include?: string[] } = {}): Promise<OperationOutcome> {
		const args = ['apply', '--whitespace=nowarn'];
		if (opts.check) {
			args.push('--check');
		}
		if (opts.index) {
			args.push('--index');
		}
		if (opts.threeWay) {
			args.push('--3way');
		}
		if (opts.reverse) {
			args.push('--reverse');
		}
		for (const inc of opts.include ?? []) {
			args.push(`--include=${inc}`);
		}
		args.push(patchFile);
		try {
			const r = opts.check ? await this.run(args) : await this.runOp(args);
			return this.outcome(r);
		} catch (e) {
			if (e instanceof GitError) {
				return { ok: false, conflicts: /conflict/i.test(e.stderr), output: e.stderr, error: e };
			}
			throw e;
		}
	}

	async clean(paths: string[]): Promise<void> {
		await this.runOp(['clean', '-f', '-d', '--', ...paths]);
	}
}

export function literalPath(p: string): string {
	return /[*?[\]]/.test(p) || p.startsWith(':') ? `:(literal)${p}` : p;
}

function safeRealpath(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return p;
	}
}

function blobSpec(ref: string, relPath: string): string {
	return ref === '' ? `:${relPath}` : `${ref}:${relPath}`;
}
