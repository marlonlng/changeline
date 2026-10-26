import * as path from 'path';
import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { showError } from '../util';
import { showDialog } from '../webviews/dialogPanel';
import { createGist, createGitHubRepository, listUserRepositories } from './github';
import type { Fetcher } from './types';

const API = 'https://api.github.com';
const fetcher: Fetcher = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetcher>;

async function token(scopes: string[]): Promise<string> {
	const session = await vscode.authentication.getSession('github', scopes, { createIfNone: true });
	return session.accessToken;
}

/** JetBrains "Share Project on GitHub". */
export async function shareOnGitHub(repo: Repository | undefined): Promise<void> {
	const s = services();
	if (!repo) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}
		await s.git.exec(folder.uri.fsPath, ['init'], { log: true });
		repo = await s.repos.openRepository(folder.uri.fsPath);
		if (!repo) {
			return;
		}
	}
	const remotes = await repo.getRemotes();
	const result = await showDialog({
		title: vscode.l10n.t('Share Project on GitHub'),
		fields: [
			{ id: 'name', type: 'text', label: vscode.l10n.t('Repository name:'), value: path.basename(repo.root), required: true, focus: true, pattern: '^[A-Za-z0-9._-]+$', patternMessage: vscode.l10n.t('Letters, digits, ".", "_" and "-" only') },
			{ id: 'private', type: 'checkbox', label: vscode.l10n.t('Private'), value: true },
			{ id: 'remote', type: 'text', label: vscode.l10n.t('Remote:'), value: remotes.some((r) => r.name === 'origin') ? 'github' : 'origin', required: true },
			{ id: 'org', type: 'text', label: vscode.l10n.t('Organization:'), placeholder: vscode.l10n.t('empty = your account') },
			{ id: 'description', type: 'textarea', label: vscode.l10n.t('Description:'), rows: 3 },
		],
		okLabel: vscode.l10n.t('Share'),
		width: 560,
	});
	if (!result) {
		return;
	}
	const v = result.values;
	try {
		const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Sharing project on GitHub...') }, async () => {
			const r = await createGitHubRepository(API, await token(['repo']), fetcher, {
				name: String(v.name).trim(),
				description: String(v.description ?? ''),
				private: v.private === true,
				org: String(v.org ?? '').trim() || undefined,
			});
			await repo!.addRemote(String(v.remote).trim(), r.cloneUrl);
			if (repo!.state.head && repo!.state.branch) {
				await repo!.push({ remote: String(v.remote).trim(), source: 'HEAD', remoteBranch: repo!.state.branch, setUpstream: true });
			}
			return r;
		});
		const hasCommits = !!repo.state.head;
		const choice = await vscode.window.showInformationMessage(
			hasCommits ? vscode.l10n.t('Successfully shared project on GitHub: {0}', created.fullName) : vscode.l10n.t('Created {0}. Commit your files and push to publish them.', created.fullName),
			vscode.l10n.t('Open in Browser'),
		);
		if (choice) {
			await vscode.env.openExternal(vscode.Uri.parse(created.htmlUrl));
		}
	} catch (e) {
		await showError(e, vscode.l10n.t('Sharing on GitHub failed'));
	}
}

/** JetBrains "Create Gist..." for the current file or selection. */
export async function createGistFromEditor(uri?: vscode.Uri): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	let content: string;
	let fileName: string;
	if (editor && (!uri || editor.document.uri.toString() === uri.toString())) {
		content = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
		fileName = path.basename(editor.document.uri.path);
	} else if (uri) {
		content = (await vscode.workspace.fs.readFile(uri)).toString();
		fileName = path.basename(uri.path);
	} else {
		return;
	}
	const result = await showDialog({
		title: vscode.l10n.t('Create Gist'),
		fields: [
			{ id: 'name', type: 'text', label: vscode.l10n.t('File name:'), value: fileName, required: true },
			{ id: 'description', type: 'text', label: vscode.l10n.t('Description:'), focus: true },
			{ id: 'secret', type: 'checkbox', label: vscode.l10n.t('Secret'), value: true },
			{ id: 'open', type: 'checkbox', label: vscode.l10n.t('Open in browser'), value: true },
		],
		okLabel: vscode.l10n.t('Create'),
		width: 520,
	});
	if (!result) {
		return;
	}
	try {
		const url = await createGist(API, await token(['gist']), fetcher, {
			files: { [String(result.values.name).trim()]: content },
			description: String(result.values.description ?? ''),
			public: result.values.secret !== true,
		});
		await vscode.env.clipboard.writeText(url);
		if (result.values.open) {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
		void vscode.window.showInformationMessage(vscode.l10n.t('Gist created; the URL was copied to the clipboard: {0}', url));
	} catch (e) {
		await showError(e, vscode.l10n.t('Creating the gist failed'));
	}
}

/** Repository picker of the "Get from Version Control → GitHub" tab. */
export async function pickGitHubRepository(): Promise<string | undefined> {
	const repos = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Loading your GitHub repositories...') }, async () => listUserRepositories(API, await token(['repo', 'read:user']), fetcher));
	const pick = await vscode.window.showQuickPick(
		repos.map((r) => ({ label: `${r.private ? '$(lock)' : '$(repo)'} ${r.fullName}`, description: r.description, detail: vscode.l10n.t('updated {0}', new Date(r.updatedAt).toLocaleDateString(vscode.env.language)), repo: r })),
		{ title: vscode.l10n.t('Clone from GitHub'), matchOnDescription: true, placeHolder: vscode.l10n.t('Select a repository') },
	);
	if (!pick) {
		return undefined;
	}
	const protocol = await vscode.window.showQuickPick([{ label: 'HTTPS', url: pick.repo.cloneUrl }, { label: 'SSH', url: pick.repo.sshUrl }], { placeHolder: vscode.l10n.t('Clone with') });
	return protocol?.url;
}
