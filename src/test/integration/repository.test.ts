import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { findGit, GitCli } from '../../git/gitCli';
import { Repository } from '../../git/repository';
import { applyChunks, diffLines, splitLines } from '../../shared/diff';

let git: GitCli;
let tmp: string;
let scripts: string;

before(async () => {
	const found = await findGit([]);
	git = new GitCli(found.path, found.version, () => undefined, {
		GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
		GIT_LITERAL_PATHSPECS: '1', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(),
	});
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'changeline-test-'));
	scripts = path.join(tmp, 'scripts');
	fs.mkdirSync(scripts);
	fs.writeFileSync(path.join(scripts, 'sequence-editor.sh'), '#!/bin/sh\ncat "$CHANGELINE_REBASE_TODO" > "$1"\n', { mode: 0o755 });
});

after(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function newRepo(name: string): Promise<Repository> {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir);
	await git.exec(dir, ['init', '-q', '-b', 'main']);
	await git.exec(dir, ['config', 'user.name', 'Test']);
	await git.exec(dir, ['config', 'user.email', 't@example.com']);
	await git.exec(dir, ['config', 'commit.gpgsign', 'false']);
	const repo = await Repository.open(git, dir);
	assert.ok(repo);
	return repo!;
}

function write(repo: Repository, rel: string, content: string) {
	const p = repo.absolutePath(rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

async function show(repo: Repository, rev: string, rel: string) {
	return (await repo.getContent(rev, rel)).toString('utf8');
}

test('initial commit through temporary index, partial content and index sync', async () => {
	const repo = await newRepo('partial');
	write(repo, 'a.txt', 'one\ntwo\nthree\n');
	write(repo, 'dir/b.txt', 'bee\n');
	write(repo, 'untouched.txt', 'x\n');
	await repo.refresh();
	assert.equal(repo.state.untracked.length, 3);
	await repo.commit({ message: 'initial', files: [{ path: 'a.txt', status: '?' }, { path: 'dir/b.txt', status: '?' }] });
	await repo.refresh();
	assert.deepEqual(repo.state.untracked.map((f) => f.path), ['untouched.txt']);
	assert.equal(repo.state.changes.length, 0);

	write(repo, 'dir/b.txt', 'bee2\n');
	await repo.stage(['dir/b.txt']);
	write(repo, 'a.txt', 'ONE\ntwo\nthree\nFOUR\n');
	const oldLines = splitLines(await show(repo, 'HEAD', 'a.txt'));
	const newLines = splitLines(fs.readFileSync(repo.absolutePath('a.txt'), 'utf8'));
	const chunks = diffLines(oldLines, newLines);
	assert.equal(chunks.length, 2);
	const partial = applyChunks(oldLines, newLines, chunks, (_c, i) => i === 0);
	await repo.commit({ message: 'partial', files: [{ path: 'a.txt', status: 'M', content: partial }] });
	assert.equal(await show(repo, 'HEAD', 'a.txt'), 'ONE\ntwo\nthree\n');
	await repo.refresh();
	assert.deepEqual(repo.state.changes.map((c) => c.path).sort(), ['a.txt', 'dir/b.txt']);
	assert.deepEqual(repo.state.staged.map((c) => c.path), ['dir/b.txt']);
	assert.equal(await show(repo, '', 'a.txt'), 'ONE\ntwo\nthree\n', 'index synced with HEAD for committed path');
	const log = await repo.log({});
	assert.deepEqual(log.map((c) => c.subject), ['partial', 'initial']);
});

test('commit deletions and renames, amend, rollback', async () => {
	const repo = await newRepo('ops');
	write(repo, 'keep.txt', 'k\n');
	write(repo, 'old.txt', 'content\n');
	write(repo, 'del.txt', 'd\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'base' });
	await git.exec(repo.root, ['mv', 'old.txt', 'new.txt']);
	fs.rmSync(repo.absolutePath('del.txt'));
	await repo.refresh();
	const changes = repo.state.changes;
	assert.ok(changes.find((c) => c.status === 'R' && c.path === 'new.txt' && c.origPath === 'old.txt'));
	assert.ok(changes.find((c) => c.status === 'D' && c.path === 'del.txt'));
	await repo.commit({ message: 'move', files: changes.map((c) => ({ ...c })) });
	await repo.refresh();
	assert.equal(repo.state.changes.length, 0);
	const files = await repo.getCommitFiles((await repo.revParse('HEAD'))!, [(await repo.revParse('HEAD~1'))!]);
	assert.deepEqual(files.map((f) => f.status).sort(), ['D', 'R']);

	await repo.commit({ message: 'move renamed', amend: true, files: [] });
	assert.equal((await repo.getCommit('HEAD')).subject, 'move renamed');

	write(repo, 'keep.txt', 'changed\n');
	write(repo, 'added.txt', 'new\n');
	await repo.add(['added.txt']);
	await repo.refresh();
	await repo.rollback(repo.state.changes, false);
	assert.equal(fs.readFileSync(repo.absolutePath('keep.txt'), 'utf8'), 'k\n');
	assert.ok(fs.existsSync(repo.absolutePath('added.txt')), 'added file kept as unversioned');
	assert.deepEqual(repo.state.untracked.map((u) => u.path), ['added.txt']);
});

test('hasFile: tracked, staged, untracked and ignored files', async () => {
	const repo = await newRepo('hasfile');
	write(repo, '.gitignore', '.env.local\n');
	write(repo, 'tracked.txt', 't\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'base' });
	write(repo, '.env.local', 'SECRET=1\n');
	write(repo, 'untracked.txt', 'u\n');
	write(repo, 'staged.txt', 's\n');
	await repo.add(['staged.txt']);
	assert.equal(await repo.hasFile('HEAD', 'tracked.txt'), true);
	assert.equal(await repo.hasFile('HEAD', '.env.local'), false);
	assert.equal(await repo.hasFile('HEAD', 'untracked.txt'), false);
	assert.equal(await repo.hasFile('HEAD', 'staged.txt'), false);
	assert.equal(await repo.hasFile('', 'staged.txt'), true);
	assert.equal(await repo.hasFile('', '.env.local'), false);
});

test('merge conflict detection and stages', async () => {
	const repo = await newRepo('merge');
	write(repo, 'f.txt', 'a\nb\nc\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'base' });
	await repo.checkout('main', { newBranch: 'feature' });
	write(repo, 'f.txt', 'a\nFEATURE\nc\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'feature' });
	await repo.checkout('main');
	write(repo, 'f.txt', 'a\nMAIN\nc\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'main' });
	const outcome = await repo.merge('feature');
	assert.equal(outcome.ok, false);
	assert.equal(outcome.conflicts, true);
	await repo.refresh();
	assert.equal(repo.state.operation, 'merge');
	assert.equal(repo.state.conflicts.length, 1);
	assert.equal(repo.state.conflicts[0].code, 'UU');
	assert.equal(await show(repo, ':1', 'f.txt'), 'a\nb\nc\n');
	assert.equal(await show(repo, ':2', 'f.txt'), 'a\nMAIN\nc\n');
	assert.equal(await show(repo, ':3', 'f.txt'), 'a\nFEATURE\nc\n');
	write(repo, 'f.txt', 'a\nMAIN\nFEATURE\nc\n');
	await repo.stage(['f.txt']);
	const cont = await repo.continueOperation();
	assert.equal(cont.ok, true);
	await repo.refresh();
	assert.equal(repo.state.operation, 'none');
	assert.equal((await repo.getCommit('HEAD')).parents.length, 2);
});

test('interactive rebase: reword, squash, drop', async () => {
	const repo = await newRepo('rebase');
	for (const n of ['one', 'two', 'three', 'four']) {
		write(repo, `${n}.txt`, n + '\n');
		await repo.stage(['.']);
		await repo.commit({ message: n });
	}
	const log = await repo.log({});
	const [four, three, two] = log;
	const base = log[3].hash;
	const outcome = await repo.rebaseInteractive(base, [
		{ action: 'reword', hash: two.hash, subject: two.subject, message: 'two (reworded)' },
		{ action: 'squash', hash: three.hash, subject: three.subject, message: 'two and three' },
		{ action: 'drop', hash: four.hash, subject: four.subject },
	], scripts);
	assert.equal(outcome.ok, true, outcome.output);
	const after = await repo.log({ revisions: ['HEAD'] });
	assert.deepEqual(after.map((c) => c.subject), ['two and three', 'one']);
	assert.ok(!fs.existsSync(repo.absolutePath('four.txt')));
	assert.ok(fs.existsSync(repo.absolutePath('three.txt')));
});

test('stash, file history, refs and push rejection', async () => {
	const remoteDir = path.join(tmp, 'remote.git');
	await git.exec(tmp, ['init', '-q', '--bare', '-b', 'main', remoteDir]);
	const repo = await newRepo('push');
	write(repo, 'a.txt', '1\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'c1' });
	await repo.addRemote('origin', remoteDir);
	let res = await repo.push({ remote: 'origin', source: 'HEAD', remoteBranch: 'main', setUpstream: true });
	assert.equal(res.rejected, false);
	await repo.refresh();
	assert.equal(repo.state.upstream, 'origin/main');

	const other = path.join(tmp, 'other');
	await git.exec(tmp, ['clone', '-q', remoteDir, other]);
	fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
	await git.exec(other, ['add', '.']);
	await git.exec(other, ['-c', 'user.name=O', '-c', 'user.email=o@x', 'commit', '-qm', 'other']);
	await git.exec(other, ['push', '-q', 'origin', 'main']);

	write(repo, 'a.txt', '2\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'c2' });
	res = await repo.push({ remote: 'origin', source: 'HEAD', remoteBranch: 'main' });
	assert.equal(res.rejected, true);

	await repo.fetch('origin');
	await repo.refresh();
	assert.equal(repo.state.behind, 1);
	assert.equal(repo.state.ahead, 1);
	const outgoing = await repo.getOutgoingCommits('HEAD', 'origin', 'main');
	assert.deepEqual(outgoing.map((c) => c.subject), ['c2']);

	write(repo, 'a.txt', '3\n');
	assert.equal(await repo.stash({ message: 'wip' }), true);
	const stashes = await repo.getStashes();
	assert.equal(stashes.length, 1);
	assert.equal(stashes[0].message, 'wip');
	assert.deepEqual((await repo.getStashFiles(stashes[0])).map((f) => f.path), ['a.txt']);
	const pop = await repo.stashApply(stashes[0].ref, { pop: true });
	assert.equal(pop.ok, true);

	const history = await repo.fileHistory('a.txt');
	assert.deepEqual(history.map((c) => c.subject), ['c2', 'c1']);
	assert.equal(history[0].files[0].path, 'a.txt');
	const refs = await repo.getRefs();
	assert.ok(refs.find((r) => r.shortName === 'origin/main' && r.type === 'remote'));
	assert.ok(refs.find((r) => r.shortName === 'main' && r.current && r.upstream === 'origin/main'));

	const blame = await repo.blame('a.txt', { contents: 'changed\n' });
	assert.equal(blame.lines.length, 1);
	assert.equal(blame.lines[0].hash, '0'.repeat(40));
});

test('path filtered log rewrites parents so the graph stays connected', async () => {
	const repo = await newRepo('pathlog');
	for (let i = 1; i <= 3; i++) {
		write(repo, 'a.txt', `${i}\n`);
		write(repo, `b${i}.txt`, `${i}\n`);
		await repo.stage(['.']);
		await repo.commit({ message: `c${i} a` });
		write(repo, `b${i}.txt`, `x${i}\n`);
		await repo.stage(['.']);
		await repo.commit({ message: `c${i} b only` });
	}
	const log = await repo.log({ paths: ['a.txt'] });
	assert.deepEqual(log.map((c) => c.subject), ['c3 a', 'c2 a', 'c1 a']);
	assert.equal(log[0].parents[0], log[1].hash);
	assert.equal(log[1].parents[0], log[2].hash);
});

test('worktrees can be listed, added and removed', async () => {
	const repo = await newRepo('wt');
	write(repo, 'a.txt', 'a\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'base' });
	const dir = path.join(tmp, 'wt-second');
	await repo.addWorktree(dir, 'main', 'second');
	let list = await repo.listWorktrees();
	assert.equal(list.length, 2);
	assert.equal(list[1].branch, 'second');
	await repo.removeWorktree(dir);
	list = await repo.listWorktrees();
	assert.equal(list.length, 1);
});

test('creating a stash fires onDidChangeRefs so stash views refresh', async () => {
	const repo = await newRepo('stashrefs');
	write(repo, 'a.txt', 'a\n');
	await repo.stage(['.']);
	await repo.commit({ message: 'base' });
	await repo.refresh();
	let fired = 0;
	repo.onDidChangeRefs(() => fired++);
	write(repo, 'a.txt', 'changed\n');
	await repo.stash({ message: 'wip' });
	assert.ok(fired > 0, 'refs change event after stash');
	const before = fired;
	await repo.stashDrop('stash@{0}');
	assert.ok(fired > before, 'refs change event after drop');
});
