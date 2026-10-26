import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { after, before, test } from 'node:test';
import { detectHosting } from '../../hosting/detect';
import { GitHubProvider } from '../../hosting/github';
import { GitLabProvider } from '../../hosting/gitlab';
import type { Fetcher } from '../../hosting/types';

interface Call {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body?: any;
}

const calls: Call[] = [];
let server: http.Server;
let base: string;
const routes: Record<string, (body: any) => unknown> = {};

before(async () => {
	server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (d) => (raw += d));
		req.on('end', () => {
			const url = new URL(req.url!, 'http://x');
			const body = raw ? JSON.parse(raw) : undefined;
			calls.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body });
			const key = `${req.method} ${url.pathname}`;
			const handler = routes[key];
			if (!handler) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: `no route ${key}` }));
				return;
			}
			const out = handler(body);
			res.writeHead(out === undefined ? 204 : 200, { 'Content-Type': 'application/json' });
			res.end(out === undefined ? '' : JSON.stringify(out));
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

const fetcher: Fetcher = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetcher>;

test('detects GitHub, GitHub Enterprise and GitLab remotes', () => {
	assert.deepEqual(detectHosting([{ name: 'origin', fetchUrl: 'git@github.com:acme/site.git' }])?.path, 'acme/site');
	const up = detectHosting([{ name: 'origin', fetchUrl: 'https://github.com/me/site.git' }, { name: 'upstream', fetchUrl: 'https://github.com/acme/site' }]);
	assert.equal(up?.path, 'acme/site');
	assert.equal(up?.remote, 'upstream');
	const ghe = detectHosting([{ name: 'origin', fetchUrl: 'https://git.corp.example/acme/site.git' }], ['git.corp.example']);
	assert.equal(ghe?.apiUrl, 'https://git.corp.example/api/v3');
	const gl = detectHosting([{ name: 'origin', fetchUrl: 'ssh://git@gitlab.com:2222/group/sub/project.git' }]);
	assert.equal(gl?.kind, 'gitlab');
	assert.equal(gl?.path, 'group/sub/project');
	assert.equal(gl?.apiUrl, 'https://gitlab.com/api/v4');
	assert.equal(detectHosting([{ name: 'origin', fetchUrl: 'https://bitbucket.org/a/b.git' }]), undefined);
});

