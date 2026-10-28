import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangelineApi } from '../../extension';
import type { DialogResult } from '../../shared/types';
import { EXTENSION_ID, runAll, test, waitFor } from './harness';

const ws = process.env['CHANGELINE_E2E_WORKSPACE']!;
let api: ChangelineApi;

test('activates and finds the repository', async () => {
	const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
	api = (await ext.activate()) as ChangelineApi;
	assert.ok(api, 'API returned');
	const repos = api.repositories();
	assert.equal(repos.length, 1);
	assert.equal(fs.realpathSync(repos[0].root), fs.realpathSync(ws));
	assert.equal(repos[0].branch, 'main');
	const all = await vscode.commands.getCommands(true);
	for (const id of ['changeline.branches', 'changeline.commit', 'changeline.push', 'changeline.updateProject', 'changeline.showLog', 'changeline.annotate', 'changeline.log.cherryPick', 'changeline.logBranch.checkout', 'changeline.shelf.unshelve', 'changeline.stash.pop']) {
		assert.ok(all.includes(id), `command ${id} registered`);
	}
});

test('local changes appear in the default changelist and are included', async () => {
	fs.writeFileSync(path.join(ws, 'a.txt'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
	fs.writeFileSync(path.join(ws, 'new.txt'), 'new file\n');
	await vscode.commands.executeCommand('changeline.changes.refresh');
	const view = api._test.changesView;
	const file = await waitFor(() => view.allFiles().find((f) => f.change.path === 'a.txt'), 'a.txt in Local Changes');
	assert.equal(file.group, 'changelist');
	assert.equal(file.change.status, 'M');
	const unversioned = await waitFor(() => view.allFiles().find((f) => f.change.path === 'new.txt'), 'new.txt as unversioned');
	assert.equal(unversioned.group, 'unversioned');
	assert.deepEqual(view.includedFiles().map((f) => f.change.path), ['a.txt']);
});

test('partial commit of the first chunk only', async () => {
	const view = api._test.changesView;
	const commit = api._test.commit;
	const file = view.allFiles().find((f) => f.change.path === 'a.txt')!;
	const { diffLines, splitLines, chunkKey } = await import('../../shared/diff');
	const head = 'one\ntwo\nthree\nfour\nfive\n';
	const work = fs.readFileSync(path.join(ws, 'a.txt'), 'utf8');
	const ol = splitLines(head);
	const nl = splitLines(work);
	const chunks = diffLines(ol, nl);
	assert.equal(chunks.length, 2);
	const services = api._test.services;
	services().changelists.setChunkIncluded(file.abs, chunkKey(chunks[1], ol, nl), false, chunks.map((c) => chunkKey(c, ol, nl)));
	const ok = await commit.commit({ message: 'partial commit', amend: false, push: false, options: commit.options });
	assert.equal(ok, true);
	const repo = services().repos.repositories[0];
	assert.equal((await repo.getContent('HEAD', 'a.txt')).toString(), 'ONE\ntwo\nthree\nfour\nfive\n');
	assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nFIVE\n', 'working tree untouched');
	await repo.refresh();
	assert.deepEqual(repo.state.changes.map((c) => c.path), ['a.txt']);
});

test('new changelist and moving files', async () => {
	const services = api._test.services;
	const cl = services().changelists;
	const list = cl.create('Feature work');
	const view = api._test.changesView;
	const file = view.allFiles().find((f) => f.change.path === 'a.txt')!;
	cl.move([file.abs], list.id);
	await waitFor(() => view.groups.find((g) => g.list?.id === list.id)?.files.length === 1, 'file moved');
	cl.remove(list.id);
	await waitFor(() => view.groups.every((g) => g.list?.id !== list.id), 'list removed');
});

test('diff panel and log view open without errors', async () => {
	const view = api._test.changesView;
	const file = view.allFiles().find((f) => f.change.path === 'a.txt')!;
	await vscode.commands.executeCommand('changeline.changes.open', file);
	await waitFor(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label.startsWith('Diff: a.txt'))), 'diff tab');
	await vscode.commands.executeCommand('changeline.showLog');
	await waitFor(() => api._test.logView.current, 'log controller', 15000);
	await api._test.logView.current!.ready;
});

test('shelve and unshelve restore the change', async () => {
	const services = api._test.services;
	const s = services();
	const repo = s.repos.repositories[0];
	await repo.refresh();
	const change = repo.state.changes.find((c) => c.path === 'a.txt')!;
	const list = await s.shelf.shelve('shelved work', [{ repo, change }]);
	assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nfive\n', 'reverted after shelving');
	fs.writeFileSync(path.join(ws, 'a.txt'), 'ONE\ntwo\nTHREE\nfour\nfive\n');
	const result = await s.shelf.unshelve(list, (root) => s.repos.getByRoot(root));
	assert.equal(result.conflicts.length, 0);
	assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'ONE\ntwo\nTHREE\nfour\nFIVE\n');
});

test('merge with conflict is detected and resolvable', async () => {
	const services = api._test.services;
	const repo = services().repos.repositories[0];
	await repo.rollback(repo.state.changes, true);
	fs.rmSync(path.join(ws, 'new.txt'), { force: true });
	fs.writeFileSync(path.join(ws, 'b.txt'), 'bee main\n');
	await repo.stage(['b.txt']);
	await repo.commit({ message: 'main change' });
	const outcome = await repo.merge('feature');
	assert.equal(outcome.conflicts, true);
	await repo.refresh();
	assert.equal(repo.state.conflicts.length, 1);
	await repo.runOp(['checkout', '--theirs', '--', 'b.txt']);
	await repo.add(['b.txt']);
	await repo.refresh();
	assert.equal(repo.state.conflicts.length, 0);
	assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'bee feature\n');
	await repo.continueOperation();
	await repo.refresh();
	assert.equal(repo.state.operation, 'none');
});

