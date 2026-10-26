import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { GitHubProvider } from '../../hosting/github';
import { GitLabProvider } from '../../hosting/gitlab';
import { HostingError, type Fetcher, type HostingProvider } from '../../hosting/types';


const fetcher: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) } as RequestInit) as unknown as ReturnType<Fetcher>;

async function unavailable(url: string): Promise<string | undefined> {
	if (process.env['CHANGELINE_OFFLINE']) {
		return 'CHANGELINE_OFFLINE is set';
	}
	try {
		await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
		return undefined;
	} catch {
		return `${new URL(url).host} is not reachable`;
	}
}

async function live(t: TestContext, api: string, fn: () => Promise<void>): Promise<void> {
	const reason = await unavailable(api);
	if (reason) {
		t.skip(reason);
		return;
	}
	try {
		await fn();
	} catch (e) {
		if (e instanceof HostingError && (e.status === 403 || e.status === 429) && /rate limit/i.test(e.message)) {
			t.skip(e.message);
			return;
		}
		throw e;
	}
}

const sha = /^[0-9a-f]{40}$/;

async function checkListAndDetails(provider: HostingProvider, urlPattern: RegExp): Promise<void> {
	const all = await provider.list('all');
	assert.ok(all.length > 0, 'requests listed');
	for (const p of all.slice(0, 10)) {
		assert.ok(Number.isInteger(p.number) && p.number > 0);
		assert.ok(p.title.length > 0);
		assert.ok(['open', 'closed', 'merged'].includes(p.state), p.state);
		assert.ok(p.author.login.length > 0);
		assert.match(p.url, urlPattern);
		assert.ok(!Number.isNaN(Date.parse(p.createdAt)) && !Number.isNaN(Date.parse(p.updatedAt)));
		assert.ok(p.baseRef.length > 0);
	}
	const closed = await provider.list('closed');
	assert.ok(closed.every((p) => p.state === 'closed'));

	const withCommits = all.find((p) => p.state === 'merged') ?? all[0];
	const d = await provider.details(withCommits.number);
	assert.equal(d.number, withCommits.number);
	assert.equal(d.title, withCommits.title);
	assert.equal(typeof d.body, 'string');
	assert.ok(d.commits.length > 0, 'commits loaded');
	for (const c of d.commits) {
		assert.match(c.sha, sha);
		assert.ok(c.author.length > 0);
	}
	for (const f of d.files) {
		assert.ok(f.path.length > 0);
		assert.ok(['A', 'M', 'D', 'R'].includes(f.status));
	}
	assert.ok(d.timeline.every((i) => !Number.isNaN(Date.parse(i.createdAt))));
	assert.ok(provider.headRefSpec(d.number).startsWith('refs/'));
}

test('GitHub API (octocat/Hello-World, anonymous): list and details of pull requests', async (t) => {
	await live(t, 'https://api.github.com', async () => {
		const gh = new GitHubProvider('https://api.github.com', 'https://github.com/octocat/Hello-World', 'octocat', 'Hello-World', async () => '', fetcher);
		await checkListAndDetails(gh, /^https:\/\/github\.com\/octocat\/Hello-World\/pull\/\d+$/);
		assert.equal(gh.headRefSpec(7), 'refs/pull/7/head');
	});
});

test('GitLab API (gitlab-org/gitlab-test, anonymous): list and details of merge requests', async (t) => {
	await live(t, 'https://gitlab.com/api/v4/version', async () => {
		const gl = new GitLabProvider('https://gitlab.com/api/v4', 'https://gitlab.com/gitlab-org/gitlab-test', 'gitlab-org/gitlab-test', async () => '', fetcher);
		await checkListAndDetails(gl, /^https:\/\/gitlab\.com\/gitlab-org\/gitlab-test\/-\/merge_requests\/\d+$/);
		assert.equal(gl.headRefSpec(7), 'refs/merge-requests/7/head');
	});
});
