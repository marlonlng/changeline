import * as vscode from 'vscode';
import { services } from '../services';
import type { ShelvedFile, ShelvedList } from '../shelf';
import { basename, dirname, plural, relativeDate } from '../util';
import { changeUri } from './decorations';

export type ShelfNode =
	| { type: 'list'; list: ShelvedList }
	| { type: 'file'; list: ShelvedList; repoIndex: number; file: ShelvedFile }
	| { type: 'deleted'; lists: ShelvedList[] };

export class ShelfView implements vscode.TreeDataProvider<ShelfNode>, vscode.Disposable {
	private lists: ShelvedList[] = [];
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	readonly treeView: vscode.TreeView<ShelfNode>;
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.treeView = vscode.window.createTreeView('changeline.shelf', { treeDataProvider: this, canSelectMany: true, showCollapseAll: true });
		this.disposables.push(this.treeView, services().shelf.onDidChange(() => void this.refresh()));
		void this.refresh();
	}

	async refresh(): Promise<void> {
		this.lists = await services().shelf.list();
		const active = this.lists.filter((l) => !l.deleted).length;
		this.treeView.description = active ? plural(active, '{0} changelist', '{0} changelists') : undefined;
		this.onDidChangeTreeDataEmitter.fire();
	}

	getChildren(node?: ShelfNode): ShelfNode[] {
		if (!node) {
			const result: ShelfNode[] = this.lists.filter((l) => !l.deleted).map((list) => ({ type: 'list', list }));
			const deleted = this.lists.filter((l) => l.deleted);
			if (deleted.length) {
				result.push({ type: 'deleted', lists: deleted });
			}
			return result;
		}
		if (node.type === 'deleted') {
			return node.lists.map((list) => ({ type: 'list', list }));
		}
		if (node.type === 'list') {
			return node.list.repos.flatMap((r, repoIndex) => r.files.map((file) => ({ type: 'file' as const, list: node.list, repoIndex, file })));
		}
		return [];
	}

	getTreeItem(node: ShelfNode): vscode.TreeItem {
		if (node.type === 'deleted') {
			const item = new vscode.TreeItem(vscode.l10n.t('Recently Deleted'), vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('trash');
			item.contextValue = 'changeline:shelfDeleted';
			item.description = plural(node.lists.length, '{0} list', '{0} lists');
			return item;
		}
		if (node.type === 'list') {
			const count = node.list.repos.reduce((n, r) => n + r.files.length, 0);
			const item = new vscode.TreeItem(node.list.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = `shelf:${node.list.id}`;
			item.iconPath = new vscode.ThemeIcon(node.list.deleted ? 'archive' : 'inbox');
			item.description = `${plural(count, '{0} file', '{0} files')} · ${relativeDate(new Date(node.list.date))}`;
			item.tooltip = vscode.l10n.t('{0}\nShelved {1}\n{2}', node.list.name, new Date(node.list.date).toLocaleString(), node.list.repos.map((r) => r.repoName).join(', '));
			item.contextValue = node.list.deleted ? 'changeline:shelfList;deleted' : 'changeline:shelfList';
			return item;
		}
		const repo = node.list.repos[node.repoIndex];
		const item = new vscode.TreeItem(basename(node.file.path), vscode.TreeItemCollapsibleState.None);
		item.id = `shelf:${node.list.id}:${node.repoIndex}:${node.file.path}`;
		item.resourceUri = changeUri(`${repo.repoRoot}/${node.file.path}`, node.file.status);
		item.iconPath = vscode.ThemeIcon.File;
		item.description = dirname(node.file.path);
		item.contextValue = node.list.deleted ? 'changeline:shelfFile;deleted' : 'changeline:shelfFile';
		item.command = { command: 'changeline.shelf.showDiff', title: vscode.l10n.t('Show Diff'), arguments: [node] };
		return item;
	}

	selected(node?: ShelfNode, nodes?: readonly ShelfNode[]): ShelfNode[] {
		return nodes && nodes.length ? [...nodes] : node ? [node] : [...this.treeView.selection];
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.onDidChangeTreeDataEmitter.dispose();
	}
}
