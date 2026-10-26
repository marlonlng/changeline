import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as P from '../../git/parsers';

test('status v2 parsing and classification', () => {
	const out = [
		'# branch.oid 1234567890abcdef1234567890abcdef12345678',
		'# branch.head main',
		'# branch.upstream origin/main',
		'# branch.ab +2 -1',
		'1 .M N... 100644 100644 100644 aaa bbb src/file with space.ts',
		'1 A. N... 000000 100644 100644 000 bbb added.txt',
		'1 .D N... 100644 100644 000000 aaa aaa gone.txt',
		'2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt',
		'old name.txt',
		'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
		'u UD N... 100644 100644 000000 100644 a b c deleted-by-them.txt',
		'? untracked.txt',
		'',
	].join('\0');
	const s = P.parseStatusV2(out);
	assert.equal(s.branch, 'main');
	assert.equal(s.upstream, 'origin/main');
	assert.equal(s.ahead, 2);
	assert.equal(s.behind, 1);
	const c = P.classifyStatus(s.entries);
	assert.deepEqual(c.changes, [
		{ path: 'src/file with space.ts', status: 'M' },
		{ path: 'added.txt', status: 'A' },
		{ path: 'gone.txt', status: 'D' },
		{ path: 'new name.txt', origPath: 'old name.txt', status: 'R' },
	]);
	assert.equal(c.staged.length, 2);
	assert.equal(c.unstaged.length, 2);
	assert.deepEqual(c.untracked, [{ path: 'untracked.txt', status: '?' }]);
	assert.equal(c.conflicts.length, 2);
	assert.equal(c.conflicts[1].theirs, 'deleted');
	assert.equal(c.conflicts[1].ours, 'modified');
});

test('name-status parsing', () => {
	const out = 'M\0a.txt\0R087\0old.txt\0new.txt\0D\0gone\0A\0x y\0';
	assert.deepEqual(P.parseNameStatus(out), [
		{ path: 'a.txt', status: 'M' },
		{ path: 'new.txt', origPath: 'old.txt', status: 'R' },
		{ path: 'gone', status: 'D' },
		{ path: 'x y', status: 'A' },
	]);
});

test('refs parsing', () => {
	const out = [
		['refs/heads/main', 'aaa', '', 'refs/remotes/origin/main', 'ahead 1, behind 2', '*', '100', ''].join('\0'),
		['refs/heads/feature/x', 'bbb', '', 'refs/remotes/origin/feature/x', 'gone', ' ', '100', ''].join('\0'),
		['refs/remotes/origin/HEAD', 'aaa', '', '', '', ' ', '100', 'refs/remotes/origin/main'].join('\0'),
		['refs/remotes/origin/main', 'ccc', '', '', '', ' ', '100', ''].join('\0'),
		['refs/tags/v1', 'tagobj', 'ddd', '', '', ' ', '100', ''].join('\0'),
	].join('\n');
	const refs = P.parseRefs(out);
	assert.equal(refs.length, 4);
	assert.equal(refs[0].current, true);
	assert.equal(refs[0].ahead, 1);
	assert.equal(refs[0].behind, 2);
	assert.equal(refs[1].upstreamGone, true);
	assert.equal(refs[2].remote, 'origin');
	assert.equal(refs[3].hash, 'ddd');
});

test('blame porcelain parsing', () => {
	const h1 = 'a'.repeat(40);
	const h2 = 'b'.repeat(40);
	const out = [
		`${h1} 1 1 2`,
		'author Alice',
		'author-mail <alice@example.com>',
		'author-time 1700000000',
		'committer Alice',
		'committer-time 1700000000',
		'summary First',
		'filename f.txt',
		'\tline one',
		`${h1} 2 2`,
		'\tline two',
		`${h2} 3 3 1`,
		'author Bob',
		'author-mail <bob@example.com>',
		'author-time 1700000100',
		'summary Second',
		`previous ${h1} f.txt`,
		'filename f.txt',
		'\tline three',
		'',
	].join('\n');
	const r = P.parseBlamePorcelain(out);
	assert.equal(r.lines.length, 3);
	assert.equal(r.lines[1].hash, h1);
	assert.equal(r.commits.get(h2)!.author, 'Bob');
	assert.equal(r.commits.get(h2)!.previous!.hash, h1);
	assert.equal(r.commits.get(h1)!.authorMail, 'alice@example.com');
});

test('push porcelain parsing', () => {
	const out = 'To github.com:x/y.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)\nDone\n';
	const r = P.parsePushPorcelain(out);
	assert.equal(r.length, 1);
	assert.equal(r[0].flag, '!');
	assert.equal(r[0].reason, 'non-fast-forward');
});

test('recent checkouts', () => {
	const out = 'checkout: moving from feature to main\ncommit: x\ncheckout: moving from main to feature\ncheckout: moving from 1a2b3c4d to main\n';
	assert.deepEqual(P.parseRecentCheckouts(out), ['main', 'feature']);
});

test('stash list', () => {
	const out = 'stash@{0}\x1fabc\x1fp1 p2\x1f100\x1fOn main: my message\x1e\nstash@{1}\x1fdef\x1fp1 p2 p3\x1f90\x1fWIP on dev: 123abc subject\x1e\n';
	const r = P.parseStashList(out);
	assert.equal(r.length, 2);
	assert.equal(r[0].message, 'my message');
	assert.equal(r[1].branch, 'dev');
	assert.equal(r[1].parents.length, 3);
});
