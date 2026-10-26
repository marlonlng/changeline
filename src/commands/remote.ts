import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { config, plural, showError } from '../util';
import { ComparePanel } from '../webviews/comparePanel';
import { showDialog } from '../webviews/dialogPanel';
import { PushPanel } from '../webviews/pushPanel';
import { CommandContext, gitProgress, handleOutcome, hasLocalChanges, resolveRepo, restoreStash, withProgress, withSmartStash } from './common';

export async function fetchAll(repos: readonly Repository[], silent = false): Promise<void> {
	if (!repos.length) {
		return;
	}
	const run = async (report: (m: string) => void) => {
		const errors: string[] = [];
		for (const r of repos) {
			const remotes = await r.getRemotes();
			if (!remotes.length) {
				continue;
			}
			try {
				report(repos.length > 1 ? r.name : '');
				await r.fetch(undefined, { onProgress: gitProgress(report) });
			} catch (e) {
				errors.push(`${r.name}: ${(e as Error).message}`);
			}
		}
		return errors;
	};
	const errors = silent ? await run(() => undefined) : await withProgress(vscode.l10n.t('Fetching...'), run);
	if (errors.length) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Fetch failed: {0}', errors.join('; ')), vscode.l10n.t('Show Console')).then((c) => c && vscode.commands.executeCommand('changeline.showConsole'));
	} else if (!silent) {
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Fetch successful'), 4000);
	}
}

interface UpdateSummary {
	repo: Repository;
	before?: string;
	after?: string;
	commits: number;
	files: number;
}

/** JetBrains "Update Project" (⌘T): fetch, then merge or rebase every tracked branch. */
export async function updateProject(repos: readonly Repository[]): Promise<void> {
	let method = config<'merge' | 'rebase' | 'ask' | 'branchDefault'>('update.method', 'ask');
	if (method === 'ask') {
		const result = await showDialog({
			title: vscode.l10n.t('Update Project'),
			fields: [
				{
					id: 'method',
					type: 'radio',
					label: vscode.l10n.t('Update type:'),
					value: services().context.workspaceState.get('changeline.update.lastMethod', 'merge'),
					options: [
						{ value: 'merge', label: vscode.l10n.t('Merge incoming changes into the current branch') },
						{ value: 'rebase', label: vscode.l10n.t('Rebase the current branch on top of incoming changes') },
						{ value: 'branchDefault', label: vscode.l10n.t('Use branch default'), description: 'pull.rebase / branch.<name>.rebase' },
					],
				},
				{ id: 'remember', type: 'checkbox', label: vscode.l10n.t('Don\'t show again'), description: vscode.l10n.t('Can be changed in settings (changeline.update.method).') },
			],
			okLabel: 'OK',
			width: 520,
		});
		if (!result) {
			return;
		}
		method = result.values.method as 'merge' | 'rebase' | 'branchDefault';
		await services().context.workspaceState.update('changeline.update.lastMethod', method);
		if (result.values.remember) {
			await vscode.workspace.getConfiguration('changeline').update('update.method', method, vscode.ConfigurationTarget.Global);
		}
	}
	const summaries: UpdateSummary[] = [];
	const skipped: string[] = [];
	await withProgress(vscode.l10n.t('Updating project...'), async (report) => {
		for (const repo of repos) {
			const st = repo.state;
			if (!st.branch || st.detached) {
				skipped.push(vscode.l10n.t('{0}: not on a branch', repo.name));
				continue;
			}
			if (!st.upstream) {
				skipped.push(vscode.l10n.t("{0}: no tracked branch configured for '{1}'", repo.name, st.branch ?? ''));
				continue;
			}
			const remote = st.upstream.split('/')[0];
			report(vscode.l10n.t('Fetching {0}...', repo.name));
			try {
				await repo.fetch(remote, { onProgress: gitProgress(report) });
			} catch (e) {
				await showError(e, vscode.l10n.t('Fetch failed for {0}', repo.name));
				continue;
			}
			await repo.refresh();
			if (repo.state.behind === 0) {
				summaries.push({ repo, commits: 0, files: 0 });
				continue;
			}
			const before = repo.state.head;
			let useRebase = method === 'rebase';
			if (method === 'branchDefault') {
				const cfg = (await repo.getConfig(`branch.${st.branch}.rebase`)) ?? (await repo.getConfig('pull.rebase'));
				useRebase = !!cfg && cfg !== 'false';
			}
			const stashed = hasLocalChanges(repo) ? await repo.stash({ message: vscode.l10n.t('Changeline: uncommitted changes before update') }) : false;
			report(useRebase ? vscode.l10n.t('Rebasing {0}...', repo.name) : vscode.l10n.t('Merging {0}...', repo.name));
			const outcome = useRebase ? await repo.rebase('@{u}') : await repo.merge('@{u}');
			await repo.refresh();
			if (!outcome.ok) {
				if (outcome.conflicts) {
					if (stashed) {
						void vscode.window.showInformationMessage(vscode.l10n.t('Local changes of {0} were stashed before updating. Unstash them after resolving the conflicts.', repo.name));
					}
					void vscode.commands.executeCommand('changeline.resolveConflicts');
				} else if (outcome.error) {
					if (stashed) {
						await restoreStash(repo);
					}
					await showError(outcome.error, vscode.l10n.t('Update failed for {0}', repo.name));
				}
				continue;
			}
			if (stashed) {
				await restoreStash(repo);
			}
			if (config('update.submodules', true) && fs.existsSync(path.join(repo.root, '.gitmodules'))) {
				report(vscode.l10n.t('Updating submodules of {0}...', repo.name));
				await repo.runOp(['submodule', 'update', '--init', '--recursive']).catch((e) => showError(e, vscode.l10n.t('Submodule update failed')));
			}
			const after = repo.state.head;
			let commits = 0;
			let files = 0;
			if (before && after && before !== after) {
				commits = Number((await repo.run(['rev-list', '--count', `${before}..${after}`])).stdout.trim()) || 0;
				files = (await repo.diffFiles(before, after)).length;
			}
			summaries.push({ repo, before, after, commits, files });
		}
	});
	for (const s of skipped) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Update skipped: {0}', s));
	}
	const changed = summaries.filter((s) => s.commits > 0);
	if (!changed.length) {
		if (summaries.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('All files are up-to-date.'));
		}
		return;
	}
	const files = changed.reduce((n, s) => n + s.files, 0);
	const commits = changed.reduce((n, s) => n + s.commits, 0);
	const choice = await vscode.window.showInformationMessage(vscode.l10n.t('{0} updated in {1}', plural(files, '{0} file', '{0} files'), plural(commits, '{0} commit', '{0} commits')), vscode.l10n.t('View Commits'), vscode.l10n.t('Show Files'));
	const first = changed[0];
	if (choice === vscode.l10n.t('View Commits')) {
		await vscode.commands.executeCommand('changeline.showLog', { repo: first.repo.root, revisions: [`${first.before}..${first.after}`], title: vscode.l10n.t('Updated') });
	} else if (choice === vscode.l10n.t('Show Files')) {
		await ComparePanel.show({ repo: first.repo, title: vscode.l10n.t('Update Info: {0}', first.repo.name), left: first.before!, right: first.after!, leftLabel: first.before!.slice(0, 8), rightLabel: first.after!.slice(0, 8) });
	}
}

