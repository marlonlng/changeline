import type { RemoteInfo } from '../git/parsers';

export interface HostingTarget {
	kind: 'github' | 'gitlab';
	host: string;
	path: string;
	remote: string;
	webUrl: string;
	apiUrl: string;
}

function parseUrl(url: string): { host: string; path: string; protocol: string } | undefined {
	let m = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url.trim());
	if (/^https?:\/\//.test(url)) {
		m = /^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
		return m ? { protocol: m[1], host: m[2], path: m[3] } : undefined;
	}
	return m ? { protocol: 'https', host: m[1], path: m[2] } : undefined;
}

/**
 * Finds the hosting service of a repository from its remotes. Prefers
 * "upstream" (the repository pull requests go to) over "origin".
 */
export function detectHosting(remotes: RemoteInfo[], extraGitHubHosts: string[] = [], extraGitLabHosts: string[] = []): HostingTarget | undefined {
	const order = [...remotes].sort((a, b) => rank(a.name) - rank(b.name));
	for (const r of order) {
		const url = r.fetchUrl ?? r.pushUrl;
		const p = url && parseUrl(url);
		if (!p) {
			continue;
		}
		const host = p.host.replace(/:\d+$/, '');
		const webUrl = `${p.protocol === 'http' ? 'http' : 'https'}://${p.host}/${p.path}`;
		if (host === 'github.com') {
			return { kind: 'github', host, path: p.path, remote: r.name, webUrl, apiUrl: 'https://api.github.com' };
		}
		if (extraGitHubHosts.includes(host)) {
			return { kind: 'github', host, path: p.path, remote: r.name, webUrl, apiUrl: `${p.protocol === 'http' ? 'http' : 'https'}://${p.host}/api/v3` };
		}
		if (host === 'gitlab.com' || extraGitLabHosts.includes(host) || /(^|\.)gitlab\./.test(host)) {
			return { kind: 'gitlab', host, path: p.path, remote: r.name, webUrl, apiUrl: `${p.protocol === 'http' ? 'http' : 'https'}://${p.host}/api/v4` };
		}
	}
	return undefined;
}

function rank(name: string): number {
	return name === 'upstream' ? 0 : name === 'origin' ? 1 : 2;
}
