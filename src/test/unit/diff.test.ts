import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyChunks, diffInts, diffLines, diffWords, splitLines } from '../../shared/diff';
import { autoMerge, computeMerge } from '../../shared/diff3';

function lcsLength(a: number[], b: number[]): number {
	const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return dp[a.length][b.length];
}

function rand(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

test('myers diff produces a valid minimal edit script', () => {
	const r = rand(42);
	for (let iter = 0; iter < 400; iter++) {
		const a = Array.from({ length: Math.floor(r() * 30) }, () => Math.floor(r() * 5));
		const b = Array.from({ length: Math.floor(r() * 30) }, () => Math.floor(r() * 5));
		const chunks = diffInts(a, b);
		const out: number[] = [];
		let pos = 0;
		let unchanged = 0;
		for (const c of chunks) {
			assert.ok(c.oldStart >= pos, 'chunks ordered');
			for (let k = pos; k < c.oldStart; k++) {
				out.push(a[k]);
				unchanged++;
			}
			out.push(...b.slice(c.newStart, c.newEnd));
			pos = c.oldEnd;
		}
		for (let k = pos; k < a.length; k++) {
			out.push(a[k]);
			unchanged++;
		}
		assert.deepEqual(out, b);
		assert.equal(unchanged, lcsLength(a, b), `minimal for ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
	}
});

test('diffLines ignores CRLF vs LF but not a missing final newline', () => {
	assert.deepEqual(diffLines(['a\r\n', 'b\r\n'], ['a\n', 'b\n']), []);
	const chunks = diffLines(['a\n', 'b'], ['a\n', 'b\n']);
	assert.equal(chunks.length, 1);
});

test('applyChunks selects chunks', () => {
	const oldLines = splitLines('one\ntwo\nthree\nfour\n');
	const newLines = splitLines('ONE\ntwo\nthree\nFOUR\nfive\n');
	const chunks = diffLines(oldLines, newLines);
	assert.equal(chunks.length, 2);
	assert.equal(applyChunks(oldLines, newLines, chunks, (_c, i) => i === 0), 'ONE\ntwo\nthree\nfour\n');
	assert.equal(applyChunks(oldLines, newLines, chunks, (_c, i) => i === 1), 'one\ntwo\nthree\nFOUR\nfive\n');
	assert.equal(applyChunks(oldLines, newLines, chunks, () => true), 'ONE\ntwo\nthree\nFOUR\nfive\n');
	assert.equal(applyChunks(oldLines, newLines, chunks, () => false), 'one\ntwo\nthree\nfour\n');
});

test('applyChunks keeps text when no final newline', () => {
	const oldLines = splitLines('a\nb');
	const newLines = splitLines('a\nb\nc');
	const chunks = diffLines(oldLines, newLines);
	assert.equal(applyChunks(oldLines, newLines, chunks, () => false), 'a\nb');
	assert.equal(applyChunks(oldLines, newLines, chunks, () => true), 'a\nb\nc');
});

test('word diff finds changed words', () => {
	const r = diffWords('const value = 1;', 'const result = 2;');
	assert.deepEqual(r.oldRanges.map((x) => 'const value = 1;'.slice(x.start, x.end)), ['value', '1']);
	assert.deepEqual(r.newRanges.map((x) => 'const result = 2;'.slice(x.start, x.end)), ['result', '2']);
});

test('three way merge classifies changes', () => {
	const base = splitLines('a\nb\nc\nd\ne\n');
	const left = splitLines('A\nb\nc\nd\ne\n');
	const right = splitLines('a\nb\nc\nd\nE\n');
	const blocks = computeMerge(base, left, right);
	const changes = blocks.filter((b) => b.type === 'change');
	assert.deepEqual(changes.map((c) => c.type === 'change' && c.kind), ['left', 'right']);
	const merged = autoMerge(base, left, right);
	assert.equal(merged.conflicts, 0);
	assert.equal(merged.text, 'A\nb\nc\nd\nE\n');
});

test('three way merge detects conflicts and identical changes', () => {
	const base = splitLines('a\nb\nc\n');
	const left = splitLines('a\nX\nc\nz\n');
	const right = splitLines('a\nY\nc\nz\n');
	const blocks = computeMerge(base, left, right);
	const kinds = blocks.filter((b) => b.type === 'change').map((b) => b.type === 'change' && b.kind);
	assert.deepEqual(kinds, ['conflict', 'both']);
	const merged = autoMerge(base, left, right);
	assert.equal(merged.conflicts, 1);
	assert.ok(merged.text.includes('<<<<<<<'));
});

test('three way merge random consistency', () => {
	const r = rand(7);
	for (let iter = 0; iter < 200; iter++) {
		const base = Array.from({ length: Math.floor(r() * 12) }, () => `l${Math.floor(r() * 6)}\n`);
		const mutate = () => {
			const out: string[] = [];
			for (const l of base) {
				const x = r();
				if (x < 0.15) {
					continue;
				}
				if (x < 0.3) {
					out.push(`m${Math.floor(r() * 3)}\n`);
					continue;
				}
				out.push(l);
				if (x > 0.9) {
					out.push(`i${Math.floor(r() * 3)}\n`);
				}
			}
			return out;
		};
		const left = mutate();
		const right = mutate();
		const blocks = computeMerge(base, left, right);
		let bp = 0;
		let lp = 0;
		let rp = 0;
		for (const b of blocks) {
			assert.equal(b.baseStart, bp);
			assert.equal(b.leftStart, lp);
			assert.equal(b.rightStart, rp);
			if (b.type === 'stable') {
				const n = b.baseEnd - b.baseStart;
				for (let k = 0; k < n; k++) {
					assert.equal(base[bp + k], left[lp + k]);
					assert.equal(base[bp + k], right[rp + k]);
				}
				bp += n;
				lp += n;
				rp += n;
			} else {
				bp = b.baseEnd;
				lp = b.leftEnd;
				rp = b.rightEnd;
			}
		}
		assert.equal(bp, base.length);
		assert.equal(lp, left.length);
		assert.equal(rp, right.length);
		assert.equal(autoMerge(base, left, left).conflicts, 0);
		assert.equal(autoMerge(base, left, base).text, left.join(''));
	}
});

test('resolve simple conflicts on word level', async () => {
	const { resolveSimpleConflict } = await import('../../shared/diff3');
	assert.equal(resolveSimpleConflict('const tax = 0.19;\n', 'const vat = 0.19;\n', 'const tax = 0.07;\n'), 'const vat = 0.07;\n');
	assert.equal(resolveSimpleConflict('a b c\n', 'a X c\n', 'a Y c\n'), undefined);
	assert.equal(resolveSimpleConflict('x\n', 'same\n', 'same\n'), 'same\n');
	assert.equal(resolveSimpleConflict('foo(a, b);\n', 'foo(a, b, c);\n', 'bar(a, b);\n'), 'bar(a, b, c);\n');
});