test('annotate decorates the editor', async () => {
	const doc = await vscode.workspace.openTextDocument(path.join(ws, 'a.txt'));
	const editor = await vscode.window.showTextDocument(doc);
	await vscode.commands.executeCommand('changeline.annotate');
	assert.equal(api._test.blame.isActive(editor.document.uri), true);
	await vscode.commands.executeCommand('changeline.annotate.close');
	assert.equal(api._test.blame.isActive(editor.document.uri), false);
});

test('partial changelists: chunks of one file in two changelists are committed separately', async () => {
	const services = api._test.services;
	const s = services();
	const repo = s.repos.repositories[0];
	const head = (await repo.getContent('HEAD', 'a.txt')).toString();
	const lines = head.split('\n');
	const edited = ['FIRST ' + lines[0], ...lines.slice(1, -2), 'LAST ' + lines[lines.length - 2], ''].join('\n');
	fs.writeFileSync(path.join(ws, 'a.txt'), edited);
	await repo.refresh();
	const view = api._test.changesView;
	const file = await waitFor(() => view.allFiles().find((f) => f.change.path === 'a.txt' && f.group === 'changelist'), 'a.txt changed');
	const { diffLines, splitLines, chunkKey } = await import('../../shared/diff');
	const ol = splitLines(head);
	const nl = splitLines(edited);
	const keys = diffLines(ol, nl).map((c) => chunkKey(c, ol, nl));
	assert.equal(keys.length, 2);
	const cl = s.changelists;
	const second = cl.create('Second');
	cl.setIncluded([file.abs], true);
	cl.moveChunk(file.abs, keys[1], second.id);
	await waitFor(() => view.groups.find((g) => g.list?.id === second.id)?.files.some((f) => f.abs === file.abs) && view.groups.find((g) => g.list?.id === cl.active.id)?.files.some((f) => f.abs === file.abs), 'file in both lists');
	assert.equal(cl.isPartIncluded(file.abs, second.id), false, 'parts of other lists start unchecked');
	const commit = api._test.commit;
	assert.equal(await commit.commit({ message: 'first chunk only', amend: false, push: false, options: commit.options }), true);
	const after1 = (await repo.getContent('HEAD', 'a.txt')).toString();
	assert.ok(after1.startsWith('FIRST '), 'first chunk committed');
	assert.ok(!after1.includes('LAST '), 'second chunk not committed');
	await repo.refresh();
	await waitFor(() => view.groups.find((g) => g.list?.id === second.id)?.files.some((f) => f.abs === file.abs), 'remaining chunk in Second');
	cl.setPartIncluded(file.abs, cl.listOf(file.abs).id, false);
	cl.move([file.abs], second.id);
	cl.setIncluded([file.abs], true);
	assert.equal(await commit.commit({ message: 'second chunk', amend: false, push: false, options: commit.options }), true);
	assert.ok((await repo.getContent('HEAD', 'a.txt')).toString().includes('LAST '));
	cl.remove(second.id);
});

