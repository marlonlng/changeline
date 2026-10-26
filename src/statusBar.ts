import * as vscode from 'vscode';
import { services } from './services';
import { config, plural, shortHash } from './util';

export class StatusBar implements vscode.Disposable {
	private branch: vscode.StatusBarItem;
	private operation: vscode.StatusBarItem;
	private disposables: vscode.Disposable[] = [];
	private fetchTimer?: NodeJS.Timeout;

	constructor() {
		this.branch = vscode.window.createStatusBarItem('changeline.branch', vscode.StatusBarAlignment.Left, 1000);
		this.branch.name = vscode.l10n.t('Changeline Branch');
		this.branch.command = 'changeline.branches';
		this.operation = vscode.window.createStatusBarItem('changeline.operation', vscode.StatusBarAlignment.Left, 999);
		this.operation.name = vscode.l10n.t('Changeline Operation');
		this.operation.command = 'changeline.vcsOperations';
		this.operation.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		const s = services();
		this.disposables.push(
			this.branch,
			this.operation,
			s.repos.onDidChangeState(() => this.update()),
			s.repos.onDidChangeRepositories(() => this.update()),
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('changeline.statusBar') || e.affectsConfiguration('changeline.autoFetch')) {
					this.update();
					this.scheduleFetch();
				}
			}),
		);
		this.update();
		this.scheduleFetch();
	}

	private scheduleFetch(): void {
		if (this.fetchTimer) {
			clearInterval(this.fetchTimer);
			this.fetchTimer = undefined;
		}
		const minutes = config('autoFetch.interval', 0);
		if (minutes > 0) {
			this.fetchTimer = setInterval(() => {
				void import('./commands/remote').then((m) => m.fetchAll(services().repos.repositories, true));
			}, Math.max(1, minutes) * 60_000);
		}
	}

	private update(): void {
		if (!config('statusBar.showBranch', true)) {
			this.branch.hide();
			this.operation.hide();
			return;
		}
		const s = services();
		const repo = s.repos.current();
		if (!repo) {
			this.branch.text = vscode.l10n.t('$(git-branch) Git');
			this.branch.tooltip = vscode.l10n.t('No Git repository · click to create or clone');
			this.branch.command = 'changeline.vcsOperations';
			this.branch.show();
			this.operation.hide();
			return;
		}
		this.branch.command = 'changeline.branches';
		const st = repo.state;
		const name = st.branch ?? (st.head ? shortHash(st.head) : 'no commits');
		const all = s.repos.repositories;
		const synchronous = all.length > 1 && config('branches.syncControl', true) && all.every((r) => r.state.branch === st.branch);
		const prefix = all.length > 1 && !synchronous ? `${repo.name}: ` : '';
		let track = '';
		if (st.behind) {
			track += ` ↓${st.behind}`;
		}
		if (st.ahead) {
			track += ` ↑${st.ahead}`;
		}
		this.branch.text = `${st.detached && st.operation !== 'rebase' ? '$(git-commit)' : '$(git-branch)'} ${prefix}${name}${track}${synchronous ? ` (${all.length} repos)` : ''}`;
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${repo.name}**  \n`);
		tip.appendMarkdown((st.detached ? vscode.l10n.t('HEAD detached at `{0}`', shortHash(st.head ?? '')) : vscode.l10n.t('Branch `{0}`', name)) + '  \n');
		if (st.upstream) {
			tip.appendMarkdown(
				st.ahead || st.behind
					? vscode.l10n.t('Tracking `{0}` · {1} outgoing, {2} incoming', st.upstream, st.ahead, st.behind) + '  \n'
					: vscode.l10n.t('Tracking `{0}` · up to date', st.upstream) + '  \n',
			);
		} else if (st.branch) {
			tip.appendMarkdown(vscode.l10n.t('No tracked branch') + '  \n');
		}
		tip.appendMarkdown('\n' + vscode.l10n.t('Click to open the Git Branches popup'));
		this.branch.tooltip = tip;
		this.branch.show();
		if (st.operation !== 'none') {
			const label =
				st.operation === 'rebase'
					? st.rebase?.step
						? vscode.l10n.t('Rebasing {0}/{1}', st.rebase.step, st.rebase.total ?? '?')
						: vscode.l10n.t('Rebasing')
					: st.operation === 'merge'
						? vscode.l10n.t('Merging')
						: st.operation === 'cherry-pick'
							? vscode.l10n.t('Cherry-picking')
							: st.operation === 'revert'
								? vscode.l10n.t('Reverting')
								: st.operation;
			this.operation.text = `$(git-merge) ${label}${st.conflicts.length ? ' · ' + plural(st.conflicts.length, '{0} conflict', '{0} conflicts') : ''}`;
			this.operation.tooltip = vscode.l10n.t('Click for Continue / Abort / Resolve');
			this.operation.show();
		} else {
			this.operation.hide();
		}
	}

	dispose(): void {
		if (this.fetchTimer) {
			clearInterval(this.fetchTimer);
		}
		this.disposables.forEach((d) => d.dispose());
	}
}
