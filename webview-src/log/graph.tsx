import type { GraphRow } from '../../src/shared/graph';

export const ROW_HEIGHT = 22;
export const LANE_WIDTH = 12;
const MAX_LANES = 40;

export const GRAPH_COLORS = ['#5fa74a', '#4b8fe2', '#e0a03a', '#c159c6', '#d9574c', '#39afab', '#a8a23a', '#8b7ad6', '#e07938', '#4fa1d4', '#d1609b', '#7aa34a'];

export function graphColor(i: number): string {
	return GRAPH_COLORS[i % GRAPH_COLORS.length];
}

export function graphWidth(row: GraphRow): number {
	return Math.min(row.width, MAX_LANES) * LANE_WIDTH + 4;
}

export function GraphCell({ row, isHead, dimmed }: { row: GraphRow; isHead: boolean; dimmed: boolean }) {
	const h = ROW_HEIGHT;
	const ys = [0, h / 2, h];
	const x = (lane: number) => Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + LANE_WIDTH / 2;
	const width = graphWidth(row);
	return (
		<svg class="graph" width={width} height={h} style={{ opacity: dimmed ? 0.45 : 1 }}>
			{row.lines.map((l, i) => {
				const x1 = x(l.x1);
				const x2 = x(l.x2);
				const y1 = ys[l.y1];
				const y2 = ys[l.y2];
				const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
				return <path key={i} d={d} stroke={graphColor(l.color)} stroke-width="1.6" fill="none" />;
			})}
			{isHead ? (
				<circle cx={x(row.node)} cy={h / 2} r={4.5} fill="var(--vscode-editor-background)" stroke={graphColor(row.color)} stroke-width="2" />
			) : (
				<circle cx={x(row.node)} cy={h / 2} r={3.5} fill={graphColor(row.color)} />
			)}
		</svg>
	);
}
