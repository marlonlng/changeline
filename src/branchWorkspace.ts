import * as vscode from 'vscode';
import type { Repository } from './git/repository';
import { services } from './services';
import { config, samePath } from './util';

interface SavedTab {
	uri: string;
	column: number;
	active: boolean;
}

/**
 * JetBrains' "Restore workspace on branch switching": the editors open on a branch are remembered when another
 * branch is checked out, closed, and opened again when the branch comes back.
 */
export class BranchWorkspace implements vscode.Disposable {
	private readonly branches = new Map<string, string | undefined>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly memento: vscode.Memento) {
		const s = services();
		for (const repo of s.repos.repositories) {
			this.branches.set(repo.root, repo.state.branch);
		}
		this.disposables.push(s.repos.onDidChangeState((repo) => void this.stateChanged(repo)));
	}

	private key(repo: Repository, branch: string): string {
		return `changeline.branchWorkspace:${repo.root}:${branch}`;
	}

	private async stateChanged(repo: Repository): Promise<void> {
		const known = this.branches.has(repo.root);
		const before = this.branches.get(repo.root);
		const after = repo.state.branch;
		this.branches.set(repo.root, after);
		if (!known || before === after || !before || !after || !config('branches.restoreWorkspace', false)) {
			return;
		}
		await this.switch(repo, before, after);
	}

	/** Saves the editors of `from`, closes them and opens the editors saved for `to`, if any. */
	async switch(repo: Repository, from: string, to: string): Promise<void> {
		const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((tab) => ({ tab, group: g }))).filter(({ tab }) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file' && repo.contains(tab.input.uri.fsPath));
		const saved: SavedTab[] = tabs.map(({ tab, group }) => ({ uri: (tab.input as vscode.TabInputText).uri.toString(), column: group.viewColumn, active: tab.isActive && group.isActive }));
		await this.memento.update(this.key(repo, from), saved);
		const restore = this.memento.get<SavedTab[]>(this.key(repo, to));
		if (!restore) {
			return;
		}
		const keep = new Set(restore.map((t) => t.uri));
		await vscode.window.tabGroups.close(tabs.filter(({ tab }) => !tab.isDirty && !keep.has((tab.input as vscode.TabInputText).uri.toString())).map(({ tab }) => tab));
		const open = (t: SavedTab, preserveFocus: boolean) =>
			vscode.window.showTextDocument(vscode.Uri.parse(t.uri), { viewColumn: t.column, preview: false, preserveFocus }).then(undefined, () => undefined);
		for (const t of restore.filter((x) => !x.active)) {
			if (!tabs.some(({ tab }) => samePath((tab.input as vscode.TabInputText).uri.fsPath, vscode.Uri.parse(t.uri).fsPath))) {
				await open(t, true);
			}
		}
		const active = restore.find((t) => t.active);
		if (active) {
			await open(active, false);
		}
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}
}
