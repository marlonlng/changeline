
export interface DiffChunk {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

export type WhitespaceMode = 'none' | 'trim' | 'all';

export interface DiffOptions {
	whitespace?: WhitespaceMode;
	timeoutMs?: number;
}

/** Splits text into lines, keeping each line's terminator attached. */
export function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			lines.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) {
		lines.push(text.slice(start));
	}
	return lines;
}

/** Returns a line without its trailing "\n" or "\r\n". */
export function stripEol(line: string): string {
	if (line.endsWith('\r\n')) {
		return line.slice(0, -2);
	}
	if (line.endsWith('\n')) {
		return line.slice(0, -1);
	}
	return line;
}

export function detectEol(text: string): '\r\n' | '\n' {
	const lf = text.indexOf('\n');
	return lf > 0 && text.charCodeAt(lf - 1) === 13 ? '\r\n' : '\n';
}

/**
 * Comparison key of a line. CRLF and LF compare equal, but a missing
 * terminator on the last line does not, so that "no newline at end of file"
 * changes are real chunks (like in git).
 */
export function lineKey(line: string, mode: WhitespaceMode): string {
	const s = stripEol(line);
	const suffix = line.endsWith('\n') ? '' : '\u0000';
	switch (mode) {
		case 'trim':
			return s.trim() + suffix;
		case 'all':
			return s.replace(/\s+/g, '') + suffix;
		default:
			return s + suffix;
	}
}

export function diffLines(oldLines: readonly string[], newLines: readonly string[], options: DiffOptions = {}): DiffChunk[] {
	const mode = options.whitespace ?? 'none';
	const ids = new Map<string, number>();
	const intern = (line: string) => {
		const key = lineKey(line, mode);
		let id = ids.get(key);
		if (id === undefined) {
			id = ids.size;
			ids.set(key, id);
		}
		return id;
	};
	const a = new Int32Array(oldLines.length);
	for (let i = 0; i < oldLines.length; i++) {
		a[i] = intern(oldLines[i]);
	}
	const b = new Int32Array(newLines.length);
	for (let i = 0; i < newLines.length; i++) {
		b[i] = intern(newLines[i]);
	}
	const deadline = options.timeoutMs === undefined ? Date.now() + 5000 : Date.now() + options.timeoutMs;
	return diffInts(a, b, deadline);
}

export function diffTexts(oldText: string, newText: string, options?: DiffOptions): { oldLines: string[]; newLines: string[]; chunks: DiffChunk[] } {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	return { oldLines, newLines, chunks: diffLines(oldLines, newLines, options) };
}

export function diffInts(a: ArrayLike<number>, b: ArrayLike<number>, deadline = Number.POSITIVE_INFINITY): DiffChunk[] {
	const n = a.length;
	const m = b.length;
	const deleted = new Uint8Array(n);
	const inserted = new Uint8Array(m);
	const stack: number[] = [0, n, 0, m];
	while (stack.length) {
		let bHi = stack.pop()!;
		let bLo = stack.pop()!;
		let aHi = stack.pop()!;
		let aLo = stack.pop()!;
		while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
			aLo++;
			bLo++;
		}
		while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
			aHi--;
			bHi--;
		}
		if (aLo === aHi) {
			inserted.fill(1, bLo, bHi);
			continue;
		}
		if (bLo === bHi) {
			deleted.fill(1, aLo, aHi);
			continue;
		}
		const split = bisect(a, aLo, aHi, b, bLo, bHi, deadline);
		if (!split || (split[0] === aLo && split[1] === bLo) || (split[0] === aHi && split[1] === bHi)) {
			deleted.fill(1, aLo, aHi);
			inserted.fill(1, bLo, bHi);
			continue;
		}
		const [x, y] = split;
		stack.push(aLo, x, bLo, y, x, aHi, y, bHi);
	}
	return chunksFromMarks(deleted, inserted);
}

/**
 * Finds the middle snake of an optimal edit path (adapted from
 * diff-match-patch's diff_bisect). Returns an absolute split point.
 */
