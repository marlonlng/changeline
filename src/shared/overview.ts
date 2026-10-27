export const OVERVIEW_MIN_THUMB = 20;

export interface ScrollView {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}

/** Position and size of the thumb in an overview track of the given height, or undefined when the content does not scroll. */
export function overviewThumb(view: ScrollView, track: number): { top: number; height: number } | undefined {
	const range = view.scrollHeight - view.clientHeight;
	if (range <= 0 || track <= 0) {
		return undefined;
	}
	const height = Math.min(track, Math.max(OVERVIEW_MIN_THUMB, (view.clientHeight / view.scrollHeight) * track));
	const top = (Math.min(Math.max(view.scrollTop, 0), range) / range) * (track - height);
	return { top, height };
}

/** Scroll position that centers the view on the content shown at offset y of the overview track. */
export function overviewScrollTo(view: ScrollView, track: number, y: number): number {
	const range = Math.max(0, view.scrollHeight - view.clientHeight);
	return Math.min(range, Math.max(0, (y / track) * view.scrollHeight - view.clientHeight / 2));
}

/** Scroll position after the thumb was dragged by dy pixels from a drag that began at startScrollTop. */
export function overviewDrag(view: ScrollView, track: number, startScrollTop: number, dy: number): number {
	const range = Math.max(0, view.scrollHeight - view.clientHeight);
	const thumb = overviewThumb(view, track);
	if (!thumb || thumb.height >= track) {
		return startScrollTop;
	}
	return Math.min(range, Math.max(0, startScrollTop + (dy * range) / (track - thumb.height)));
}

/** Top and height of a mark as fractions of the overview track for an element at top with the given height in content of scrollHeight. */
export function overviewMark(top: number, height: number, scrollHeight: number): { top: number; height: number } {
	if (scrollHeight <= 0) {
		return { top: 0, height: 0 };
	}
	const start = Math.min(1, Math.max(0, top / scrollHeight));
	return { top: start, height: Math.min(1 - start, Math.max(0, height / scrollHeight)) };
}