export async function pullDialog(repo: Repository): Promise<void> {
	const remotes = await repo.getRemotes();
	if (!remotes.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t('No remotes configured. Add one via "Manage Remotes".'));
		return;
	}
	const upstream = repo.state.upstream;
	const defRemote = upstream?.split('/')[0] ?? remotes[0].name;
	const remoteBranches = repo.refs.filter((r) => r.type === 'remote');
	const result = await showDialog({
		title: vscode.l10n.t('Pull to {0}', repo.state.branch ?? 'HEAD'),
		fields: [
			{ id: 'remote', type: 'select', label: vscode.l10n.t('Remote:'), value: defRemote, options: remotes.map((r) => ({ value: r.name, label: `${r.name} (${r.fetchUrl ?? ''})` })) },
			{
				id: 'branch',
				type: 'combo',
				label: vscode.l10n.t('Branch:'),
				value: upstream ? upstream.slice(defRemote.length + 1) : repo.state.branch ?? '',
				options: remoteBranches.map((b) => ({ value: b.shortName.slice((b.remote?.length ?? 0) + 1), label: b.shortName })),
				required: true,
				focus: true,
			},
			{ id: 'rebase', type: 'checkbox', label: vscode.l10n.t('Rebase (--rebase)'), value: (await repo.getConfig('pull.rebase')) === 'true' },
			{ id: 'ffonly', type: 'checkbox', label: vscode.l10n.t('Fast-forward only (--ff-only)') },
			{ id: 'noff', type: 'checkbox', label: vscode.l10n.t('Create a merge commit (--no-ff)') },
			{ id: 'squash', type: 'checkbox', label: vscode.l10n.t('Squash commits (--squash)') },
			{ id: 'nocommit', type: 'checkbox', label: vscode.l10n.t('Do not commit (--no-commit)') },
			{ id: 'noverify', type: 'checkbox', label: vscode.l10n.t('Bypass hooks (--no-verify)') },
		],
		okLabel: vscode.l10n.t('Pull'),
	});
	if (!result) {
		return;
	}
	const v = result.values;
	const remote = String(v.remote);
	const branch = String(v.branch).trim();
	const outcome = await withProgress(vscode.l10n.t('Pulling {0}...', `${remote}/${branch}`), (report) =>
		withSmartStash(repo, vscode.l10n.t('Pull'), () =>
			repo.pull(remote, [branch], {
				rebase: v.rebase === true,
				ffOnly: v.ffonly === true,
				noFf: v.noff === true,
				squash: v.squash === true,
				noCommit: v.nocommit === true,
				noVerify: v.noverify === true,
				onProgress: gitProgress(report),
			}),
		),
	);
	await handleOutcome(repo, outcome, vscode.l10n.t('Pulled {0}/{1}', remote, branch));
}