test('compare with clipboard, log in a new tab and ignored files', async () => {
	const services = api._test.services;
	const repo = services().repos.repositories[0];
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await vscode.env.clipboard.writeText('clipboard text\n');
	await vscode.commands.executeCommand('changeline.compareWithClipboard', vscode.Uri.file(path.join(ws, 'b.txt')));
	await waitFor(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Diff: b.txt')), 'clipboard diff tab');
	await vscode.commands.executeCommand('changeline.showLogInNewTab', { repo: repo.root, branches: ['main'] });
	await waitFor(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Log: main')), 'log tab');
	fs.writeFileSync(path.join(ws, '.gitignore'), 'ignored.log\n');
	fs.writeFileSync(path.join(ws, 'ignored.log'), 'x\n');
	await vscode.commands.executeCommand('changeline.changes.toggleIgnored');
	await repo.refresh();
	await waitFor(() => api._test.changesView.groups.some((g) => g.group === 'ignored' && g.files.some((f) => f.change.path === 'ignored.log')), 'ignored files node');
	await vscode.commands.executeCommand('changeline.changes.toggleIgnored');
	fs.rmSync(path.join(ws, 'ignored.log'));
	fs.rmSync(path.join(ws, '.gitignore'));
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('synchronous branch control checks out a common branch in all repositories', async () => {
	const cp = await import('child_process');
	const sub = path.join(ws, 'sub');
	fs.mkdirSync(sub, { recursive: true });
	const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: sub, stdio: 'pipe' });
	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'E2E');
	git('config', 'user.email', 'e2e@example.com');
	fs.writeFileSync(path.join(sub, 's.txt'), 's\n');
	git('add', '.');
	git('commit', '-qm', 'sub initial');
	git('branch', 'feature');
	await vscode.commands.executeCommand('changeline.refresh');
	const services = api._test.services;
	const repos = [...services().repos.repositories];
	assert.equal(repos.length, 2, 'nested repository found');
	const common = await api._test.multi.commonRefs(repos);
	const feature = common.find((c) => c.type === 'head' && c.name === 'feature');
	assert.ok(feature, 'feature is a common branch');
	assert.ok(!common.some((c) => c.name === 'nonexistent'));
	await api._test.multi.runCommonAction(repos, feature!, 'checkout');
	for (const r of repos) {
		await r.refresh();
		assert.equal(r.state.branch, 'feature', `${r.name} switched`);
	}
	await api._test.multi.runCommonAction(repos, common.find((c) => c.type === 'head' && c.name === 'main')!, 'checkout');
	for (const r of repos) {
		await r.refresh();
		assert.equal(r.state.branch, 'main');
	}

	fs.writeFileSync(path.join(sub, 's.txt'), 's changed\n');
	fs.writeFileSync(path.join(ws, 'b.txt'), fs.readFileSync(path.join(ws, 'b.txt'), 'utf8') + 'grouped\n');
	await Promise.all(repos.map((r) => r.refresh()));
	const view = api._test.changesView;
	const repoNodes = await waitFor(() => {
		const group = view.groups.find((g) => g.list?.id === services().changelists.active.id);
		const nodes = group ? view.getChildren(group) : [];
		return nodes.length === 2 && nodes.every((n) => n.type === 'repo') && nodes;
	}, 'repository nodes');
	assert.deepEqual(repoNodes.map((n) => (n as { repo: { name: string } }).repo.name).sort(), [path.basename(ws), 'sub'].sort());
	await vscode.commands.executeCommand('changeline.changes.groupByDirectory');
	const subNode = repoNodes.find((n) => (n as { repo: { name: string } }).repo.name === 'sub')!;
	await waitFor(() => {
		const group = view.groups.find((g) => g.list?.id === services().changelists.active.id)!;
		const node = view.getChildren(group).find((n) => n.type === 'repo' && n.id === subNode.id);
		return node && view.getChildren(node).some((c) => c.type === 'file');
	}, 'files below the repository node');
	await vscode.commands.executeCommand('changeline.changes.groupByNone');
	for (const r of repos) {
		await r.restore([r === repos.find((x) => x.name === 'sub') ? 's.txt' : 'b.txt']);
	}
});

test('merge requests: list, fetch the head and add a review line comment (GitLab API mock + git server)', async () => {
	const http = await import('http');
	const cp = await import('child_process');
	const services = api._test.services;
	const repo = services().repos.repositories.find((r) => fs.realpathSync(r.root) === fs.realpathSync(ws))!;
	const srv = fs.mkdtempSync(path.join(require('os').tmpdir(), 'changeline-git-server-'));
	const bare = path.join(srv, 'group', 'project.git');
	fs.mkdirSync(path.dirname(bare), { recursive: true });
	cp.execFileSync('git', ['clone', '-q', '--bare', ws, bare]);
	const scratch = path.join(srv, 'scratch');
	cp.execFileSync('git', ['clone', '-q', bare, scratch]);
	const sg = (...a: string[]) => cp.execFileSync('git', ['-c', 'user.name=Rev', '-c', 'user.email=r@x', ...a], { cwd: scratch }).toString().trim();
	fs.writeFileSync(path.join(scratch, 'a.txt'), 'one\ntwo\nTHREE from MR\nfour\nfive\n');
	sg('commit', '-qam', 'MR change');
	const head = sg('rev-parse', 'HEAD');
	const baseSha = sg('rev-parse', 'HEAD~1');
	sg('push', '-q', 'origin', `HEAD:refs/merge-requests/1/head`);
	const posted: any[] = [];
	const mr = { iid: 1, title: 'Shout three', state: 'opened', author: { username: 'rev' }, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', web_url: 'http://x/mr/1', source_branch: 'shout', target_branch: 'main', sha: head, labels: [], description: 'Please review', diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: head } };
	const server = http.createServer((req, res) => {
		const url = new URL(req.url!, 'http://x');
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			if (url.pathname.startsWith('/group/project.git')) {
				const child = cp.spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: srv, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '' } });
				child.stdin.end(body);
				const out: Buffer[] = [];
				child.stdout.on('data', (d) => out.push(d));
				child.on('close', () => {
					const buf = Buffer.concat(out);
					const sep = buf.indexOf('\r\n\r\n');
					const headers: Record<string, string> = {};
					let status = 200;
					for (const line of buf.slice(0, sep).toString().split('\r\n')) {
						const i = line.indexOf(':');
						if (line.slice(0, i).toLowerCase() === 'status') {
							status = parseInt(line.slice(i + 1), 10);
						} else if (i > 0) {
							headers[line.slice(0, i)] = line.slice(i + 1).trim();
						}
					}
					res.writeHead(status, headers);
					res.end(buf.slice(sep + 4));
				});
				return;
			}
			assert.equal(req.headers['private-token'], 'e2e-token');
			const json = (o: unknown) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(o));
			};
			const p = url.pathname.replace('/api/v4/projects/group%2Fproject', '');
			if (p === '/merge_requests' && req.method === 'GET') {
				return json([mr]);
			}
			if (p === '/merge_requests/1') {
				return json(mr);
			}
			if (p === '/merge_requests/1/commits') {
				return json([{ id: head, message: 'MR change', author_name: 'Rev', created_at: '2026-10-20T10:00:00Z' }]);
			}
			if (p === '/merge_requests/1/changes') {
				return json({ changes: [{ new_path: 'a.txt', old_path: 'a.txt', diff: '-three\n+THREE from MR\n' }] });
			}
			if (p === '/merge_requests/1/notes') {
				return json([{ id: 50, author: { username: 'rev' }, created_at: '2026-10-20T11:00:00Z', body: 'Is this loud enough?' }]);
			}
			if (p === '/merge_requests/1/discussions' && req.method === 'GET') {
				return json([{ id: 'disc1', notes: [{ id: 50, position: { new_path: 'a.txt', new_line: 3 } }] }]);
			}
			if (p === '/merge_requests/1/discussions' && req.method === 'POST') {
				posted.push(JSON.parse(body));
				return json({});
			}
			if (p === '/merge_requests/1/discussions/disc1/notes' && req.method === 'POST') {
				posted.push({ reply: true, ...JSON.parse(body) });
				return json({});
			}
			if (p === '/merge_requests/1/approvals') {
				return json({ approved_by: [] });
			}
			res.writeHead(404);
			res.end('{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as { port: number }).port;
	try {
		await vscode.workspace.getConfiguration('changeline').update('gitlab.hosts', ['127.0.0.1'], vscode.ConfigurationTarget.Global);
		await services().context.secrets.store('changeline.token.gitlab.127.0.0.1', 'e2e-token');
		await repo.addRemote('origin', `http://127.0.0.1:${port}/group/project.git`);
		api._test.hosting.forgetHosting();
		const h = await api._test.hosting.hostingFor(repo, false);
		assert.ok(h, 'GitLab detected');
		assert.equal(h!.target.kind, 'gitlab');
		const list = await h!.provider.list('open');
		assert.deepEqual(list.map((m) => m.title), ['Shout three']);
		const { targets } = await api._test.pullRequests.reviewTargets(1);
		assert.equal(targets.length, 1);
		const t = targets[0];
		assert.equal(t.review?.comments.length, 1);
		assert.equal(t.review?.comments[0].line, 3);
		assert.equal(await repo.revParse('refs/changeline/pr/1'), head, 'merge request head fetched');
		const content = (await repo.getContent(head, 'a.txt')).toString();
		assert.match(content, /THREE from MR/);
		await t.review!.submit({ line: 3, side: 'RIGHT', body: 'Yes, LGTM' });
		assert.equal(posted.length, 1);
		assert.equal(posted[0].body, 'Yes, LGTM');
		assert.equal(posted[0].position.new_line, 3);
		assert.equal(posted[0].position.head_sha, head);
		await t.review!.submit({ line: 3, side: 'RIGHT', body: 'Reply', inReplyTo: t.review!.comments[0].thread });
		assert.deepEqual(posted[1], { reply: true, body: 'Reply' });
	} finally {
		server.close();
		await repo.removeRemote('origin').catch(() => undefined);
		await vscode.workspace.getConfiguration('changeline').update('gitlab.hosts', undefined, vscode.ConfigurationTarget.Global);
		try {
			fs.rmSync(srv, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {
			console.log(`  (could not remove ${srv}; it is in the system temp folder)`);
		}
	}
});


type Answer = (message: string, items: string[]) => string | undefined;

/** Answers modals and pickers the extension raises (the test shares the extension's `vscode` API object). */
function stubWindow(h: { warning?: Answer; info?: Answer; quickPick?: (items: any[]) => any }): () => void {
	const w = vscode.window as any;
	const orig = { showWarningMessage: w.showWarningMessage, showInformationMessage: w.showInformationMessage, showQuickPick: w.showQuickPick };
	const strings = (rest: unknown[]) => rest.filter((r): r is string => typeof r === 'string');
	if (h.warning) {
		w.showWarningMessage = async (m: string, ...rest: unknown[]) => h.warning!(m, strings(rest));
	}
	if (h.info) {
		w.showInformationMessage = async (m: string, ...rest: unknown[]) => h.info!(m, strings(rest));
	}
	if (h.quickPick) {
		w.showQuickPick = async (items: any) => h.quickPick!(await items);
	}
	return () => Object.assign(w, orig);
}

function mainRepo() {
	return api._test.services().repos.repositories.find((r) => fs.realpathSync(r.root) === fs.realpathSync(ws))!;
}

async function commitFile(rel: string, content: string, message: string): Promise<string> {
	const repo = mainRepo();
	fs.writeFileSync(path.join(ws, rel), content);
	await repo.stage([rel]);
	await repo.commit({ message });
	await repo.refresh();
	return (await repo.revParse('HEAD'))!;
}

const read = (rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8');
const hasTab = (label: string | RegExp) => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => (typeof label === 'string' ? t.label === label : label.test(t.label))));
const setting = (key: string, value: unknown, target = vscode.ConfigurationTarget.Global) => vscode.workspace.getConfiguration('changeline').update(key, value, target);

/** Modifies a tracked file and includes only it in the next commit. */
async function changeOnly(rel: string, content: string): Promise<string> {
	const repo = mainRepo();
	const abs = repo.absolutePath(rel);
	fs.writeFileSync(abs, content);
	await repo.refresh();
	await waitFor(() => api._test.changesView.allFiles().some((f) => f.abs === abs && f.group === 'changelist'), `${rel} in Local Changes`);
	api._test.services().changelists.includeOnly([abs]);
	return abs;
}


test('before-commit checks: analyze code, check TODO, run tests, reformat, optimize imports', async () => {
	const repo = mainRepo();
	const commit = api._test.commit;
	const run = (message: string, options: Partial<typeof commit.options>) => commit.commit({ message, amend: false, push: false, options: { ...commit.options, ...options } });
	const head = async (rel: string) => (await repo.getContent('HEAD', rel)).toString();
	await commitFile('chk.txt', 'x1\n', 'add chk');
	const asked: string[] = [];
	let answer: string | undefined;
	const restore = stubWindow({ warning: (m) => (asked.push(m), answer) });
	try {
		const abs = await changeOnly('chk.txt', 'x2\n');
		const dc = vscode.languages.createDiagnosticCollection('changeline-test');
		dc.set(vscode.Uri.file(abs), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'broken', vscode.DiagnosticSeverity.Error)]);
		answer = 'Review';
		assert.equal(await run('analyzed', { analyzeCode: true }), false);
		assert.ok(asked.some((m) => /Code analysis found 1 error and 0 warnings/.test(m)), asked.join(' | '));
		assert.equal(await head('chk.txt'), 'x1\n');
		answer = 'Commit Anyway';
		assert.equal(await run('analyzed', { analyzeCode: true }), true);
		assert.equal(await head('chk.txt'), 'x2\n');
		dc.dispose();

		await changeOnly('chk.txt', 'x3\n// TODO later\n');
		answer = undefined;
		assert.equal(await run('todo', { checkTodo: true }), false);
		assert.ok(asked.some((m) => /1 new TODO item found:\nchk\.txt:2/.test(m)), asked.join(' | '));
		answer = 'Commit Anyway';
		assert.equal(await run('todo', { checkTodo: true }), true);

		fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
		fs.writeFileSync(path.join(ws, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
			{ label: 'jg-fail', type: 'shell', command: 'exit 3', presentation: { reveal: 'never' }, problemMatcher: [] },
			{ label: 'jg-ok', type: 'shell', command: 'exit 0', presentation: { reveal: 'never' }, problemMatcher: [] },
		] }));
		await waitFor(async () => (await vscode.tasks.fetchTasks()).some((t) => t.name === 'jg-ok'), 'tasks.json picked up');
		await changeOnly('chk.txt', 'x4\n');
		await setting('commit.testTask', 'jg-fail', vscode.ConfigurationTarget.Workspace);
		answer = undefined;
		assert.equal(await run('tested', { runTests: true }), false);
		assert.ok(asked.some((m) => /Tests failed \("jg-fail" exited with code 3\)/.test(m)), asked.join(' | '));
		await setting('commit.testTask', 'jg-ok', vscode.ConfigurationTarget.Workspace);
		assert.equal(await run('tested', { runTests: true }), true);
		assert.equal(await head('chk.txt'), 'x4\n');

		await commitFile('imp.fmt', 'b\na\n', 'add imp');
		const selector = { pattern: '**/*.fmt' };
		const fmt = vscode.languages.registerDocumentFormattingEditProvider(selector, {
			provideDocumentFormattingEdits: (doc) => [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().toUpperCase())],
		});
		const imports = vscode.languages.registerCodeActionsProvider(selector, {
			provideCodeActions: (doc) => {
				const action = new vscode.CodeAction('Sort lines', vscode.CodeActionKind.SourceOrganizeImports);
				action.edit = new vscode.WorkspaceEdit();
				action.edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().split('\n').filter(Boolean).sort().join('\n') + '\n');
				return [action];
			},
		}, { providedCodeActionKinds: [vscode.CodeActionKind.SourceOrganizeImports] });
		await changeOnly('imp.fmt', 'd\nc\n');
		assert.equal(await run('formatted', { reformatCode: true, optimizeImports: true }), true);
		assert.equal(await head('imp.fmt'), 'C\nD\n');
		assert.equal(read('imp.fmt'), 'C\nD\n');
		fmt.dispose();
		imports.dispose();
	} finally {
		restore();
		await setting('commit.testTask', undefined, vscode.ConfigurationTarget.Workspace);
		fs.rmSync(path.join(ws, '.vscode'), { recursive: true, force: true });
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	}
});

