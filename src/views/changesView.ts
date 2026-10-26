import * as path from 'path';
import * as vscode from 'vscode';
import type { Changelist } from '../changelists';
import type { Repository } from '../git/repository';
import { services } from '../services';
import type { FileChange } from '../shared/types';
import { basename, config, dirname, plural, statusLabel } from '../util';
import { workingChunks } from '../chunks';
import { changeUri } from './decorations';

export type ChangeGroup = 'changelist' | 'unversioned' | 'conflicts' | 'staged' | 'unstaged' | 'ignored';

interface BaseNode {
	id: string;
	group: ChangeGroup;
	listId?: string;
	parent?: ContainerNode;
}

export interface FileNode extends BaseNode {
	type: 'file';
	repo: Repository;
	change: FileChange;
	abs: string;
}

export interface DirNode extends BaseNode {
	type: 'dir';
	label: string;
	abs: string;
	children: ChangeNode[];
}

export interface RepoNode extends BaseNode {
	type: 'repo';
	repo: Repository;
	children: ChangeNode[];
}

export interface GroupNode extends BaseNode {
	type: 'group';
	label: string;
	list?: Changelist;
	children: ChangeNode[];
	files: FileNode[];
}

export type ContainerNode = DirNode | RepoNode | GroupNode;
export type ChangeNode = FileNode | ContainerNode;

const MIME = 'application/vnd.code.tree.changeline.changes';

