import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlameController, registerAnnotateCommands } from './annotate';
import { AskpassServer } from './askpass/askpassServer';
import { ChangelistManager } from './changelists';
import { registerBranchCommands } from './commands/branches';
import { registerChangesCommands } from './commands/changes';
import { commandDialogOverlay, makeRegistrar } from './commands/common';
import { registerFileCommands } from './commands/files';
import { registerHistoryCommands } from './commands/history';
import { registerRemoteCommands } from './commands/remote';
import { registerStashShelfCommands } from './commands/stashShelf';
import { registerWorktreeCommands } from './commands/worktrees';
import { registerExtraCommands } from './commands/extras';
import * as multi from './commands/multiBranch';
import * as hosting from './hosting/service';
import { CommitController } from './commit';
import { GIT_SCHEME, GitContentProvider, TEXT_SCHEME, TextContentProvider } from './content';
import { findGit, GitCli } from './git/gitCli';
import { RepositoryManager } from './git/repositoryManager';
import { services, setServices } from './services';
import { ShelfManager } from './shelf';
import { StatusBar } from './statusBar';
import { config } from './util';
import type { DialogOverlay } from './webviews/dialogOverlay';
import { setDialogResponder } from './webviews/dialogPanel';
import { DiffPanel } from './webviews/diffPanel';
import { ChangesView } from './views/changesView';
import { CommitMessageView } from './views/commitMessageView';
import { StatusDecorationProvider } from './views/decorations';
import { LogViewProvider } from './views/logController';
import { createPullRequest, PullRequestsView } from './views/pullRequestsView';
import { ScmIntegration } from './views/scmProvider';
import { ShelfView } from './views/shelfView';
import { StashView } from './views/stashView';

export interface ChangelineApi {
	readonly repositories: () => { root: string; branch?: string }[];
	readonly _test: { changesView: ChangesView; commit: CommitController; logView: LogViewProvider; blame: BlameController; services: typeof services; multi: typeof multi; pullRequests: PullRequestsView; hosting: typeof hosting; scm: ScmIntegration; setDialogResponder: typeof setDialogResponder; diffPanel: () => DiffPanel | undefined; commitDialogs: DialogOverlay };
}

