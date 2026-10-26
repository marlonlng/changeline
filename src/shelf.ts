import * as fs from 'fs';
import * as path from 'path';
import type { Repository } from './git/repository';
import { Emitter } from './shared/emitter';
import { autoMerge } from './shared/diff3';
import { isBinary, splitLines } from './shared/diff';
import type { ChangeStatus, FileChange } from './shared/types';

export interface ShelvedFile {
	path: string;
	origPath?: string;
	status: ChangeStatus;
	binary: boolean;
}

export interface ShelvedRepo {
	repoRoot: string;
	repoName: string;
	base?: string;
	files: ShelvedFile[];
}

export interface ShelvedList {
	id: string;
	name: string;
	date: number;
	deleted?: boolean;
	repos: ShelvedRepo[];
}

export interface UnshelveConflict {
	repo: Repository;
	file: ShelvedFile;
	base: string;
	local: string;
	shelved: string;
}

export interface UnshelveResult {
	applied: number;
	conflicts: UnshelveConflict[];
	skipped: string[];
}

export class ShelfManager {
	private readonly onDidChangeEmitter = new Emitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly dir: string) {}

	private listDir(id: string): string {
		return path.join(this.dir, id);
	}

	async list(): Promise<ShelvedList[]> {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.dir);
		} catch {
			return [];
		}
		const lists: ShelvedList[] = [];
		for (const id of entries) {
			try {
				const meta = JSON.parse(await fs.promises.readFile(path.join(this.dir, id, 'meta.json'), 'utf8')) as ShelvedList;
				lists.push(meta);
			} catch {
			}
		}
		return lists.sort((a, b) => b.date - a.date);
	}

	async get(id: string): Promise<ShelvedList | undefined> {
		try {
			return JSON.parse(await fs.promises.readFile(path.join(this.listDir(id), 'meta.json'), 'utf8')) as ShelvedList;
		} catch {
			return undefined;
		}
	}

	private async save(list: ShelvedList): Promise<void> {
		await fs.promises.mkdir(this.listDir(list.id), { recursive: true });
		await fs.promises.writeFile(path.join(this.listDir(list.id), 'meta.json'), JSON.stringify(list, null, 1), 'utf8');
		this.onDidChangeEmitter.fire();
	}

	private contentPath(id: string, repoIndex: number, file: string): string {
		return path.join(this.listDir(id), String(repoIndex), 'files', ...file.split('/'));
	}

	/** Shelves the given changes and (unless `keepLocal`) reverts them. */
	async shelve(name: string, changes: { repo: Repository; change: FileChange }[], keepLocal = false): Promise<ShelvedList> {
		const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const byRepo = new Map<Repository, FileChange[]>();
		for (const c of changes) {
			const arr = byRepo.get(c.repo) ?? [];
			arr.push(c.change);
			byRepo.set(c.repo, arr);
		}
		const list: ShelvedList = { id, name, date: Date.now(), repos: [] };
		let repoIndex = 0;
		for (const [repo, files] of byRepo) {
			const entry: ShelvedRepo = { repoRoot: repo.root, repoName: repo.name, base: repo.state.head, files: [] };
			for (const f of files) {
				const status: ChangeStatus = f.status === '?' ? 'A' : f.status;
				let binary = false;
				if (status !== 'D') {
					const content = await repo.readWorkingFile(f.path);
					if (content === undefined) {
						continue;
					}
					binary = isBinary(content);
					const target = this.contentPath(id, repoIndex, f.path);
					await fs.promises.mkdir(path.dirname(target), { recursive: true });
					await fs.promises.writeFile(target, content);
				}
				entry.files.push({ path: f.path, origPath: f.origPath, status, binary });
			}
			const tracked = files.filter((f) => f.status !== '?').flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
			let patch = tracked.length && repo.state.head ? await repo.createPatch({ from: 'HEAD', paths: tracked }) : '';
			for (const f of files.filter((x) => x.status === '?')) {
				patch += await repo.createUntrackedPatch(f.path);
			}
			await fs.promises.mkdir(path.join(this.listDir(id), String(repoIndex)), { recursive: true });
			await fs.promises.writeFile(path.join(this.listDir(id), String(repoIndex), 'changes.patch'), patch, 'utf8');
			list.repos.push(entry);
			repoIndex++;
		}
		await this.save(list);
		if (!keepLocal) {
			for (const [repo, files] of byRepo) {
				await repo.rollback(files, true);
			}
		}
		return list;
	}

	async readShelved(list: ShelvedList, repoIndex: number, file: ShelvedFile): Promise<Buffer | undefined> {
		try {
			return await fs.promises.readFile(this.contentPath(list.id, repoIndex, file.path));
		} catch {
			return undefined;
		}
	}

	async readPatch(list: ShelvedList): Promise<string> {
		let out = '';
		for (let i = 0; i < list.repos.length; i++) {
			try {
				out += await fs.promises.readFile(path.join(this.listDir(list.id), String(i), 'changes.patch'), 'utf8');
			} catch {
			}
		}
		return out;
	}

	/**
	 * Applies shelved files to the working tree. Non-conflicting local
	 * modifications are merged automatically; real conflicts are returned
	 * for interactive resolution.
	 */
	async unshelve(list: ShelvedList, getRepo: (root: string) => Repository | undefined, only?: Set<string>): Promise<UnshelveResult> {
		const result: UnshelveResult = { applied: 0, conflicts: [], skipped: [] };
		for (let ri = 0; ri < list.repos.length; ri++) {
			const entry = list.repos[ri];
			const repo = getRepo(entry.repoRoot);
			if (!repo) {
				result.skipped.push(...entry.files.map((f) => `${entry.repoName}/${f.path}`));
				continue;
			}
			for (const file of entry.files) {
				if (only && !only.has(`${ri}:${file.path}`)) {
					continue;
				}
				const abs = repo.absolutePath(file.path);
				const baseBuf = entry.base ? await repo.getContentOrEmpty(entry.base, file.origPath ?? file.path, { filters: true }) : undefined;
				const localBuf = await repo.readWorkingFile(file.path);
				if (file.status === 'D') {
					if (localBuf === undefined) {
						result.applied++;
					} else if (baseBuf && localBuf.equals(baseBuf)) {
						await fs.promises.rm(abs, { force: true });
						result.applied++;
					} else {
						result.skipped.push(file.path);
					}
					continue;
				}
				const shelvedBuf = await this.readShelved(list, ri, file);
				if (!shelvedBuf) {
					result.skipped.push(file.path);
					continue;
				}
				if (file.origPath && file.origPath !== file.path) {
					const origBuf = await repo.readWorkingFile(file.origPath);
					if (origBuf && baseBuf && origBuf.equals(baseBuf)) {
						await fs.promises.rm(repo.absolutePath(file.origPath), { force: true });
					}
				}
				if (localBuf === undefined || (baseBuf && localBuf.equals(baseBuf)) || localBuf.equals(shelvedBuf)) {
					await fs.promises.mkdir(path.dirname(abs), { recursive: true });
					await fs.promises.writeFile(abs, shelvedBuf);
					result.applied++;
					continue;
				}
				if (file.binary || isBinary(localBuf)) {
					result.skipped.push(file.path);
					continue;
				}
				const base = baseBuf?.toString('utf8') ?? '';
				const local = localBuf.toString('utf8');
				const shelved = shelvedBuf.toString('utf8');
				const merged = autoMerge(splitLines(base), splitLines(local), splitLines(shelved));
				if (merged.conflicts === 0) {
					await fs.promises.writeFile(abs, merged.text, 'utf8');
					result.applied++;
				} else {
					result.conflicts.push({ repo, file, base, local, shelved });
				}
			}
			await repo.refresh();
		}
		return result;
	}

	/** Removes files from a shelved list; the list is deleted when empty. */
	async removeFiles(list: ShelvedList, files: Set<string>): Promise<void> {
		list.repos = list.repos.map((r, ri) => ({ ...r, files: r.files.filter((f) => !files.has(`${ri}:${f.path}`)) }));
		if (list.repos.every((r) => r.files.length === 0)) {
			await this.delete(list);
			return;
		}
		await this.save(list);
	}

	/** Moves a list to "Recently Deleted"; deleting there removes it for good. */
	async delete(list: ShelvedList): Promise<void> {
		if (list.deleted) {
			await fs.promises.rm(this.listDir(list.id), { recursive: true, force: true });
			this.onDidChangeEmitter.fire();
			return;
		}
		list.deleted = true;
		await this.save(list);
	}

	async restore(list: ShelvedList): Promise<void> {
		list.deleted = false;
		await this.save(list);
	}

	async rename(list: ShelvedList, name: string): Promise<void> {
		list.name = name;
		await this.save(list);
	}

	async emptyRecentlyDeleted(): Promise<void> {
		for (const l of await this.list()) {
			if (l.deleted) {
				await fs.promises.rm(this.listDir(l.id), { recursive: true, force: true });
			}
		}
		this.onDidChangeEmitter.fire();
	}

	/** Imports a patch file as a new shelved list (applied to a scratch copy is not needed: stored as patch only). */
	async importPatch(repo: Repository, name: string, patch: string): Promise<void> {
		const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const files: ShelvedFile[] = [];
		const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(patch))) {
			files.push({ path: m[2], origPath: m[1] !== m[2] ? m[1] : undefined, status: 'M', binary: false });
		}
		const list: ShelvedList = { id, name, date: Date.now(), repos: [{ repoRoot: repo.root, repoName: repo.name, base: repo.state.head, files: [] }] };
		await fs.promises.mkdir(path.join(this.listDir(id), '0'), { recursive: true });
		await fs.promises.writeFile(path.join(this.listDir(id), '0', 'changes.patch'), patch, 'utf8');
		const tmpIndex = path.join(repo.gitDir, `changeline-import-${id}`);
		const patchFile = path.join(this.listDir(id), '0', 'changes.patch');
		try {
			const env = { GIT_INDEX_FILE: tmpIndex };
			if (repo.state.head) {
				await repo.run(['read-tree', 'HEAD'], { env });
			}
			await repo.run(['apply', '--cached', '--whitespace=nowarn', patchFile], { env });
			for (const f of files) {
				const exists = await repo.run(['ls-files', '--', f.path], { env });
				if (!exists.stdout.trim()) {
					f.status = 'D';
					continue;
				}
				const blob = await repo.git.execBuffer(repo.root, ['cat-file', '--filters', `:${f.path}`], { env });
				const inHead = repo.state.head ? await repo.getContentOrEmpty('HEAD', f.origPath ?? f.path) : undefined;
				f.status = f.origPath ? 'R' : inHead ? 'M' : 'A';
				f.binary = isBinary(blob.stdout);
				const target = this.contentPath(id, 0, f.path);
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				await fs.promises.writeFile(target, blob.stdout);
			}
		} finally {
			await fs.promises.rm(tmpIndex, { force: true });
		}
		list.repos[0].files = files;
		await this.save(list);
	}
}
