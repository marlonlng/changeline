export type BranchRow<T> = { kind: 'folder'; key: string; label: string; depth: number; count: number } | { kind: 'item'; item: T; label: string; depth: number };

/** Branch rows of one section, grouped into prefix folders (feature/…) like JetBrains' "Group by Prefix"; collapsed folders hide their branches. */
export function groupByPrefix<T>(names: { name: string; item: T }[], collapsed: ReadonlySet<string>, section: string): BranchRow<T>[] {
	const out: BranchRow<T>[] = [];
	const walk = (entries: { parts: string[]; item: T }[], depth: number, prefix: string) => {
		const folders = new Map<string, { parts: string[]; item: T }[]>();
		const leaves: { parts: string[]; item: T }[] = [];
		for (const e of entries) {
			if (e.parts.length > 1) {
				folders.set(e.parts[0], [...(folders.get(e.parts[0]) ?? []), { parts: e.parts.slice(1), item: e.item }]);
			} else {
				leaves.push(e);
			}
		}
		for (const [name, children] of folders) {
			const key = `${section}:${prefix}${name}`;
			out.push({ kind: 'folder', key, label: name, depth, count: children.length });
			if (!collapsed.has(key)) {
				walk(children, depth + 1, `${prefix}${name}/`);
			}
		}
		for (const leaf of leaves) {
			out.push({ kind: 'item', item: leaf.item, label: leaf.parts[0], depth });
		}
	};
	walk(names.map((n) => ({ parts: n.name.split('/'), item: n.item })), 0, '');
	return out;
}
