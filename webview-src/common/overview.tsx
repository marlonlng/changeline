import './overview.css';
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { overviewDrag, overviewMark, overviewScrollTo, overviewThumb } from '../../src/shared/overview';

export interface OverviewMark {
	index: number;
	className: string;
	top: number;
	height: number;
}

/** Marks for the elements matching selector inside the scrolling element, indexed by their data-chunk attribute. */
export function measureMarks(scroller: HTMLElement, selector: string, classOf: (el: HTMLElement) => string): OverviewMark[] {
	const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
	return [...scroller.querySelectorAll<HTMLElement>(selector)].map((el) => {
		const rect = el.getBoundingClientRect();
		return { index: Number(el.dataset.chunk), className: classOf(el), ...overviewMark(rect.top - origin, rect.height, scroller.scrollHeight) };
	});
}

/** Vertical scrollbar for target with a mark for every change, like the error stripe in JetBrains IDEs; marks are measured again whenever revision changes or target is resized. */
export function OverviewRuler({ target, revision, measure, onMark }: { target: RefObject<HTMLElement>; revision: unknown; measure: (scroller: HTMLElement) => OverviewMark[]; onMark: (index: number) => void }) {
	const track = useRef<HTMLDivElement>(null);
	const thumb = useRef<HTMLDivElement>(null);
	const measureRef = useRef(measure);
	measureRef.current = measure;
	const [marks, setMarks] = useState<OverviewMark[]>([]);

	useEffect(() => {
		const el = target.current;
		const tr = track.current;
		const th = thumb.current;
		if (!el || !tr || !th) {
			return;
		}
		const updateThumb = () => {
			const g = overviewThumb(el, tr.clientHeight);
			th.style.display = g ? '' : 'none';
			if (g) {
				th.style.top = `${g.top}px`;
				th.style.height = `${g.height}px`;
			}
		};
		let frame = 0;
		const refresh = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				setMarks(measureRef.current(el));
				updateThumb();
			});
		};
		refresh();
		el.addEventListener('scroll', updateThumb, { passive: true });
		const ro = new ResizeObserver(refresh);
		ro.observe(el);
		ro.observe(tr);
		return () => {
			cancelAnimationFrame(frame);
			el.removeEventListener('scroll', updateThumb);
			ro.disconnect();
		};
	}, [revision]);

	const onPointerDown = (e: PointerEvent) => {
		const el = target.current;
		const tr = track.current;
		if (!el || !tr || e.button !== 0) {
			return;
		}
		e.preventDefault();
		const mark = (e.target as HTMLElement).closest<HTMLElement>('[data-mark]');
		if (mark) {
			onMark(Number(mark.dataset.mark));
			return;
		}
		if (e.target !== thumb.current) {
			el.scrollTop = overviewScrollTo(el, tr.clientHeight, e.clientY - tr.getBoundingClientRect().top);
		}
		const startY = e.clientY;
		const startTop = el.scrollTop;
		const move = (ev: PointerEvent) => {
			el.scrollTop = overviewDrag(el, tr.clientHeight, startTop, ev.clientY - startY);
		};
		const up = () => {
			tr.classList.remove('dragging');
			tr.removeEventListener('pointermove', move);
			tr.removeEventListener('pointerup', up);
			tr.removeEventListener('pointercancel', up);
		};
		tr.setPointerCapture(e.pointerId);
		tr.classList.add('dragging');
		tr.addEventListener('pointermove', move);
		tr.addEventListener('pointerup', up);
		tr.addEventListener('pointercancel', up);
	};

	return (
		<div ref={track} class="jg-overview" onPointerDown={onPointerDown as any} onWheel={(e) => target.current?.scrollBy({ top: e.deltaY })}>
			{marks.map((m) => (
				<div key={m.index} class={`mark ${m.className}`} data-mark={m.index} style={{ top: `${m.top * 100}%`, height: `${m.height * 100}%` }} />
			))}
			<div ref={thumb} class="thumb" />
		</div>
	);
}
