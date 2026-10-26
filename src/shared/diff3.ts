import { DiffChunk, DiffOptions, diffInts, diffLines, lineKey, tokenize } from './diff';

export type MergeChangeKind = 'left' | 'right' | 'both' | 'conflict';

export interface StableBlock {
	type: 'stable';
	baseStart: number;
	baseEnd: number;
	leftStart: number;
	rightStart: number;
}

export interface ChangeBlock {
	type: 'change';
	kind: MergeChangeKind;
	baseStart: number;
	baseEnd: number;
	leftStart: number;
	leftEnd: number;
	rightStart: number;
	rightEnd: number;
}

export type MergeBlock = StableBlock | ChangeBlock;

export function computeMerge(
	base: readonly string[],
	left: readonly string[],
	right: readonly string[],
	options: DiffOptions = {},
): MergeBlock[] {
	const leftChunks = diffLines(base, left, options);
	const rightChunks = diffLines(base, right, options);
	const mode = options.whitespace ?? 'none';
	const blocks: MergeBlock[] = [];
	let li = 0;
	let ri = 0;
	let basePos = 0;
	let leftDelta = 0;
	let rightDelta = 0;
	const delta = (c: DiffChunk) => c.newEnd - c.newStart - (c.oldEnd - c.oldStart);

	while (li < leftChunks.length || ri < rightChunks.length) {
		const nextLeft = leftChunks[li];
		const nextRight = rightChunks[ri];
		const gs = Math.min(nextLeft ? nextLeft.oldStart : Infinity, nextRight ? nextRight.oldStart : Infinity);
		let ge = gs;
		let groupLeftEnd = li;
		let groupRightEnd = ri;
		let first = true;
		for (;;) {
			let grew = false;
			while (groupLeftEnd < leftChunks.length && (leftChunks[groupLeftEnd].oldStart < ge || (leftChunks[groupLeftEnd].oldStart === ge && (first || groupRightEnd > ri)))) {
				ge = Math.max(ge, leftChunks[groupLeftEnd].oldEnd);
				groupLeftEnd++;
				grew = true;
				first = false;
			}
			while (groupRightEnd < rightChunks.length && (rightChunks[groupRightEnd].oldStart < ge || (rightChunks[groupRightEnd].oldStart === ge && (first || groupLeftEnd > li)))) {
				ge = Math.max(ge, rightChunks[groupRightEnd].oldEnd);
				groupRightEnd++;
				grew = true;
				first = false;
			}
			if (!grew) {
				break;
			}
		}

		if (gs > basePos) {
			blocks.push({ type: 'stable', baseStart: basePos, baseEnd: gs, leftStart: basePos + leftDelta, rightStart: basePos + rightDelta });
		}

		const leftStart = gs + leftDelta;
		const rightStart = gs + rightDelta;
		let leftGroupDelta = 0;
		for (let k = li; k < groupLeftEnd; k++) {
			leftGroupDelta += delta(leftChunks[k]);
		}
		let rightGroupDelta = 0;
		for (let k = ri; k < groupRightEnd; k++) {
			rightGroupDelta += delta(rightChunks[k]);
		}
		const leftEnd = ge + leftDelta + leftGroupDelta;
		const rightEnd = ge + rightDelta + rightGroupDelta;
		const hasLeft = groupLeftEnd > li;
		const hasRight = groupRightEnd > ri;
		let kind: MergeChangeKind;
		if (hasLeft && hasRight) {
			kind = sameLines(left, leftStart, leftEnd, right, rightStart, rightEnd, mode) ? 'both' : 'conflict';
		} else {
			kind = hasLeft ? 'left' : 'right';
		}
		blocks.push({ type: 'change', kind, baseStart: gs, baseEnd: ge, leftStart, leftEnd, rightStart, rightEnd });

		leftDelta += leftGroupDelta;
		rightDelta += rightGroupDelta;
		li = groupLeftEnd;
		ri = groupRightEnd;
		basePos = ge;
	}
	if (basePos < base.length) {
		blocks.push({ type: 'stable', baseStart: basePos, baseEnd: base.length, leftStart: basePos + leftDelta, rightStart: basePos + rightDelta });
	}
	return blocks;
}

function sameLines(
	a: readonly string[], aStart: number, aEnd: number,
	b: readonly string[], bStart: number, bEnd: number,
	mode: 'none' | 'trim' | 'all',
): boolean {
	if (aEnd - aStart !== bEnd - bStart) {
		return false;
	}
	for (let k = 0; k < aEnd - aStart; k++) {
		if (lineKey(a[aStart + k], mode) !== lineKey(b[bStart + k], mode)) {
			return false;
		}
	}
	return true;
}

