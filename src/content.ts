import * as vscode from 'vscode';
import type { Repository } from './git/repository';
import { services } from './services';

export const GIT_SCHEME = 'changeline';
export const EMPTY_REF = '~empty';

export interface GitUriParams {
	repo: string;
	ref: string;
	path: string;
}

/** Read-only document with a file's content at a revision ('' = index, ':1'..':3' = conflict stages). */
export function toGitUri(repo: Repository, ref: string, relPath: string): vscode.Uri {
	const params: GitUriParams = { repo: repo.root, ref, path: relPath };
	return vscode.Uri.file(repo.absolutePath(relPath)).with({ scheme: GIT_SCHEME, query: JSON.stringify(params) });
}

export function fromGitUri(uri: vscode.Uri): GitUriParams | undefined {
	if (uri.scheme !== GIT_SCHEME) {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as GitUriParams;
	} catch {
		return undefined;
	}
}

export function refLabel(ref: string): string {
	if (ref === '') {
		return vscode.l10n.t('Staged');
	}
	if (ref === EMPTY_REF) {
		return vscode.l10n.t('Empty');
	}
	if (ref === ':1') {
		return vscode.l10n.t('Base');
	}
	if (ref === ':2') {
		return vscode.l10n.t('Yours');
	}
	if (ref === ':3') {
		return vscode.l10n.t('Theirs');
	}
	return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}

export class GitContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private subscription: vscode.Disposable;

	constructor() {
		this.subscription = services().repos.onDidChangeState((repo) => {
			for (const doc of vscode.workspace.textDocuments) {
				const p = fromGitUri(doc.uri);
				if (p && p.repo === repo.root && (p.ref === '' || p.ref.startsWith(':') || p.ref === 'HEAD')) {
					this.onDidChangeEmitter.fire(doc.uri);
				}
			}
		});
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const p = fromGitUri(uri);
		if (!p || p.ref === EMPTY_REF) {
			return '';
		}
		const repo = services().repos.getByRoot(p.repo);
		if (!repo) {
			return '';
		}
		const buf = await repo.getContentOrEmpty(p.ref, p.path, { filters: true });
		return buf ? buf.toString('utf8') : '';
	}

	dispose(): void {
		this.subscription.dispose();
		this.onDidChangeEmitter.dispose();
	}
}

export const TEXT_SCHEME = 'changeline-text';
const textStore = new Map<string, string>();
let textCounter = 0;

/** Read-only in-memory document, e.g. a shelved version of a file. */
export function textUri(text: string, fileName: string, label = 'text'): vscode.Uri {
	const id = `${Date.now().toString(36)}-${textCounter++}`;
	textStore.set(id, text);
	if (textStore.size > 200) {
		textStore.delete(textStore.keys().next().value!);
	}
	return vscode.Uri.from({ scheme: TEXT_SCHEME, path: `/${label}/${fileName}`, query: id });
}

export class TextContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		return textStore.get(uri.query) ?? '';
	}
}
