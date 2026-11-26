import * as vscode from 'vscode';
import type { CommitController } from '../commit';
import { canGenerateMessage, commitDiff, generateCommitMessage, pickModel } from '../generateMessage';
import { forgetIssueRules, issueRules } from '../issueLinks';
import { services } from '../services';
import type { IssueRule } from '../shared/issueLinks';
import { capitalize, config } from '../util';
import { DialogOverlay, withDialogOrigin } from '../webviews/dialogOverlay';
import { RpcChannel, RpcHandlers, renderWebviewHtml, webviewOptions } from '../webviews/host';
import type { ChangesView } from './changesView';

export class CommitMessageView implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'changeline.commitMessage';
	private view?: vscode.WebviewView;
	private rpc?: RpcChannel;
	private disposables: vscode.Disposable[] = [];
	readonly dialogs = new DialogOverlay((name, data) => this.rpc?.emit(name, data), { visible: () => this.view?.visible === true, reveal: () => this.view?.show(false) });
	private rules: IssueRule[] = [];
	private canGenerate = false;
	private generating = false;
	private symbolTimer?: NodeJS.Timeout;
	private readonly fileSymbols = new Map<string, { name: string; kind: vscode.SymbolKind }[]>();

	constructor(private readonly extensionUri: vscode.Uri, private readonly controller: CommitController, private readonly changes: ChangesView) {
		this.disposables.push(
			controller.onDidChange((e) => this.push(e.message)),
			changes.onDidChangeModel(() => {
				this.push(false);
				this.scheduleSymbols();
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('changeline.issueNavigation') || e.affectsConfiguration('changeline.github') || e.affectsConfiguration('changeline.gitlab')) {
					forgetIssueRules();
					void this.loadRules();
				}
				if (e.affectsConfiguration('changeline.commit')) {
					this.push(false);
				}
			}),
			services().repos.onDidChangeRepositories(() => void this.loadRules()),
			vscode.lm.onDidChangeChatModels(() => void this.checkModels()),
		);
		void this.loadRules();
		void this.checkModels();
	}

	private async loadRules(): Promise<void> {
		this.rules = await issueRules(this.controller.targetRepositories()[0] ?? services().repos.current());
		this.push(false);
	}

	private async checkModels(): Promise<void> {
		this.canGenerate = await canGenerateMessage();
		this.push(false);
	}

	/** Loads the symbols of the changed files in the background, so completion has them before the language servers answer the first time. */
	private scheduleSymbols(): void {
		if (this.symbolTimer) {
			clearTimeout(this.symbolTimer);
		}
		this.symbolTimer = setTimeout(() => void this.loadFileSymbols(), 1000);
	}

	private async loadFileSymbols(): Promise<void> {
		const files = this.changes.allFiles().filter((f) => f.change.status !== 'D').slice(0, 30);
		const keep = new Set(files.map((f) => f.abs));
		for (const abs of [...this.fileSymbols.keys()]) {
			if (!keep.has(abs)) {
				this.fileSymbols.delete(abs);
			}
		}
		await Promise.all(
			files.map(async (f) => {
				const list: { name: string; kind: vscode.SymbolKind }[] = [];
				const walk = (symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined) => {
					for (const s of symbols ?? []) {
						list.push({ name: s.name, kind: s.kind });
						if ('children' in s) {
							walk(s.children);
						}
					}
				};
				walk(await Promise.resolve(vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', vscode.Uri.file(f.abs))).catch(() => undefined));
				if (list.length || !this.fileSymbols.has(f.abs)) {
					this.fileSymbols.set(f.abs, list);
				}
			}),
		);
	}

	/** Class, function and method names for completing the commit message, like JetBrains completes class names: workspace symbols plus the symbols of the changed files. */
	async symbols(word: string): Promise<string[]> {
		const kinds = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Struct, vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Module, vscode.SymbolKind.Namespace]);
		const prefix = word.toLowerCase();
		const names = new Set<string>();
		const add = (name: string, kind: vscode.SymbolKind) => {
			const n = name.replace(/\(.*$/, '').trim();
			if (kinds.has(kind) && n.toLowerCase().startsWith(prefix) && n.length > word.length) {
				names.add(n);
			}
		};
		const workspace = word.length >= 2 ? await Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', word)).catch(() => undefined) : undefined;
		for (const s of workspace ?? []) {
			add(s.name, s.kind);
		}
		if (![...this.fileSymbols.values()].some((l) => l.length)) {
			await this.loadFileSymbols();
		}
		for (const list of this.fileSymbols.values()) {
			for (const s of list) {
				add(s.name, s.kind);
			}
		}
		this.scheduleSymbols();
		return [...names].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 20);
	}

	/** Generates a message for the changes about to be committed and streams it into the message field. */
	async generate(): Promise<void> {
		const repo = this.controller.targetRepositories()[0];
		if (!repo || this.generating) {
			if (!repo) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Select the changes to commit first.'));
			}
			return;
		}
		this.generating = true;
		this.push(false);
		try {
			const model = await pickModel();
			if (!model) {
				void vscode.window.showWarningMessage(vscode.l10n.t('No language model is available. Install and sign in to an extension that provides one, for example GitHub Copilot.'));
				return;
			}
			const paths = this.changes.stagingMode ? undefined : this.changes.includedFiles().filter((f) => f.repo === repo).map((f) => f.change.path);
			const [diff, recent] = await Promise.all([commitDiff(repo, paths), repo.log({ limit: 10 }).catch(() => [])]);
			this.controller.setMessage(await generateCommitMessage(model, diff, recent.map((c) => c.subject), (partial) => this.controller.setMessage(partial)));
		} finally {
			this.generating = false;
			this.push(false);
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = webviewOptions(this.extensionUri);
		this.rpc?.dispose();
		this.dialogs.reset();
		this.rpc = new RpcChannel(view.webview, { ...this.dialogs.handlers(), ...this.handlers() }, (fn) => withDialogOrigin(this.dialogs, fn));
		view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'commitMessage', { title: vscode.l10n.t('Commit') });
		view.onDidDispose(() => {
			this.dialogs.reset();
			this.rpc?.dispose();
			this.rpc = undefined;
			this.view = undefined;
		}, null, this.disposables);
	}

	private handlers(): RpcHandlers {
		return {
			ready: () => this.state(true),
			setMessage: (p: { message: string }) => this.controller.setMessage(p.message, true),
			setAmend: (p: { amend: boolean }) => this.controller.setAmend(p.amend),
			setOptions: (p: Record<string, unknown>) => this.controller.setOptions(p),
			commit: (p: { message: string; amend: boolean; push: boolean }) =>
				this.controller.commit({ message: p.message, amend: p.amend, push: p.push, options: this.controller.options }),
			history: () => this.controller.showMessageHistory(),
			rollback: () => vscode.commands.executeCommand('changeline.changes.rollback'),
			showDiff: () => vscode.commands.executeCommand('changeline.changes.showDiff'),
			resolve: () => vscode.commands.executeCommand('changeline.resolveConflicts'),
			abort: () => vscode.commands.executeCommand('changeline.abortOperation'),
			continue: () => vscode.commands.executeCommand('changeline.continueOperation'),
			openUrl: (p: { url: string }) => {
				if (/^https?:\/\//i.test(p.url)) {
					void vscode.env.openExternal(vscode.Uri.parse(p.url));
				}
			},
			generate: () => this.generate(),
			symbols: (p: { word: string }) => this.symbols(p.word),
		};
	}

	private state(includeMessage: boolean) {
		const s = services();
		const summary = this.controller.summary();
		const repos = s.repos.repositories;
		const repo = this.controller.targetRepositories()[0] ?? s.repos.current();
		const st = repo?.state;
		let operation: string | undefined;
		if (st && st.operation !== 'none') {
			operation =
				st.operation === 'rebase' && st.rebase?.step
					? vscode.l10n.t('Rebasing {0} ({1}/{2})', st.branch ?? '', st.rebase.step, st.rebase.total ?? '?')
					: vscode.l10n.t('{0} in progress', capitalize(st.operation));
		}
		return {
			message: includeMessage ? this.controller.message : undefined,
			amend: this.controller.amend,
			options: this.controller.options,
			summary: summary.text,
			count: summary.count,
			staging: this.changes.stagingMode,
			busy: this.controller.busy,
			hasRepository: repos.length > 0,
			branch: st?.branch,
			operation,
			conflicts: repos.reduce((n, r) => n + r.state.conflicts.length, 0),
			subjectLimit: config('commit.subjectLengthLimit', 72),
			bodyLimit: config('commit.bodyLineLengthLimit', 72),
			showInspections: config('commit.messageInspections', true),
			wrapMargin: config('commit.wrapWhenTypingReachesRightMargin', false) ? config('commit.bodyLineLengthLimit', 72) : 0,
			completions: [...new Set(this.changes.allFiles().flatMap((f) => [f.change.path, f.change.path.slice(f.change.path.lastIndexOf('/') + 1)]))],
			issueRules: this.rules,
			canGenerate: this.canGenerate,
			generating: this.generating,
		};
	}

	private push(includeMessage = false): void {
		this.rpc?.emit('state', this.state(!!includeMessage));
	}

	focus(): void {
		this.view?.show(false);
		this.rpc?.emit('focus');
	}

	dispose(): void {
		this.rpc?.dispose();
		this.disposables.forEach((d) => d.dispose());
	}
}