test('detached HEAD and CRLF warnings before commit', async () => {
	const repo = mainRepo();
	const commit = api._test.commit;
	const asked: string[] = [];
	const restore = stubWindow({ warning: (m, items) => (asked.push(m), items.find((i) => i === 'Commit' || i === 'Commit As Is')) });
	try {
		await repo.checkout('HEAD', { detach: true });
		await changeOnly('chk.txt', 'detached\n');
		assert.equal(repo.state.detached, true);
		assert.equal(await commit.commit({ message: 'on detached head', amend: false, push: false, options: commit.options }), true);
		assert.ok(asked.some((m) => /is in detached HEAD state/.test(m)), asked.join(' | '));
		await repo.checkout('main');
		await repo.refresh();
		assert.equal(repo.state.branch, 'main');

		if ((await repo.getConfig('core.autocrlf')) === undefined) {
			await setting('commit.warnAboutCrlf', true);
			await changeOnly('chk.txt', 'windows\r\nline\r\n');
			asked.length = 0;
			assert.equal(await commit.commit({ message: 'crlf', amend: false, push: false, options: commit.options }), true);
			assert.ok(asked.some((m) => /You are about to commit CRLF line separators/.test(m) && m.includes('chk.txt')), asked.join(' | '));
			await setting('commit.warnAboutCrlf', undefined);
		} else {
			console.log('    (CRLF check skipped: core.autocrlf is configured on this machine)');
		}
	} finally {
		restore();
	}
});

