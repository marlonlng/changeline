
export interface GraphCommit {
	hash: string;
	parents: readonly string[];
}

export interface GraphLine {
	x1: number;
	y1: 0 | 1 | 2;
	x2: number;
	y2: 0 | 1 | 2;
	color: number;
	arrow?: 'down' | 'up';
}

export interface GraphRow {
	node: number;
	color: number;
	lines: GraphLine[];
	width: number;
}

interface Lane {
	hash: string;
	color: number;
	until?: number;
	resumed?: boolean;
}

export const LONG_EDGE = 30;
const EDGE_STUB = 3;

/**
 * Lays out the commit graph lane by lane. Unless longEdges is set, an edge to a parent more than LONG_EDGE rows
 * away is cut like JetBrains does: it ends in an arrow a few rows below the child and starts again with an arrow
 * a few rows above the parent, so the lanes in between stay free.
 */
export function layoutGraph(commits: readonly GraphCommit[], options: { longEdges?: boolean } = {}): GraphRow[] {
	let lanes: Lane[] = [];
	let nextColor = 0;
	const rows: GraphRow[] = [];
	const rowOf = new Map(commits.map((c, i) => [c.hash, i]));
	const resume = new Map<number, Lane[]>();

	for (const [r, commit] of commits.entries()) {
		for (const lane of resume.get(r) ?? []) {
			if (!lanes.some((l) => l.hash === lane.hash)) {
				lanes = [...lanes, { ...lane, resumed: true }];
			}
		}
		const before = lanes;
		let node = before.findIndex((l) => l.hash === commit.hash);
		let color: number;
		if (node === -1) {
			node = before.length;
			color = nextColor++;
		} else {
			color = before[node].color;
		}

		const lines: GraphLine[] = [];
		const passing: { lane: Lane; from: number }[] = [];
		for (let j = 0; j < before.length; j++) {
			const lane = before[j];
			if (lane.hash === commit.hash) {
				lines.push({ x1: j, y1: lane.resumed ? 1 : 0, x2: node, y2: 1, color: lane.color, ...(lane.resumed ? { arrow: 'up' as const } : {}) });
			} else if (lane.until === r) {
				lines.push({ x1: j, y1: 0, x2: j, y2: 1, color: lane.color, arrow: 'down' });
			} else {
				passing.push({ lane, from: j });
			}
		}
		const found = before.some((l) => l.hash === commit.hash);
		const insertAt = found ? passing.filter((p) => p.from < node).length : passing.length;

		const added: { lane: Lane; from: number }[] = [];
		commit.parents.forEach((parent, index) => {
			if (passing.some((p) => p.lane.hash === parent) || added.some((p) => p.lane.hash === parent)) {
				return;
			}
			const lane: Lane = { hash: parent, color: index === 0 ? color : nextColor++ };
			const at = rowOf.get(parent);
			if (!options.longEdges && at !== undefined && at - r > LONG_EDGE) {
				lane.until = r + EDGE_STUB;
				const list = resume.get(at - EDGE_STUB) ?? [];
				list.push({ hash: parent, color: lane.color });
				resume.set(at - EDGE_STUB, list);
			}
			added.push({ lane, from: -1 });
		});
		const after = [...passing.slice(0, insertAt), ...added, ...passing.slice(insertAt)];

		after.forEach((entry, k) => {
			if (entry.from >= 0) {
				const resumed = entry.lane.resumed;
				lines.push({ x1: entry.from, y1: resumed ? 1 : 0, x2: k, y2: 2, color: entry.lane.color, ...(resumed ? { arrow: 'up' as const } : {}) });
			}
		});
		for (const parent of commit.parents) {
			const k = after.findIndex((e) => e.lane.hash === parent);
			if (k >= 0) {
				lines.push({ x1: node, y1: 1, x2: k, y2: 2, color: after[k].lane.color });
			}
		}

		lanes = after.map((e) => (e.lane.resumed ? { ...e.lane, resumed: false } : e.lane));
		rows.push({ node, color, lines, width: Math.max(before.length, lanes.length, node + 1) });
	}
	return rows;
}

/**
 * "Collapse Linear Branches": hides the inner commits of linear runs on side
 * branches (one parent, one child, no refs). The newest commit of a run
 * keeps a "+N" marker and is connected directly to the oldest one.
 */
export function collapseLinearBranches<C extends GraphCommit>(commits: C[], labels: ReadonlyMap<string, unknown>, head: string | undefined, expanded: ReadonlySet<string>): { visible: C[]; counts: Map<string, number> } {
	const byHash = new Map(commits.map((c) => [c.hash, c]));
	const children = new Map<string, string[]>();
	for (const c of commits) {
		for (const p of c.parents) {
			const arr = children.get(p) ?? [];
			arr.push(c.hash);
			children.set(p, arr);
		}
	}
	const mainline = new Set<string>();
	for (let h = head; h && byHash.has(h) && !mainline.has(h); h = byHash.get(h)!.parents[0]) {
		mainline.add(h);
	}
	const linear = (h: string) => {
		const c = byHash.get(h);
		return !!c && c.parents.length === 1 && (children.get(h)?.length ?? 0) === 1 && !labels.has(h) && !mainline.has(h);
	};
	const hidden = new Set<string>();
	const rewrite = new Map<string, string>();
	const counts = new Map<string, number>();
	for (const c of commits) {
		const child = children.get(c.hash)?.[0];
		if (!linear(c.hash) || (child && linear(child) && byHash.get(child)!.parents[0] === c.hash) || expanded.has(c.hash)) {
			continue;
		}
		const run = [c.hash];
		let next = c.parents[0];
		while (next && linear(next)) {
			run.push(next);
			next = byHash.get(next)!.parents[0];
		}
		if (run.length < 3) {
			continue;
		}
		const last = run[run.length - 1];
		for (const h of run.slice(1, -1)) {
			hidden.add(h);
			rewrite.set(h, last);
		}
		counts.set(c.hash, run.length - 2);
	}
	const visible = commits.filter((c) => !hidden.has(c.hash)).map((c) => (c.parents.some((p) => rewrite.has(p)) ? { ...c, parents: c.parents.map((p) => rewrite.get(p) ?? p) } : c));
	return { visible, counts };
}

