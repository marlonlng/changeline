import type { Repository } from './git/repository';
import { detectHosting } from './hosting/detect';
import { hostingIssueRules, IssueRule } from './shared/issueLinks';
import { config } from './util';

const hosted = new Map<string, IssueRule[]>();

/** Issue navigation rules of a repository: the configured changeline.issueNavigation plus #123 links for GitHub and GitLab remotes. */
export async function issueRules(repo: Repository | undefined): Promise<IssueRule[]> {
	const configured = config<IssueRule[]>('issueNavigation', []).filter((r) => r && typeof r.pattern === 'string' && typeof r.link === 'string' && r.pattern && r.link);
	if (!repo) {
		return configured;
	}
	let rules = hosted.get(repo.root);
	if (!rules) {
		const target = detectHosting(await repo.getRemotes().catch(() => []), config<string[]>('github.enterpriseHosts', []), config<string[]>('gitlab.hosts', []));
		rules = target ? hostingIssueRules(target.kind, target.webUrl) : [];
		hosted.set(repo.root, rules);
	}
	return [...configured, ...rules];
}

/** Forgets the rules derived from the remotes, after remotes or settings changed. */
export function forgetIssueRules(): void {
	hosted.clear();
}