test('GitHub client: list, details, create, merge, review and line comments', async () => {
	const gh = new GitHubProvider(base, 'https://github.com/acme/site', 'acme', 'site', async () => 'tok', fetcher);
	const prJson = (n: number, extra: object = {}) => ({
		number: n, title: `PR ${n}`, state: 'open', draft: false, user: { login: 'anna' }, created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-02T10:00:00Z',
		html_url: `https://github.com/acme/site/pull/${n}`, head: { ref: 'feature', sha: 'h1', repo: { full_name: 'acme/site' } }, base: { ref: 'main', sha: 'b1', repo: { full_name: 'acme/site' } },
		labels: [{ name: 'bug' }], body: 'Fixes **things**', ...extra,
	});
	routes['GET /repos/acme/site/pulls'] = () => [prJson(1), prJson(2, { state: 'closed', merged_at: '2026-01-03T00:00:00Z' })];
	const open = await gh.list('all');
	assert.deepEqual(open.map((p) => p.state), ['open', 'merged']);
	assert.equal(calls.at(-1)!.headers.authorization, 'Bearer tok');
	assert.equal((await gh.list('merged')).length, 1);

	routes['GET /repos/acme/site/pulls/1'] = () => prJson(1, { mergeable: true });
	routes['GET /repos/acme/site/pulls/1/commits'] = () => [{ sha: 'c1', commit: { message: 'Do it', author: { name: 'Anna', date: '2026-01-01T11:00:00Z' } } }];
	routes['GET /repos/acme/site/pulls/1/files'] = () => [{ filename: 'a.php', status: 'modified', additions: 3, deletions: 1 }, { filename: 'b.php', previous_filename: 'old.php', status: 'renamed', additions: 0, deletions: 0 }];
	routes['GET /repos/acme/site/issues/1/comments'] = () => [{ id: 5, user: { login: 'jonas' }, created_at: '2026-01-01T12:00:00Z', body: 'Looks good' }];
	routes['GET /repos/acme/site/pulls/1/reviews'] = () => [{ id: 6, user: { login: 'lea' }, state: 'APPROVED', submitted_at: '2026-01-01T13:00:00Z', body: '' }];
	routes['GET /repos/acme/site/pulls/1/comments'] = () => [{ id: 7, user: { login: 'lea' }, created_at: '2026-01-01T12:30:00Z', body: 'Rename this', path: 'a.php', line: 12, side: 'RIGHT', diff_hunk: '@@ -1 +1 @@' }];
	routes['GET /repos/acme/site/pulls/1/requested_reviewers'] = () => ({ users: [{ login: 'marlon' }] });
	routes['GET /repos/acme/site/commits/h1/status'] = () => ({ state: 'success', total_count: 2 });
	const d = await gh.details(1);
	assert.equal(d.files[1].status, 'R');
	assert.equal(d.files[1].origPath, 'old.php');
	assert.deepEqual(d.reviewers.map((r) => `${r.user.login}:${r.state}`).sort(), ['lea:approved', 'marlon:pending']);
	assert.deepEqual(d.timeline.map((t) => t.kind), ['commit', 'comment', 'reviewComment', 'review']);
	assert.equal(d.timeline[2].line, 12);
	assert.equal(d.checks?.state, 'success');

	routes['POST /repos/acme/site/pulls'] = (b) => prJson(3, { title: b.title });
	routes['POST /repos/acme/site/pulls/3/requested_reviewers'] = () => ({});
	const created = await gh.create({ title: 'New', body: 'Body', head: 'feature', base: 'main', draft: true, reviewers: ['lea'] });
	assert.equal(created.number, 3);
	const createCall = calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/site/pulls')!;
	assert.deepEqual(createCall.body, { title: 'New', body: 'Body', head: 'feature', base: 'main', draft: true });
	assert.deepEqual(calls.at(-1)!.body, { reviewers: ['lea'] });

	routes['PUT /repos/acme/site/pulls/1/merge'] = () => ({ merged: true });
	await gh.merge(1, 'squash');
	assert.deepEqual(calls.at(-1)!.body, { merge_method: 'squash' });
	routes['PATCH /repos/acme/site/pulls/1'] = () => prJson(1);
	await gh.setState(1, 'closed');
	assert.deepEqual(calls.at(-1)!.body, { state: 'closed' });
	routes['POST /repos/acme/site/pulls/1/reviews'] = () => ({});
	await gh.review(1, 'request_changes', 'Please fix');
	assert.deepEqual(calls.at(-1)!.body, { event: 'REQUEST_CHANGES', body: 'Please fix' });
	routes['POST /repos/acme/site/pulls/1/comments'] = () => ({});
	await gh.lineComment(1, { body: 'Nit', path: 'a.php', line: 4, side: 'RIGHT', commitSha: 'h1', baseSha: 'b1' });
	assert.deepEqual(calls.at(-1)!.body, { body: 'Nit', commit_id: 'h1', path: 'a.php', line: 4, side: 'RIGHT' });
	routes['POST /repos/acme/site/pulls/1/comments/7/replies'] = () => ({});
	await gh.lineComment(1, { body: 'Done', path: 'a.php', line: 12, side: 'RIGHT', commitSha: 'h1', baseSha: 'b1', inReplyTo: '7' });
	assert.equal(calls.at(-1)!.path, '/repos/acme/site/pulls/1/comments/7/replies');
	assert.equal(gh.headRefSpec(9), 'refs/pull/9/head');

	routes['GET /user'] = () => ({ login: 'marlon', name: 'Marlon' });
	assert.equal((await gh.currentUser()).login, 'marlon');
	delete routes['GET /repos/acme/site/pulls/1'];
	await assert.rejects(() => gh.details(1), /no route/);
});

