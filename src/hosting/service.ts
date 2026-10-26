import * as vscode from 'vscode';
import type { Repository } from '../git/repository';
import { services } from '../services';
import { config } from '../util';
import { detectHosting, HostingTarget } from './detect';
import { GitHubProvider } from './github';
import { GitLabProvider } from './gitlab';
import type { Fetcher, HostingProvider } from './types';

export interface Hosting {
	provider: HostingProvider;
	target: HostingTarget;
}

const fetcher: Fetcher = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetcher>;
const cache = new Map<string, Hosting | null>();

function tokenKey(target: HostingTarget): string {
	return `changeline.token.${target.kind}.${target.host}`;
}

export async function setToken(target: HostingTarget, token: string | undefined): Promise<void> {
	const secrets = services().context.secrets;
	if (token) {
		await secrets.store(tokenKey(target), token);
	} else {
		await secrets.delete(tokenKey(target));
	}
}

async function promptToken(target: HostingTarget): Promise<string> {
	const createUrl = target.kind === 'gitlab' ? `https://${target.host}/-/user_settings/personal_access_tokens?name=Changeline&scopes=api` : `https://${target.host}/settings/tokens/new?description=Changeline&scopes=repo`;
	const token = await vscode.window.showInputBox({
		title: vscode.l10n.t('{0} access token for {1}', target.kind === 'gitlab' ? 'GitLab' : 'GitHub Enterprise', target.host),
		prompt: vscode.l10n.t('Personal access token with {0} scope. Create one at {1}', target.kind === 'gitlab' ? '"api"' : '"repo"', createUrl),
		password: true,
		ignoreFocusOut: true,
	});
	if (!token) {
		throw new vscode.CancellationError();
	}
	await setToken(target, token.trim());
	return token.trim();
}

function tokenGetter(target: HostingTarget, interactive: boolean): () => Promise<string> {
	return async () => {
		if (target.kind === 'github' && target.host === 'github.com') {
			const session = await vscode.authentication.getSession('github', ['repo', 'read:user'], interactive ? { createIfNone: true } : { silent: true });
			if (!session) {
				throw new Error(vscode.l10n.t('Not signed in to GitHub.'));
			}
			return session.accessToken;
		}
		if (target.kind === 'github') {
			const gheUri = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
			if (gheUri && new URL(gheUri).host === target.host) {
				const session = await vscode.authentication.getSession('github-enterprise', ['repo', 'read:user'], interactive ? { createIfNone: true } : { silent: true });
				if (session) {
					return session.accessToken;
				}
			}
		}
		const stored = await services().context.secrets.get(tokenKey(target));
		if (stored) {
			return stored;
		}
		if (!interactive) {
			throw new Error(vscode.l10n.t('No access token for {0}.', target.host));
		}
		return promptToken(target);
	};
}

/** Pull request service of a repository, or undefined when its remote is not GitHub/GitLab. */
export async function hostingFor(repo: Repository, interactive = true): Promise<Hosting | undefined> {
	if (cache.has(repo.root)) {
		return cache.get(repo.root) ?? undefined;
	}
	const target = detectHosting(await repo.getRemotes(), config<string[]>('github.enterpriseHosts', []), config<string[]>('gitlab.hosts', []));
	if (!target) {
		cache.set(repo.root, null);
		return undefined;
	}
	const token = tokenGetter(target, interactive);
	let provider: HostingProvider;
	if (target.kind === 'github') {
		const [owner, ...rest] = target.path.split('/');
		provider = new GitHubProvider(target.apiUrl, target.webUrl, owner, rest.join('/'), token, fetcher);
	} else {
		provider = new GitLabProvider(target.apiUrl, target.webUrl, target.path, token, fetcher);
	}
	const hosting = { provider, target };
	cache.set(repo.root, hosting);
	return hosting;
}

export function forgetHosting(repo?: Repository): void {
	if (repo) {
		cache.delete(repo.root);
	} else {
		cache.clear();
	}
}

/** Makes the commits of a pull request available locally. Returns the local ref. */
export async function fetchPullRequest(repo: Repository, hosting: Hosting, n: number): Promise<string> {
	const local = `refs/changeline/pr/${n}`;
	await repo.run(['fetch', '--no-tags', hosting.target.remote, `+${hosting.provider.headRefSpec(n)}:${local}`], { log: true });
	return local;
}