/**
 * Result of merging without user interaction: non-conflicting changes are
 * applied, conflicts are reported. Used by unshelve and as the "apply all
 * non-conflicting changes" action.
 */
export function autoMerge(base: readonly string[], left: readonly string[], right: readonly string[], options?: DiffOptions): { text: string; conflicts: number; blocks: MergeBlock[] } {
	const blocks = computeMerge(base, left, right, options);
	const out: string[] = [];
	let conflicts = 0;
	for (const b of blocks) {
		if (b.type === 'stable') {
			for (let k = 0; k < b.baseEnd - b.baseStart; k++) {
				out.push(left[b.leftStart + k]);
			}
		} else if (b.kind === 'left' || b.kind === 'both') {
			out.push(...left.slice(b.leftStart, b.leftEnd));
		} else if (b.kind === 'right') {
			out.push(...right.slice(b.rightStart, b.rightEnd));
		} else {
			conflicts++;
			out.push('<<<<<<< ours\n', ...withEol(left.slice(b.leftStart, b.leftEnd)), '=======\n', ...withEol(right.slice(b.rightStart, b.rightEnd)), '>>>>>>> theirs\n');
		}
	}
	return { text: out.join(''), conflicts, blocks };
}

function withEol(lines: string[]): string[] {
	return lines.map((l) => (l.endsWith('\n') ? l : l + '\n'));
}

/**
 * "Resolve simple conflicts": merges a conflict on word level when both
 * sides changed different parts of the same lines. Returns undefined when
 * the sides really overlap.
 */
export function resolveSimpleConflict(base: string, left: string, right: string): string | undefined {
	if (left === right) {
		return left;
	}
	const tb = tokenize(base).tokens;
	const tl = tokenize(left).tokens;
	const tr = tokenize(right).tokens;
	const ids = new Map<string, number>();
	const intern = (t: string) => {
		let id = ids.get(t);
		if (id === undefined) {
			id = ids.size;
			ids.set(t, id);
		}
		return id;
	};
	const b = tb.map(intern);
	const l = tl.map(intern);
	const r = tr.map(intern);
	const leftChunks = diffInts(b, l, Date.now() + 200);
	const rightChunks = diffInts(b, r, Date.now() + 200);
	const out: string[] = [];
	let li = 0;
	let ri = 0;
	let pos = 0;
	let leftDelta = 0;
	let rightDelta = 0;
	const delta = (c: DiffChunk) => c.newEnd - c.newStart - (c.oldEnd - c.oldStart);
	while (li < leftChunks.length || ri < rightChunks.length) {
		const nl = leftChunks[li];
		const nr = rightChunks[ri];
		const gs = Math.min(nl ? nl.oldStart : Infinity, nr ? nr.oldStart : Infinity);
		let ge = gs;
		let le = li;
		let re = ri;
		for (;;) {
			let grew = false;
			while (le < leftChunks.length && leftChunks[le].oldStart <= ge && (leftChunks[le].oldStart < ge || le === li || re > ri)) {
				ge = Math.max(ge, leftChunks[le].oldEnd);
				le++;
				grew = true;
			}
			while (re < rightChunks.length && rightChunks[re].oldStart <= ge && (rightChunks[re].oldStart < ge || re === ri || le > li)) {
				ge = Math.max(ge, rightChunks[re].oldEnd);
				re++;
				grew = true;
			}
			if (!grew) {
				break;
			}
		}
		out.push(...tb.slice(pos, gs));
		let ld = 0;
		for (let k = li; k < le; k++) {
			ld += delta(leftChunks[k]);
		}
		let rd = 0;
		for (let k = ri; k < re; k++) {
			rd += delta(rightChunks[k]);
		}
		const leftPart = tl.slice(gs + leftDelta, ge + leftDelta + ld);
		const rightPart = tr.slice(gs + rightDelta, ge + rightDelta + rd);
		if (le > li && re > ri) {
			if (leftPart.join('') !== rightPart.join('')) {
				return undefined;
			}
			out.push(...leftPart);
		} else {
			out.push(...(le > li ? leftPart : rightPart));
		}
		leftDelta += ld;
		rightDelta += rd;
		li = le;
		ri = re;
		pos = ge;
	}
	out.push(...tb.slice(pos));
	return out.join('');
}
