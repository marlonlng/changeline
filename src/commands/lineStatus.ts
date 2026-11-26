import * as vscode from 'vscode';
import { localChangeTarget, openDiff } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { chunkKey, diffLines, splitLines } from '../shared/diff';
import { chunkForLineChange, LineChange, originalText, revertLineChange, textDelta } from '../shared/lineChanges';
import { config } from '../util';
import type { ScmIntegration } from '../views/scmProvider';
import { moveChunkToChangelist } from './changelistPicker';
import type { CommandContext } from './common';

interface ChangeAt {
	uri: vscode.Uri;
	repo: Repository;
	document: vscode.TextDocument;
	original: string;
	changes: LineChange[];
	index: number;
}

/** Resolves the arguments VS Code passes to scm/change/title actions: the file, the quick diff changes and the index of the shown one. */
async function changeAt(scm: ScmIntegration, uri: unknown, changes: unknown, index: unknown): Promise<ChangeAt | undefined> {
	if (!(uri instanceof vscode.Uri) || !Array.isArray(changes) || typeof index !== 'number' || !changes[index]) {
		return undefined;
	}
	const repo = services().repos.getRepository(uri);
	const originalUri = repo && (await scm.originalResource(repo, uri));
	if (!repo || !originalUri) {
		return undefined;
	}
	const [document, originalDocument] = await Promise.all([vscode.workspace.openTextDocument(uri), vscode.workspace.openTextDocument(originalUri)]);
	return { uri, repo, document, original: originalDocument.getText(), changes: changes as LineChange[], index };
}

/** Commands of the change popup in the editor gutter (JetBrains: Rollback Lines, Show Diff, Copy, Move to Another Changelist). */
export function registerLineStatusCommands(ctx: CommandContext, scm: ScmIntegration): void {
	ctx.register('changeline.lineStatus.rollback', async (uri?: unknown, changes?: unknown, index?: unknown) => {
		const c = await changeAt(scm, uri, changes, index);
		if (!c) {
			return;
		}
		const before = c.document.getText();
		const delta = textDelta(before, revertLineChange(c.original, before, c.changes, c.index));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(c.uri, new vscode.Range(c.document.positionAt(delta.start), c.document.positionAt(delta.end)), delta.text);
		await vscode.workspace.applyEdit(edit);
	});
	ctx.register('changeline.lineStatus.showDiff', async (uri?: unknown, changes?: unknown, index?: unknown) => {
		const c = await changeAt(scm, uri, changes, index);
		if (!c) {
			return;
		}
		const rel = c.repo.relativePath(c.uri.fsPath);
		const change = c.repo.state.changes.find((x) => x.path === rel) ?? { path: rel, status: 'M' as const };
		const group = config('commit.useStagingArea', false) ? 'unstaged' : 'changelist';
		await openDiff({ targets: [localChangeTarget(c.repo, change, group)], index: 0, focus: c.changes[c.index] });
	});
	ctx.register('changeline.lineStatus.copy', async (uri?: unknown, changes?: unknown, index?: unknown) => {
		const c = await changeAt(scm, uri, changes, index);
		const text = c && originalText(c.original, c.changes[c.index]);
		if (text) {
			await vscode.env.clipboard.writeText(text);
		}
	});
	ctx.register('changeline.lineStatus.moveToChangelist', async (uri?: unknown, changes?: unknown, index?: unknown) => {
		const c = await changeAt(scm, uri, changes, index);
		if (!c) {
			return;
		}
		const oldLines = splitLines(c.original);
		const newLines = splitLines(c.document.getText());
		const chunks = diffLines(oldLines, newLines);
		const i = chunkForLineChange(chunks, c.changes[c.index]);
		if (i >= 0) {
			await moveChunkToChangelist(c.repo.absolutePath(c.repo.relativePath(c.uri.fsPath)), chunkKey(chunks[i], oldLines, newLines));
		}
	});
}
