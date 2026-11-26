import type { CommitInfo } from './types';

/** Merges the newest-first commit lists of several repositories by commit date, keeping the order inside each repository. */
export function mergeByDate(lists: CommitInfo[][], limit: number): CommitInfo[] {
	const pos = lists.map(() => 0);
	const out: CommitInfo[] = [];
	while (out.length < limit) {
		let best = -1;
		lists.forEach((l, i) => {
			if (pos[i] < l.length && (best < 0 || l[pos[i]].commitDate > lists[best][pos[best]].commitDate)) {
				best = i;
			}
		});
		if (best < 0) {
			break;
		}
		out.push(lists[best][pos[best]++]);
	}
	return out;
}