export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.TreeDragAndDropController<ChangeNode>, vscode.Disposable {
	readonly dragMimeTypes = [MIME, 'text/uri-list'];
	readonly dropMimeTypes = [MIME];

	private roots: GroupNode[] = [];
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ChangeNode | undefined | void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly onDidChangeModelEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeModel = this.onDidChangeModelEmitter.event;
	readonly treeView: vscode.TreeView<ChangeNode>;
	private disposables: vscode.Disposable[] = [];
	private rebuildTimer?: NodeJS.Timeout;

	constructor() {
		const s = services();
		this.treeView = vscode.window.createTreeView('changeline.changes', {
			treeDataProvider: this,
			canSelectMany: true,
			showCollapseAll: true,
			dragAndDropController: this,
			manageCheckboxStateManually: true,
		});
		this.disposables.push(
			this.treeView,
			this.treeView.onDidChangeCheckboxState((e) => this.onCheckbox(e)),
			s.repos.onDidChangeState(() => {
				this.scheduleRebuild();
				void this.refreshChunkKeys();
			}),
			s.repos.onDidChangeRepositories(() => this.scheduleRebuild()),
			s.changelists.onDidChange(() => {
				this.scheduleRebuild();
				void this.refreshChunkKeys();
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('changeline.changes') || e.affectsConfiguration('changeline.commit.useStagingArea')) {
					this.scheduleRebuild();
				}
			}),
		);
		this.rebuild();
	}

	get stagingMode(): boolean {
		return config('commit.useStagingArea', false);
	}

	get groups(): readonly GroupNode[] {
		return this.roots;
	}

	private scheduleRebuild(): void {
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer);
		}
		this.rebuildTimer = setTimeout(() => this.rebuild(), 50);
	}

	rebuild(): void {
		const s = services();
		const repos = s.repos.repositories;
		const staging = this.stagingMode;
		const groupByDir = config<string>('changes.groupBy', 'none') === 'directory';
		const groupByRepo = repos.length > 1 && config('changes.groupByRepository', true);
		const cl = s.changelists;

		const tracked: string[] = [];
		const unversioned: string[] = [];
		for (const r of repos) {
			for (const c of r.state.changes) {
				tracked.push(r.absolutePath(c.path));
			}
			for (const c of r.state.conflicts) {
				tracked.push(r.absolutePath(c.path));
			}
			for (const c of r.state.untracked) {
				unversioned.push(r.absolutePath(c.path));
			}
		}
		cl.sync(tracked, unversioned);

		const roots: GroupNode[] = [];
		const makeGroup = (id: string, group: ChangeGroup, label: string, files: { repo: Repository; change: FileChange }[], list?: Changelist): GroupNode => {
			const node: GroupNode = { type: 'group', id, group, label, list, listId: list?.id, children: [], files: [] };
			node.files = files.map(({ repo, change }) => ({
				type: 'file',
				id: `${id}|${repo.absolutePath(change.path)}`,
				group,
				listId: list?.id,
				repo,
				change,
				abs: repo.absolutePath(change.path),
			}));
			node.children = arrange(node, node.files, groupByRepo, groupByDir);
			return node;
		};

		const conflicts = repos.flatMap((repo) => repo.state.conflicts.map((change) => ({ repo, change: change as FileChange })));
		if (conflicts.length) {
			roots.push(makeGroup('conflicts', 'conflicts', vscode.l10n.t('Merge Conflicts'), conflicts));
		}
		if (staging) {
			roots.push(makeGroup('staged', 'staged', vscode.l10n.t('Staged'), repos.flatMap((repo) => repo.state.staged.map((change) => ({ repo, change })))));
			roots.push(makeGroup('unstaged', 'unstaged', vscode.l10n.t('Changes'), repos.flatMap((repo) => repo.state.unstaged.map((change) => ({ repo, change })))));
		} else {
			const byList = new Map<string, { repo: Repository; change: FileChange }[]>();
			const add = (listId: string, entry: { repo: Repository; change: FileChange }) => {
				let arr = byList.get(listId);
				if (!arr) {
					arr = [];
					byList.set(listId, arr);
				}
				arr.push(entry);
			};
			for (const repo of repos) {
				for (const change of repo.state.changes) {
					const abs = repo.absolutePath(change.path);
					if (!cl.hasPartialLists(abs)) {
						add(cl.listOf(abs).id, { repo, change });
						continue;
					}
					const keys = this.chunkKeys.get(abs);
					const lists = keys ? new Set(keys.map((k) => cl.chunkListOf(abs, k))) : new Set([cl.listOf(abs).id, ...cl.partLists(abs)]);
					for (const id of lists) {
						add(id, { repo, change });
					}
				}
			}
			const lists = [...cl.all].sort((a, b) => (a.id === cl.active.id ? -1 : b.id === cl.active.id ? 1 : 0));
			for (const list of lists) {
				roots.push(makeGroup(`cl:${list.id}`, 'changelist', list.name, byList.get(list.id) ?? [], list));
			}
		}
		const untracked = repos.flatMap((repo) => repo.state.untracked.map((change) => ({ repo, change })));
		if (untracked.length) {
			roots.push(makeGroup('unversioned', 'unversioned', vscode.l10n.t('Unversioned Files'), untracked));
		}
		if (config('changes.showIgnored', false)) {
			const ignored = repos.flatMap((repo) => repo.state.ignored.map((change) => ({ repo, change })));
			if (ignored.length) {
				roots.push(makeGroup('ignored', 'ignored', vscode.l10n.t('Ignored Files'), ignored));
			}
		}
		this.roots = roots;
		const changed = new Set(roots.filter((g) => g.group !== 'ignored' && g.group !== 'unversioned').flatMap((g) => g.files.map((f) => f.abs))).size;
		const total = changed + untracked.length;
		this.treeView.badge = total
			? { value: total, tooltip: untracked.length ? vscode.l10n.t(changed === 1 ? '{0} changed file, {1} unversioned' : '{0} changed files, {1} unversioned', changed, untracked.length) : plural(changed, '{0} changed file', '{0} changed files') }
			: undefined;
		const branchInfo = repos.length === 1 ? repos[0].state.branch ?? (repos[0].state.head ? `detached at ${repos[0].state.head.slice(0, 8)}` : undefined) : undefined;
		this.treeView.description = branchInfo;
		void vscode.commands.executeCommand('setContext', 'changeline.stagingArea', staging);
		void vscode.commands.executeCommand('setContext', 'changeline.hasConflicts', conflicts.length > 0);
		this.onDidChangeTreeDataEmitter.fire();
		this.onDidChangeModelEmitter.fire();
	}


	getChildren(element?: ChangeNode): ChangeNode[] {
		if (!element) {
			return this.roots;
		}
		return element.type === 'file' ? [] : element.children;
	}

	getParent(element: ChangeNode): ChangeNode | undefined {
		return element.parent;
	}

	getTreeItem(node: ChangeNode): vscode.TreeItem {
		const s = services();
		const checkboxes = !this.stagingMode && (node.group === 'changelist' || node.group === 'unversioned');
		const stateOf = (included: boolean) => (included ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked);
		if (node.type === 'file') {
			const c = node.change;
			const item = new vscode.TreeItem(basename(c.path), vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.resourceUri = changeUri(node.abs, c.status);
			item.iconPath = vscode.ThemeIcon.File;
			const parentIsDir = node.parent?.type === 'dir';
			const parts: string[] = [];
			if (!parentIsDir) {
				const dir = dirname(c.path);
				if (dir) {
					parts.push(dir);
				}
			}
			if (c.origPath) {
				parts.push(dirname(c.origPath) === dirname(c.path) ? vscode.l10n.t('renamed from {0}', basename(c.origPath)) : vscode.l10n.t('moved from {0}', c.origPath));
			}
			const partial = checkboxes && s.changelists.isPartiallyIncluded(node.abs);
			if (node.group === 'changelist' && s.changelists.hasPartialLists(node.abs)) {
				parts.push('· ' + vscode.l10n.t('split across changelists'));
			} else if (partial) {
				parts.push('· ' + vscode.l10n.t('partially included'));
			}
			item.description = parts.join('  ');
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown(`**${statusLabel(c.status)}**  \n`);
			tooltip.appendText(node.abs);
			if (c.origPath) {
				tooltip.appendMarkdown('  \n');
				tooltip.appendText(`from ${c.origPath}`);
			}
			item.tooltip = tooltip;
			item.contextValue = `changeline:file;group=${node.group};status=${c.status}${s.repos.repositories.length > 1 ? ';multi' : ''}`;
			if (checkboxes) {
				item.checkboxState = stateOf(node.group === 'changelist' ? s.changelists.isPartIncluded(node.abs, node.listId) : s.changelists.isIncluded(node.abs));
			}
			item.command = { command: 'changeline.changes.open', title: vscode.l10n.t('Show Diff'), arguments: [node] };
			return item;
		}
		const files = collectFiles([node]);
		const count = files.length;
		let item: vscode.TreeItem;
		if (node.type === 'group') {
			const isActive = node.list && node.list.id === s.changelists.active.id;
			item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			const files = count ? plural(count, '{0} file', '{0} files') : 'no files';
			item.description = isActive && s.changelists.all.length > 1 ? `${files} · active` : files;
			if (node.list?.comment) {
				item.tooltip = node.list.comment;
			}
			if (node.group === 'conflicts') {
				item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('changeline.conflictForeground'));
				item.description = vscode.l10n.t('{0} · Resolve...', plural(count, '{0} file', '{0} files'));
				item.command = { command: 'changeline.resolveConflicts', title: vscode.l10n.t('Resolve Conflicts') };
			}
			item.contextValue = node.group === 'changelist'
				? `changeline:changelist${isActive ? ';active' : ''}${s.changelists.all.length > 1 ? ';removable' : ''}`
				: `changeline:group;group=${node.group}`;
		} else if (node.type === 'repo') {
			item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = new vscode.ThemeIcon('repo');
			item.description = `${node.repo.state.branch ?? 'detached'} · ${plural(count, '{0} file', '{0} files')}`;
			item.contextValue = `changeline:dir;group=${node.group}`;
		} else {
			item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = vscode.ThemeIcon.Folder;
			item.resourceUri = vscode.Uri.file(node.abs).with({ scheme: 'changeline-change', query: 'dir=1' });
			item.description = plural(count, '{0} file', '{0} files');
			item.contextValue = `changeline:dir;group=${node.group}`;
		}
		item.id = node.id;
		if (checkboxes && count > 0) {
			item.checkboxState = stateOf(files.every((f) => (f.group === 'changelist' ? s.changelists.isPartIncluded(f.abs, f.listId) : s.changelists.isIncluded(f.abs))));
		}
		return item;
	}

	private onCheckbox(e: vscode.TreeCheckboxChangeEvent<ChangeNode>): void {
		const cl = services().changelists;
		for (const [node, state] of e.items) {
			const include = state === vscode.TreeItemCheckboxState.Checked;
			const files = collectFiles([node]);
			const split = files.filter((f) => f.group === 'changelist' && cl.hasPartialLists(f.abs));
			cl.setIncluded(files.filter((f) => !split.includes(f)).map((f) => f.abs), include);
			for (const f of split) {
				cl.setPartIncluded(f.abs, f.listId, include);
			}
		}
	}

	private chunkKeys = new Map<string, string[]>();

	private async refreshChunkKeys(): Promise<void> {
		const s = services();
		let changed = false;
		const seen = new Set<string>();
		for (const repo of s.repos.repositories) {
			for (const c of repo.state.changes) {
				const abs = repo.absolutePath(c.path);
				if (!s.changelists.hasPartialLists(abs)) {
					continue;
				}
				seen.add(abs);
				const chunks = await workingChunks(repo, c.path);
				const keys = chunks?.keys ?? [];
				if (JSON.stringify(keys) !== JSON.stringify(this.chunkKeys.get(abs))) {
					this.chunkKeys.set(abs, keys);
					changed = true;
				}
				s.changelists.pruneChunkLists(abs, keys);
			}
		}
		for (const abs of [...this.chunkKeys.keys()]) {
			if (!seen.has(abs)) {
				this.chunkKeys.delete(abs);
				changed = true;
			}
		}
		if (changed) {
			this.scheduleRebuild();
		}
	}


	handleDrag(source: readonly ChangeNode[], data: vscode.DataTransfer): void {
		const files = collectFiles(source);
		data.set(MIME, new vscode.DataTransferItem(files.map((f) => f.id)));
		data.set('text/uri-list', new vscode.DataTransferItem(files.map((f) => vscode.Uri.file(f.abs).toString()).join('\r\n')));
	}

	async handleDrop(target: ChangeNode | undefined, data: vscode.DataTransfer): Promise<void> {
		const item = data.get(MIME);
		if (!item || !target) {
			return;
		}
		const ids = new Set(item.value as string[]);
		const files = this.allFiles().filter((f) => ids.has(f.id));
		if (!files.length) {
			return;
		}
		const s = services();
		if (target.listId && target.group === 'changelist') {
			s.changelists.move(files.filter((f) => f.group === 'changelist').map((f) => f.abs), target.listId);
			return;
		}
		if (target.group === 'staged') {
			await stageFiles(files.filter((f) => f.group !== 'staged'));
		} else if (target.group === 'unstaged') {
			await unstageFiles(files.filter((f) => f.group === 'staged'));
		}
	}


	allFiles(): FileNode[] {
		return this.roots.flatMap((g) => g.files);
	}

	/** Files selected in the tree, or those passed to a command. */
	selectedFiles(node?: ChangeNode, nodes?: readonly ChangeNode[]): FileNode[] {
		const sel = nodes && nodes.length ? nodes : node ? [node] : this.treeView.selection;
		return collectFiles(sel);
	}

	/** Files with at least one included part, once per file. */
	includedFiles(): FileNode[] {
		const cl = services().changelists;
		const seen = new Set<string>();
		return this.roots
			.filter((g) => g.group === 'changelist' || g.group === 'unversioned')
			.flatMap((g) => g.files)
			.filter((f) => (f.group === 'changelist' ? cl.isPartIncluded(f.abs, f.listId) : cl.isIncluded(f.abs)))
			.filter((f) => !seen.has(f.abs) && !!seen.add(f.abs));
	}

	findFile(absPath: string, group?: ChangeGroup): FileNode | undefined {
		return this.allFiles().find((f) => f.abs === absPath && (!group || f.group === group));
	}

	async reveal(node: ChangeNode): Promise<void> {
		await this.treeView.reveal(node, { select: true, focus: true, expand: true });
	}

	async expandAll(): Promise<void> {
		for (const g of this.roots) {
			await this.treeView.reveal(g, { expand: 3, select: false, focus: false });
		}
	}

	dispose(): void {
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer);
		}
		this.disposables.forEach((d) => d.dispose());
		this.onDidChangeTreeDataEmitter.dispose();
		this.onDidChangeModelEmitter.dispose();
	}
}

