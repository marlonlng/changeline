import { bandPath, mapOffset, PaneBox } from '../../src/shared/linkedPanes';

const SVG = 'http://www.w3.org/2000/svg';
const LINE_STEP = 40;

/**
 * Editor panes that scroll together like JetBrains' diff and merge viewers: every pane scrolls on its own,
 * the others follow through the corresponding changes, and the dividers between them draw curved bands
 * from a change on one side to the same change on the other. Elements with data-chunk mark the changes.
 */
export class LinkedPanes {
	private boxes: Map<number, PaneBox>[] = [];
	private readonly expected: (number | undefined)[] = [];
	private frame = 0;
	private readonly cleanup: (() => void)[] = [];
	/** JetBrains' "Synchronize Scrolling": when off, every pane scrolls on its own and only the bands follow. */
	synced = true;

	constructor(
		private readonly panes: HTMLElement[],
		private readonly dividers: SVGSVGElement[],
		private readonly band: (divider: number, index: number) => string | undefined,
		private readonly onLayout: () => void = () => undefined,
	) {
		panes.forEach((pane, k) => {
			const onScroll = () => this.scrolled(k);
			const onWheel = (e: WheelEvent) => {
				if (e.deltaY && !e.ctrlKey) {
					pane.scrollTop += e.deltaMode === 1 ? e.deltaY * LINE_STEP / 2 : e.deltaY;
				}
			};
			const onKey = (e: KeyboardEvent) => {
				const step = { ArrowDown: LINE_STEP / 2, ArrowUp: -LINE_STEP / 2, PageDown: pane.clientHeight * 0.9, PageUp: -pane.clientHeight * 0.9 }[e.key];
				if (step !== undefined && !e.altKey && !e.shiftKey) {
					pane.scrollTop += step;
					e.preventDefault();
				} else if ((e.key === 'Home' || e.key === 'End') && (e.metaKey || e.ctrlKey)) {
					pane.scrollTop = e.key === 'Home' ? 0 : pane.scrollHeight;
					e.preventDefault();
				}
			};
			pane.addEventListener('scroll', onScroll, { passive: true });
			pane.addEventListener('wheel', onWheel, { passive: true });
			pane.addEventListener('keydown', onKey);
			this.cleanup.push(() => {
				pane.removeEventListener('scroll', onScroll);
				pane.removeEventListener('wheel', onWheel);
				pane.removeEventListener('keydown', onKey);
			});
		});
		dividers.forEach((divider, k) => {
			const onWheel = (e: WheelEvent) => {
				if (e.deltaY) {
					panes[k + 1].scrollTop += e.deltaY;
				}
			};
			divider.parentElement?.addEventListener('wheel', onWheel, { passive: true });
			this.cleanup.push(() => divider.parentElement?.removeEventListener('wheel', onWheel));
		});
		const ro = new ResizeObserver(() => this.refresh());
		panes.forEach((p) => ro.observe(p));
		this.cleanup.push(() => ro.disconnect());
	}

	/** Measures the changes again after the content or the size of a pane changed, then lines the panes up again. */
	refresh(source = this.panes.length - 1): void {
		this.boxes = this.panes.map((pane) => {
			const m = new Map<number, PaneBox>();
			for (const el of pane.querySelectorAll<HTMLElement>('[data-chunk]')) {
				m.set(Number(el.dataset.chunk), { top: el.offsetTop, height: el.offsetHeight });
			}
			return m;
		});
		this.sync(source);
	}

	/** Position of a change in a pane relative to the visible area, or undefined when the pane does not show it. */
	visibleBox(pane: number, index: number): PaneBox | undefined {
		const b = this.boxes[pane]?.get(index);
		return b && { top: b.top - this.panes[pane].scrollTop, height: b.height };
	}

	/** Scrolls so that a change sits a third down the visible area of every pane. */
	reveal(index: number, pane = this.panes.length - 1): void {
		const b = this.boxes[pane]?.get(index);
		const el = this.panes[pane];
		if (b) {
			el.scrollTop = b.top - el.clientHeight / 3;
			this.sync(pane);
		}
	}

	dispose(): void {
		cancelAnimationFrame(this.frame);
		this.cleanup.forEach((f) => f());
	}

	private scrolled(k: number): void {
		const want = this.expected[k];
		if (want !== undefined && Math.abs(this.panes[k].scrollTop - want) < 1) {
			this.expected[k] = undefined;
			this.schedule();
			return;
		}
		this.expected[k] = undefined;
		this.sync(k);
	}

	private sync(source: number): void {
		const src = this.panes[source];
		if (!src) {
			return;
		}
		const center = src.scrollTop + src.clientHeight / 2;
		this.panes.forEach((pane, k) => {
			if (k === source || !this.synced) {
				return;
			}
			const target = Math.round(mapOffset(this.anchors(source, k), center) - pane.clientHeight / 2);
			if (Math.abs(pane.scrollTop - target) >= 1) {
				pane.scrollTop = target;
				this.expected[k] = pane.scrollTop;
			}
		});
		this.schedule();
	}

	private anchors(from: number, to: number): [number, number][] {
		const a = this.boxes[from];
		const b = this.boxes[to];
		const pairs: [number, number][] = [[0, 0]];
		for (const [i, box] of [...a].sort((x, y) => x[1].top - y[1].top)) {
			const other = b.get(i);
			if (other) {
				pairs.push([box.top, other.top], [box.top + box.height, other.top + other.height]);
			}
		}
		pairs.push([this.panes[from].scrollHeight, this.panes[to].scrollHeight]);
		return pairs;
	}

	private schedule(): void {
		cancelAnimationFrame(this.frame);
		this.frame = requestAnimationFrame(() => this.draw());
	}

	private draw(): void {
		this.dividers.forEach((svg, k) => {
			const width = svg.clientWidth;
			const height = svg.clientHeight;
			const paths: SVGPathElement[] = [];
			for (const [i] of this.boxes[k] ?? []) {
				const cls = this.band(k, i);
				const l = this.visibleBox(k, i);
				const r = this.visibleBox(k + 1, i);
				if (!cls || !l || !r) {
					continue;
				}
				if (Math.max(l.top + l.height, r.top + r.height) < 0 || Math.min(l.top, r.top) > height) {
					continue;
				}
				const path = document.createElementNS(SVG, 'path');
				path.setAttribute('d', bandPath(l, r, width));
				path.setAttribute('class', cls);
				paths.push(path);
			}
			svg.replaceChildren(...paths);
		});
		this.onLayout();
	}
}