test('log context menus on commits and changed files', async () => {
	const repo = mainRepo();
	await vscode.commands.executeCommand('changeline.showLog');
	const c = await waitFor(() => api._test.logView.current, 'log controller', 15000);
	const logId = c.id;
	c.setSelection([]);
	const h1 = await commitFile('ctx.txt', 'one\n', 'ctx base');
	const h2 = await commitFile('ctx.txt', 'one\ntwo\n', 'ctx change');
	const warnings: string[] = [];
	const restore = stubWindow({
		warning: (m, items) => (warnings.push(m), items[0]),
		info: () => undefined,
		quickPick: (items) => items.find((i: any) => i.id === 'clip') ?? items.find((i: any) => i.file === 'ctx.txt'),
	});
	const onCommit = (command: string, hash: string) => vscode.commands.executeCommand(command, { logId, hash });
	const onFile = async (command: string, hash: string, file = { path: 'ctx.txt', status: 'M' }) => {
		c.setSelection([await repo.getCommit(hash)]);
		await vscode.commands.executeCommand(command, { logId, hash, ...file });
		c.setSelection([]);
	};
	const closeAll = () => vscode.commands.executeCommand('workbench.action.closeAllEditors');
	const activeDoc = () => vscode.window.activeTextEditor?.document;
	try {
		await onCommit('changeline.log.copyRevision', h2);
		assert.equal(await vscode.env.clipboard.readText(), h2);
		await onCommit('changeline.log.createPatch', h2);
		assert.match(await vscode.env.clipboard.readText(), /^From [0-9a-f]{40}[\s\S]*diff --git a\/ctx\.txt b\/ctx\.txt/);
		await closeAll();
		await onCommit('changeline.log.showRepositoryAtRevision', h1);
		await waitFor(() => activeDoc()?.uri.scheme === 'changeline', 'repository file at revision');
		assert.equal(activeDoc()!.getText(), 'one\n');
		await onCommit('changeline.log.compareWithLocal', h1);
		await waitFor(() => hasTab(/^Compare [0-9a-f]+ with Local$/), 'compare with local');
		await onCommit('changeline.log.showDiff', h2);
		await waitFor(() => hasTab('Diff: ctx.txt'), 'commit diff');
		await closeAll();

		await onCommit('changeline.log.goToParent', h2);
		await waitFor(() => c.selectedCommits.length === 1 && c.selectedCommits[0].hash === h1, 'parent selected in the log');
		await onCommit('changeline.log.goToChild', h1);
		await waitFor(() => c.selectedCommits.length === 1 && c.selectedCommits[0].hash === h2, 'child selected in the log');
		c.setSelection([]);

		await onCommit('changeline.log.fixup', h1);
		assert.equal(api._test.commit.message, 'fixup! ctx base');
		await onCommit('changeline.log.squashInto', h1);
		assert.equal(api._test.commit.message, 'squash! ctx base\n\n');
		api._test.commit.setMessage('');
		await onCommit('changeline.log.checkoutRevision', h1);
		await repo.refresh();
		assert.equal(repo.state.detached, true);
		assert.equal(repo.state.head, h1);
		await repo.checkout('main');
		await repo.refresh();

		const opened: string[] = [];
		const env = vscode.env as any;
		const openExternal = env.openExternal;
		env.openExternal = async (u: vscode.Uri) => (opened.push(u.toString(true)), true);
		await repo.addRemote('origin', 'https://github.com/acme/site.git');
		try {
			await onCommit('changeline.log.openInBrowser', h1);
			await onFile('changeline.logFile.openInBrowser', h2);
		} finally {
			env.openExternal = openExternal;
			await repo.removeRemote('origin');
		}
		assert.deepEqual(opened, [`https://github.com/acme/site/commit/${h1}`, `https://github.com/acme/site/blob/${h2}/ctx.txt`]);

		await onFile('changeline.logFile.showDiff', h2);
		await waitFor(() => hasTab('Diff: ctx.txt'), 'file diff');
		await closeAll();
		await onFile('changeline.logFile.compareWithLocal', h1);
		await waitFor(() => hasTab('Diff: ctx.txt'), 'file compared with local');
		await closeAll();
		await onFile('changeline.logFile.openRepositoryVersion', h1);
		await waitFor(() => activeDoc()?.uri.scheme === 'changeline', 'repository version');
		assert.equal(activeDoc()!.getText(), 'one\n');
		await onFile('changeline.logFile.annotate', h2);
		await waitFor(() => activeDoc()?.uri.scheme === 'changeline' && activeDoc()!.getText() === 'one\ntwo\n', 'revision to annotate');
		assert.equal(api._test.blame.isActive(activeDoc()!.uri), true, 'revision annotated');
		await onFile('changeline.logFile.editSource', h2);
		await waitFor(() => activeDoc()?.uri.scheme === 'file' && activeDoc()!.uri.fsPath.endsWith('ctx.txt'), 'source file');
		await onFile('changeline.logFile.historyUpToHere', h2);
		await waitFor(() => hasTab('History: ctx.txt'), 'history up to here');
		await closeAll();
		await onFile('changeline.logFile.getRevision', h1);
		assert.equal(read('ctx.txt'), 'one\n', 'Get');
		await repo.restore(['ctx.txt']);
		await onFile('changeline.logFile.revertSelectedChanges', h2);
		assert.equal(read('ctx.txt'), 'one\n', 'revert selected changes');
		await repo.restore(['ctx.txt']);

		api._test.setDialogResponder((spec): DialogResult | undefined => {
			if (spec.title.startsWith('Create New Branch')) {
				return { button: 'ok', values: { name: 'from-log', checkout: false, overwrite: false } };
			}
			if (spec.title === 'Create New Tag') {
				return { button: 'ok', values: { name: 'v-log', force: false, message: '' } };
			}
			if (spec.title.startsWith('Edit Commit Message')) {
				return { button: 'ok', values: { message: 'ctx change (reworded)\n' } };
			}
			if (spec.title === 'Squash 2 Commits') {
				return { button: 'ok', values: { message: 'squashed s1 and s2\n' } };
			}
			if (spec.title === 'Git Reset') {
				return { button: 'ok', values: { mode: 'keep' } };
			}
			throw new Error(`unexpected dialog ${spec.title}`);
		});
		await onCommit('changeline.log.newBranch', h1);
		assert.equal(await repo.revParse('refs/heads/from-log'), h1);
		assert.equal(repo.state.branch, 'main', 'not checked out');
		await onCommit('changeline.log.newTag', h1);
		assert.equal(await repo.revParse('refs/tags/v-log'), h1);
		await onCommit('changeline.log.editMessage', h2);
		assert.equal((await repo.getCommit('HEAD')).subject, 'ctx change (reworded)');

		await repo.checkout('from-log');
		const side = await commitFile('side.txt', 'side\n', 'side commit');
		await repo.checkout('main');
		await repo.refresh();
		await onFile('changeline.logFile.cherryPickSelectedChanges', side, { path: 'side.txt', status: 'A' });
		assert.equal(read('side.txt'), 'side\n', 'cherry-pick selected changes');
		fs.rmSync(path.join(ws, 'side.txt'));
		await repo.refresh();
		await onCommit('changeline.log.cherryPick', side);
		assert.equal((await repo.getCommit('HEAD')).subject, 'side commit');
		await repo.refresh();
		await onCommit('changeline.log.revertCommit', repo.state.head!);
		assert.equal((await repo.getCommit('HEAD')).subject, 'Revert "side commit"');
		assert.ok(!fs.existsSync(path.join(ws, 'side.txt')));
		await repo.refresh();
		const picked = (await repo.revParse('HEAD~1'))!;
		await onCommit('changeline.log.undoCommit', repo.state.head!);
		assert.equal(await repo.revParse('HEAD'), picked);
		assert.match(api._test.commit.message, /^Revert "side commit"/);
		api._test.commit.setMessage('');
		await repo.restore(['side.txt']);
		assert.equal(read('side.txt'), 'side\n');

		const d1 = await commitFile('drop1.txt', 'd1\n', 'to be dropped');
		await commitFile('keep.txt', 'k\n', 'to be kept');
		await onCommit('changeline.log.dropCommits', d1);
		assert.equal((await repo.getCommit('HEAD')).subject, 'to be kept');
		assert.equal((await repo.getCommit('HEAD~1')).subject, 'side commit');
		assert.ok(!fs.existsSync(path.join(ws, 'drop1.txt')));
		await repo.refresh();
		const s1 = await commitFile('s.txt', 's1\n', 's1');
		const s2 = await commitFile('s.txt', 's1\ns2\n', 's2');
		c.setSelection([await repo.getCommit(s2), await repo.getCommit(s1)]);
		await onCommit('changeline.log.squashCommits', s2);
		c.setSelection([]);
		assert.equal((await repo.getCommit('HEAD')).subject, 'squashed s1 and s2');
		assert.equal((await repo.getCommit('HEAD~1')).subject, 'to be kept');
		assert.equal(read('s.txt'), 's1\ns2\n');
		await repo.refresh();
		const kept = (await repo.revParse('HEAD~1'))!;
		await onCommit('changeline.log.resetToHere', kept);
		assert.equal(await repo.revParse('HEAD'), kept);
		assert.ok(!fs.existsSync(path.join(ws, 's.txt')), 'reset --keep updated the working tree');

		await repo.refresh();
		await onCommit('changeline.log.interactiveRebase', kept);
		await waitFor(() => hasTab('Rebasing main'), 'rebase dialog');
		await closeAll();
		await onCommit('changeline.log.pushUpToHere', kept);
		await waitFor(() => hasTab(/^Push Commits/), 'push dialog');
		await closeAll();
		assert.deepEqual(warnings.filter((w) => !/^(Replace the local|Revert the changes|Drop commit|Hard reset)/.test(w)), []);
	} finally {
		restore();
		api._test.setDialogResponder(undefined);
	}
});

