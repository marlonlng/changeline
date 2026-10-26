import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommitFile, Repository } from './git/repository';
import { services } from './services';
import { workingChunks } from './chunks';
import { applyChunks, chunkKey, DiffChunk, diffLines, isBinary, splitLines } from './shared/diff';
import { config, pathKey, plural, showError } from './util';
import type { ChangesView, FileNode } from './views/changesView';

export interface CommitOptions {
	signOff: boolean;
	runHooks: boolean;
	author: string;
	analyzeCode: boolean;
	checkTodo: boolean;
	cleanupWhitespace: boolean;
	reformatCode: boolean;
	optimizeImports: boolean;
	gpgSign: boolean;
	runTests: boolean;
}

export interface CommitRequest {
	message: string;
	amend: boolean;
	push: boolean;
	options: CommitOptions;
}

const HISTORY_KEY = 'changeline.commitMessageHistory';
const DRAFT_KEY = 'changeline.commitMessageDraft';

export class CommitController implements vscode.Disposable {
	private _message: string;
	private _amend = false;
	private amendedFrom?: string;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<{ message?: boolean }>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	busy = false;

	constructor(private readonly view: ChangesView) {
		this._message = services().context.workspaceState.get<string>(DRAFT_KEY, '');
		const cl = services().changelists;
		let lastActive = cl.active.id;
		this.subscription = cl.onDidChange(() => {
			if (cl.active.id === lastActive) {
				return;
			}
			const previous = cl.get(lastActive)?.comment ?? '';
			lastActive = cl.active.id;
			if (!this._message.trim() || this._message === previous) {
				this.setMessage(cl.active.comment ?? '');
			}
		});
	}

	private subscription: vscode.Disposable;

