export interface PaneBox {
	top: number;
	height: number;
}

/** Maps an offset in one pane to the other pane through anchor pairs [offset here, offset there], linear between them. */
export function mapOffset(anchors: readonly (readonly [number, number])[], y: number): number {
	if (!anchors.length) {
		return y;
	}
	if (y <= anchors[0][0]) {
		return anchors[0][1] + (y - anchors[0][0]);
	}
	for (let i = 1; i < anchors.length; i++) {
		const [a0, b0] = anchors[i - 1];
		const [a1, b1] = anchors[i];
		if (y <= a1) {
			return a1 === a0 ? b1 : b0 + ((y - a0) / (a1 - a0)) * (b1 - b0);
		}
	}
	const [a, b] = anchors[anchors.length - 1];
	return b + (y - a);
}

/** SVG path of the curved band JetBrains draws in the divider from a change on the left to the same change on the right. */
export function bandPath(left: PaneBox, right: PaneBox, width: number): string {
	const n = (v: number) => Math.round(v * 10) / 10;
	const l1 = n(left.top);
	const l2 = n(left.top + left.height);
	const r1 = n(right.top);
	const r2 = n(right.top + right.height);
	const mid = n(width / 2);
	return `M0 ${l1} C${mid} ${l1} ${mid} ${r1} ${width} ${r1} L${width} ${r2} C${mid} ${r2} ${mid} ${l2} 0 ${l2} Z`;
}
