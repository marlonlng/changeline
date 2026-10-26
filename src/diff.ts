import * as vscode from 'vscode';
import { EMPTY_REF, refLabel, textUri, toGitUri } from './content';
import type { Repository } from './git/repository';
import type { ChangeStatus, FileChange } from './shared/types';
import { basename, config, shortHash } from './util';
import type { ChangeGroup } from './views/changesView';

export type DiffSide =
	| { kind: 'git'; ref: string; path: string }
	| { kind: 'working'; path: string }
	| { kind: 'empty' }
	| { kind: 'text'; text: string };

export type DiffMode = 'local' | 'staged' | 'unstaged' | 'readonly';

export interface ReviewComment {
	id: string;
	author: string;
	createdAt: string;
	body: string;
	line: number;
	side: 'LEFT' | 'RIGHT';
	inReplyTo?: string;
	thread?: string;
}

export interface DiffReview {
	title: string;
	comments: ReviewComment[];
	submit(comment: { line: number; side: 'LEFT' | 'RIGHT'; body: string; inReplyTo?: string }): Promise<ReviewComment[]>;
}

export interface DiffTarget {
	repo: Repository;
	path: string;
	status: ChangeStatus;
	left: DiffSide;
	right: DiffSide;
	leftTitle: string;
	rightTitle: string;
	mode: DiffMode;
	review?: DiffReview;
}

export interface DiffContext {
	targets: DiffTarget[];
	index: number;
}

export function localChangeTarget(repo: Repository, change: FileChange, group: ChangeGroup): DiffTarget {
	const base = change.origPath ?? change.path;
	const added = change.status === 'A' || change.status === '?' || change.status === 'C';
	const deleted = change.status === 'D';
	switch (group) {
		case 'staged':
			return {
				repo, path: change.path, status: change.status,
				left: added || !repo.state.head ? { kind: 'empty' } : { kind: 'git', ref: 'HEAD', path: base },
				right: deleted ? { kind: 'empty' } : { kind: 'git', ref: '', path: change.path },
				leftTitle: 'HEAD', rightTitle: vscode.l10n.t('Staged'), mode: 'staged',
			};
		case 'unstaged':
			return {
				repo, path: change.path, status: change.status,
				left: change.status === 'A' ? { kind: 'empty' } : { kind: 'git', ref: '', path: change.path },
				right: deleted ? { kind: 'empty' } : { kind: 'working', path: change.path },
				leftTitle: vscode.l10n.t('Staged'), rightTitle: vscode.l10n.t('Local Changes'), mode: 'unstaged',
			};
		case 'unversioned':
		case 'ignored':
			return {
				repo, path: change.path, status: change.status,
				left: { kind: 'empty' }, right: { kind: 'working', path: change.path },
				leftTitle: vscode.l10n.t('No content'), rightTitle: vscode.l10n.t('Your version'), mode: 'readonly',
			};
		default:
			return {
				repo, path: change.path, status: change.status,
				left: added || !repo.state.head ? { kind: 'empty' } : { kind: 'git', ref: 'HEAD', path: base },
				right: deleted ? { kind: 'empty' } : { kind: 'working', path: change.path },
				leftTitle: repo.state.head ? `HEAD (${shortHash(repo.state.head)})` : vscode.l10n.t('Empty'), rightTitle: vscode.l10n.t('Your version'), mode: 'local',
			};
	}
}

export function commitFileTarget(repo: Repository, commit: { hash: string; parents: string[] }, file: FileChange, parentIndex = 0): DiffTarget {
	const parent = commit.parents[Math.min(parentIndex, commit.parents.length - 1)];
	return {
		repo, path: file.path, status: file.status,
		left: file.status === 'A' || file.status === 'C' || !parent ? { kind: 'empty' } : { kind: 'git', ref: parent, path: file.origPath ?? file.path },
		right: file.status === 'D' ? { kind: 'empty' } : { kind: 'git', ref: commit.hash, path: file.path },
		leftTitle: parent ? shortHash(parent) : vscode.l10n.t('Empty'), rightTitle: shortHash(commit.hash), mode: 'readonly',
	};
}

/** Compare two revisions; `right` undefined means the working tree. */
export function revisionTarget(repo: Repository, left: string, right: string | undefined, file: FileChange): DiffTarget {
	const leftPath = file.origPath ?? file.path;
	return {
		repo, path: file.path, status: file.status,
		left: file.status === 'A' || file.status === '?' ? { kind: 'empty' } : { kind: 'git', ref: left, path: leftPath },
		right: file.status === 'D' ? { kind: 'empty' } : right === undefined ? { kind: 'working', path: file.path } : { kind: 'git', ref: right, path: file.path },
		leftTitle: refLabel(left), rightTitle: right === undefined ? vscode.l10n.t('Your version') : refLabel(right), mode: right === undefined ? 'local' : 'readonly',
	};
}

export function sideUri(repo: Repository, side: DiffSide, fallbackPath: string): vscode.Uri {
	switch (side.kind) {
		case 'git':
			return toGitUri(repo, side.ref, side.path);
		case 'working':
			return vscode.Uri.file(repo.absolutePath(side.path));
		case 'text':
			return textUri(side.text, basename(fallbackPath));
		default:
			return toGitUri(repo, EMPTY_REF, fallbackPath);
	}
}

export async function openNativeDiff(t: DiffTarget, options?: vscode.TextDocumentShowOptions): Promise<void> {
	const left = sideUri(t.repo, t.left, t.path);
	const right = sideUri(t.repo, t.right, t.path);
	const title = `${basename(t.path)} (${t.leftTitle} ↔ ${t.rightTitle})`;
	await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
}

/** Opens a diff with the configured viewer (JetBrains style webview or VS Code diff editor). */
export async function openDiff(ctx: DiffContext, preferNative = false): Promise<void> {
	if (!ctx.targets.length) {
		return;
	}
	if (preferNative || config<string>('diff.viewer', 'jetbrains') === 'native') {
		await openNativeDiff(ctx.targets[ctx.index], { preview: true });
		return;
	}
	const { DiffPanel } = await import('./webviews/diffPanel');
	DiffPanel.show(ctx);
}
