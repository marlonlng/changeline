import type { DiffChunk } from './diff';

/** A change as VS Code's quick diff passes it to scm/change/title commands: 1-based lines, an end of 0 marks an empty side. */
export interface LineChange {
	originalStartLineNumber: number;
	originalEndLineNumber: number;
	modifiedStartLineNumber: number;
	modifiedEndLineNumber: number;
}

class Lines {
	private readonly starts: number[] = [0];

	constructor(private readonly text: string) {
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) {
				this.starts.push(i + 1);
			}
		}
	}

	get count(): number {
		return this.starts.length;
	}

	length(line: number): number {
		const start = this.starts[line];
		let end = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
		if (end > start && this.text.charCodeAt(end - 1) === 13) {
			end--;
		}
		return end - start;
	}

	offset(line: number, ch: number): number {
		if (line < 0) {
			return 0;
		}
		return line >= this.starts.length ? this.text.length : this.starts[line] + ch;
	}
}

/** The original text with the given changes from the modified text applied, the way VS Code's Git extension stages and reverts quick diff changes. */
export function applyLineChanges(original: string, modified: string, changes: readonly LineChange[]): string {
	const o = new Lines(original);
	const m = new Lines(modified);
	const result: string[] = [];
	let current = 0;
	for (const d of changes) {
		const insertion = d.originalEndLineNumber === 0;
		const deletion = d.modifiedEndLineNumber === 0;
		let endLine = insertion ? d.originalStartLineNumber : d.originalStartLineNumber - 1;
		let endCh = 0;
		if (deletion && d.originalEndLineNumber === o.count) {
			endLine -= 1;
			endCh = endLine >= 0 ? o.length(endLine) : 0;
		}
		result.push(original.slice(o.offset(current, 0), Math.max(o.offset(current, 0), o.offset(endLine, endCh))));
		if (!deletion) {
			let fromLine = d.modifiedStartLineNumber - 1;
			let fromCh = 0;
			if (insertion && d.originalStartLineNumber === o.count) {
				fromLine -= 1;
				fromCh = m.length(fromLine);
			}
			result.push(modified.slice(m.offset(fromLine, fromCh), m.offset(d.modifiedEndLineNumber, 0)));
		}
		current = insertion ? d.originalStartLineNumber : d.originalEndLineNumber;
	}
	result.push(original.slice(o.offset(current, 0)));
	return result.join('');
}

/** The modified text with change `index` rolled back to the original. */
export function revertLineChange(original: string, modified: string, changes: readonly LineChange[], index: number): string {
	return applyLineChanges(original, modified, changes.filter((_, i) => i !== index));
}

/** The original lines a change replaced or deleted, as JetBrains' Copy in the change popup copies them. */
export function originalText(original: string, change: LineChange): string {
	if (change.originalEndLineNumber === 0) {
		return '';
	}
	const o = new Lines(original);
	return original.slice(o.offset(change.originalStartLineNumber - 1, 0), o.offset(change.originalEndLineNumber, 0));
}

/** Index of the chunk (from diffLines) that covers a quick diff change, or the nearest one. */
export function chunkForLineChange(chunks: readonly DiffChunk[], change: LineChange): number {
	const deletion = change.modifiedEndLineNumber === 0;
	const from = deletion ? change.modifiedStartLineNumber : change.modifiedStartLineNumber - 1;
	const to = deletion ? from : change.modifiedEndLineNumber;
	let best = -1;
	let bestDistance = Infinity;
	chunks.forEach((c, i) => {
		const overlaps = deletion ? c.newStart <= from && from <= c.newEnd : c.newStart < to && from < Math.max(c.newEnd, c.newStart + 1);
		const distance = overlaps ? 0 : Math.min(Math.abs(c.newStart - from), Math.abs(c.newEnd - to));
		if (distance < bestDistance) {
			best = i;
			bestDistance = distance;
		}
	});
	return best;
}

/** The smallest replacement that turns `before` into `after`, so an edit leaves the cursor and folding of untouched text alone. */
export function textDelta(before: string, after: string): { start: number; end: number; text: string } {
	const max = Math.min(before.length, after.length);
	let start = 0;
	while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) {
		start++;
	}
	if (start > 0 && before.charCodeAt(start - 1) === 13) {
		start--;
	}
	let tail = 0;
	while (tail < max - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) {
		tail++;
	}
	if (tail > 0 && before.charCodeAt(before.length - tail) === 10 && before.charCodeAt(before.length - tail - 1) === 13 && before.length - tail - 1 >= start) {
		tail--;
	}
	return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}
