import * as path from 'path';
import * as vscode from 'vscode';
import { GitError } from './git/gitCli';
import { pathKey } from './paths';
import { relativeTime } from './shared/relativeTime';
import type { ChangeStatus } from './shared/types';

export function config<T>(key: string, fallback: T, scope?: vscode.Uri): T {
	return vscode.workspace.getConfiguration('changeline', scope).get<T>(key, fallback);
}

export function errorMessage(e: unknown): string {
	if (e instanceof GitError) {
		return e.summary;
	}
	if (e instanceof Error) {
		return e.message;
	}
	return String(e);
}

export async function showError(e: unknown, prefix?: string): Promise<void> {
	const msg = errorMessage(e);
	const choice = await vscode.window.showErrorMessage(prefix ? `${prefix}: ${msg}` : msg, vscode.l10n.t('Show Console'));
	if (choice === vscode.l10n.t('Show Console')) {
		void vscode.commands.executeCommand('changeline.showConsole');
	}
}

/** Wraps a command handler so that errors end up in a notification. */
export function safe<A extends unknown[]>(fn: (...args: A) => unknown, prefix?: string): (...args: A) => Promise<void> {
	return async (...args: A) => {
		try {
			await fn(...args);
		} catch (e) {
			if (e instanceof vscode.CancellationError) {
				return;
			}
			await showError(e, prefix);
		}
	};
}

export function statusLabel(s: ChangeStatus): string {
	switch (s) {
		case 'M':
			return vscode.l10n.t('Modified');
		case 'A':
			return vscode.l10n.t('Added');
		case 'D':
			return vscode.l10n.t('Deleted');
		case 'R':
			return vscode.l10n.t('Renamed');
		case 'C':
			return vscode.l10n.t('Copied');
		case 'T':
			return vscode.l10n.t('Type changed');
		case 'U':
			return vscode.l10n.t('Merge conflict');
		case '?':
			return vscode.l10n.t('Unversioned');
		case '!':
			return vscode.l10n.t('Ignored');
	}
}

export function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function shortHash(hash: string): string {
	return hash.slice(0, 8);
}

export function basename(p: string): string {
	const i = p.lastIndexOf('/');
	return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
	const i = p.lastIndexOf('/');
	return i === -1 ? '' : p.slice(0, i);
}

export function formatDate(unixSeconds: number, style: 'relative' | 'absolute' = 'absolute'): string {
	const d = new Date(unixSeconds * 1000);
	if (style === 'relative') {
		return relativeDate(d);
	}
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeDate(d: Date): string {
	return relativeTime(d, vscode.env.language, vscode.l10n.t('moments ago'));
}

/** Localized count with a singular and a plural message, e.g. plural(n, '{0} file', '{0} files'). */
export function plural(n: number, one: string, other: string): string {
	return vscode.l10n.t(n === 1 ? one : other, n);
}

export function fileUri(absPath: string): vscode.Uri {
	return vscode.Uri.file(absPath);
}

export function normalizePath(p: string): string {
	return path.normalize(p);
}

export { pathKey };

export function samePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

export function isValidBranchName(name: string): string | undefined {
	if (!name.trim()) {
		return vscode.l10n.t('Branch name cannot be empty');
	}
	if (/\s/.test(name)) {
		return vscode.l10n.t('Branch name cannot contain whitespace');
	}
	if (/(^[./]|\/\.|\.\.|[~^:?*[\\\x00-\x1f\x7f]|@\{|\/$|\.lock$|\/\/|\.$)/.test(name) || name === '@') {
		return vscode.l10n.t("'{0}' is not a valid branch name", name);
	}
	return undefined;
}

/** Converts a remote URL to the base URL of its web page (GitHub, GitLab, Bitbucket, ...). */
export function remoteWebUrl(remoteUrl: string): { base: string; host: 'github' | 'gitlab' | 'bitbucket' | 'other' } | undefined {
	let url = remoteUrl.trim();
	let m = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
	if (m) {
		url = `https://${m[1]}/${m[2]}`;
	} else {
		m = /^(?:https?|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
		if (!m) {
			return undefined;
		}
		url = `https://${m[1].replace(/:\d+$/, '')}/${m[2]}`;
	}
	const host = /github/.test(url) ? 'github' : /gitlab/.test(url) ? 'gitlab' : /bitbucket/.test(url) ? 'bitbucket' : 'other';
	return { base: url, host };
}

export class Debouncer {
	private timers = new Map<string, NodeJS.Timeout>();

	run(key: string, delay: number, fn: () => void): void {
		const t = this.timers.get(key);
		if (t) {
			clearTimeout(t);
		}
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			fn();
		}, delay));
	}

	dispose(): void {
		for (const t of this.timers.values()) {
			clearTimeout(t);
		}
		this.timers.clear();
	}
}

export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