test('shelve silently, staging area mode, line status markers, console', async () => {
	const s = api._test.services();
	const repo = mainRepo();
	const view = api._test.changesView;
	const abs = repo.absolutePath('b.txt');
	const original = read('b.txt');

	fs.writeFileSync(abs, original + 'shelved line\n');
	await repo.refresh();
	const node = await waitFor(() => view.allFiles().find((f) => f.abs === abs), 'b.txt changed');
	const before = (await s.shelf.list()).length;
	await vscode.commands.executeCommand('changeline.changes.shelveSilently', node);
	assert.equal((await s.shelf.list()).length, before + 1);
	assert.equal(read('b.txt'), original);

	await setting('commit.useStagingArea', true);
	try {
		await waitFor(() => view.stagingMode, 'staging mode');
		fs.writeFileSync(abs, original + 'staged line\n');
		await repo.refresh();
		const unstaged = await waitFor(() => view.allFiles().find((f) => f.abs === abs && f.group === 'unstaged'), 'b.txt unstaged');
		await vscode.commands.executeCommand('changeline.changes.stage', unstaged);
		await waitFor(() => view.allFiles().some((f) => f.abs === abs && f.group === 'staged'), 'b.txt staged');
		const commit = api._test.commit;
		assert.equal(await commit.commit({ message: 'staged commit', amend: false, push: false, options: commit.options }), true);
		assert.equal((await repo.getContent('HEAD', 'b.txt')).toString(), original + 'staged line\n');
	} finally {
		await setting('commit.useStagingArea', undefined);
	}

	await setting('lineStatus.enabled', 'on');
	await waitFor(() => api._test.scm.count === s.repos.repositories.length, 'source controls');
	fs.writeFileSync(abs, 'changed for markers\n');
	await repo.refresh();
	const originalUri = await api._test.scm.originalResource(repo, vscode.Uri.file(abs));
	assert.equal(originalUri?.scheme, 'changeline');
	assert.equal(JSON.parse(originalUri!.query).ref, 'HEAD');
	assert.equal((await vscode.workspace.openTextDocument(originalUri!)).getText(), original + 'staged line\n');
	const exclude = path.join(repo.root, '.git', 'info', 'exclude');
	const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : undefined;
	fs.mkdirSync(path.dirname(exclude), { recursive: true });
	fs.appendFileSync(exclude, '\n.env.local\n');
	fs.writeFileSync(path.join(ws, '.env.local'), 'SECRET=1\n');
	try {
		await repo.refresh();
		assert.equal(await api._test.scm.originalResource(repo, vscode.Uri.file(path.join(ws, '.env.local'))), undefined, 'no line markers for an ignored file');
	} finally {
		fs.rmSync(path.join(ws, '.env.local'));
		if (excluded === undefined) {
			fs.rmSync(exclude);
		} else {
			fs.writeFileSync(exclude, excluded);
		}
	}
	await setting('lineStatus.enabled', undefined);
	await waitFor(() => api._test.scm.count === 0, 'off next to the built-in Git support');
	await repo.restore(['b.txt']);

	const logged: string[] = [];
	const info = s.console.info;
	s.console.info = (line: string, ...rest: unknown[]) => (logged.push(line), info.call(s.console, line, ...rest));
	try {
		await vscode.commands.executeCommand('changeline.showConsole');
		await repo.runOp(['tag', 'console-check']);
		assert.ok(logged.some((l) => /git tag console-check/.test(l)), logged.join(' | '));
	} finally {
		s.console.info = info;
	}
});

