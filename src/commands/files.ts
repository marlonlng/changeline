import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fromGitUri } from '../content';
import { localChangeTarget, openDiff, revisionTarget } from '../diff';
import { services } from '../services';
import type { FileChange } from '../shared/types';
import { basename, capitalize, formatDate, plural, samePath, shortHash } from '../util';
import type { ChangesView } from '../views/changesView';
import { ComparePanel } from '../webviews/comparePanel';
import { ConflictsPanel } from '../webviews/conflictsPanel';
import { showDialog } from '../webviews/dialogPanel';
import { changedFilesUnder, rollbackDialog } from './changes';
import { CommandContext, confirm, handleOutcome, resolveRepo, uriOf } from './common';
import { openInBrowser } from './history';

function repoFile(arg: unknown) {
	const uri = uriOf(arg);
	if (!uri || uri.scheme !== 'file') {
		void vscode.window.showWarningMessage(vscode.l10n.t('Select a file in the workspace.'));
		return undefined;
	}
	const repo = services().repos.getRepository(uri);
	if (!repo) {
		void vscode.window.showWarningMessage(vscode.l10n.t('The file is not under Git version control.'));
		return undefined;
	}
	const rel = repo.relativePath(uri.fsPath);
	const isDir = fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory();
	return { uri, repo, rel, isDir };
}

function currentChange(repo: ReturnType<typeof repoFile> & object): FileChange {
	const st = repo.repo.state;
	return st.changes.find((c) => c.path === repo.rel) ?? st.untracked.find((c) => c.path === repo.rel) ?? { path: repo.rel, status: 'M' };
}