	/** Prefills the message from git's commit.template, like JetBrains IDEs do. */
	async loadTemplate(): Promise<void> {
		const repo = services().repos.current();
		const file = repo && (await repo.getConfig('commit.template'));
		if (!repo || !file) {
			return;
		}
		const resolved = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : path.isAbsolute(file) ? file : path.join(repo.root, file);
		try {
			const text = (await fs.promises.readFile(resolved, 'utf8')).replace(/^#.*$\n?/gm, '').trimEnd();
			if (text && !this._message) {
				this.setMessage(text);
			}
		} catch {
		}
	}

	get message(): string {
		return this._message;
	}

	setMessage(message: string, fromView = false): void {
		this._message = message;
		void services().context.workspaceState.update(DRAFT_KEY, message);
		this.onDidChangeEmitter.fire({ message: !fromView });
	}

	get amend(): boolean {
		return this._amend;
	}

	async setAmend(amend: boolean): Promise<void> {
		this._amend = amend;
		if (amend && !this._message.trim()) {
			const repo = this.targetRepositories()[0] ?? services().repos.current();
			if (repo && repo.state.head) {
				try {
					const c = await repo.getCommit('HEAD');
					this.amendedFrom = c.body;
					this.setMessage(c.body);
				} catch {
				}
			}
		} else if (!amend && this.amendedFrom !== undefined && this._message === this.amendedFrom) {
			this.setMessage('');
			this.amendedFrom = undefined;
		}
		this.onDidChangeEmitter.fire({});
	}

	get options(): CommitOptions {
		const st = services().context.workspaceState;
		return {
			signOff: st.get('changeline.commit.signOff', config('commit.signOff', false)),
			runHooks: st.get('changeline.commit.runHooks', config('commit.runHooks', true)),
			author: st.get('changeline.commit.author', ''),
			analyzeCode: st.get('changeline.commit.analyzeCode', config('commit.analyzeCode', false)),
			checkTodo: st.get('changeline.commit.checkTodo', config('commit.checkTodo', false)),
			cleanupWhitespace: st.get('changeline.commit.cleanupWhitespace', false),
			reformatCode: st.get('changeline.commit.reformatCode', config('commit.reformatCode', false)),
			optimizeImports: st.get('changeline.commit.optimizeImports', config('commit.optimizeImports', false)),
			gpgSign: st.get('changeline.commit.gpgSign', false),
			runTests: st.get('changeline.commit.runTests', false),
		};
	}

	async setOptions(o: Partial<CommitOptions>): Promise<void> {
		const st = services().context.workspaceState;
		for (const [k, v] of Object.entries(o)) {
			await st.update(`changeline.commit.${k}`, v);
		}
		this.onDidChangeEmitter.fire({});
	}

	/** Repositories that would receive a commit right now. */
	targetRepositories(): Repository[] {
		const repos = new Set<Repository>();
		if (this.view.stagingMode) {
			for (const r of services().repos.repositories) {
				if (r.state.staged.length) {
					repos.add(r);
				}
			}
		} else {
			for (const f of this.view.includedFiles()) {
				repos.add(f.repo);
			}
		}
		return [...repos];
	}

	summary(): { text: string; count: number; total: number } {
		if (this.view.stagingMode) {
			const staged = services().repos.repositories.reduce((n, r) => n + r.state.staged.length, 0);
			const total = services().repos.repositories.reduce((n, r) => n + r.state.unstaged.length + r.state.staged.length + r.state.untracked.length, 0);
			return { text: staged ? plural(staged, '{0} file staged', '{0} files staged') : vscode.l10n.t('Nothing staged'), count: staged, total };
		}
		const included = this.view.includedFiles();
		const total = new Set(this.view.allFiles().filter((f) => f.group === 'changelist' || f.group === 'unversioned').map((f) => f.abs)).size;
		const added = included.filter((f) => f.change.status === 'A' || f.change.status === '?').length;
		const deleted = included.filter((f) => f.change.status === 'D').length;
		const modified = included.length - added - deleted;
		const parts: string[] = [];
		if (modified) {
			parts.push(vscode.l10n.t('{0} modified', modified));
		}
		if (added) {
			parts.push(vscode.l10n.t('{0} added', added));
		}
		if (deleted) {
			parts.push(vscode.l10n.t('{0} deleted', deleted));
		}
		return { text: included.length ? parts.join(', ') : total ? vscode.l10n.t('No files selected') : vscode.l10n.t('No changes'), count: included.length, total };
	}

	messageHistory(): string[] {
		return services().context.globalState.get<string[]>(HISTORY_KEY, []);
	}

	private async remember(message: string): Promise<void> {
		const history = this.messageHistory().filter((m) => m !== message);
		history.unshift(message);
		await services().context.globalState.update(HISTORY_KEY, history.slice(0, 40));
	}

	async showMessageHistory(): Promise<void> {
		const history = this.messageHistory();
		if (!history.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No recent commit messages.'));
			return;
		}
		const pick = await vscode.window.showQuickPick(
			history.map((m) => ({ label: m.split('\n')[0], detail: m.includes('\n') ? m.split('\n').slice(1).join(' ').trim().slice(0, 200) : undefined, message: m })),
			{ placeHolder: vscode.l10n.t('Choose Message'), matchOnDetail: true },
		);
		if (pick) {
			this.setMessage(pick.message);
		}
	}

	async commit(req: CommitRequest): Promise<boolean> {
		if (this.busy) {
			return false;
		}
		const message = req.message.trim() ? req.message.replace(/\s+$/, '') + '\n' : '';
		if (!message.trim()) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Specify a commit message.'), { modal: false });
			return false;
		}
		const s = services();
		const staging = this.view.stagingMode;
		let repos: Repository[];
		let filesByRepo = new Map<Repository, FileNode[]>();
		if (staging) {
			repos = req.amend ? this.amendTargets() : this.targetRepositories();
		} else {
			filesByRepo = groupByRepo(this.view.includedFiles());
			repos = [...filesByRepo.keys()];
			if (req.amend && !repos.length) {
				repos = this.amendTargets();
			}
		}
		if (!repos.length) {
			void vscode.window.showWarningMessage(staging ? vscode.l10n.t('No changes staged for commit.') : vscode.l10n.t('No changes selected for commit.'));
			return false;
		}
		const unresolved = repos.filter((r) => r.state.conflicts.length);
		if (unresolved.length) {
			const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Unresolved merge conflicts must be resolved before committing.'), vscode.l10n.t('Resolve...'));
			if (choice) {
				void vscode.commands.executeCommand('changeline.resolveConflicts');
			}
			return false;
		}

		const detached = repos.filter((r) => r.state.detached && r.state.operation === 'none');
		if (detached.length) {
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t(
					detached.length === 1
						? '{0} is in detached HEAD state. The commit will not belong to any branch and may be lost after the next checkout.'
						: '{0} are in detached HEAD state. The commit will not belong to any branch and may be lost after the next checkout.',
					detached.map((r) => r.name).join(', '),
				),
				{ modal: true },
				vscode.l10n.t('Commit'),
				vscode.l10n.t('Create Branch...'),
			);
			if (choice === vscode.l10n.t('Create Branch...')) {
				await vscode.commands.executeCommand('changeline.newBranch', detached[0]);
				return false;
			}
			if (choice !== vscode.l10n.t('Commit')) {
				return false;
			}
		}

