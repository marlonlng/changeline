import type * as vscode from 'vscode';
import type { ChangelistManager } from './changelists';
import type { GitCli } from './git/gitCli';
import type { RepositoryManager } from './git/repositoryManager';
import type { ShelfManager } from './shelf';

export interface Services {
	context: vscode.ExtensionContext;
	git: GitCli;
	repos: RepositoryManager;
	changelists: ChangelistManager;
	shelf: ShelfManager;
	console: vscode.LogOutputChannel;
	scriptsDir: string;
}

let current: Services | undefined;

export function services(): Services {
	if (!current) {
		throw new Error('Changeline is not initialised');
	}
	return current;
}

export function setServices(s: Services | undefined): void {
	current = s;
}
