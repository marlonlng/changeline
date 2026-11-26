import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeByDate } from '../../shared/logMerge';
import type { CommitInfo } from '../../shared/types';

const c = (hash: string, commitDate: number): CommitInfo => ({ hash, parents: [], author: '', authorEmail: '', authorDate: commitDate, committer: '', committerEmail: '', commitDate, subject: hash });

test('mergeByDate: interleaves repositories by commit date and keeps each order', () => {
	const a = [c('a3', 30), c('a1', 10)];
	const b = [c('b4', 40), c('b2', 20), c('b0', 0)];
	assert.deepEqual(mergeByDate([a, b], 10).map((x) => x.hash), ['b4', 'a3', 'b2', 'a1', 'b0']);
	assert.deepEqual(mergeByDate([a, b], 2).map((x) => x.hash), ['b4', 'a3']);
	assert.deepEqual(mergeByDate([[c('t2', 5), c('t1', 50)]], 5).map((x) => x.hash), ['t2', 't1']);
});