export async function manageRemotes(repo: Repository): Promise<void> {
	for (;;) {
		const remotes = await repo.getRemotes();
		const edit = { iconPath: new vscode.ThemeIcon('edit'), tooltip: vscode.l10n.t('Edit') };
		const remove = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Remove') };
		const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { remote?: string; add?: boolean }>();
		qp.title = vscode.l10n.t('Git Remotes · {0}', repo.name);
		qp.items = [
			...remotes.map((r) => ({ label: `$(cloud) ${r.name}`, description: r.fetchUrl, detail: r.pushUrl && r.pushUrl !== r.fetchUrl ? vscode.l10n.t('push: {0}', r.pushUrl) : undefined, remote: r.name, buttons: [edit, remove] })),
			{ label: vscode.l10n.t('$(add) Add Remote...'), add: true },
		];
		const action = await new Promise<{ type: 'add' | 'edit' | 'remove'; remote?: string } | undefined>((resolve) => {
			qp.onDidAccept(() => {
				const it = qp.selectedItems[0];
				resolve(it?.add ? { type: 'add' } : it?.remote ? { type: 'edit', remote: it.remote } : undefined);
				qp.hide();
			});
			qp.onDidTriggerItemButton((e) => {
				resolve({ type: e.button === remove ? 'remove' : 'edit', remote: e.item.remote });
				qp.hide();
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
		});
		qp.dispose();
		if (!action) {
			return;
		}
		try {
			if (action.type === 'add') {
				const result = await showDialog({
					title: vscode.l10n.t('Define Remote'),
					fields: [
						{ id: 'name', type: 'text', label: vscode.l10n.t('Name:'), value: remotes.length ? '' : 'origin', required: true, pattern: '^[^\\s/]+$', patternMessage: vscode.l10n.t('Invalid remote name') },
						{ id: 'url', type: 'text', label: vscode.l10n.t('URL:'), required: true, focus: true, placeholder: 'https://example.com/user/repo.git' },
					],
					okLabel: vscode.l10n.t('Add'),
				});
				if (result) {
					await repo.addRemote(String(result.values.name).trim(), String(result.values.url).trim());
				}
			} else if (action.type === 'remove' && action.remote) {
				const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Remove remote \'{0}\'?', action.remote), { modal: true }, vscode.l10n.t('Remove'));
				if (choice) {
					await repo.removeRemote(action.remote);
				}
			} else if (action.type === 'edit' && action.remote) {
				const r = remotes.find((x) => x.name === action.remote)!;
				const result = await showDialog({
					title: vscode.l10n.t('Edit Remote'),
					fields: [
						{ id: 'name', type: 'text', label: vscode.l10n.t('Name:'), value: r.name, required: true },
						{ id: 'url', type: 'text', label: vscode.l10n.t('URL:'), value: r.fetchUrl ?? '', required: true, focus: true },
					],
					okLabel: vscode.l10n.t('Save'),
				});
				if (result) {
					const name = String(result.values.name).trim();
					if (name !== r.name) {
						await repo.renameRemote(r.name, name);
					}
					if (String(result.values.url).trim() !== r.fetchUrl) {
						await repo.setRemoteUrl(name, String(result.values.url).trim());
					}
				}
			}
		} catch (e) {
			await showError(e);
		}
	}
}