function bisect(
	a: ArrayLike<number>, aLo: number, aHi: number,
	b: ArrayLike<number>, bLo: number, bHi: number,
	deadline: number,
): [number, number] | undefined {
	const n = aHi - aLo;
	const m = bHi - bLo;
	const maxD = Math.ceil((n + m) / 2);
	const vOffset = maxD;
	const vLength = 2 * maxD + 2;
	const v1 = new Int32Array(vLength).fill(-1);
	const v2 = new Int32Array(vLength).fill(-1);
	v1[vOffset + 1] = 0;
	v2[vOffset + 1] = 0;
	const delta = n - m;
	const front = delta % 2 !== 0;
	let k1start = 0;
	let k1end = 0;
	let k2start = 0;
	let k2end = 0;
	for (let d = 0; d < maxD; d++) {
		if ((d & 31) === 0 && Date.now() > deadline) {
			return undefined;
		}
		for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
			const k1Offset = vOffset + k1;
			let x1: number;
			if (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1])) {
				x1 = v1[k1Offset + 1];
			} else {
				x1 = v1[k1Offset - 1] + 1;
			}
			let y1 = x1 - k1;
			while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
				x1++;
				y1++;
			}
			v1[k1Offset] = x1;
			if (x1 > n) {
				k1end += 2;
			} else if (y1 > m) {
				k1start += 2;
			} else if (front) {
				const k2Offset = vOffset + delta - k1;
				if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
					const x2 = n - v2[k2Offset];
					if (x1 >= x2) {
						return [aLo + x1, bLo + y1];
					}
				}
			}
		}
		for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
			const k2Offset = vOffset + k2;
			let x2: number;
			if (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1])) {
				x2 = v2[k2Offset + 1];
			} else {
				x2 = v2[k2Offset - 1] + 1;
			}
			let y2 = x2 - k2;
			while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) {
				x2++;
				y2++;
			}
			v2[k2Offset] = x2;
			if (x2 > n) {
				k2end += 2;
			} else if (y2 > m) {
				k2start += 2;
			} else if (!front) {
				const k1Offset = vOffset + delta - k2;
				if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
					const x1 = v1[k1Offset];
					const y1 = vOffset + x1 - k1Offset;
					if (x1 >= n - x2) {
						return [aLo + x1, bLo + y1];
					}
				}
			}
		}
	}
	return undefined;
}

function chunksFromMarks(deleted: Uint8Array, inserted: Uint8Array): DiffChunk[] {
	const n = deleted.length;
	const m = inserted.length;
	const chunks: DiffChunk[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && !deleted[i] && !inserted[j]) {
			i++;
			j++;
			continue;
		}
		const oldStart = i;
		const newStart = j;
		while (i < n && deleted[i]) {
			i++;
		}
		while (j < m && inserted[j]) {
			j++;
		}
		if (i === oldStart && j === newStart) {
			chunks.push({ oldStart, oldEnd: n, newStart, newEnd: m });
			break;
		}
		chunks.push({ oldStart, oldEnd: i, newStart, newEnd: j });
	}
	return chunks;
}

/** Stable identity of a chunk used to remember per-chunk choices across refreshes. */
export function chunkKey(chunk: DiffChunk, oldLines: readonly string[], newLines: readonly string[]): string {
	const oldPart = oldLines.slice(chunk.oldStart, chunk.oldEnd).map(stripEol).join('\n');
	const newPart = newLines.slice(chunk.newStart, chunk.newEnd).map(stripEol).join('\n');
	return `${hashString(oldPart)}:${hashString(newPart)}:${chunk.oldEnd - chunk.oldStart}:${chunk.newEnd - chunk.newStart}`;
}

export function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * Builds a new text from `oldLines` where only the chunks accepted by
 * `take` are replaced by their new side. Unchanged regions come from the
 * new side so that line endings of the working copy are kept.
 */
