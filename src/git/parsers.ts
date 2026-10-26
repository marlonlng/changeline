import type { ChangeStatus, CommitInfo, ConflictInfo, FileChange, RefInfo } from '../shared/types';

export interface StatusEntry {
	kind: 'ordinary' | 'rename' | 'unmerged' | 'untracked' | 'ignored';
	x: string;
	y: string;
	path: string;
	origPath?: string;
	submodule: boolean;
	modeHead?: string;
	modeIndex?: string;
	modeWorktree?: string;
}

export interface StatusResult {
	oid?: string;
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	entries: StatusEntry[];
}

function splitFields(s: string, n: number): [string[], string] {
	const fields: string[] = [];
	let pos = 0;
	for (let k = 0; k < n; k++) {
		const sp = s.indexOf(' ', pos);
		if (sp === -1) {
			fields.push(s.slice(pos));
			return [fields, ''];
		}
		fields.push(s.slice(pos, sp));
		pos = sp + 1;
	}
	return [fields, s.slice(pos)];
}

/** Parses `git status --porcelain=v2 -z --branch`. */
export function parseStatusV2(out: string): StatusResult {
	const result: StatusResult = { ahead: 0, behind: 0, entries: [] };
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (!p) {
			continue;
		}
		if (p.startsWith('# ')) {
			const [key, ...rest] = p.slice(2).split(' ');
			const value = rest.join(' ');
			switch (key) {
				case 'branch.oid':
					result.oid = value === '(initial)' ? undefined : value;
					break;
				case 'branch.head':
					result.branch = value === '(detached)' ? undefined : value;
					break;
				case 'branch.upstream':
					result.upstream = value;
					break;
				case 'branch.ab': {
					const m = /\+(\d+) -(\d+)/.exec(value);
					if (m) {
						result.ahead = Number(m[1]);
						result.behind = Number(m[2]);
					}
					break;
				}
			}
			continue;
		}
		switch (p[0]) {
			case '1': {
				const [f, path] = splitFields(p, 8);
				result.entries.push({ kind: 'ordinary', x: f[1][0], y: f[1][1], submodule: f[2][0] === 'S', modeHead: f[3], modeIndex: f[4], modeWorktree: f[5], path });
				break;
			}
			case '2': {
				const [f, path] = splitFields(p, 9);
				const origPath = parts[++i];
				result.entries.push({ kind: 'rename', x: f[1][0], y: f[1][1], submodule: f[2][0] === 'S', modeHead: f[3], modeIndex: f[4], modeWorktree: f[5], path, origPath });
				break;
			}
			case 'u': {
				const [f, path] = splitFields(p, 10);
				result.entries.push({ kind: 'unmerged', x: f[1][0], y: f[1][1], submodule: f[2][0] === 'S', path });
				break;
			}
			case '?':
				result.entries.push({ kind: 'untracked', x: '?', y: '?', submodule: false, path: p.slice(2) });
				break;
			case '!':
				result.entries.push({ kind: 'ignored', x: '!', y: '!', submodule: false, path: p.slice(2) });
				break;
		}
	}
	return result;
}

export interface ClassifiedStatus {
	changes: FileChange[];
	staged: FileChange[];
	unstaged: FileChange[];
	untracked: FileChange[];
	ignored: FileChange[];
	conflicts: ConflictInfo[];
}

function letter(c: string): ChangeStatus {
	switch (c) {
		case 'A':
			return 'A';
		case 'D':
			return 'D';
		case 'R':
			return 'R';
		case 'C':
			return 'C';
		case 'T':
			return 'T';
		default:
			return 'M';
	}
}

