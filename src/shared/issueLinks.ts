export interface IssueRule {
	pattern: string;
	link: string;
}

export interface TextPart {
	text: string;
	url?: string;
}

/** Splits text into plain parts and issue references linking to the tracker, like JetBrains' Issue navigation: $0 is the whole match, $1… its groups. */
export function linkIssues(text: string, rules: readonly IssueRule[]): TextPart[] {
	const found: { start: number; end: number; url: string }[] = [];
	for (const rule of rules) {
		let re: RegExp;
		try {
			re = new RegExp(rule.pattern, 'g');
		} catch {
			continue;
		}
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) && m[0]) {
			const groups = m;
			found.push({ start: m.index, end: m.index + m[0].length, url: rule.link.replace(/\$(\d)/g, (_, g: string) => groups[Number(g)] ?? '') });
		}
	}
	found.sort((a, b) => a.start - b.start || b.end - a.end);
	const parts: TextPart[] = [];
	let pos = 0;
	for (const f of found) {
		if (f.start < pos) {
			continue;
		}
		if (f.start > pos) {
			parts.push({ text: text.slice(pos, f.start) });
		}
		parts.push({ text: text.slice(f.start, f.end), url: f.url });
		pos = f.end;
	}
	if (pos < text.length) {
		parts.push({ text: text.slice(pos) });
	}
	return parts;
}

/** Default rules for the hosting of a repository: #123 opens the issue (and !123 the merge request on GitLab), like JetBrains adds for GitHub and GitLab projects. */
export function hostingIssueRules(kind: 'github' | 'gitlab', webUrl: string): IssueRule[] {
	const base = webUrl.replace(/\/+$/, '');
	return kind === 'github'
		? [{ pattern: '(?<![\\w/])#(\\d+)\\b', link: `${base}/issues/$1` }]
		: [
				{ pattern: '(?<![\\w/])#(\\d+)\\b', link: `${base}/-/issues/$1` },
				{ pattern: '(?<![\\w/])!(\\d+)\\b', link: `${base}/-/merge_requests/$1` },
			];
}