		this.busy = true;
		this.onDidChangeEmitter.fire({});
		try {
			await this.prepareFiles([...filesByRepo.values()].flat(), req.options);
			await this.saveDocuments([...filesByRepo.values()].flat());
			if (!(await this.checkLineSeparators(repos, [...filesByRepo.values()].flat()))) {
				return false;
			}
			if (!(await this.runChecks([...filesByRepo.values()].flat(), req.options))) {
				return false;
			}
			const committed: { repo: Repository; count: number }[] = [];
			for (const repo of repos) {
				const files = filesByRepo.get(repo) ?? [];
				const params = {
					message,
					amend: req.amend,
					signOff: req.options.signOff,
					noVerify: !req.options.runHooks,
					author: req.options.author.trim() || undefined,
					gpgSign: req.options.gpgSign,
				};
				if (staging) {
					await repo.commit(params);
					committed.push({ repo, count: repo.state.staged.length });
				} else {
					const commitFiles = await this.toCommitFiles(repo, files);
					await repo.commit({ ...params, files: commitFiles, useRealIndex: repo.state.operation !== 'none' });
					committed.push({ repo, count: commitFiles.length });
				}
			}
			await this.remember(message.trim());
			this.amendedFrom = undefined;
			this._amend = false;
			this.setMessage('');
			await this.loadTemplate();
			const subject = message.split('\n')[0];
			const count = committed.reduce((n, c) => n + c.count, 0);
			void vscode.window.showInformationMessage(vscode.l10n.t(count === 1 ? '{0} file committed: {1}' : '{0} files committed: {1}', count, subject));
			await this.cleanupChangelists();
			if (req.push) {
				await vscode.commands.executeCommand('changeline.push', committed.length === 1 ? committed[0].repo : undefined);
			}
			return true;
		} catch (e) {
			await showError(e, vscode.l10n.t('Commit failed'));
			return false;
		} finally {
			this.busy = false;
			this.onDidChangeEmitter.fire({});
		}
	}

	private amendTargets(): Repository[] {
		const r = services().repos.current();
		return r ? [r] : [];
	}

	/** Builds the commit file list; files with excluded chunks get partial content. */
	async toCommitFiles(repo: Repository, files: FileNode[]): Promise<CommitFile[]> {
		const cl = services().changelists;
		const result: CommitFile[] = [];
		for (const f of files) {
			const c = f.change;
			const excluded = cl.getExcludedChunks(f.abs);
			if ((excluded.size || cl.hasPartialLists(f.abs)) && c.status === 'M') {
				const fc = await workingChunks(repo, c.path);
				if (fc) {
					const take = (chunk: DiffChunk) => {
						const key = chunkKey(chunk, fc.oldLines, fc.newLines);
						return cl.isPartIncluded(f.abs, cl.chunkListOf(f.abs, key)) && !excluded.has(key);
					};
					if (!fc.chunks.some(take)) {
						continue;
					}
					const content = applyChunks(fc.oldLines, fc.newLines, fc.chunks, take);
					result.push({ path: c.path, origPath: c.origPath, status: c.status, content });
					continue;
				}
			}
			result.push({ path: c.path, origPath: c.origPath, status: c.status === '?' ? 'A' : c.status });
		}
		return result;
	}

	/** "Reformat code" and "Optimize imports" before commit, for fully included text files. */
	private async prepareFiles(files: FileNode[], options: CommitOptions): Promise<void> {
		if (!options.reformatCode && !options.optimizeImports) {
			return;
		}
		const cl = services().changelists;
		for (const f of files) {
			if (f.change.status === 'D' || cl.getExcludedChunks(f.abs).size) {
				continue;
			}
			const uri = vscode.Uri.file(f.abs);
			let doc: vscode.TextDocument;
			try {
				doc = await vscode.workspace.openTextDocument(uri);
			} catch {
				continue;
			}
			if (options.optimizeImports) {
				const range = new vscode.Range(0, 0, doc.lineCount, 0);
				const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, range, vscode.CodeActionKind.SourceOrganizeImports.value);
				const action = actions?.find((a) => a.kind && vscode.CodeActionKind.SourceOrganizeImports.contains(a.kind));
				if (action?.edit) {
					await vscode.workspace.applyEdit(action.edit);
				} else if (action?.command) {
					await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
				}
			}
			if (options.reformatCode) {
				const editorConfig = vscode.workspace.getConfiguration('editor', uri);
				const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, {
					tabSize: editorConfig.get<number>('tabSize', 4),
					insertSpaces: editorConfig.get<boolean>('insertSpaces', true),
				});
				if (edits?.length) {
					const we = new vscode.WorkspaceEdit();
					we.set(uri, edits);
					await vscode.workspace.applyEdit(we);
				}
			}
			if (doc.isDirty) {
				await doc.save();
			}
		}
	}

	/** JetBrains warns on Windows when CRLF line separators are about to be committed. */
	private async checkLineSeparators(repos: Repository[], files: FileNode[]): Promise<boolean> {
		if (!(config<boolean | null>('commit.warnAboutCrlf', null) ?? process.platform === 'win32')) {
			return true;
		}
		for (const repo of repos) {
			if ((await repo.getConfig('core.autocrlf')) !== undefined) {
				continue;
			}
			const crlf: string[] = [];
			for (const f of files.filter((x) => x.repo === repo && x.change.status !== 'D')) {
				const buf = await repo.readWorkingFile(f.change.path);
				if (buf && !isBinary(buf) && buf.includes('\r\n')) {
					crlf.push(f.change.path);
				}
			}
			if (!crlf.length) {
				continue;
			}
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('You are about to commit CRLF line separators to {0}:\n{1}{2}\n\nIt is recommended to set core.autocrlf to true so line separators are converted on commit.', repo.name, crlf.slice(0, 8).join('\n'), crlf.length > 8 ? '\n…' : ''),
				{ modal: true },
				vscode.l10n.t('Fix and Commit'),
				vscode.l10n.t('Commit As Is'),
			);
			if (choice === vscode.l10n.t('Fix and Commit')) {
				await repo.git.exec(repo.root, ['config', '--global', 'core.autocrlf', 'true'], { log: true });
			} else if (choice !== vscode.l10n.t('Commit As Is')) {
				return false;
			}
		}
		return true;
	}

	private async saveDocuments(files: FileNode[]): Promise<void> {
		const paths = new Set(files.map((f) => pathKey(f.abs)));
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.isDirty && doc.uri.scheme === 'file' && (paths.has(pathKey(doc.uri.fsPath)) || this.view.stagingMode)) {
				await doc.save();
			}
		}
	}

	/** "Run Tests" before commit: runs a VS Code task and asks to continue when it fails. */
	private async runTestTask(): Promise<boolean> {
		const tasks = await vscode.tasks.fetchTasks();
		let label = config<string>('commit.testTask', '');
		let task = tasks.find((t) => t.name === label || `${t.source}: ${t.name}` === label);
		if (!task) {
			const pick = await vscode.window.showQuickPick(
				tasks.map((t) => ({ label: t.name, description: t.source, task: t })),
				{ title: vscode.l10n.t('Run Tests before Commit'), placeHolder: vscode.l10n.t('Select the task that runs your tests (saved in changeline.commit.testTask)') },
			);
			if (!pick) {
				return false;
			}
			task = pick.task;
			label = task.name;
			await vscode.workspace.getConfiguration('changeline').update('commit.testTask', label, vscode.ConfigurationTarget.Workspace);
		}
		const execution = await vscode.tasks.executeTask(task);
		const exitCode = await new Promise<number | undefined>((resolve) => {
			const sub = vscode.tasks.onDidEndTaskProcess((e) => {
				if (e.execution === execution) {
					sub.dispose();
					resolve(e.exitCode);
				}
			});
		});
		if (exitCode === 0) {
			return true;
		}
		const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Tests failed ("{0}" exited with code {1}).', label, exitCode ?? '?'), { modal: true }, vscode.l10n.t('Commit Anyway'));
		return choice === vscode.l10n.t('Commit Anyway');
	}

	private async runChecks(files: FileNode[], options: CommitOptions): Promise<boolean> {
		if (options.runTests && !(await this.runTestTask())) {
			return false;
		}
		if (options.analyzeCode) {
			let errors = 0;
			let warnings = 0;
			for (const f of files) {
				for (const d of vscode.languages.getDiagnostics(vscode.Uri.file(f.abs))) {
					if (d.severity === vscode.DiagnosticSeverity.Error) {
						errors++;
					} else if (d.severity === vscode.DiagnosticSeverity.Warning) {
						warnings++;
					}
				}
			}
			if (errors || warnings) {
				const choice = await vscode.window.showWarningMessage(
					vscode.l10n.t('Code analysis found {0} and {1} in the files to commit.', plural(errors, '{0} error', '{0} errors'), plural(warnings, '{0} warning', '{0} warnings')),
					{ modal: true },
					vscode.l10n.t('Commit Anyway'),
					vscode.l10n.t('Review'),
				);
				if (choice === vscode.l10n.t('Review')) {
					void vscode.commands.executeCommand('workbench.actions.view.problems');
					return false;
				}
				if (choice !== vscode.l10n.t('Commit Anyway')) {
					return false;
				}
			}
		}
		if (options.checkTodo) {
			const todos: string[] = [];
			for (const f of files) {
				if (f.change.status === 'D') {
					continue;
				}
				const [head, work] = await Promise.all([
					f.change.status === 'M' ? f.repo.getContentOrEmpty('HEAD', f.change.path, { filters: true }) : Promise.resolve(Buffer.alloc(0)),
					f.repo.readWorkingFile(f.change.path),
				]);
				if (!work || isBinary(work)) {
					continue;
				}
				const oldLines = splitLines(head?.toString('utf8') ?? '');
				const newLines = splitLines(work.toString('utf8'));
				for (const chunk of diffLines(oldLines, newLines)) {
					for (let i = chunk.newStart; i < chunk.newEnd; i++) {
						if (/\b(TODO|FIXME)\b/.test(newLines[i])) {
							todos.push(`${f.change.path}:${i + 1}`);
						}
					}
				}
			}
			if (todos.length) {
				const choice = await vscode.window.showWarningMessage(
					plural(todos.length, '{0} new TODO item found:', '{0} new TODO items found:') + `\n${todos.slice(0, 10).join('\n')}${todos.length > 10 ? '\n…' : ''}`,
					{ modal: true },
					vscode.l10n.t('Commit Anyway'),
				);
				if (choice !== vscode.l10n.t('Commit Anyway')) {
					return false;
				}
			}
		}
		return true;
	}

	/** Offers to delete changelists that became empty, like JetBrains does. */
	private async cleanupChangelists(): Promise<void> {
		const cl = services().changelists;
		if (!config('commit.offerDeleteEmptyChangelist', true)) {
			return;
		}
		const active = cl.active;
		if (active.id === 'default' || this.view.stagingMode) {
			return;
		}
		const stillUsed = services().repos.repositories.some((r) => r.state.changes.some((c) => cl.listOf(r.absolutePath(c.path)).id === active.id));
		if (!stillUsed) {
			const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Changelist \'{0}\' is empty. Delete it?', active.name), vscode.l10n.t('Delete'), vscode.l10n.t('Keep'));
			if (choice === vscode.l10n.t('Delete')) {
				cl.remove(active.id);
			}
		}
	}

	dispose(): void {
		this.subscription.dispose();
		this.onDidChangeEmitter.dispose();
	}
}

export function groupByRepo(files: FileNode[]): Map<Repository, FileNode[]> {
	const map = new Map<Repository, FileNode[]>();
	for (const f of files) {
		const arr = map.get(f.repo) ?? [];
		arr.push(f);
		map.set(f.repo, arr);
	}
	return map;
}