export function classifyStatus(entries: StatusEntry[]): ClassifiedStatus {
	const result: ClassifiedStatus = { changes: [], staged: [], unstaged: [], untracked: [], ignored: [], conflicts: [] };
	for (const e of entries) {
		switch (e.kind) {
			case 'untracked':
				result.untracked.push({ path: e.path, status: '?' });
				continue;
			case 'ignored':
				result.ignored.push({ path: e.path, status: '!' });
				continue;
			case 'unmerged':
				result.conflicts.push(conflictInfo(e));
				continue;
		}
		if (e.x !== '.') {
			result.staged.push({ path: e.path, origPath: e.origPath, status: letter(e.x) });
		}
		if (e.y !== '.') {
			result.unstaged.push({ path: e.path, status: e.y === 'A' ? 'A' : letter(e.y) });
		}
		if (e.kind === 'rename') {
			if (e.y === 'D') {
				result.changes.push({ path: e.origPath!, status: 'D' });
			} else if (e.x === 'C') {
				result.changes.push({ path: e.path, status: 'A' });
			} else {
				result.changes.push({ path: e.path, origPath: e.origPath, status: 'R' });
			}
			continue;
		}
		if (e.x === 'A' && e.y === 'D') {
			continue;
		}
		let status: ChangeStatus;
		if (e.y === 'D' || e.x === 'D') {
			status = 'D';
		} else if (e.x === 'A' || e.y === 'A') {
			status = 'A';
		} else {
			status = 'M';
		}
		result.changes.push({ path: e.path, status });
	}
	return result;
}

function conflictInfo(e: StatusEntry): ConflictInfo {
	const code = e.x + e.y;
	const side = (c: string, other: string): ConflictInfo['ours'] => {
		if (c === 'D') {
			return 'deleted';
		}
		if (c === 'A') {
			return 'added';
		}
		if (c === 'U' && other === 'A') {
			return 'modified';
		}
		return 'modified';
	};
	let ours = side(e.x, e.y);
	let theirs = side(e.y, e.x);
	if (code === 'AU') {
		ours = 'added';
		theirs = 'deleted';
	} else if (code === 'UA') {
		ours = 'deleted';
		theirs = 'added';
	}
	return { path: e.path, status: 'U', code, ours, theirs };
}

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'].join('%x1f') + '%x1e';
export const LOG_FORMAT_WITH_BODY = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s', '%B'].join('%x1f') + '%x1e';

export function parseLog(out: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	for (const raw of out.split('\x1e')) {
		const rec = raw.replace(/^[\r\n\0]+/, '');
		if (!rec) {
			continue;
		}
		const f = rec.split('\x1f');
		if (f.length < 9) {
			continue;
		}
		commits.push({
			hash: f[0],
			parents: f[1] ? f[1].split(' ') : [],
			author: f[2],
			authorEmail: f[3],
			authorDate: Number(f[4]),
			committer: f[5],
			committerEmail: f[6],
			commitDate: Number(f[7]),
			subject: f[8],
		});
	}
	return commits;
}

export function parseLogWithBody(out: string): (CommitInfo & { body: string })[] {
	const commits: (CommitInfo & { body: string })[] = [];
	for (const raw of out.split('\x1e')) {
		const rec = raw.replace(/^[\r\n\0]+/, '');
		if (!rec) {
			continue;
		}
		const f = rec.split('\x1f');
		if (f.length < 10) {
			continue;
		}
		commits.push({
			hash: f[0],
			parents: f[1] ? f[1].split(' ') : [],
			author: f[2],
			authorEmail: f[3],
			authorDate: Number(f[4]),
			committer: f[5],
			committerEmail: f[6],
			commitDate: Number(f[7]),
			subject: f[8],
			body: f.slice(9).join('\x1f').replace(/\s+$/, ''),
		});
	}
	return commits;
}

/**
 * Parses `git log --format=%x1e<LOG fields>%x1f --name-status -z`, i.e. a log
 * where each commit is followed by its changed files.
 */
export function parseLogWithFiles(out: string): (CommitInfo & { files: FileChange[] })[] {
	const commits: (CommitInfo & { files: FileChange[] })[] = [];
	for (const raw of out.split('\x1e')) {
		if (!raw.trim()) {
			continue;
		}
		const f = raw.split('\x1f');
		if (f.length < 10) {
			continue;
		}
		commits.push({
			hash: f[0].replace(/^[\r\n\0]+/, ''),
			parents: f[1] ? f[1].split(' ') : [],
			author: f[2],
			authorEmail: f[3],
			authorDate: Number(f[4]),
			committer: f[5],
			committerEmail: f[6],
			commitDate: Number(f[7]),
			subject: f[8],
			files: parseNameStatus(f.slice(9).join('\x1f')),
		});
	}
	return commits;
}

