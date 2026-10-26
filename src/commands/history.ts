import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommitController } from '../commit';
import { toGitUri } from '../content';
import { commitFileTarget, openDiff, revisionTarget } from '../diff';
import type { Repository } from '../git/repository';
import { services } from '../services';
import type { CommitInfo, FileChange } from '../shared/types';
import { basename, capitalize, plural, remoteWebUrl, shortHash } from '../util';
import { LogController, LogScope, LogViewProvider } from '../views/logController';
import { ComparePanel } from '../webviews/comparePanel';
import { showDialog } from '../webviews/dialogPanel';
import { renderWebviewHtml, webviewOptions } from '../webviews/host';
import { PushPanel } from '../webviews/pushPanel';
import { RebasePanel } from '../webviews/rebasePanel';
import { newBranch, newTag, resetDialog } from './branches';
import { CommandContext, confirm, handleOutcome, resolveRepo, savePatch, uriOf, withSmartStash } from './common';

/** A log in an editor tab (file history, update info, ...). */
export function openLogPanel(scope: LogScope, title: string): void {
	const panel = vscode.window.createWebviewPanel('changeline.history', title, vscode.ViewColumn.Active, { ...webviewOptions(services().context.extensionUri), retainContextWhenHidden: true });
	const controller = new LogController(panel.webview, scope);
	panel.webview.html = renderWebviewHtml(panel.webview, services().context.extensionUri, 'log', { title });
	panel.onDidChangeViewState(() => {
		if (panel.active) {
			controller.markFocused();
		}
	});
	panel.onDidDispose(() => controller.dispose());
}

interface LogArg {
	logId?: string;
	hash?: string;
	path?: string;
	origPath?: string;
	status?: string;
}

function controllerOf(arg?: LogArg): LogController | undefined {
	return LogController.get(arg?.logId);
}

/** Selected commits of the log the command came from (newest first). */
async function selectedCommits(arg?: LogArg): Promise<{ repo: Repository; commits: CommitInfo[]; controller: LogController } | undefined> {
	const c = controllerOf(arg);
	const repo = c?.repo;
	if (!c || !repo) {
		return undefined;
	}
	let commits = c.selectedCommits;
	if (arg?.hash && !commits.some((x) => x.hash === arg.hash)) {
		commits = [await repo.getCommit(arg.hash)];
	}
	if (!commits.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Select a commit in the log first.'));
		return undefined;
	}
	return { repo, commits, controller: c };
}

/** Checks that commits can be rewritten: on the current branch and without merges in between. */
async function checkRewritable(repo: Repository, commits: CommitInfo[], action: string): Promise<{ base?: string } | undefined> {
	if (repo.state.operation !== 'none') {
		void vscode.window.showWarningMessage(vscode.l10n.t('{0} is not possible while a {1} is in progress.', action, capitalize(repo.state.operation)));
		return undefined;
	}
	for (const c of commits) {
		if (!(await repo.isAncestor(c.hash, 'HEAD'))) {
			void vscode.window.showWarningMessage(vscode.l10n.t('{0} is not possible: commit {1} is not in the current branch.', action, shortHash(c.hash)));
			return undefined;
		}
	}
	const oldest = commits[commits.length - 1];
	const base = oldest.parents[0];
	const merges = (await repo.run(['rev-list', '--merges', base ? `${base}..HEAD` : 'HEAD'])).stdout.trim();
	if (merges) {
		void vscode.window.showWarningMessage(vscode.l10n.t('{0} is not possible: there are merge commits between {1} and HEAD.', action, shortHash(oldest.hash)));
		return undefined;
	}
	if (repo.state.upstream) {
		const pushed = await repo.isAncestor(commits[0].hash, `refs/remotes/${repo.state.upstream}`).catch(() => false);
		if (pushed && !(await confirm(commits.length > 1 ? vscode.l10n.t('The commits were already pushed to {0}. Rewriting history requires a force push.', repo.state.upstream) : vscode.l10n.t('The commit was already pushed to {0}. Rewriting history requires a force push.', repo.state.upstream), vscode.l10n.t('Continue')))) {
			return undefined;
		}
	}
	return { base };
}

async function commitsBetween(repo: Repository, base: string | undefined): Promise<(CommitInfo & { body: string })[]> {
	const list = await repo.log({ revisions: [base ? `${base}..HEAD` : 'HEAD'], order: 'topo', limit: 5000 });
	return Promise.all(list.map((c) => repo.getCommit(c.hash)));
}

