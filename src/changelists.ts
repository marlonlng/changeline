import * as vscode from 'vscode';

export interface Changelist {
	id: string;
	name: string;
	comment?: string;
}

interface PersistedState {
	lists: Changelist[];
	activeId: string;
	assignments: Record<string, string>;
	included: string[];
	excludedChunks: Record<string, string[]>;
	known: string[];
	chunkLists?: Record<string, Record<string, string>>;
	includedParts?: string[];
}

const STORAGE_KEY = 'changeline.changelists';
export const DEFAULT_LIST_ID = 'default';

export class ChangelistManager implements vscode.Disposable {
	private lists: Changelist[];
	private activeId: string;
	private assignments: Map<string, string>;
	private included: Set<string>;
	private excludedChunks: Map<string, Set<string>>;
	private known: Set<string>;
	private chunkLists: Map<string, Map<string, string>>;
	private includedParts: Set<string>;
	private saveTimer?: NodeJS.Timeout;

	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly memento: vscode.Memento) {
		const s = memento.get<PersistedState>(STORAGE_KEY);
		this.lists = s?.lists?.length ? s.lists : [{ id: DEFAULT_LIST_ID, name: vscode.l10n.t('Changes') }];
		this.activeId = s && this.lists.some((l) => l.id === s.activeId) ? s.activeId : this.lists[0].id;
		this.assignments = new Map(Object.entries(s?.assignments ?? {}));
		this.included = new Set(s?.included ?? []);
		this.excludedChunks = new Map(Object.entries(s?.excludedChunks ?? {}).map(([k, v]) => [k, new Set(v)]));
		this.known = new Set(s?.known ?? []);
		this.chunkLists = new Map(Object.entries(s?.chunkLists ?? {}).map(([k, v]) => [k, new Map(Object.entries(v))]));
		this.includedParts = new Set(s?.includedParts ?? []);
	}

	get all(): readonly Changelist[] {
		return this.lists;
	}

	get active(): Changelist {
		return this.lists.find((l) => l.id === this.activeId) ?? this.lists[0];
	}

	get(id: string): Changelist | undefined {
		return this.lists.find((l) => l.id === id);
	}

	listOf(absPath: string): Changelist {
		const id = this.assignments.get(absPath);
		return (id && this.get(id)) || this.active;
	}

	create(name: string, comment?: string, makeActive = false): Changelist {
		const list: Changelist = { id: `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, comment };
		this.lists.push(list);
		if (makeActive) {
			this.setActive(list.id);
		}
		this.changed();
		return list;
	}

	findByName(name: string): Changelist | undefined {
		return this.lists.find((l) => l.name === name);
	}

	edit(id: string, name: string, comment?: string): void {
		const list = this.get(id);
		if (list) {
			list.name = name;
			list.comment = comment;
			this.changed();
		}
	}

	/** Deletes a changelist, moving its files to `moveTo` (default: active). */
	remove(id: string, moveTo?: string): void {
		if (this.lists.length <= 1) {
			return;
		}
		const target = moveTo ?? (id === this.activeId ? this.lists.find((l) => l.id !== id)!.id : this.activeId);
		for (const [p, lid] of this.assignments) {
			if (lid === id) {
				this.assignments.set(p, target);
			}
		}
		for (const [p, m] of this.chunkLists) {
			for (const [k, lid] of m) {
				if (lid === id) {
					m.set(k, target);
				}
			}
			this.normalizeChunks(p);
		}
		this.lists = this.lists.filter((l) => l.id !== id);
		if (this.activeId === id) {
			this.activeId = target;
		}
		this.changed();
	}

	setActive(id: string): void {
		if (!this.get(id) || id === this.activeId) {
			return;
		}
		for (const p of this.known) {
			if (!this.assignments.has(p)) {
				this.assignments.set(p, this.activeId);
			}
		}
		this.activeId = id;
		for (const [p, lid] of [...this.assignments]) {
			if (lid === id) {
				this.assignments.delete(p);
			}
		}
		this.changed();
	}

	move(paths: string[], listId: string): void {
		for (const p of paths) {
			this.chunkLists.delete(p);
			for (const part of [...this.includedParts]) {
				if (part.startsWith(p + '\0')) {
					this.includedParts.delete(part);
				}
			}
			if (listId === this.activeId) {
				this.assignments.delete(p);
			} else {
				this.assignments.set(p, listId);
			}
		}
		this.changed();
	}


	/** Changelist a chunk belongs to (its file's list unless it was moved). */
	chunkListOf(absPath: string, key: string): string {
		return this.chunkLists.get(absPath)?.get(key) ?? this.listOf(absPath).id;
	}

	hasPartialLists(absPath: string): boolean {
		return (this.chunkLists.get(absPath)?.size ?? 0) > 0;
	}

	/** Other changelists holding chunks of the file. */
	partLists(absPath: string): string[] {
		const fileList = this.listOf(absPath).id;
		return [...new Set(this.chunkLists.get(absPath)?.values() ?? [])].filter((id) => id !== fileList);
	}

	moveChunk(absPath: string, key: string, listId: string): void {
		const fileList = this.listOf(absPath).id;
		let m = this.chunkLists.get(absPath);
		if (!m) {
			m = new Map();
			this.chunkLists.set(absPath, m);
		}
		if (listId === fileList) {
			m.delete(key);
		} else {
			m.set(key, listId);
			if (listId === this.activeId) {
				this.includedParts.add(`${absPath}\0${listId}`);
			}
		}
		this.normalizeChunks(absPath);
		this.changed();
	}

	isPartIncluded(absPath: string, listId: string | undefined): boolean {
		if (!listId || listId === this.listOf(absPath).id) {
			return this.isIncluded(absPath);
		}
		return this.includedParts.has(`${absPath}\0${listId}`);
	}

	setPartIncluded(absPath: string, listId: string | undefined, include: boolean): void {
		if (!listId || listId === this.listOf(absPath).id) {
			this.setIncluded([absPath], include);
			return;
		}
		const key = `${absPath}\0${listId}`;
		if (include) {
			this.includedParts.add(key);
		} else {
			this.includedParts.delete(key);
		}
		this.changed();
	}

	/** True when any part of the file is included into the commit. */
	isAnyPartIncluded(absPath: string): boolean {
		return this.isIncluded(absPath) || this.partLists(absPath).some((l) => this.includedParts.has(`${absPath}\0${l}`));
	}

	/**
	 * Checkbox of a single chunk in the diff viewer. Including a chunk of an
	 * unchecked changelist part checks the part but only for this chunk.
	 */
	setChunkInclusion(absPath: string, key: string, include: boolean, allKeys: string[]): void {
		const list = this.chunkListOf(absPath, key);
		const partKeys = allKeys.filter((k) => this.chunkListOf(absPath, k) === list);
		let set = this.excludedChunks.get(absPath);
		if (!set) {
			set = new Set();
			this.excludedChunks.set(absPath, set);
		}
		if (include) {
			if (!this.isPartIncluded(absPath, list)) {
				this.setPartRaw(absPath, list, true);
				for (const k of partKeys) {
					set.add(k);
				}
			}
			set.delete(key);
		} else {
			set.add(key);
			if (partKeys.every((k) => set!.has(k))) {
				this.setPartRaw(absPath, list, false);
				for (const k of partKeys) {
					set.delete(k);
				}
			}
		}
		if (!set.size) {
			this.excludedChunks.delete(absPath);
		}
		this.changed();
	}

	private setPartRaw(absPath: string, listId: string, include: boolean): void {
		if (listId === this.listOf(absPath).id) {
			if (include) {
				this.included.add(absPath);
			} else {
				this.included.delete(absPath);
			}
		} else if (include) {
			this.includedParts.add(`${absPath}\0${listId}`);
		} else {
			this.includedParts.delete(`${absPath}\0${listId}`);
		}
	}

	/** Forgets chunk assignments for chunks that no longer exist. */
	pruneChunkLists(absPath: string, existingKeys: string[]): void {
		const m = this.chunkLists.get(absPath);
		if (!m) {
			return;
		}
		const keys = new Set(existingKeys);
		let changed = false;
		for (const k of [...m.keys()]) {
			if (!keys.has(k)) {
				m.delete(k);
				changed = true;
			}
		}
		if (changed) {
			this.normalizeChunks(absPath);
			this.changed();
		}
	}

	private normalizeChunks(absPath: string): void {
		const m = this.chunkLists.get(absPath);
		const fileList = this.listOf(absPath).id;
		if (m) {
			for (const [k, lid] of [...m]) {
				if (lid === fileList || !this.get(lid)) {
					m.delete(k);
				}
			}
			if (!m.size) {
				this.chunkLists.delete(absPath);
			}
		}
		const lists = new Set(this.partLists(absPath));
		for (const part of [...this.includedParts]) {
			const [p, lid] = part.split('\0');
			if (p === absPath && !lists.has(lid)) {
				this.includedParts.delete(part);
			}
		}
	}

	isIncluded(absPath: string): boolean {
		return this.included.has(absPath);
	}

	setIncluded(paths: Iterable<string>, include: boolean): void {
		let any = false;
		for (const p of paths) {
			if (include) {
				if (!this.included.has(p)) {
					this.included.add(p);
					any = true;
				}
			} else if (this.included.delete(p)) {
				any = true;
			}
			if (this.excludedChunks.delete(p)) {
				any = true;
			}
		}
		if (any) {
			this.changed();
		}
	}

	/** Includes exactly the given files and excludes all others. */
	includeOnly(paths: Iterable<string>): void {
		this.included = new Set(paths);
		this.excludedChunks.clear();
		this.changed();
	}

	getExcludedChunks(absPath: string): ReadonlySet<string> {
		return this.excludedChunks.get(absPath) ?? new Set();
	}

	isPartiallyIncluded(absPath: string): boolean {
		return this.included.has(absPath) && (this.excludedChunks.get(absPath)?.size ?? 0) > 0;
	}

	setChunkIncluded(absPath: string, key: string, include: boolean, allKeys?: string[]): void {
		let set = this.excludedChunks.get(absPath);
		if (include) {
			set?.delete(key);
			this.included.add(absPath);
		} else {
			if (!set) {
				set = new Set();
				this.excludedChunks.set(absPath, set);
			}
			set.add(key);
			if (allKeys && allKeys.every((k) => set!.has(k))) {
				this.included.delete(absPath);
				this.excludedChunks.delete(absPath);
			}
		}
		if (set && set.size === 0) {
			this.excludedChunks.delete(absPath);
		}
		this.changed();
	}

	/** Keeps only chunk exclusions that still exist in the file. */
	pruneChunks(absPath: string, existingKeys: string[]): void {
		const set = this.excludedChunks.get(absPath);
		if (!set) {
			return;
		}
		const keys = new Set(existingKeys);
		let changed = false;
		for (const k of [...set]) {
			if (!keys.has(k)) {
				set.delete(k);
				changed = true;
			}
		}
		if (set.size === 0) {
			this.excludedChunks.delete(absPath);
		}
		if (changed) {
			this.changed();
		}
	}

	/**
	 * Called with all currently changed files. New tracked changes in the
	 * active changelist get included automatically, vanished files are
	 * forgotten.
	 */
	sync(tracked: string[], unversioned: string[]): void {
		const current = new Set([...tracked, ...unversioned]);
		let changed = false;
		const unversionedSet = new Set(unversioned);
		for (const p of current) {
			if (!this.known.has(p)) {
				this.known.add(p);
				if (!unversionedSet.has(p) && this.listOf(p).id === this.activeId) {
					this.included.add(p);
				}
				changed = true;
			}
		}
		for (const p of [...this.known]) {
			if (!current.has(p)) {
				this.known.delete(p);
				this.included.delete(p);
				this.assignments.delete(p);
				this.excludedChunks.delete(p);
				this.chunkLists.delete(p);
				for (const part of [...this.includedParts]) {
					if (part.startsWith(p + '\0')) {
						this.includedParts.delete(part);
					}
				}
				changed = true;
			}
		}
		if (changed) {
			this.changed();
		}
	}

	private changed(): void {
		this.onDidChangeEmitter.fire();
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => this.save(), 300);
	}

	private save(): void {
		const state: PersistedState = {
			lists: this.lists,
			activeId: this.activeId,
			assignments: Object.fromEntries(this.assignments),
			included: [...this.included],
			excludedChunks: Object.fromEntries([...this.excludedChunks].map(([k, v]) => [k, [...v]])),
			known: [...this.known],
			chunkLists: Object.fromEntries([...this.chunkLists].map(([k, v]) => [k, Object.fromEntries(v)])),
			includedParts: [...this.includedParts],
		};
		void this.memento.update(STORAGE_KEY, state);
	}

	dispose(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.save();
		}
		this.onDidChangeEmitter.dispose();
	}
}
