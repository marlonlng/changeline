import type { Repository } from './git/repository';
import { chunkKey, DiffChunk, diffLines, isBinary, splitLines } from './shared/diff';

export interface FileChunks {
	oldLines: string[];
	newLines: string[];
	chunks: DiffChunk[];
	keys: string[];
}

/** Chunks of a modified file between HEAD and the working tree (as used for partial commits). */
export async function workingChunks(repo: Repository, relPath: string): Promise<FileChunks | undefined> {
	const [head, work] = await Promise.all([repo.getContentOrEmpty('HEAD', relPath, { filters: true }), repo.readWorkingFile(relPath)]);
	if (!head || !work || isBinary(head) || isBinary(work)) {
		return undefined;
	}
	const oldLines = splitLines(head.toString('utf8'));
	const newLines = splitLines(work.toString('utf8'));
	const chunks = diffLines(oldLines, newLines);
	return { oldLines, newLines, chunks, keys: chunks.map((c) => chunkKey(c, oldLines, newLines)) };
}
