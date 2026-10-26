import * as vscode from 'vscode';
import { services } from '../services';
import type { ChangeStatus } from '../shared/types';
import { config, pathKey, statusLabel } from '../util';

export const CHANGE_SCHEME = 'changeline-change';

/** URI used as resourceUri of tree items so they get file icons and status colors. */
export function changeUri(absPath: string, status: ChangeStatus, extra = ''): vscode.Uri {
	return vscode.Uri.file(absPath).with({ scheme: CHANGE_SCHEME, query: `status=${encodeURIComponent(status)}${extra}` });
}

export function statusColor(status: ChangeStatus): vscode.ThemeColor | undefined {
	switch (status) {
		case 'M':
		case 'T':
			return new vscode.ThemeColor('changeline.modifiedForeground');
		case 'A':
		case 'C':
			return new vscode.ThemeColor('changeline.addedForeground');
		case 'D':
			return new vscode.ThemeColor('changeline.deletedForeground');
		case 'R':
			return new vscode.ThemeColor('changeline.renamedForeground');
		case 'U':
			return new vscode.ThemeColor('changeline.conflictForeground');
		case '?':
			return new vscode.ThemeColor('changeline.unversionedForeground');
		case '!':
			return new vscode.ThemeColor('changeline.ignoredForeground');
	}
}

export class StatusDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;
	private explorerStatus = new Map<string, { status: ChangeStatus; path: string }>();
	private subscriptions: vscode.Disposable[] = [];

	constructor() {
		const s = services();
		this.subscriptions.push(
			s.repos.onDidChangeState(() => this.updateExplorer()),
			s.repos.onDidChangeRepositories(() => this.updateExplorer()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('changeline.decorations.explorer')) {
					this.updateExplorer();
				}
			}),
		);
		this.updateExplorer();
	}

	private updateExplorer(): void {
		const previous = this.explorerStatus;
		const next = new Map<string, { status: ChangeStatus; path: string }>();
		const put = (p: string, status: ChangeStatus) => next.set(pathKey(p), { status, path: p });
		if (config('decorations.explorer', false)) {
			for (const repo of services().repos.repositories) {
				const st = repo.state;
				for (const c of st.changes) {
					put(repo.absolutePath(c.path), c.status);
				}
				for (const c of st.untracked) {
					put(repo.absolutePath(c.path), '?');
				}
				for (const c of st.conflicts) {
					put(repo.absolutePath(c.path), 'U');
				}
			}
		}
		this.explorerStatus = next;
		const changed: vscode.Uri[] = [];
		for (const [k, v] of next) {
			if (previous.get(k)?.status !== v.status) {
				changed.push(vscode.Uri.file(v.path));
			}
		}
		for (const [k, v] of previous) {
			if (!next.has(k)) {
				changed.push(vscode.Uri.file(v.path));
			}
		}
		if (changed.length) {
			this.onDidChangeEmitter.fire(changed);
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		let status: ChangeStatus | undefined;
		if (uri.scheme === CHANGE_SCHEME) {
			const m = /(?:^|&)status=([^&]*)/.exec(uri.query);
			status = m ? (decodeURIComponent(m[1]) as ChangeStatus) : undefined;
			if (/(?:^|&)dir=1/.test(uri.query)) {
				return undefined;
			}
		} else if (uri.scheme === 'file') {
			status = this.explorerStatus.get(pathKey(uri.fsPath))?.status;
		}
		if (!status) {
			return undefined;
		}
		const badge = status === '?' ? 'U' : status === 'U' ? '!' : status;
		return { badge: status === '!' ? 'I' : badge, color: statusColor(status), tooltip: statusLabel(status), propagate: false };
	}

	dispose(): void {
		this.subscriptions.forEach((d) => d.dispose());
		this.onDidChangeEmitter.dispose();
	}
}
