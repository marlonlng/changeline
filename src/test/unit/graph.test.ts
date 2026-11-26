import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { layoutGraph } from '../../shared/graph';

test('linear history uses one lane', () => {
	const rows = layoutGraph([
		{ hash: 'c', parents: ['b'] },
		{ hash: 'b', parents: ['a'] },
		{ hash: 'a', parents: [] },
	]);
	assert.deepEqual(rows.map((r) => r.node), [0, 0, 0]);
	assert.deepEqual(rows.map((r) => r.width), [1, 1, 1]);
});

test('merge creates and joins a second lane', () => {
	const rows = layoutGraph([
		{ hash: 'm', parents: ['b', 'f'] },
		{ hash: 'f', parents: ['a'] },
		{ hash: 'b', parents: ['a'] },
		{ hash: 'a', parents: [] },
	]);
	assert.equal(rows[0].node, 0);
	assert.equal(rows[1].node, 1);
	assert.equal(rows[2].node, 0);
	assert.equal(rows[3].node, 0);
	assert.equal(rows[0].width, 2);
	assert.ok(rows[2].lines.some((l) => l.x1 === 1 && l.y1 === 0 && l.x2 === 0 && l.y2 === 2));
	assert.equal(rows[3].width, 1);
});

test('branch tips get new lanes', () => {
	const rows = layoutGraph([
		{ hash: 'x', parents: ['a'] },
		{ hash: 'y', parents: ['a'] },
		{ hash: 'a', parents: [] },
	]);
	assert.equal(rows[0].node, 0);
	assert.equal(rows[1].node, 1);
	assert.notEqual(rows[0].color, rows[1].color);
	assert.equal(rows[2].node, 0);
});

test('collapse linear branches hides the inside of side branch runs', async () => {
	const { collapseLinearBranches } = await import('../../shared/graph');
	const commits = [
		{ hash: 'm2', parents: ['m1', 's4'] },
		{ hash: 's4', parents: ['s3'] },
		{ hash: 's3', parents: ['s2'] },
		{ hash: 's2', parents: ['s1'] },
		{ hash: 's1', parents: ['m0'] },
		{ hash: 'm1', parents: ['m0'] },
		{ hash: 'm0', parents: [] },
	];
	const r = collapseLinearBranches(commits, new Map(), 'm2', new Set());
	assert.deepEqual(r.visible.map((c) => c.hash), ['m2', 's4', 's1', 'm1', 'm0']);
	assert.deepEqual(r.visible.find((c) => c.hash === 's4')!.parents, ['s1']);
	assert.equal(r.counts.get('s4'), 2);
	assert.equal(collapseLinearBranches(commits, new Map(), 'm2', new Set(['s4'])).visible.length, 7);
	assert.equal(collapseLinearBranches(commits, new Map([['s3', 1]]), 'm2', new Set()).visible.length, 7);
	const rows = layoutGraph(r.visible);
	assert.equal(rows[rows.length - 1].width <= 2, true);
});

test('layoutGraph: long edges end in arrows and free their lane, unless shown', () => {
	const main = Array.from({ length: 42 }, (_, i) => `m${i}`);
	const commits = [
		{ hash: 'm0', parents: ['m1', 's0'] },
		...main.slice(1, 41).map((h, i) => ({ hash: h, parents: [main[i + 2]] })),
		{ hash: 's0', parents: ['m41'] },
		{ hash: 'm41', parents: [] },
	];
	const cut = layoutGraph(commits);
	assert.ok(cut[3].lines.some((l) => l.arrow === 'down'), 'the edge ends with an arrow a few rows below the merge');
	assert.equal(cut[20].width, 1, 'the lane is free in between');
	assert.ok(cut[38].lines.some((l) => l.arrow === 'up'), 'the edge starts again a few rows above the parent');
	assert.equal(cut[41].node, 1);
	const full = layoutGraph(commits, { longEdges: true });
	assert.ok(full.every((r) => r.lines.every((l) => !l.arrow)));
	assert.equal(full[20].width, 2);
});
