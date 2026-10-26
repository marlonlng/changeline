import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const languages: Record<string, any> = {
	bash, c, cpp, csharp, css, dart, diff, dockerfile, go, ini, java, javascript, json, kotlin, less, lua, makefile, markdown,
	perl, php, plaintext, powershell, python, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(languages)) {
	hljs.registerLanguage(name, def);
}

const BY_EXT: Record<string, string> = {
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
	ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
	php: 'php', phtml: 'php', inc: 'php',
	py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', go: 'go', rs: 'rust',
	c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', swift: 'swift', dart: 'dart', lua: 'lua', pl: 'perl', pm: 'perl',
	json: 'json', jsonc: 'json', json5: 'json', lock: 'json',
	html: 'xml', htm: 'xml', xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml', vue: 'xml', twig: 'xml', xlf: 'xml', fluid: 'xml', tmpl: 'xml',
	css: 'css', scss: 'scss', sass: 'scss', less: 'less',
	md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini', typoscript: 'ini', tsconfig: 'ini',
	sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', sql: 'sql', diff: 'diff', patch: 'diff',
};

export function languageFor(path: string): string | undefined {
	const name = path.split('/').pop()!.toLowerCase();
	if (name === 'dockerfile' || name.startsWith('dockerfile.')) {
		return 'dockerfile';
	}
	if (name === 'makefile' || name === 'gnumakefile') {
		return 'makefile';
	}
	if (name.startsWith('.env')) {
		return 'ini';
	}
	const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
	return BY_EXT[ext];
}

export interface Segment {
	text: string;
	cls?: string;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

function unescape(s: string): string {
	return s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);
}

function toClass(raw: string): string {
	const parts = raw.split(/\s+/);
	const out: string[] = [];
	let main = '';
	for (const p of parts) {
		if (p.startsWith('hljs-')) {
			main = 'hl-' + p.slice(5);
			out.push(main);
		} else if (main) {
			out.push(`${main}.${p}`);
		}
	}
	return out.join(' ');
}

/**
 * Highlights a whole text and returns flat segments per line (line
 * terminators removed). Highlighting the whole file keeps multi-line
 * constructs like comments correct.
 */
export function highlightLines(text: string, lang: string | undefined, lineCount: number): Segment[][] {
	const plain = () => text.split('\n').slice(0, lineCount).map((l) => [{ text: l.replace(/\r$/, '') }]);
	if (!lang || text.length > 1_500_000) {
		return pad(plain(), lineCount);
	}
	let html: string;
	try {
		html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
	} catch {
		return pad(plain(), lineCount);
	}
	const lines: Segment[][] = [[]];
	const stack: string[] = [];
	const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[1] !== undefined) {
			stack.push(toClass(m[1]));
		} else if (m[2] !== undefined) {
			const cls = stack.length ? stack.join(' ') : undefined;
			const parts = unescape(m[2]).split('\n');
			parts.forEach((part, i) => {
				if (i > 0) {
					lines.push([]);
				}
				const item = part.replace(/\r$/, '');
				if (item) {
					lines[lines.length - 1].push({ text: item, cls });
				}
			});
		} else {
			stack.pop();
		}
	}
	return pad(lines, lineCount);
}

function pad(lines: Segment[][], count: number): Segment[][] {
	while (lines.length < count) {
		lines.push([]);
	}
	return lines.slice(0, count);
}

function esc(s: string): string {
	return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

/** Renders segments to HTML, wrapping the given character ranges with `markClass`. */
export function renderSegments(segments: Segment[], marks: { start: number; end: number }[] = [], markClass = 'wd'): string {
	if (!segments.length) {
		return '';
	}
	let html = '';
	let pos = 0;
	let mi = 0;
	for (const seg of segments) {
		let offset = 0;
		while (offset < seg.text.length) {
			const abs = pos + offset;
			while (mi < marks.length && marks[mi].end <= abs) {
				mi++;
			}
			const mark = marks[mi];
			let end: number;
			let marked = false;
			if (mark && mark.start <= abs) {
				end = Math.min(seg.text.length, mark.end - pos);
				marked = true;
			} else if (mark) {
				end = Math.min(seg.text.length, mark.start - pos);
			} else {
				end = seg.text.length;
			}
			const piece = esc(seg.text.slice(offset, end));
			const inner = seg.cls ? `<span class="${seg.cls}">${piece}</span>` : piece;
			html += marked ? `<span class="${markClass}">${inner}</span>` : inner;
			offset = end;
		}
		pos += seg.text.length;
	}
	return html;
}
