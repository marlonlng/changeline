
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';

export interface FileChange {
	path: string;
	origPath?: string;
	status: ChangeStatus;
}

export interface CommitInfo {
	hash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: number;
	committer: string;
	committerEmail: string;
	commitDate: number;
	subject: string;
}

export interface CommitDetails extends CommitInfo {
	body: string;
	files: FileChange[];
}

export type RefType = 'head' | 'remote' | 'tag';

export interface RefInfo {
	name: string;
	shortName: string;
	type: RefType;
	hash: string;
	remote?: string;
	upstream?: string;
	ahead?: number;
	behind?: number;
	upstreamGone?: boolean;
	current?: boolean;
	committerDate?: number;
}

export type RepoOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | 'bisect';

export interface ConflictInfo extends FileChange {
	code: string;
	ours: 'modified' | 'added' | 'deleted';
	theirs: 'modified' | 'added' | 'deleted';
}

export interface RpcRequest {
	kind: 'request';
	id: number;
	method: string;
	params: unknown;
}

export interface RpcResponse {
	kind: 'response';
	id: number;
	result?: unknown;
	error?: string;
}

export interface RpcEvent {
	kind: 'event';
	name: string;
	data: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

export interface DialogField {
	id: string;
	type: 'text' | 'textarea' | 'checkbox' | 'select' | 'radio' | 'label' | 'combo' | 'checklist';
	label?: string;
	description?: string;
	value?: string | boolean | string[];
	placeholder?: string;
	options?: { value: string; label: string; description?: string }[];
	pattern?: string;
	patternMessage?: string;
	required?: boolean;
	rows?: number;
	monospace?: boolean;
	visibleWhen?: string;
	focus?: boolean;
}

export interface DialogSpec {
	title: string;
	description?: string;
	fields: DialogField[];
	okLabel?: string;
	cancelLabel?: string;
	extraButtons?: { id: string; label: string }[];
	liveValidation?: boolean;
	width?: number;
}

export type DialogValues = Record<string, string | boolean | string[]>;

export interface DialogResult {
	button: string;
	values: DialogValues;
}