export const LOG_FILES_FORMAT = '%x1e' + ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'].join('%x1f') + '%x1f';

/** Parses `--name-status -z` output (also works with leading newlines). */
export function parseNameStatus(out: string): FileChange[] {
	const tokens = out.split('\0');
	const files: FileChange[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i].replace(/^[\r\n]+/, '');
		if (!t) {
			continue;
		}
		const code = t[0];
		if (!/^[MADRCTUX]/.test(code) || !/^[A-Z]\d*$/.test(t)) {
			continue;
		}
		if (code === 'R' || code === 'C') {
			const origPath = tokens[++i];
			const path = tokens[++i];
			if (path === undefined) {
				break;
			}
			files.push(code === 'R' ? { path, origPath, status: 'R' } : { path, origPath, status: 'C' });
		} else {
			const path = tokens[++i];
			if (path === undefined) {
				break;
			}
			files.push({ path, status: code === 'X' ? 'M' : (code as ChangeStatus) });
		}
	}
	return files;
}

export const REF_FORMAT = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream)', '%(upstream:track,nobracket)', '%(HEAD)', '%(creatordate:unix)', '%(symref)'].join('%00');

export function parseRefs(out: string): RefInfo[] {
	const refs: RefInfo[] = [];
	for (const line of out.split('\n')) {
		if (!line) {
			continue;
		}
		const [name, oid, peeled, upstream, track, head, date, symref] = line.split('\0');
		if (symref) {
			continue;
		}
		let type: RefInfo['type'];
		let shortName: string;
		let remote: string | undefined;
		if (name.startsWith('refs/heads/')) {
			type = 'head';
			shortName = name.slice('refs/heads/'.length);
		} else if (name.startsWith('refs/remotes/')) {
			type = 'remote';
			shortName = name.slice('refs/remotes/'.length);
			remote = shortName.split('/')[0];
		} else if (name.startsWith('refs/tags/')) {
			type = 'tag';
			shortName = name.slice('refs/tags/'.length);
		} else {
			continue;
		}
		const ref: RefInfo = { name, shortName, type, hash: peeled || oid, remote, committerDate: date ? Number(date) : undefined };
		if (type === 'head') {
			ref.current = head === '*';
			if (upstream) {
				ref.upstream = upstream.replace(/^refs\/remotes\//, '');
				if (track === 'gone') {
					ref.upstreamGone = true;
				} else {
					const a = /ahead (\d+)/.exec(track ?? '');
					const b = /behind (\d+)/.exec(track ?? '');
					ref.ahead = a ? Number(a[1]) : 0;
					ref.behind = b ? Number(b[1]) : 0;
				}
			}
		}
		refs.push(ref);
	}
	return refs;
}

export interface BlameLine {
	hash: string;
	origLine: number;
	line: number;
}

export interface BlameCommit {
	hash: string;
	author: string;
	authorMail: string;
	authorTime: number;
	committer: string;
	committerTime: number;
	summary: string;
	filename: string;
	previous?: { hash: string; filename: string };
	boundary: boolean;
}

export const UNCOMMITTED_HASH = '0000000000000000000000000000000000000000';

export function parseBlamePorcelain(out: string): { lines: BlameLine[]; commits: Map<string, BlameCommit> } {
	const lines: BlameLine[] = [];
	const commits = new Map<string, BlameCommit>();
	let current: BlameCommit | undefined;
	let pendingLine: BlameLine | undefined;
	for (const l of out.split('\n')) {
		if (l.startsWith('\t')) {
			if (pendingLine) {
				lines.push(pendingLine);
				pendingLine = undefined;
			}
			continue;
		}
		const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(l);
		if (header) {
			const hash = header[1];
			current = commits.get(hash);
			if (!current) {
				current = { hash, author: '', authorMail: '', authorTime: 0, committer: '', committerTime: 0, summary: '', filename: '', boundary: false };
				commits.set(hash, current);
			}
			pendingLine = { hash, origLine: Number(header[2]), line: Number(header[3]) };
			continue;
		}
		if (!current) {
			continue;
		}
		const sp = l.indexOf(' ');
		const key = sp === -1 ? l : l.slice(0, sp);
		const value = sp === -1 ? '' : l.slice(sp + 1);
		switch (key) {
			case 'author':
				current.author = value;
				break;
			case 'author-mail':
				current.authorMail = value.replace(/^<|>$/g, '');
				break;
			case 'author-time':
				current.authorTime = Number(value);
				break;
			case 'committer':
				current.committer = value;
				break;
			case 'committer-time':
				current.committerTime = Number(value);
				break;
			case 'summary':
				current.summary = value;
				break;
			case 'filename':
				current.filename = value;
				break;
			case 'boundary':
				current.boundary = true;
				break;
			case 'previous': {
				const ps = value.indexOf(' ');
				current.previous = { hash: value.slice(0, ps), filename: value.slice(ps + 1) };
				break;
			}
		}
	}
	return { lines, commits };
}

export interface StashEntry {
	index: number;
	ref: string;
	hash: string;
	parents: string[];
	date: number;
	message: string;
	branch?: string;
}

export const STASH_FORMAT = ['%gd', '%H', '%P', '%ct', '%gs'].join('%x1f') + '%x1e';

export function parseStashList(out: string): StashEntry[] {
	const result: StashEntry[] = [];
	for (const raw of out.split('\x1e')) {
		const rec = raw.replace(/^[\r\n]+/, '');
		if (!rec) {
			continue;
		}
		const [ref, hash, parents, date, subject] = rec.split('\x1f');
		const idx = /\{(\d+)\}/.exec(ref);
		const m = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(subject ?? '');
		result.push({
			index: idx ? Number(idx[1]) : result.length,
			ref,
			hash,
			parents: parents ? parents.split(' ') : [],
			date: Number(date),
			message: m ? m[2] : subject ?? '',
			branch: m ? m[1] : undefined,
		});
	}
	return result;
}

export interface RemoteInfo {
	name: string;
	fetchUrl?: string;
	pushUrl?: string;
}

export function parseRemotes(out: string): RemoteInfo[] {
	const map = new Map<string, RemoteInfo>();
	for (const line of out.split('\n')) {
		const m = /^(\S+)\t(.+?) \((fetch|push)\)$/.exec(line.trim());
		if (!m) {
			continue;
		}
		const r = map.get(m[1]) ?? { name: m[1] };
		if (m[3] === 'fetch') {
			r.fetchUrl = m[2];
		} else {
			r.pushUrl = m[2];
		}
		map.set(m[1], r);
	}
	return [...map.values()];
}

/** Extracts recently checked out branch names from `git reflog --format=%gs`. */
export function parseRecentCheckouts(out: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const line of out.split('\n')) {
		const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
		if (!m) {
			continue;
		}
		for (const name of [m[2], m[1]]) {
			if (!seen.has(name) && !/^[0-9a-f]{7,40}$/.test(name)) {
				seen.add(name);
				result.push(name);
			}
		}
	}
	return result;
}

export interface PushRefResult {
	flag: string;
	from: string;
	to: string;
	summary: string;
	reason?: string;
}

export function parsePushPorcelain(out: string): PushRefResult[] {
	const result: PushRefResult[] = [];
	for (const line of out.split('\n')) {
		const m = /^([ +\-*!=])\t([^:]*):([^\t]*)\t(.*)$/.exec(line);
		if (!m) {
			continue;
		}
		const summary = m[4];
		const reason = /\((.*)\)/.exec(summary)?.[1];
		result.push({ flag: m[1], from: m[2], to: m[3], summary, reason });
	}
	return result;
}

export function parseConflictFilesFromOutput(out: string): string[] {
	const files: string[] = [];
	for (const line of out.split('\n')) {
		const m = /^CONFLICT \([^)]*\): (?:Merge conflict in |.*? in )?(.+?)(?: deleted in .*)?$/.exec(line.trim());
		if (m) {
			files.push(m[1]);
		}
	}
	return files;
}
