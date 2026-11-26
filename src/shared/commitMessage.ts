/** JetBrains' "Wrap when typing reaches right margin": breaks the line at the caret at its last space before the margin. The subject line is left alone. */
export function wrapTyping(text: string, caret: number, margin: number): { text: string; caret: number } | undefined {
	if (margin <= 0) {
		return undefined;
	}
	const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
	if (lineStart === 0) {
		return undefined;
	}
	const lineEnd = text.indexOf('\n', caret) === -1 ? text.length : text.indexOf('\n', caret);
	const line = text.slice(lineStart, lineEnd);
	if (line.length <= margin) {
		return undefined;
	}
	const space = line.lastIndexOf(' ', margin);
	if (space <= 0) {
		return undefined;
	}
	const at = lineStart + space;
	return { text: `${text.slice(0, at)}\n${text.slice(at + 1)}`, caret };
}

/** The partial word before the caret that completion replaces: letters, digits and the characters of file paths. */
export function wordAt(text: string, caret: number): { start: number; word: string } {
	let start = caret;
	while (start > 0 && /[\w./-]/.test(text[start - 1])) {
		start--;
	}
	return { start, word: text.slice(start, caret) };
}

/** Completion items for a prefix: changed file names and paths, best matches first. */
export function completeWord(word: string, candidates: readonly string[], limit = 12): string[] {
	if (!word) {
		return candidates.slice(0, limit);
	}
	const w = word.toLowerCase();
	const scored: { c: string; score: number }[] = [];
	for (const c of new Set(candidates)) {
		const l = c.toLowerCase();
		if (l === w) {
			continue;
		}
		const base = l.slice(l.lastIndexOf('/') + 1);
		const score = base.startsWith(w) ? 0 : l.startsWith(w) ? 1 : base.includes(w) ? 2 : -1;
		if (score >= 0) {
			scored.push({ c, score });
		}
	}
	return scored.sort((a, b) => a.score - b.score || a.c.length - b.c.length || a.c.localeCompare(b.c)).slice(0, limit).map((s) => s.c);
}