test('diff viewer: jump to source (F4) and open in the VS Code diff editor', async () => {
	const repo = mainRepo();
	const abs = await changeOnly('b.txt', read('b.txt') + 'jump here\n');
	const node = api._test.changesView.allFiles().find((f) => f.abs === abs)!;
	const lines = read('b.txt').split('\n').length - 1;
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await vscode.commands.executeCommand('changeline.changes.openFile', node);
	await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === vscode.Uri.file(abs).fsPath, 'F4 opens the file');
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');

	await vscode.commands.executeCommand('changeline.changes.open', node);
	const panel = await waitFor(() => api._test.diffPanel(), 'diff window');
	await panel.request('openSource', { line: lines, side: 'right' });
	const editor = await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'file' && vscode.window.activeTextEditor, 'source at the line');
	assert.equal(editor.document.uri.fsPath, vscode.Uri.file(abs).fsPath);
	assert.equal(editor.selection.active.line, lines - 1);
	assert.equal(editor.document.lineAt(lines - 1).text, 'jump here');
	await panel.request('openSource', { line: 1, side: 'left' });
	await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'changeline', 'left side (HEAD) as a read-only revision');

	await panel.request('openNative');
	await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 'VS Code diff editor');
	const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
	assert.equal(input.original.scheme, 'changeline');
	assert.equal(input.modified.fsPath, vscode.Uri.file(abs).fsPath);
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await repo.restore(['b.txt']);
});

