import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import type { StashEntry } from '../git/parsers';
import { services } from '../services';
import type { FileChange } from '../shared/types';
import { basename, dirname, plural, relativeDate } from '../util';
import { changeUri } from './decorations';

export type StashNode =
	| { type: 'repo'; repo: Repository }
	| { type: 'stash'; repo: Repository; stash: StashEntry }
	| { type: 'file'; repo: Repository; stash: StashEntry; file: FileChange };

export class StashView implements vscode.TreeDataProvider<StashNode>, vscode.Disposable {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	readonly treeView: vscode.TreeView<StashNode>;
	private disposables: vscode.Disposable[] = [];
	private cache = new Map<Repository, StashEntry[]>();

	constructor() {
		this.treeView = vscode.window.createTreeView('changeline.stash', { treeDataProvider: this, canSelectMany: false, showCollapseAll: true });
		const s = services();
		this.disposables.push(
			this.treeView,
			s.repos.onDidChangeRefs(() => this.refresh()),
			s.repos.onDidChangeRepositories(() => this.refresh()),
		);
		this.refresh();
	}

	refresh(): void {
		this.cache.clear();
		this.onDidChangeTreeDataEmitter.fire();
		void this.updateBadge();
	}

	private async updateBadge(): Promise<void> {
		let n = 0;
		for (const r of services().repos.repositories) {
			n += (await this.stashes(r)).length;
		}
		this.treeView.description = n ? plural(n, '{0} stash', '{0} stashes') : undefined;
	}

	private async stashes(repo: Repository): Promise<StashEntry[]> {
		let s = this.cache.get(repo);
		if (!s) {
			s = await repo.getStashes();
			this.cache.set(repo, s);
		}
		return s;
	}

	async getChildren(node?: StashNode): Promise<StashNode[]> {
		const repos = services().repos.repositories;
		if (!node) {
			if (repos.length > 1) {
				return repos.map((repo) => ({ type: 'repo', repo }));
			}
			if (repos.length === 1) {
				return (await this.stashes(repos[0])).map((stash) => ({ type: 'stash', repo: repos[0], stash }));
			}
			return [];
		}
		if (node.type === 'repo') {
			return (await this.stashes(node.repo)).map((stash) => ({ type: 'stash', repo: node.repo, stash }));
		}
		if (node.type === 'stash') {
			const files = await node.repo.getStashFiles(node.stash);
			return files.map((file) => ({ type: 'file', repo: node.repo, stash: node.stash, file }));
		}
		return [];
	}

	getTreeItem(node: StashNode): vscode.TreeItem {
		if (node.type === 'repo') {
			const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = new vscode.ThemeIcon('repo');
			item.contextValue = 'changeline:stashRepo';
			return item;
		}
		if (node.type === 'stash') {
			const item = new vscode.TreeItem(node.stash.message || node.stash.ref, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = `stash:${node.repo.root}:${node.stash.hash}`;
			item.iconPath = new vscode.ThemeIcon('archive');
			item.description = `${node.stash.ref}${node.stash.branch ? ` · ${node.stash.branch}` : ''} · ${relativeDate(new Date(node.stash.date * 1000))}`;
			item.tooltip = `${node.stash.ref}: ${node.stash.message}\nOn ${node.stash.branch ?? '?'}\n${new Date(node.stash.date * 1000).toLocaleString()}`;
			item.contextValue = 'changeline:stash';
			return item;
		}
		const item = new vscode.TreeItem(basename(node.file.path), vscode.TreeItemCollapsibleState.None);
		item.resourceUri = changeUri(node.repo.absolutePath(node.file.path), node.file.status);
		item.iconPath = vscode.ThemeIcon.File;
		item.description = dirname(node.file.path);
		item.contextValue = 'changeline:stashFile';
		item.command = { command: 'changeline.stash.showDiff', title: vscode.l10n.t('Show Diff'), arguments: [node] };
		return item;
	}

	selected(node?: StashNode): StashNode | undefined {
		return node ?? this.treeView.selection[0];
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.onDidChangeTreeDataEmitter.dispose();
	}
}