async function applyPartialPatch(repo: Repository, from: string | undefined, to: string, file: FileChange, reverse: boolean): Promise<void> {
	const patch = await repo.createPatch({ from: from ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', to, paths: file.origPath ? [file.origPath, file.path] : [file.path] });
	const tmp = path.join(os.tmpdir(), `changeline-${Date.now()}.patch`);
	await fs.promises.writeFile(tmp, patch, 'utf8');
	try {
		const r = await repo.applyPatch(tmp, { reverse, threeWay: true });
		if (!r.ok) {
			if (r.conflicts) {
				void vscode.commands.executeCommand('changeline.resolveConflicts');
			} else {
				throw r.error ?? new Error(r.output);
			}
		} else {
			await repo.unstage([file.path]).catch(() => undefined);
			void vscode.window.showInformationMessage(reverse ? vscode.l10n.t('Reverted changes of {0} from {1}.', file.path, shortHash(to)) : vscode.l10n.t('Applied changes of {0} from {1}.', file.path, shortHash(to)));
		}
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
}

export async function openInBrowser(repo: Repository, kind: 'commit' | 'file', hash: string, relPath?: string, lines?: [number, number]): Promise<void> {
	const remotes = await repo.getRemotes();
	const remote = remotes.find((r) => r.name === (repo.state.upstream?.split('/')[0] ?? 'origin')) ?? remotes[0];
	const web = remote && remoteWebUrl(remote.fetchUrl ?? remote.pushUrl ?? '');
	if (!web) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Could not determine a web URL for the remote of this repository.'));
		return;
	}
	let url: string;
	if (kind === 'commit') {
		url = web.host === 'gitlab' ? `${web.base}/-/commit/${hash}` : web.host === 'bitbucket' ? `${web.base}/commits/${hash}` : `${web.base}/commit/${hash}`;
	} else {
		const p = relPath!.split('/').map(encodeURIComponent).join('/');
		if (web.host === 'gitlab') {
			url = `${web.base}/-/blob/${hash}/${p}${lines ? `#L${lines[0]}-${lines[1]}` : ''}`;
		} else if (web.host === 'bitbucket') {
			url = `${web.base}/src/${hash}/${p}${lines ? `#lines-${lines[0]}:${lines[1]}` : ''}`;
		} else {
			url = `${web.base}/blob/${hash}/${p}${lines ? `#L${lines[0]}${lines[1] !== lines[0] ? `-L${lines[1]}` : ''}` : ''}`;
		}
	}
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

export function registerHistoryCommands(ctx: CommandContext, logView: LogViewProvider, commit: CommitController): void {
	ctx.register('changeline.showLog', async (arg?: { repo?: string; hash?: string; revisions?: string[]; title?: string; branches?: string[] }) => {
		if (arg?.revisions) {
			openLogPanel({ kind: 'log', repoRoot: arg.repo, revisions: arg.revisions, title: arg.title }, arg.title ?? vscode.l10n.t('Log'));
			return;
		}
		await logView.show((c) => {
			if (arg?.repo && c.repoRoot !== arg.repo) {
				c.repoRoot = arg.repo;
				c.refresh();
			}
			if (arg?.branches) {
				c.setFilters({ branches: arg.branches });
			}
			if (arg?.hash) {
				c.selectCommit(arg.hash);
			}
		});
	});
	ctx.register('changeline.showConsole', () => services().console.show(true));
	ctx.register('changeline.showHistory', async (arg?: unknown) => {
		const uri = uriOf(arg);
		if (!uri) {
			return;
		}
		const repo = services().repos.getRepository(uri);
		if (!repo) {
			void vscode.window.showWarningMessage(vscode.l10n.t('The file is not in a Git repository.'));
			return;
		}
		const rel = repo.relativePath(uri.fsPath);
		if (!rel) {
			await vscode.commands.executeCommand('changeline.showLog', { repo: repo.root });
			return;
		}
		const isDir = fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory();
		if (isDir) {
			openLogPanel({ kind: 'log', repoRoot: repo.root, title: vscode.l10n.t('History: {0}', rel), filters: { paths: [rel] } }, vscode.l10n.t('History: {0}', basename(rel)));
			return;
		}
		openLogPanel({ kind: 'history', repoRoot: repo.root, path: rel, title: vscode.l10n.t('History: {0}', rel) }, vscode.l10n.t('History: {0}', basename(rel)));
	});
	ctx.register('changeline.showHistoryForSelection', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const repo = services().repos.getRepository(editor.document.uri);
		if (!repo) {
			return;
		}
		const rel = repo.relativePath(editor.document.uri.fsPath);
		const start = editor.selection.start.line + 1;
		const end = Math.max(start, editor.selection.end.line + (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line ? 0 : 1));
		openLogPanel({ kind: 'history', repoRoot: repo.root, path: rel, lineRange: { start, end }, title: vscode.l10n.t('History for Selection: {0}:{1}-{2}', rel, start, end) }, vscode.l10n.t('History: {0}:{1}-{2}', basename(rel), start, end));
	});

	ctx.register('changeline.log.copyRevision', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			await vscode.env.clipboard.writeText(sel.commits.map((c) => c.hash).join('\n'));
			vscode.window.setStatusBarMessage(vscode.l10n.t('$(copy) Copied {0}', sel.commits.length > 1 ? plural(sel.commits.length, '{0} revision', '{0} revisions') : shortHash(sel.commits[0].hash)), 3000);
		}
	});
	ctx.register('changeline.copyText', async (text: string) => {
		await vscode.env.clipboard.writeText(text);
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(copy) Copied to clipboard'), 3000);
	});
	ctx.register('changeline.log.createPatch', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			const patch = await sel.repo.formatPatch([...sel.commits].reverse().map((c) => c.hash));
			await savePatch(patch, sel.commits.length === 1 ? `${shortHash(sel.commits[0].hash)}.patch` : 'commits.patch');
		}
	});
	ctx.register('changeline.log.cherryPick', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const { repo, commits } = sel;
		const merge = commits.find((c) => c.parents.length > 1);
		let mainline: number | undefined;
		if (merge) {
			const pick = await vscode.window.showQuickPick(merge.parents.map((p, i) => ({ label: vscode.l10n.t('Parent {0}', i + 1), description: shortHash(p), n: i + 1 })), { placeHolder: vscode.l10n.t('{0} is a merge commit. Cherry-pick relative to which parent?', shortHash(merge.hash)) });
			if (!pick) {
				return;
			}
			mainline = pick.n;
		}
		const ordered = [...commits].reverse().map((c) => c.hash);
		const outcome = await withSmartStash(repo, vscode.l10n.t('Cherry-Pick'), () => repo.cherryPick(ordered, { recordOrigin: vscode.workspace.getConfiguration('changeline').get('cherryPick.addSourceReference', false), mainline }));
		await handleOutcome(repo, outcome, commits.length === 1 ? vscode.l10n.t('Cherry-picked {0} {1}', shortHash(commits[0].hash), commits[0].subject) : vscode.l10n.t('Cherry-picked {0}', plural(commits.length, '{0} commit', '{0} commits')));
	});
	ctx.register('changeline.log.checkoutRevision', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			const { checkoutRef } = await import('./branches');
			await checkoutRef(sel.repo, sel.commits[0].hash, { detach: true });
		}
	});
	ctx.register('changeline.log.showRepositoryAtRevision', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const hash = sel.commits[0].hash;
		const files = await sel.repo.listFiles(hash);
		const pick = await vscode.window.showQuickPick(files.map((f) => ({ label: basename(f), description: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f), file: f })), {
			title: vscode.l10n.t('Repository at {0} · {1}', shortHash(hash), plural(files.length, '{0} file', '{0} files')),
			placeHolder: vscode.l10n.t('Open a file as of this revision'),
			matchOnDescription: true,
		});
		if (pick) {
			await vscode.window.showTextDocument(toGitUri(sel.repo, hash, pick.file), { preview: true });
		}
	});
	ctx.register('changeline.log.compareWithLocal', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			const hash = sel.commits[0].hash;
			await ComparePanel.show({ repo: sel.repo, title: vscode.l10n.t('Compare {0} with Local', shortHash(hash)), left: hash, right: undefined, leftLabel: shortHash(hash), rightLabel: vscode.l10n.t('Local') });
		}
	});
	ctx.register('changeline.log.showDiff', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const c = sel.commits[0];
		const files = await sel.repo.getCommitFiles(c.hash, c.parents);
		await openDiff({ targets: files.map((f) => commitFileTarget(sel.repo, c, f)), index: 0 });
	});
	ctx.register('changeline.log.showCommitDiff', async (arg: { repo: string; hash: string }) => {
		const repo = await resolveRepo({ repo: arg.repo });
		if (!repo) {
			return;
		}
		const c = await repo.getCommit(arg.hash);
		const files = await repo.getCommitFiles(c.hash, c.parents);
		await openDiff({ targets: files.map((f) => commitFileTarget(repo, c, f)), index: 0 });
	});
	ctx.register('changeline.log.resetToHere', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			await resetDialog(sel.repo, sel.commits[0].hash, `${shortHash(sel.commits[0].hash)} "${sel.commits[0].subject}"`);
		}
	});
	ctx.register('changeline.log.revertCommit', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const { repo, commits } = sel;
		const merge = commits.find((c) => c.parents.length > 1);
		const outcome = await withSmartStash(repo, vscode.l10n.t('Revert'), () => repo.revert(commits.map((c) => c.hash), { mainline: merge ? 1 : undefined }));
		await handleOutcome(repo, outcome, commits.length === 1 ? vscode.l10n.t('Reverted {0}', shortHash(commits[0].hash)) : vscode.l10n.t('Reverted {0}', plural(commits.length, '{0} commit', '{0} commits')));
	});
	ctx.register('changeline.log.undoCommit', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const { repo, commits } = sel;
		const c = commits[0];
		if (c.hash !== repo.state.head) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Only the last commit (HEAD) can be undone.'));
			return;
		}
		if (repo.state.upstream && (await repo.isAncestor(c.hash, `refs/remotes/${repo.state.upstream}`))) {
			if (!(await confirm(vscode.l10n.t('The commit was already pushed to {0}. Undo it anyway?', repo.state.upstream), vscode.l10n.t('Undo Commit')))) {
				return;
			}
		}
		const full = await repo.getCommit(c.hash);
		await repo.reset(c.parents[0] ?? 'HEAD', 'soft');
		commit.setMessage(full.body);
		void vscode.window.showInformationMessage(vscode.l10n.t('Undid commit "{0}". Its changes are back in the Commit tool window.', c.subject));
	});
	ctx.register('changeline.log.editMessage', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const { repo } = sel;
		const c = await repo.getCommit(sel.commits[0].hash);
		const isHead = c.hash === repo.state.head;
		const check = isHead ? { base: c.parents[0] } : await checkRewritable(repo, [c], vscode.l10n.t('Edit Commit Message'));
		if (!check) {
			return;
		}
		const result = await showDialog({
			title: vscode.l10n.t('Edit Commit Message: {0}', shortHash(c.hash)),
			fields: [{ id: 'message', type: 'textarea', value: c.body, rows: 12, monospace: true, required: true, focus: true }],
			okLabel: 'OK',
			width: 720,
		});
		if (!result) {
			return;
		}
		const message = String(result.values.message);
		if (isHead) {
			await repo.amendMessage(message);
			void vscode.window.showInformationMessage(vscode.l10n.t('Commit message changed.'));
			return;
		}
		await RebasePanel.show({ repo, base: check.base, commits: await commitsBetween(repo, check.base), preset: { [c.hash]: { action: 'reword', message } }, silent: true });
	});
	ctx.register('changeline.log.fixup', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			commit.setMessage(`fixup! ${sel.commits[0].subject}`);
			await vscode.commands.executeCommand('changeline.commit');
		}
	});
	ctx.register('changeline.log.squashInto', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			commit.setMessage(`squash! ${sel.commits[0].subject}\n\n`);
			await vscode.commands.executeCommand('changeline.commit');
		}
	});
	ctx.register('changeline.log.squashCommits', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const { repo, commits } = sel;
		if (commits.length < 2) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Select at least two commits to squash.'));
			return;
		}
		const check = await checkRewritable(repo, commits, vscode.l10n.t('Squash Commits'));
		if (!check) {
			return;
		}
		const full = await Promise.all(commits.map((c) => repo.getCommit(c.hash)));
		const result = await showDialog({
			title: vscode.l10n.t('Squash {0} Commits', commits.length),
			fields: [{ id: 'message', type: 'textarea', value: [...full].reverse().map((c) => c.body).join('\n\n'), rows: 14, monospace: true, required: true, focus: true }],
			okLabel: 'OK',
			width: 720,
		});
		if (!result) {
			return;
		}
		const all = await commitsBetween(repo, check.base);
		const selectedSet = new Set(commits.map((c) => c.hash));
		const oldestFirst = [...all].reverse();
		const firstIdx = oldestFirst.findIndex((c) => selectedSet.has(c.hash));
		const others = oldestFirst.filter((c) => !selectedSet.has(c.hash));
		const sel2 = oldestFirst.filter((c) => selectedSet.has(c.hash));
		const reordered = [...others.slice(0, firstIdx), ...sel2, ...others.slice(firstIdx)];
		const preset: Record<string, { action: 'pick' | 'squash'; message?: string }> = {};
		sel2.forEach((c, i) => (preset[c.hash] = i === 0 ? { action: 'pick' } : { action: 'squash', message: i === sel2.length - 1 ? String(result.values.message) : undefined }));
		await RebasePanel.show({ repo, base: check.base, commits: [...reordered].reverse(), preset, silent: true });
	});
	ctx.register('changeline.log.dropCommits', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const { repo, commits } = sel;
		const check = await checkRewritable(repo, commits, vscode.l10n.t('Drop Commits'));
		if (!check) {
			return;
		}
		if (!(await confirm(commits.length === 1 ? vscode.l10n.t('Drop commit "{0}"? Its changes will be lost.', commits[0].subject) : vscode.l10n.t('Drop {0} commits? The changes of the dropped commits will be lost.', commits.length), vscode.l10n.t('Drop')))) {
			return;
		}
		const preset = Object.fromEntries(commits.map((c) => [c.hash, { action: 'drop' as const }]));
		await RebasePanel.show({ repo, base: check.base, commits: await commitsBetween(repo, check.base), preset, silent: true });
	});
	ctx.register('changeline.log.interactiveRebase', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const oldest = sel.commits[sel.commits.length - 1];
		const check = await checkRewritable(sel.repo, [oldest], vscode.l10n.t('Interactive Rebase'));
		if (check) {
			await RebasePanel.show({ repo: sel.repo, base: check.base, commits: await commitsBetween(sel.repo, check.base) });
		}
	});
	ctx.register('changeline.interactiveRebase', async (arg?: { repo?: string; base?: string }) => {
		const repo = await resolveRepo(arg);
		if (!repo) {
			return;
		}
		let base = arg?.base;
		if (!base) {
			const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Rebase commits after this revision (e.g. HEAD~5, main, a commit hash)'), value: repo.state.upstream ?? 'HEAD~5' });
			if (!value) {
				return;
			}
			base = (await repo.mergeBase('HEAD', value)) ?? value;
		}
		const commits = await commitsBetween(repo, base);
		if (!commits.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No commits to rebase.'));
			return;
		}
		if (commits.some((c) => c.parents.length > 1)) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Interactive rebase is not possible: the range contains merge commits, which would be flattened. Rebase from a commit after the last merge.'));
			return;
		}
		await RebasePanel.show({ repo, base, commits });
	});
	ctx.register('changeline.log.pushUpToHere', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			await PushPanel.show({ repos: [sel.repo], source: sel.commits[0].hash });
		}
	});
	ctx.register('changeline.log.newBranch', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			await newBranch(sel.repo, sel.commits[0].hash);
		}
	});
	ctx.register('changeline.log.newTag', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			await newTag(sel.repo, sel.commits[0].hash);
		}
	});
	ctx.register('changeline.log.goToParent', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel && sel.commits[0].parents[0]) {
			sel.controller.selectCommit(sel.commits[0].parents[0]);
		}
	});
	ctx.register('changeline.log.goToChild', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (!sel) {
			return;
		}
		const out = await sel.repo.run(['rev-list', '--all', '--children']);
		const line = out.stdout.split('\n').find((l) => l.startsWith(sel.commits[0].hash));
		const child = line?.split(' ')[1];
		if (child) {
			sel.controller.selectCommit(child);
		}
	});
	ctx.register('changeline.log.goTo', async (arg?: LogArg) => {
		const c = controllerOf(arg);
		const repo = c?.repo;
		if (!c || !repo) {
			return;
		}
		const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Go to hash, branch or tag') });
		if (!value) {
			return;
		}
		const hash = await repo.revParse(value.trim());
		if (hash) {
			c.selectCommit(hash);
		} else {
			void vscode.window.showWarningMessage(vscode.l10n.t('Revision \'{0}\' not found.', value));
		}
	});
	ctx.register('changeline.log.openInBrowser', async (arg?: LogArg) => {
		const sel = await selectedCommits(arg);
		if (sel) {
			await openInBrowser(sel.repo, 'commit', sel.commits[0].hash);
		}
	});
	ctx.register('changeline.log.refresh', (arg?: LogArg) => controllerOf(arg)?.refresh());

	const fileArg = async (arg?: LogArg) => {
		const c = controllerOf(arg);
		const repo = c?.repo;
		if (!c || !repo || !arg?.path) {
			return undefined;
		}
		const commits = c.selectedCommits.length ? c.selectedCommits : arg.hash ? [await repo.getCommit(arg.hash)] : [];
		if (!commits.length) {
			return undefined;
		}
		const file: FileChange = { path: arg.path, origPath: arg.origPath, status: (arg.status as FileChange['status']) ?? 'M' };
		return { repo, commits, file, newest: commits[0], oldest: commits[commits.length - 1] };
	};
	ctx.register('changeline.logFile.showDiff', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (!a) {
			return;
		}
		if (a.commits.length === 1) {
			await openDiff({ targets: [commitFileTarget(a.repo, a.newest, a.file)], index: 0 });
		} else {
			await openDiff({ targets: [revisionTarget(a.repo, a.oldest.parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', a.newest.hash, a.file)], index: 0 });
		}
	});
	ctx.register('changeline.logFile.compareWithLocal', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a) {
			await openDiff({ targets: [revisionTarget(a.repo, a.newest.hash, undefined, { ...a.file, status: a.file.status === 'A' ? 'M' : a.file.status, origPath: undefined })], index: 0 });
		}
	});
	ctx.register('changeline.logFile.openRepositoryVersion', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a) {
			const ref = a.file.status === 'D' ? a.newest.parents[0] : a.newest.hash;
			await vscode.window.showTextDocument(toGitUri(a.repo, ref, a.file.status === 'D' ? a.file.origPath ?? a.file.path : a.file.path), { preview: true });
		}
	});
	ctx.register('changeline.logFile.editSource', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a) {
			await vscode.window.showTextDocument(vscode.Uri.file(a.repo.absolutePath(a.file.path)), { preview: false });
		}
	});
	ctx.register('changeline.logFile.getRevision', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (!a || a.file.status === 'D') {
			return;
		}
		if (!(await confirm(vscode.l10n.t('Replace the local {0} with its version from {1}?', a.file.path, shortHash(a.newest.hash)), vscode.l10n.t('Get'), vscode.l10n.t('Local changes to this file are overwritten.')))) {
			return;
		}
		await a.repo.restore([a.file.path], a.newest.hash, { staged: false, worktree: true });
		void vscode.window.showInformationMessage(vscode.l10n.t('{0} restored from {1}.', a.file.path, shortHash(a.newest.hash)));
	});
	ctx.register('changeline.logFile.revertSelectedChanges', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a && (await confirm(vscode.l10n.t('Revert the changes made to {0} in {1}?', a.file.path, shortHash(a.newest.hash)), vscode.l10n.t('Revert')))) {
			await applyPartialPatch(a.repo, a.oldest.parents[0], a.newest.hash, a.file, true);
		}
	});
	ctx.register('changeline.logFile.cherryPickSelectedChanges', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a) {
			await applyPartialPatch(a.repo, a.oldest.parents[0], a.newest.hash, a.file, false);
		}
	});
	ctx.register('changeline.logFile.historyUpToHere', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a) {
			openLogPanel({ kind: 'history', repoRoot: a.repo.root, path: a.file.path, revisions: [a.newest.hash], title: vscode.l10n.t('History: {0} up to {1}', a.file.path, shortHash(a.newest.hash)) }, vscode.l10n.t('History: {0}', basename(a.file.path)));
		}
	});
	ctx.register('changeline.logFile.annotate', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a && a.file.status !== 'D') {
			const doc = await vscode.window.showTextDocument(toGitUri(a.repo, a.newest.hash, a.file.path), { preview: true });
			await vscode.commands.executeCommand('changeline.annotate', doc.document.uri);
		}
	});
	ctx.register('changeline.logFile.openInBrowser', async (arg?: LogArg) => {
		const a = await fileArg(arg);
		if (a) {
			await openInBrowser(a.repo, 'file', a.newest.hash, a.file.path);
		}
	});
}
