import * as vscode from 'vscode';
import type { CommitController } from '../commit';
import { canGenerateMessage, commitDiff, generateCommitMessage } from '../generateMessage';
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

	constructor(private readonly extensionUri: vscode.Uri, private readonly controller: CommitController, private readonly changes: ChangesView) {
		this.disposables.push(
			controller.onDidChange((e) => this.push(e.message)),
			changes.onDidChangeModel(() => this.push(false)),
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
			const paths = this.changes.stagingMode ? undefined : this.changes.includedFiles().filter((f) => f.repo === repo).map((f) => f.change.path);
			const [diff, recent] = await Promise.all([commitDiff(repo, paths), repo.log({ limit: 10 }).catch(() => [])]);
			const text = await generateCommitMessage(diff, recent.map((c) => c.subject), (partial) => this.controller.setMessage(partial));
			if (text === undefined) {
				void vscode.window.showWarningMessage(vscode.l10n.t('No language model is available. Install and sign in to an extension that provides one, for example GitHub Copilot.'));
			} else {
				this.controller.setMessage(text);
			}
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

