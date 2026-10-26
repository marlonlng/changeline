import * as vscode from 'vscode';
import { literalPath, Repository } from '../git/repository';
import { services } from '../services';
import type { ConflictInfo } from '../shared/types';
import { showError } from '../util';
import { RpcHandlers, WebviewPanelBase } from './host';
import { conflictTitles, openGitConflictMerge } from './mergePanel';

export async function acceptSide(repo: Repository, conflicts: ConflictInfo[], side: 'ours' | 'theirs'): Promise<void> {
	const remove: string[] = [];
	const take: string[] = [];
	for (const c of conflicts) {
		if ((side === 'ours' ? c.ours : c.theirs) === 'deleted') {
			remove.push(c.path);
		} else {
			take.push(c.path);
		}
	}
	if (take.length) {
		await repo.runOp(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', ...take.map(literalPath)]);
		await repo.add(take);
	}
	if (remove.length) {
		await repo.rm(remove);
	}
}

/** What to do once all conflicts of an operation are resolved. */
export async function offerContinue(repo: Repository): Promise<void> {
	const op = repo.state.operation;
	if (op === 'none') {
		return;
	}
	if (op === 'merge') {
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t('All conflicts are resolved. Commit the merge?'), vscode.l10n.t('Commit...'));
		if (choice) {
			const msg = await repo.readGitFile('MERGE_MSG');
			await vscode.commands.executeCommand('changeline.commit', { message: msg?.replace(/^#.*$/gm, '').trim() });
		}
		return;
	}
	const label = op === 'rebase' ? vscode.l10n.t('Continue Rebase') : op === 'cherry-pick' ? vscode.l10n.t('Continue Cherry-Pick') : op === 'revert' ? vscode.l10n.t('Continue Revert') : vscode.l10n.t('Continue');
	const choice = await vscode.window.showInformationMessage(vscode.l10n.t('All conflicts are resolved.'), label);
	if (choice) {
		await vscode.commands.executeCommand('changeline.continueOperation', repo);
	}
}

export class ConflictsPanel extends WebviewPanelBase {
	private static current?: ConflictsPanel;
	private hadConflicts = new Set<string>();

	static show(): void {
		if (ConflictsPanel.current && !ConflictsPanel.current.isDisposed) {
			ConflictsPanel.current.panel.reveal();
			void ConflictsPanel.current.push();
			return;
		}
		ConflictsPanel.current = new ConflictsPanel();
	}

	private constructor() {
		super(services().context.extensionUri, 'changeline.conflicts', vscode.l10n.t('Conflicts'), 'conflicts', null, vscode.ViewColumn.Active);
		this.disposables.push(services().repos.onDidChangeState(() => void this.push()));
	}

	private repos(): Repository[] {
		return services().repos.repositories.filter((r) => r.state.conflicts.length || this.hadConflicts.has(r.root));
	}

	private async data() {
		const groups = [];
		for (const repo of services().repos.repositories) {
			if (!repo.state.conflicts.length && !this.hadConflicts.has(repo.root)) {
				continue;
			}
			if (repo.state.conflicts.length) {
				this.hadConflicts.add(repo.root);
			}
			const titles = await conflictTitles(repo);
			groups.push({ root: repo.root, name: repo.name, title: titles.title, left: titles.left, right: titles.right, files: repo.state.conflicts, operation: repo.state.operation });
		}
		return { groups, multiple: services().repos.repositories.length > 1 };
	}

	private async push(): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		const data = await this.data();
		this.rpc.emit('data', data);
		const total = data.groups.reduce((n, g) => n + g.files.length, 0);
		if (total === 0 && this.hadConflicts.size) {
			const repos = this.repos();
			this.hadConflicts.clear();
			this.dispose();
			for (const r of repos) {
				await offerContinue(r);
			}
		}
	}

	private repo(root: string): Repository {
		const r = services().repos.getByRoot(root);
		if (!r) {
			throw new Error(vscode.l10n.t('Repository not found'));
		}
		return r;
	}

	protected handlers(): RpcHandlers {
		const pick = (root: string, paths: string[]) => this.repo(root).state.conflicts.filter((c) => paths.includes(c.path));
		return {
			ready: () => this.data(),
			acceptYours: async (p: { root: string; paths: string[] }) => {
				try {
					await acceptSide(this.repo(p.root), pick(p.root, p.paths), 'ours');
				} catch (e) {
					await showError(e);
				}
			},
			acceptTheirs: async (p: { root: string; paths: string[] }) => {
				try {
					await acceptSide(this.repo(p.root), pick(p.root, p.paths), 'theirs');
				} catch (e) {
					await showError(e);
				}
			},
			merge: async (p: { root: string; path: string }) => {
				const repo = this.repo(p.root);
				const c = repo.state.conflicts.find((x) => x.path === p.path);
				if (!c) {
					return;
				}
				if (c.ours === 'deleted' || c.theirs === 'deleted') {
					void vscode.window.showInformationMessage(vscode.l10n.t('{0} was deleted on one side. Use "Accept Yours" or "Accept Theirs".', p.path));
					return;
				}
				await openGitConflictMerge(repo, c);
			},
			open: async (p: { root: string; path: string }) => {
				await vscode.window.showTextDocument(vscode.Uri.file(this.repo(p.root).absolutePath(p.path)));
			},
			abort: async (p: { root: string }) => {
				const repo = this.repo(p.root);
				const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Abort {0} in {1}? Local changes from the operation are lost.', repo.state.operation, repo.name), { modal: true }, vscode.l10n.t('Abort'));
				if (choice) {
					await repo.abortOperation();
					this.hadConflicts.delete(repo.root);
				}
			},
			close: () => this.dispose(),
		};
	}

	override dispose(): void {
		if (ConflictsPanel.current === this) {
			ConflictsPanel.current = undefined;
		}
		super.dispose();
	}
}
