import * as vscode from 'vscode';
import { toGitUri } from '../content';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { config, statusLabel } from '../util';

export class ScmIntegration implements vscode.Disposable {
	private controls = new Map<string, { scm: vscode.SourceControl; groups: Map<string, vscode.SourceControlResourceGroup> }>();
	private disposables: vscode.Disposable[] = [];

	constructor() {
		const s = services();
		this.disposables.push(
			s.repos.onDidChangeRepositories(() => this.sync()),
			s.repos.onDidChangeState((r) => this.updateResources(r)),
			s.changelists.onDidChange(() => s.repos.repositories.forEach((r) => this.updateResources(r))),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('changeline.lineStatus') || e.affectsConfiguration('git.enabled') || e.affectsConfiguration('changeline.commit.useStagingArea')) {
					this.sync(true);
				}
			}),
		);
		this.sync();
	}

	get enabled(): boolean {
		const mode = config<'auto' | 'on' | 'off'>('lineStatus.enabled', 'auto');
		if (mode !== 'auto') {
			return mode === 'on';
		}
		const builtin = vscode.extensions.getExtension('vscode.git');
		return !builtin || vscode.workspace.getConfiguration('git').get<boolean>('enabled', true) === false;
	}

	private sync(recreate = false): void {
		if (recreate || !this.enabled) {
			for (const c of this.controls.values()) {
				c.scm.dispose();
			}
			this.controls.clear();
		}
		if (!this.enabled) {
			return;
		}
		const repos = services().repos.repositories;
		for (const [root, c] of [...this.controls]) {
			if (!repos.some((r) => r.root === root)) {
				c.scm.dispose();
				this.controls.delete(root);
			}
		}
		for (const repo of repos) {
			if (this.controls.has(repo.root)) {
				continue;
			}
			const scm = vscode.scm.createSourceControl('changeline', 'Changeline', vscode.Uri.file(repo.root));
			scm.inputBox.visible = false;
			scm.quickDiffProvider = {
				provideOriginalResource: (uri) => this.originalResource(repo, uri),
			};
			scm.acceptInputCommand = { command: 'changeline.commit', title: vscode.l10n.t('Commit') };
			this.controls.set(repo.root, { scm, groups: new Map() });
			this.updateResources(repo);
		}
	}

	/** Number of Changeline source controls (one per repository while enabled). */
	get count(): number {
		return this.controls.size;
	}

	originalResource(repo: Repository, uri: vscode.Uri): vscode.Uri | undefined {
		if (uri.scheme !== 'file' || !repo.contains(uri.fsPath)) {
			return undefined;
		}
		const rel = repo.relativePath(uri.fsPath);
		if (repo.state.untracked.some((u) => u.path === rel) || !repo.state.head) {
			return undefined;
		}
		return toGitUri(repo, config('commit.useStagingArea', false) ? '' : 'HEAD', rel);
	}

	private updateResources(repo: Repository): void {
		const c = this.controls.get(repo.root);
		if (!c) {
			return;
		}
		const cl = services().changelists;
		const wanted = new Map<string, { label: string; states: vscode.SourceControlResourceState[] }>();
		for (const list of cl.all) {
			wanted.set(list.id, { label: list.name, states: [] });
		}
		wanted.set('__unversioned', { label: vscode.l10n.t('Unversioned Files'), states: [] });
		const state = (path: string, status: import('../shared/types').ChangeStatus): vscode.SourceControlResourceState => ({
			resourceUri: vscode.Uri.file(repo.absolutePath(path)),
			decorations: { tooltip: statusLabel(status), strikeThrough: status === 'D', faded: status === 'D' },
			command: { command: 'changeline.showDiff', title: vscode.l10n.t('Show Diff'), arguments: [vscode.Uri.file(repo.absolutePath(path))] },
		});
		for (const ch of repo.state.changes) {
			wanted.get(cl.listOf(repo.absolutePath(ch.path)).id)?.states.push(state(ch.path, ch.status));
		}
		for (const u of repo.state.untracked) {
			wanted.get('__unversioned')!.states.push(state(u.path, '?'));
		}
		for (const [id, w] of wanted) {
			let g = c.groups.get(id);
			if (!g) {
				g = c.scm.createResourceGroup(id, w.label);
				g.hideWhenEmpty = true;
				c.groups.set(id, g);
			}
			g.label = w.label;
			g.resourceStates = w.states;
		}
		for (const [id, g] of [...c.groups]) {
			if (!wanted.has(id)) {
				g.dispose();
				c.groups.delete(id);
			}
		}
		c.scm.count = repo.state.changes.length;
	}

	dispose(): void {
		for (const c of this.controls.values()) {
			c.scm.dispose();
		}
		this.disposables.forEach((d) => d.dispose());
	}
}