export async function cloneRepository(): Promise<void> {
	const source = await vscode.window.showQuickPick(
		[
			{ label: vscode.l10n.t('$(link) Repository URL'), id: 'url' },
			{ label: vscode.l10n.t('$(github) GitHub'), description: vscode.l10n.t('your repositories and organizations'), id: 'github' },
		],
		{ title: vscode.l10n.t('Get from Version Control') },
	);
	if (!source) {
		return;
	}
	let presetUrl = '';
	if (source.id === 'github') {
		const { pickGitHubRepository } = await import('../hosting/githubAccount');
		presetUrl = (await pickGitHubRepository()) ?? '';
		if (!presetUrl) {
			return;
		}
	}
	const result = await showDialog({
		title: vscode.l10n.t('Get from Version Control'),
		fields: [
			{ id: 'url', type: 'text', label: vscode.l10n.t('URL:'), required: true, focus: !presetUrl, value: presetUrl, placeholder: 'https://github.com/user/repo.git' },
			{ id: 'dir', type: 'text', label: vscode.l10n.t('Directory:'), required: true, value: path.join(os.homedir(), 'Projects'), description: vscode.l10n.t('Parent directory; the repository folder is created inside it.') },
		],
		okLabel: vscode.l10n.t('Clone'),
		width: 640,
	});
	if (!result) {
		return;
	}
	const url = String(result.values.url).trim();
	const parent = String(result.values.dir).trim();
	const name = url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '') || 'repository';
	const target = path.join(parent, name);
	if (fs.existsSync(target) && fs.readdirSync(target).length) {
		void vscode.window.showErrorMessage(vscode.l10n.t('Directory {0} already exists and is not empty.', target));
		return;
	}
	await fs.promises.mkdir(parent, { recursive: true });
	const git = services().git;
	try {
		await withProgress(vscode.l10n.t('Cloning {0}...', name), (report, token) => git.exec(parent, ['clone', '--progress', url, target], { log: true, onStderr: gitProgress(report), cancel: token }), true);
	} catch (e) {
		await showError(e, vscode.l10n.t('Clone failed'));
		return;
	}
	const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Cloned {0} into {1}.', name, target), vscode.l10n.t('Open'), vscode.l10n.t('Open in New Window'), vscode.l10n.t('Add to Workspace'));
	const uri = vscode.Uri.file(target);
	if (choice === vscode.l10n.t('Open')) {
		await vscode.commands.executeCommand('vscode.openFolder', uri, false);
	} else if (choice === vscode.l10n.t('Open in New Window')) {
		await vscode.commands.executeCommand('vscode.openFolder', uri, true);
	} else if (choice === vscode.l10n.t('Add to Workspace')) {
		vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
	}
}

export async function initRepository(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	let dir: string | undefined;
	if (folders.length === 1) {
		dir = folders[0].uri.fsPath;
	} else {
		const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: folders[0]?.uri, openLabel: vscode.l10n.t('Create Git Repository') });
		dir = pick?.[0]?.fsPath;
	}
	if (!dir) {
		return;
	}
	await services().git.exec(dir, ['init'], { log: true });
	const repo = await services().repos.openRepository(dir);
	void vscode.window.showInformationMessage(vscode.l10n.t('Created Git repository in {0}', dir));
	if (repo) {
		await services().repos.scan();
	}
}

export function registerRemoteCommands(ctx: CommandContext): void {
	ctx.register('changeline.fetch', async (arg?: unknown) => {
		const repos = arg ? [await resolveRepo(arg)].filter((r): r is Repository => !!r) : services().repos.repositories;
		await fetchAll(repos);
	});
	ctx.register('changeline.pull', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await pullDialog(repo);
		}
	});
	ctx.register('changeline.updateProject', async (arg?: unknown) => {
		const repos = arg ? [await resolveRepo(arg)].filter((r): r is Repository => !!r) : services().repos.repositories;
		await updateProject(repos);
	});
	ctx.register('changeline.push', async (arg?: unknown) => {
		const s = services();
		let repos: Repository[];
		if (arg) {
			const r = await resolveRepo(arg);
			repos = r ? [r] : [];
		} else {
			repos = s.repos.repositories.filter((r) => r.state.branch && !r.state.detached);
			const current = s.repos.current();
			repos.sort((a, b) => (a === current ? -1 : b === current ? 1 : 0));
			repos = repos.filter((r) => r === current || r.state.ahead > 0 || !r.state.upstream);
		}
		if (!repos.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to push.'));
			return;
		}
		await PushPanel.show({ repos });
	});
	ctx.register('changeline.manageRemotes', async (arg?: unknown) => {
		const repo = await resolveRepo(arg);
		if (repo) {
			await manageRemotes(repo);
		}
	});
	ctx.register('changeline.clone', cloneRepository);
	ctx.register('changeline.init', initRepository);
}