export function registerFileCommands(ctx: CommandContext, view: ChangesView): void {
	ctx.register('changeline.showDiff', async (arg?: unknown) => {
		const f = repoFile(arg);
		if (!f) {
			return;
		}
		if (f.isDir) {
			await ComparePanel.show({ repo: f.repo, title: vscode.l10n.t('Local Changes: {0}', f.rel || f.repo.name), left: 'HEAD', right: undefined, leftLabel: 'HEAD', rightLabel: vscode.l10n.t('Local'), paths: f.rel ? [f.rel] : undefined });
			return;
		}
		const change = currentChange(f);
		await openDiff({ targets: [localChangeTarget(f.repo, change, change.status === '?' ? 'unversioned' : 'changelist')], index: 0 });
	});
	ctx.register('changeline.compareWithRevision', async (arg?: unknown) => {
		const f = repoFile(arg);
		if (!f || f.isDir) {
			return;
		}
		const history = await f.repo.fileHistory(f.rel, { limit: 300 });
		const pick = await vscode.window.showQuickPick(
			history.map((c) => ({ label: `$(git-commit) ${shortHash(c.hash)}`, description: c.subject, detail: `${c.author} · ${formatDate(c.authorDate)}`, commit: c })),
			{ title: vscode.l10n.t('Compare {0} with Revision', basename(f.rel)), matchOnDescription: true, matchOnDetail: true },
		);
		if (!pick) {
			return;
		}
		const pathThen = pick.commit.files.find((x) => x.status !== 'D')?.path ?? f.rel;
		await openDiff({ targets: [{ ...revisionTarget(f.repo, pick.commit.hash, undefined, { path: f.rel, origPath: pathThen !== f.rel ? pathThen : undefined, status: 'M' }), leftTitle: shortHash(pick.commit.hash) }], index: 0 });
	});
	ctx.register('changeline.compareWithBranch', async (arg?: unknown) => {
		const f = repoFile(arg);
		if (!f) {
			return;
		}
		const refs = f.repo.refs.filter((r) => !r.current);
		const pick = await vscode.window.showQuickPick(
			refs.map((r) => ({ label: `${r.type === 'tag' ? '$(tag)' : r.type === 'remote' ? '$(cloud)' : '$(git-branch)'} ${r.shortName}`, ref: r.type === 'tag' ? `refs/tags/${r.shortName}` : r.shortName, name: r.shortName })),
			{ title: vscode.l10n.t('Compare {0} with Branch', f.rel || f.repo.name) },
		);
		if (!pick) {
			return;
		}
		if (f.isDir) {
			await ComparePanel.show({ repo: f.repo, title: vscode.l10n.t('Compare {0} with {1}', f.rel || f.repo.name, pick.name), left: pick.ref, right: undefined, leftLabel: pick.name, rightLabel: vscode.l10n.t('Local'), paths: f.rel ? [f.rel] : undefined });
			return;
		}
		const exists = await f.repo.getContentOrEmpty(pick.ref, f.rel);
		await openDiff({ targets: [{ ...revisionTarget(f.repo, pick.ref, undefined, { path: f.rel, status: exists ? 'M' : 'A' }), leftTitle: pick.name }], index: 0 });
	});
	ctx.register('changeline.showCurrentRevision', async (arg?: unknown) => {
		const f = repoFile(arg);
		if (!f) {
			return;
		}
		const [last] = await f.repo.log({ revisions: ['HEAD'], paths: [f.rel || '.'], limit: 1 });
		if (last) {
			await vscode.commands.executeCommand('changeline.showLog', { repo: f.repo.root, hash: last.hash });
		}
	});
	ctx.register('changeline.rollbackFile', async (arg?: unknown, args?: unknown[]) => {
		const uris = (Array.isArray(args) && args.length ? args : [arg]).map(uriOf).filter((u): u is vscode.Uri => !!u);
		const files = changedFilesUnder(view, uris);
		await rollbackDialog(view, files);
	});
	ctx.register('changeline.addFile', async (arg?: unknown, args?: unknown[]) => {
		const uris = (Array.isArray(args) && args.length ? args : [arg]).map(uriOf).filter((u): u is vscode.Uri => !!u);
		for (const u of uris) {
			const repo = services().repos.getRepository(u);
			if (repo) {
				await repo.add([repo.relativePath(u.fsPath) || '.']);
			}
		}
	});
	ctx.register('changeline.addToGitignore', async (arg?: unknown) => {
		const f = repoFile(arg);
		if (!f) {
			return;
		}
		const gitignore = path.join(f.repo.root, '.gitignore');
		let content = '';
		try {
			content = await fs.promises.readFile(gitignore, 'utf8');
		} catch {
		}
		const entry = '/' + f.rel + (f.isDir ? '/' : '');
		await fs.promises.writeFile(gitignore, content + (content && !content.endsWith('\n') ? '\n' : '') + entry + '\n', 'utf8');
		await f.repo.refresh();
		void vscode.window.showInformationMessage(vscode.l10n.t('Added {0} to .gitignore', entry));
	});
	ctx.register('changeline.openInBrowser', async (arg?: unknown) => {
		const f = repoFile(arg);
		if (!f) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		const lines: [number, number] | undefined = editor && samePath(editor.document.uri.fsPath, f.uri.fsPath) ? [editor.selection.start.line + 1, editor.selection.end.line + 1] : undefined;
		const ref = f.repo.state.upstream && f.repo.state.ahead === 0 ? f.repo.state.branch! : f.repo.state.head!;
		await openInBrowser(f.repo, 'file', ref, f.rel, lines);
	});

	ctx.register('changeline.resolveConflicts', () => ConflictsPanel.show());
	ctx.register('changeline.continueOperation', async (arg?: unknown) => {
		const repo = await resolveRepo(arg ?? services().repos.repositories.find((r) => r.state.operation !== 'none'));
		if (!repo) {
			return;
		}
		if (repo.state.conflicts.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Resolve the remaining conflicts first.'), vscode.l10n.t('Resolve...')).then((c) => c && ConflictsPanel.show());
			return;
		}
		if (repo.state.operation === 'merge') {
			await vscode.commands.executeCommand('changeline.commit', { message: (await repo.readGitFile('MERGE_MSG'))?.replace(/^#.*$/gm, '').trim() });
			return;
		}
		if (repo.state.unstaged.length && repo.state.operation !== 'none') {
			await repo.stage(repo.state.unstaged.map((c) => c.path));
		}
		const op = repo.state.operation;
		const outcome = await repo.continueOperation();
		await handleOutcome(repo, outcome, op === 'rebase' ? vscode.l10n.t('Rebase continued') : op === 'cherry-pick' ? vscode.l10n.t('Cherry-pick continued') : vscode.l10n.t('Operation continued'));
	});
	ctx.register('changeline.abortOperation', async (arg?: unknown) => {
		const repo = await resolveRepo(arg ?? services().repos.repositories.find((r) => r.state.operation !== 'none'));
		if (!repo || repo.state.operation === 'none') {
			return;
		}
		if (await confirm(vscode.l10n.t('Abort {0}? The repository returns to the state before the {1} started.', repo.state.operation, repo.state.operation), vscode.l10n.t('Abort'))) {
			await repo.abortOperation();
			void vscode.window.showInformationMessage(vscode.l10n.t('Aborted.'));
		}
	});
	ctx.register('changeline.skipCommit', async (arg?: unknown) => {
		const repo = await resolveRepo(arg ?? services().repos.repositories.find((r) => r.state.operation !== 'none'));
		if (repo) {
			await handleOutcome(repo, await repo.skipOperation(), vscode.l10n.t('Skipped commit'));
		}
	});
	ctx.register('changeline.applyPatch', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (!repo) {
			return;
		}
		const uris = await vscode.window.showOpenDialog({ filters: { Patch: ['patch', 'diff'] }, defaultUri: vscode.Uri.file(repo.root) });
		if (!uris?.length) {
			return;
		}
		const patchFile = uris[0].fsPath;
		const text = await fs.promises.readFile(patchFile, 'utf8');
		const files = [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]);
		const result = await showDialog({
			title: vscode.l10n.t('Apply Patch'),
			description: `${basename(uris[0].path)} → ${repo.name}`,
			fields: [
				{ id: 'files', type: 'checklist', label: plural(files.length, '{0} file', '{0} files'), options: files.map((f) => ({ value: f, label: f })) },
				{ id: 'threeWay', type: 'checkbox', label: vscode.l10n.t('Use three-way merge when the patch does not apply cleanly (--3way)'), value: true },
				{ id: 'index', type: 'checkbox', label: vscode.l10n.t('Also stage the changes (--index)'), value: false },
			],
			okLabel: vscode.l10n.t('Apply'),
			width: 640,
		});
		if (!result) {
			return;
		}
		const chosen = result.values.files as string[];
		const include = chosen.length === files.length ? [] : chosen;
		if (!chosen.length) {
			return;
		}
		const check = await repo.applyPatch(patchFile, { check: true, include, index: result.values.index === true });
		const outcome = check.ok || !result.values.threeWay
			? await repo.applyPatch(patchFile, { include, index: result.values.index === true })
			: await repo.applyPatch(patchFile, { include, threeWay: true });
		await handleOutcome(repo, outcome, vscode.l10n.t('Applied {0} ({1})', basename(uris[0].path), plural(chosen.length, '{0} file', '{0} files')));
	});
	ctx.register('changeline.vcsOperations', async () => {
		const repo = services().repos.current();
		const editor = vscode.window.activeTextEditor;
		const inRepo = !!(editor && services().repos.getRepository(editor.document.uri));
		const items: (vscode.QuickPickItem & { cmd?: string })[] = [];
		if (repo && repo.state.operation !== 'none') {
			items.push(
				{ label: vscode.l10n.t('{0} in progress', capitalize(repo.state.operation)), kind: vscode.QuickPickItemKind.Separator },
				...(repo.state.conflicts.length ? [{ label: vscode.l10n.t('$(warning) Resolve Conflicts...'), cmd: 'changeline.resolveConflicts' }] : []),
				{ label: vscode.l10n.t('$(debug-continue) Continue'), cmd: 'changeline.continueOperation' },
				...(repo.state.operation === 'rebase' || repo.state.operation === 'cherry-pick' ? [{ label: vscode.l10n.t('$(debug-step-over) Skip Commit'), cmd: 'changeline.skipCommit' }] : []),
				{ label: vscode.l10n.t('$(debug-stop) Abort'), cmd: 'changeline.abortOperation' },
			);
		}
		items.push(
			{ label: vscode.l10n.t('Git'), kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(check) Commit...'), description: '⌘K', cmd: 'changeline.commit' },
			{ label: vscode.l10n.t('$(arrow-up) Push...'), description: '⇧⌘K', cmd: 'changeline.push' },
			{ label: vscode.l10n.t('$(arrow-down) Update Project...'), description: '⌘T', cmd: 'changeline.updateProject' },
			{ label: vscode.l10n.t('$(git-pull-request) Pull...'), cmd: 'changeline.pull' },
			{ label: vscode.l10n.t('$(repo-fetch) Fetch'), cmd: 'changeline.fetch' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(git-branch) Branches...'), cmd: 'changeline.branches' },
			{ label: vscode.l10n.t('$(add) New Branch...'), cmd: 'changeline.newBranch' },
			{ label: vscode.l10n.t('$(tag) New Tag...'), cmd: 'changeline.newTag' },
			{ label: vscode.l10n.t('$(git-merge) Merge...'), cmd: 'changeline.merge' },
			{ label: vscode.l10n.t('$(git-pull-request-go-to-changes) Rebase...'), cmd: 'changeline.rebase' },
			{ label: vscode.l10n.t('$(discard) Reset HEAD...'), cmd: 'changeline.resetHead' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(archive) Stash Changes...'), cmd: 'changeline.stashChanges' },
			{ label: vscode.l10n.t('$(archive) Unstash Changes...'), cmd: 'changeline.unstashChanges' },
			{ label: vscode.l10n.t('$(inbox) Shelve Changes...'), cmd: 'changeline.shelveChanges' },
			{ label: vscode.l10n.t('$(discard) Rollback...'), cmd: 'changeline.changes.rollback' },
			{ label: vscode.l10n.t('$(history) Show Git Log'), cmd: 'changeline.showLog' },
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(git-pull-request-create) Create Pull Request...'), cmd: 'changeline.pullRequests.create' },
			{ label: vscode.l10n.t('$(git-pull-request) View Pull Requests'), cmd: 'changeline.pullRequests.show' },
			{ label: vscode.l10n.t('$(github) Share Project on GitHub...'), cmd: 'changeline.github.share' },
			{ label: vscode.l10n.t('$(github) Create Gist...'), cmd: 'changeline.github.createGist' },
			{ label: vscode.l10n.t('$(repo-forked) Sync Fork'), cmd: 'changeline.github.syncFork' },
		);
		if (inRepo) {
			items.push(
				{ label: vscode.l10n.t('Current File'), kind: vscode.QuickPickItemKind.Separator },
				{ label: vscode.l10n.t('$(diff) Show Diff'), description: '⌘D', cmd: 'changeline.showDiff' },
				{ label: vscode.l10n.t('$(history) Show History'), cmd: 'changeline.showHistory' },
				{ label: vscode.l10n.t('$(person) Annotate with Git Blame'), cmd: 'changeline.annotate' },
				{ label: vscode.l10n.t('$(git-compare) Compare with Revision...'), cmd: 'changeline.compareWithRevision' },
				{ label: vscode.l10n.t('$(git-compare) Compare with Branch...'), cmd: 'changeline.compareWithBranch' },
				{ label: vscode.l10n.t('$(clippy) Compare with Clipboard'), cmd: 'changeline.compareWithClipboard' },
				{ label: vscode.l10n.t('$(discard) Rollback...'), cmd: 'changeline.rollbackFile' },
				{ label: vscode.l10n.t('$(link-external) Open in Browser'), cmd: 'changeline.openInBrowser' },
			);
		}
		items.push(
			{ label: vscode.l10n.t('More'), kind: vscode.QuickPickItemKind.Separator },
			{ label: vscode.l10n.t('$(file-diff) Create Patch...'), cmd: 'changeline.changes.createPatch' },
			{ label: vscode.l10n.t('$(file-add) Apply Patch...'), cmd: 'changeline.applyPatch' },
			{ label: vscode.l10n.t('$(cloud) Manage Remotes...'), cmd: 'changeline.manageRemotes' },
			{ label: vscode.l10n.t('$(repo-forked) Manage Worktrees...'), cmd: 'changeline.worktrees' },
			{ label: vscode.l10n.t('$(repo-clone) Clone...'), cmd: 'changeline.clone' },
			{ label: vscode.l10n.t('$(output) Show Git Console'), cmd: 'changeline.showConsole' },
		);
		const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('VCS Operations'), placeHolder: repo ? `${repo.name} · ${repo.state.branch ?? 'detached'}${repo.state.changes.length ? ` · ${plural(repo.state.changes.length, '{0} change', '{0} changes')}` : ''}` : undefined });
		if (pick?.cmd) {
			await vscode.commands.executeCommand(pick.cmd);
		}
	});
	ctx.register('changeline.openRevisionFile', async (uri?: vscode.Uri) => {
		const p = uri && fromGitUri(uri);
		if (p) {
			await vscode.window.showTextDocument(vscode.Uri.file(path.join(p.repo, ...p.path.split('/'))));
		}
	});
}