test('explorer: Commit File and Rollback on a folder find the changed files inside it', async () => {
	const repo = mainRepo();
	fs.mkdirSync(path.join(ws, 'dir', 'sub'), { recursive: true });
	await commitFile('dir/sub/x.txt', 'x\n', 'add dir');
	await commitFile('dir2.txt', 'y\n', 'add dir2');
	fs.writeFileSync(path.join(ws, 'dir', 'sub', 'x.txt'), 'x changed\n');
	fs.writeFileSync(path.join(ws, 'dir2.txt'), 'y changed\n');
	await repo.refresh();
	const inside = repo.absolutePath('dir/sub/x.txt');
	const outside = repo.absolutePath('dir2.txt');
	await waitFor(() => [inside, outside].every((p) => api._test.changesView.allFiles().some((f) => f.abs === p) && api._test.services().changelists.isIncluded(p)), 'both files changed');
	const folder = vscode.Uri.file(path.join(ws, 'dir'));
	await vscode.commands.executeCommand('changeline.commitFile', folder);
	assert.deepEqual(api._test.changesView.includedFiles().map((f) => f.change.path), ['dir/sub/x.txt']);
	let offered: string[] = [];
	api._test.setDialogResponder((spec): DialogResult | undefined => {
		const list = spec.fields.find((f) => f.id === 'files') as { options: { value: string; label: string }[] };
		offered = list.options.map((o) => o.label);
		return { button: 'ok', values: { files: list.options.map((o) => o.value) } };
	});
	try {
		await vscode.commands.executeCommand('changeline.rollbackFile', folder);
	} finally {
		api._test.setDialogResponder(undefined);
	}
	assert.deepEqual(offered, ['x.txt']);
	assert.equal(read('dir/sub/x.txt'), 'x\n');
	assert.equal(read('dir2.txt'), 'y changed\n');
	await repo.restore(['dir2.txt']);
});

export function run(): Promise<void> {
	return runAll();
}