export function applyChunks(
	oldLines: readonly string[],
	newLines: readonly string[],
	chunks: readonly DiffChunk[],
	take: (chunk: DiffChunk, index: number) => boolean,
): string {
	const out: string[] = [];
	let oldPos = 0;
	let newPos = 0;
	chunks.forEach((chunk, index) => {
		for (let k = 0; k < chunk.oldStart - oldPos; k++) {
			out.push(newLines[newPos + k]);
		}
		if (take(chunk, index)) {
			for (let k = chunk.newStart; k < chunk.newEnd; k++) {
				out.push(newLines[k]);
			}
		} else {
			for (let k = chunk.oldStart; k < chunk.oldEnd; k++) {
				out.push(oldLines[k]);
			}
		}
		oldPos = chunk.oldEnd;
		newPos = chunk.newEnd;
	});
	for (let k = newPos; k < newLines.length; k++) {
		out.push(newLines[k]);
	}
	return fixMissingEol(out);
}

/**
 * When chunks from both sides are spliced together a line that used to be the
 * last one (without terminator) can end up in the middle. Give it the EOL of
 * its neighbours so that lines are not glued together.
 */
function fixMissingEol(lines: string[]): string {
	if (lines.length < 2) {
		return lines.join('');
	}
	let eol = '\n';
	for (const l of lines) {
		if (l.endsWith('\r\n')) {
			eol = '\r\n';
			break;
		}
		if (l.endsWith('\n')) {
			break;
		}
	}
	for (let i = 0; i < lines.length - 1; i++) {
		if (!lines[i].endsWith('\n')) {
			lines[i] += eol;
		}
	}
	return lines.join('');
}

export interface TextRange {
	start: number;
	end: number;
}

const TOKEN_RE = /\r?\n|[^\S\r\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

export function tokenize(text: string): { tokens: string[]; offsets: number[] } {
	const tokens: string[] = [];
	const offsets: number[] = [];
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(text))) {
		tokens.push(m[0]);
		offsets.push(m.index);
	}
	return { tokens, offsets };
}

/**
 * Word level diff for highlighting inside a modified chunk. Returns changed
 * character ranges on both sides.
 */
export function diffWords(oldText: string, newText: string, ignoreWhitespace = false): { oldRanges: TextRange[]; newRanges: TextRange[] } {
	const ta = tokenize(oldText);
	const tb = tokenize(newText);
	const ids = new Map<string, number>();
	const intern = (t: string) => {
		const key = ignoreWhitespace && /^\s+$/.test(t) && !t.includes('\n') ? ' ' : t;
		let id = ids.get(key);
		if (id === undefined) {
			id = ids.size;
			ids.set(key, id);
		}
		return id;
	};
	const a = ta.tokens.map(intern);
	const b = tb.tokens.map(intern);
	const chunks = diffInts(a, b, Date.now() + 500);
	const toRanges = (tok: { tokens: string[]; offsets: number[] }, total: number, pick: (c: DiffChunk) => [number, number]) => {
		const ranges: TextRange[] = [];
		for (const c of chunks) {
			const [s, e] = pick(c);
			if (s === e) {
				continue;
			}
			const start = tok.offsets[s];
			const end = e < tok.offsets.length ? tok.offsets[e] : total;
			const slice = tok.tokens.slice(s, e).join('');
			if (ignoreWhitespace && /^\s*$/.test(slice)) {
				continue;
			}
			const last = ranges[ranges.length - 1];
			if (last && last.end === start) {
				last.end = end;
			} else {
				ranges.push({ start, end });
			}
		}
		return ranges;
	};
	return {
		oldRanges: toRanges(ta, oldText.length, (c) => [c.oldStart, c.oldEnd]),
		newRanges: toRanges(tb, newText.length, (c) => [c.newStart, c.newEnd]),
	};
}

/** Clips ranges (relative to a chunk text) to one line starting at `lineStart`. */
export function rangesInLine(ranges: readonly TextRange[], lineStart: number, lineEnd: number): TextRange[] {
	const out: TextRange[] = [];
	for (const r of ranges) {
		if (r.end <= lineStart || r.start >= lineEnd) {
			continue;
		}
		out.push({ start: Math.max(r.start, lineStart) - lineStart, end: Math.min(r.end, lineEnd) - lineStart });
	}
	return out;
}

export function isBinary(content: Uint8Array): boolean {
	const len = Math.min(content.length, 8000);
	for (let i = 0; i < len; i++) {
		if (content[i] === 0) {
			return true;
		}
	}
	return false;
}