export async function activate(context: vscode.ExtensionContext): Promise<ChangelineApi | undefined> {
	const output = vscode.window.createOutputChannel(vscode.l10n.t('Changeline Console'), { log: true });
	context.subscriptions.push(output);

	let found: { path: string; version: string };
	try {
		const builtinGitPath = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
		const hints = [config<string>('path', ''), ...(Array.isArray(builtinGitPath) ? builtinGitPath : [builtinGitPath])];
		found = await findGit(hints);
	} catch (e) {
		const choice = await vscode.window.showErrorMessage(vscode.l10n.t('Changeline: {0}', (e as Error).message), vscode.l10n.t('Open Settings'));
		if (choice) {
			void vscode.commands.executeCommand('workbench.action.openSettings', 'changeline.path');
		}
		return undefined;
	}
	output.info(`Using git ${found.version} at ${found.path}`);

	const scriptsDir = path.join(context.globalStorageUri.fsPath, 'scripts');
	await fs.promises.mkdir(scriptsDir, { recursive: true });
	const seqEditor = path.join(scriptsDir, 'sequence-editor.sh');
	await fs.promises.writeFile(seqEditor, '#!/bin/sh\ncat "$CHANGELINE_REBASE_TODO" > "$1"\n', { mode: 0o755 });
	await fs.promises.chmod(seqEditor, 0o755);

	let askpassEnv: NodeJS.ProcessEnv = {};
	if (config('askpass.enabled', true)) {
		try {
			const askpass = new AskpassServer(scriptsDir, context.extensionPath);
			await askpass.start();
			askpassEnv = await askpass.env();
			context.subscriptions.push(askpass);
		} catch (e) {
			output.warn(`Credential prompts are disabled: ${(e as Error).message}`);
		}
	}

	const git = new GitCli(found.path, found.version, (line, kind) => {
		if (kind === 'command') {
			output.info(line);
		} else if (kind === 'error') {
			output.error(line);
		} else {
			output.trace(line);
			if (config('console.showOutput', true)) {
				for (const l of line.split(/\r?\n/).filter((x) => x.trim() && !/\d+%/.test(x))) {
					output.info(`  ${l}`);
				}
			}
		}
	}, askpassEnv);

	const repos = new RepositoryManager(git);
	const changelists = new ChangelistManager(context.workspaceState);
	const shelfDir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'shelf');
	const shelf = new ShelfManager(shelfDir);
	context.subscriptions.push(repos, changelists);
	setServices({ context, git, repos, changelists, shelf, console: output, scriptsDir });

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()),
		vscode.workspace.registerTextDocumentContentProvider(TEXT_SCHEME, new TextContentProvider()),
	);
	const decorations = new StatusDecorationProvider();
	context.subscriptions.push(decorations, vscode.window.registerFileDecorationProvider(decorations));

	const changesView = new ChangesView();
	const commit = new CommitController(changesView);
	const messageView = new CommitMessageView(context.extensionUri, commit, changesView);
	const shelfView = new ShelfView();
	const stashView = new StashView();
	const logView = new LogViewProvider(context.extensionUri);
	const pullRequests = new PullRequestsView(context.extensionUri);
	const blame = new BlameController();
	const statusBar = new StatusBar();
	const scm = new ScmIntegration();
	context.subscriptions.push(
		changesView,
		commit,
		messageView,
		shelfView,
		stashView,
		logView,
		blame,
		statusBar,
		scm,
		vscode.window.registerWebviewViewProvider(CommitMessageView.viewId, messageView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider(LogViewProvider.viewId, logView, { webviewOptions: { retainContextWhenHidden: true } }),
		pullRequests,
		vscode.window.registerWebviewViewProvider(PullRequestsView.viewId, pullRequests, { webviewOptions: { retainContextWhenHidden: true } }),
	);

	const ctx = makeRegistrar(context, (id, args) => commandDialogOverlay(id, args, messageView.dialogs));
	registerBranchCommands(ctx);
	registerRemoteCommands(ctx);
	registerChangesCommands(ctx, changesView, commit, messageView);
	registerStashShelfCommands(ctx, stashView, shelfView);
	registerHistoryCommands(ctx, logView, commit);
	registerFileCommands(ctx, changesView);
	registerAnnotateCommands(ctx, blame);
	registerWorktreeCommands(ctx);
	registerExtraCommands(ctx);
	ctx.register('changeline.refresh', async () => {
		await repos.scan();
	});
	ctx.register('changeline.pullRequests.create', async (arg?: unknown) => {
		const { resolveRepo } = await import('./commands/common');
		const repo = await resolveRepo(arg);
		if (repo) {
			await createPullRequest(repo);
			pullRequests.refresh();
		}
	});
	ctx.register('changeline.github.share', async () => {
		const { shareOnGitHub } = await import('./hosting/githubAccount');
		await shareOnGitHub(repos.current());
	});
	ctx.register('changeline.github.createGist', async (uri?: vscode.Uri) => {
		const { createGistFromEditor } = await import('./hosting/githubAccount');
		await createGistFromEditor(uri instanceof vscode.Uri ? uri : undefined);
	});
	ctx.register('changeline.pullRequests.show', () => vscode.commands.executeCommand('changeline.pullRequests.focus'));
	ctx.register('changeline.pullRequests.refresh', () => pullRequests.refresh());
	ctx.register('changeline.hosting.signOut', async () => {
		const { resolveRepo } = await import('./commands/common');
		const { detectHosting } = await import('./hosting/detect');
		const { forgetHosting, setToken } = await import('./hosting/service');
		const repo = await resolveRepo();
		const target = repo && detectHosting(await repo.getRemotes(), config<string[]>('github.enterpriseHosts', []), config<string[]>('gitlab.hosts', []));
		if (target) {
			await setToken(target, undefined);
			forgetHosting();
			void vscode.window.showInformationMessage(vscode.l10n.t('Forgot the stored access token for {0}. GitHub.com sessions are managed in the Accounts menu.', target.host));
		}
	});

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('changeline.path')) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Reload the window to use the new Git executable.'), vscode.l10n.t('Reload')).then((c) => {
					if (c) {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
			if (e.affectsConfiguration('changeline.repositoryScanMaxDepth')) {
				void repos.scan();
			}
		}),
	);

	const showIgnored = config('changes.showIgnored', false);
	await repos.scan();
	for (const r of repos.repositories) {
		r.showIgnored = showIgnored;
	}
	if (showIgnored) {
		await Promise.all(repos.repositories.map((r) => r.refresh()));
	}
	if (!commit.message) {
		void commit.loadTemplate();
	}
	output.info(`Found ${repos.repositories.length} repositor${repos.repositories.length === 1 ? 'y' : 'ies'}: ${repos.repositories.map((r) => r.root).join(', ')}`);

	return {
		repositories: () => services().repos.repositories.map((r) => ({ root: r.root, branch: r.state.branch })),
		_test: { changesView, commit, logView, blame, services, multi, pullRequests, hosting, scm, setDialogResponder, diffPanel: () => DiffPanel.open, commitDialogs: messageView.dialogs },
	};
}

export function deactivate(): void {
	setServices(undefined);
}