test('GitLab client: merge requests with discussions and approvals', async () => {
	const gl = new GitLabProvider(base, 'https://gitlab.com/group/project', 'group/project', async () => 'gltok', fetcher);
	const enc = encodeURIComponent('group/project');
	const p = `/projects/${enc}`;
	const mrJson = (iid: number, extra: object = {}) => ({
		iid, title: `MR ${iid}`, state: 'opened', author: { username: 'anna' }, created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-02T10:00:00Z',
		web_url: `https://gitlab.com/group/project/-/merge_requests/${iid}`, source_branch: 'feature', target_branch: 'main', sha: 'h1', labels: [], description: 'Desc',
		diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' }, reviewers: [{ username: 'lea' }], merge_status: 'can_be_merged', head_pipeline: { status: 'failed' }, ...extra,
	});
	routes[`GET /projects/group%2Fproject/merge_requests`] = () => [mrJson(4), mrJson(5, { state: 'merged' })];
	const list = await gl.list('all');
	assert.deepEqual(list.map((m) => `${m.number}:${m.state}`), ['4:open', '5:merged']);
	assert.equal(calls.at(-1)!.headers['private-token'], 'gltok');
	assert.match(calls.at(-1)!.path, /state=all/);

	routes[`GET /projects/group%2Fproject/merge_requests/4`] = () => mrJson(4);
	routes[`GET /projects/group%2Fproject/merge_requests/4/commits`] = () => [{ id: 'c1', message: 'Work', author_name: 'Anna', created_at: '2026-01-01T11:00:00Z' }];
	routes[`GET /projects/group%2Fproject/merge_requests/4/changes`] = () => ({ changes: [{ new_path: 'x.ts', old_path: 'x.ts', new_file: true, diff: '+a\n+b\n' }] });
	routes[`GET /projects/group%2Fproject/merge_requests/4/notes`] = () => [
		{ id: 11, author: { username: 'lea' }, created_at: '2026-01-01T12:00:00Z', body: 'Line note' },
		{ id: 12, author: { username: 'jonas' }, created_at: '2026-01-01T12:05:00Z', body: 'General' },
	];
	routes[`GET /projects/group%2Fproject/merge_requests/4/approvals`] = () => ({ approved_by: [{ user: { username: 'lea' } }] });
	routes[`GET /projects/group%2Fproject/merge_requests/4/discussions`] = () => [{ id: 'd1', notes: [{ id: 11, position: { new_path: 'x.ts', new_line: 2 } }] }];
	const d = await gl.details(4);
	assert.equal(d.files[0].status, 'A');
	assert.equal(d.files[0].additions, 2);
	assert.equal(d.reviewers[0].state, 'approved');
	const note = d.timeline.find((t) => t.id === '11')!;
	assert.equal(note.kind, 'reviewComment');
	assert.equal(note.line, 2);
	assert.equal(d.checks?.state, 'failure');
	assert.equal(d.mergeable, true);

	routes[`POST /projects/group%2Fproject/merge_requests`] = (b) => mrJson(6, { title: b.title });
	routes['GET /users'] = () => [{ id: 42, username: 'lea' }];
	const created = await gl.create({ title: 'New', body: 'B', head: 'feature', base: 'main', draft: true, reviewers: ['lea'] });
	assert.equal(created.title, 'Draft: New');
	assert.deepEqual(calls.at(-1)!.body.reviewer_ids, [42]);

	routes[`POST /projects/group%2Fproject/merge_requests/4/approve`] = () => ({});
	await gl.review(4, 'approve', '');
	assert.equal(calls.at(-1)!.path, `${p}/merge_requests/4/approve`.replace(enc, 'group%2Fproject'));
	routes[`PUT /projects/group%2Fproject/merge_requests/4/merge`] = () => ({});
	await gl.merge(4, 'squash');
	assert.deepEqual(calls.at(-1)!.body, { squash: true });
	routes[`POST /projects/group%2Fproject/merge_requests/4/discussions`] = () => ({});
	await gl.lineComment(4, { body: 'Hmm', path: 'x.ts', line: 1, side: 'RIGHT', commitSha: 'h1', baseSha: 'b1' });
	assert.equal(calls.at(-1)!.body.position.new_line, 1);
	assert.equal(calls.at(-1)!.body.position.start_sha, 's1');
	routes[`POST /projects/group%2Fproject/merge_requests/4/discussions/d1/notes`] = () => ({});
	await gl.lineComment(4, { body: 'Reply', path: 'x.ts', line: 2, side: 'RIGHT', commitSha: 'h1', baseSha: 'b1', inReplyTo: 'd:d1' });
	assert.match(calls.at(-1)!.path, /discussions\/d1\/notes$/);
	routes[`PUT /projects/group%2Fproject/merge_requests/4`] = () => mrJson(4);
	await gl.setState(4, 'closed');
	assert.deepEqual(calls.at(-1)!.body, { state_event: 'close' });
	assert.equal(gl.headRefSpec(4), 'refs/merge-requests/4/head');
});

test('GitHub account calls: create repository, gist and list repositories', async () => {
	const { createGitHubRepository, createGist, listUserRepositories } = await import('../../hosting/github');
	routes['POST /user/repos'] = (b) => ({ clone_url: `https://github.com/me/${b.name}.git`, ssh_url: `git@github.com:me/${b.name}.git`, html_url: `https://github.com/me/${b.name}`, full_name: `me/${b.name}` });
	const r = await createGitHubRepository(base, 'tok', fetcher, { name: 'site', description: 'd', private: true });
	assert.equal(r.fullName, 'me/site');
	assert.deepEqual(calls.at(-1)!.body, { name: 'site', description: 'd', private: true, auto_init: false });
	routes['POST /orgs/acme/repos'] = (b) => ({ clone_url: `https://github.com/acme/${b.name}.git`, ssh_url: '', html_url: '', full_name: `acme/${b.name}` });
	assert.equal((await createGitHubRepository(base, 'tok', fetcher, { name: 'x', description: '', private: false, org: 'acme' })).fullName, 'acme/x');
	routes['POST /gists'] = () => ({ html_url: 'https://gist.github.com/abc' });
	assert.equal(await createGist(base, 'tok', fetcher, { files: { 'a.php': '<?php' }, description: 'snippet', public: false }), 'https://gist.github.com/abc');
	assert.deepEqual(calls.at(-1)!.body, { description: 'snippet', public: false, files: { 'a.php': { content: '<?php' } } });
	routes['GET /user/repos'] = () => [{ full_name: 'me/site', clone_url: 'c', ssh_url: 's', private: true, updated_at: '2026-01-01T00:00:00Z' }];
	const list = await listUserRepositories(base, 'tok', fetcher);
	assert.equal(list[0].fullName, 'me/site');
	assert.match(calls.at(-1)!.path, /affiliation=owner/);
});
