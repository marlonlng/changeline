import type { CommitInfo, FileChange, RefInfo } from '../../src/shared/types';

export type { CommitInfo, FileChange, RefInfo };

export interface Filters {
	branches?: string[];
	users?: string[];
	since?: string;
	until?: string;
	dateLabel?: string;
	paths?: string[];
	text?: string;
	regex?: boolean;
	matchCase?: boolean;
}

export interface Scope {
	kind: 'log' | 'history';
	repoRoot?: string;
	path?: string;
	lineRange?: { start: number; end: number };
	revisions?: string[];
	title?: string;
	filters?: Filters;
}

export interface RefsPayload {
	refs: RefInfo[];
	head?: string;
	branch?: string;
	detached?: boolean;
	favorites?: string[];
}

export interface InitData extends RefsPayload {
	id: string;
	scope: Scope;
	repos: { root: string; name: string }[];
	repoRoot?: string;
	user: { name?: string; email?: string };
	settings: { dateFormat: 'relative' | 'absolute'; pageSize: number; showHash: boolean };
}

export interface Details {
	commits: (CommitInfo & { body: string })[];
	files: FileChange[];
}

export interface RefLabel {
	text: string;
	kind: 'head' | 'local' | 'remote' | 'tag' | 'current';
	title: string;
}