export function collectFiles(nodes: readonly ChangeNode[]): FileNode[] {
	const out: FileNode[] = [];
	const seen = new Set<string>();
	const visit = (n: ChangeNode) => {
		if (n.type === 'file') {
			const key = `${n.group === 'changelist' ? 'cl' : n.group}:${n.abs}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push(n);
			}
		} else if (n.type === 'group') {
			n.files.forEach(visit);
		} else {
			n.children.forEach(visit);
		}
	};
	nodes.forEach(visit);
	return out;
}

function arrange(group: GroupNode, files: FileNode[], byRepo: boolean, byDir: boolean): ChangeNode[] {
	const sortFiles = (a: FileNode, b: FileNode) => a.change.path.localeCompare(b.change.path);
	if (byRepo) {
		const repos = new Map<Repository, FileNode[]>();
		for (const f of files) {
			const arr = repos.get(f.repo) ?? [];
			arr.push(f);
			repos.set(f.repo, arr);
		}
		return [...repos.entries()].sort((a, b) => a[0].name.localeCompare(b[0].name)).map(([repo, repoFiles]) => {
			const node: RepoNode = { type: 'repo', id: `${group.id}|repo:${repo.root}`, group: group.group, listId: group.listId, parent: group, repo, children: [] };
			node.children = byDir ? dirTree(node, repo, repoFiles) : repoFiles.sort(sortFiles);
			reparent(node);
			return node;
		});
	}
	if (byDir) {
		const nodes: ChangeNode[] = [];
		const repos = new Map<Repository, FileNode[]>();
		for (const f of files) {
			const arr = repos.get(f.repo) ?? [];
			arr.push(f);
			repos.set(f.repo, arr);
		}
		for (const [repo, repoFiles] of repos) {
			nodes.push(...dirTree(group, repo, repoFiles));
		}
		nodes.forEach((n) => (n.parent = group));
		return nodes;
	}
	const sorted = [...files].sort(sortFiles);
	sorted.forEach((f) => (f.parent = group));
	group.files = sorted;
	return sorted;
}

interface Trie {
	dirs: Map<string, Trie>;
	files: FileNode[];
}

function dirTree(parent: ContainerNode, repo: Repository, files: FileNode[]): ChangeNode[] {
	const root: Trie = { dirs: new Map(), files: [] };
	for (const f of files) {
		const segments = f.change.path.split('/');
		segments.pop();
		let t = root;
		for (const seg of segments) {
			let next = t.dirs.get(seg);
			if (!next) {
				next = { dirs: new Map(), files: [] };
				t.dirs.set(seg, next);
			}
			t = next;
		}
		t.files.push(f);
	}
	const build = (t: Trie, relDir: string, container: ContainerNode): ChangeNode[] => {
		const out: ChangeNode[] = [];
		for (const [name, sub] of [...t.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			let label = name;
			let node = sub;
			let rel = relDir ? `${relDir}/${name}` : name;
			while (node.files.length === 0 && node.dirs.size === 1) {
				const [childName, child] = [...node.dirs.entries()][0];
				label += '/' + childName;
				rel += '/' + childName;
				node = child;
			}
			const dir: DirNode = {
				type: 'dir',
				id: `${container.id}|dir:${repo.root}/${rel}`,
				group: container.group,
				listId: container.listId,
				parent: container,
				label,
				abs: path.join(repo.root, ...rel.split('/')),
				children: [],
			};
			dir.children = build(node, rel, dir);
			out.push(dir);
		}
		for (const f of [...t.files].sort((a, b) => a.change.path.localeCompare(b.change.path))) {
			f.parent = container;
			out.push(f);
		}
		return out;
	};
	return build(root, '', parent);
}

function reparent(node: ContainerNode): void {
	for (const c of node.children) {
		c.parent = node;
		if (c.type !== 'file') {
			reparent(c);
		}
	}
}

export async function stageFiles(files: FileNode[]): Promise<void> {
	const byRepo = new Map<Repository, string[]>();
	for (const f of files) {
		const arr = byRepo.get(f.repo) ?? [];
		arr.push(f.change.path);
		if (f.change.origPath) {
			arr.push(f.change.origPath);
		}
		byRepo.set(f.repo, arr);
	}
	for (const [repo, paths] of byRepo) {
		await repo.stage(paths);
	}
}

export async function unstageFiles(files: FileNode[]): Promise<void> {
	const byRepo = new Map<Repository, string[]>();
	for (const f of files) {
		const arr = byRepo.get(f.repo) ?? [];
		arr.push(f.change.path);
		if (f.change.origPath) {
			arr.push(f.change.origPath);
		}
		byRepo.set(f.repo, arr);
	}
	for (const [repo, paths] of byRepo) {
		await repo.unstage(paths);
	}
}
