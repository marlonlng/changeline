import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { overviewDrag, overviewMark, overviewScrollTo, overviewThumb, OVERVIEW_MIN_THUMB } from '../../shared/overview';

const view = (scrollTop: number, clientHeight = 200, scrollHeight = 1000) => ({ scrollTop, clientHeight, scrollHeight });

test('overviewThumb: covers the visible part of the content', () => {
	assert.deepEqual(overviewThumb(view(0), 500), { top: 0, height: 100 });
	assert.deepEqual(overviewThumb(view(400), 500), { top: 200, height: 100 });
	assert.deepEqual(overviewThumb(view(800), 500), { top: 400, height: 100 });
	assert.deepEqual(overviewThumb(view(5000), 500), { top: 400, height: 100 });
});

test('overviewThumb: keeps a minimum size and disappears when nothing scrolls', () => {
	assert.equal(overviewThumb(view(0, 10, 10000), 500)?.height, OVERVIEW_MIN_THUMB);
	assert.equal(overviewThumb(view(9990, 10, 10000), 500)?.top, 500 - OVERVIEW_MIN_THUMB);
	assert.equal(overviewThumb(view(0, 200, 200), 500), undefined);
	assert.equal(overviewThumb(view(0), 0), undefined);
});

test('overviewScrollTo: centers the view on the clicked place, within the scroll range', () => {
	assert.equal(overviewScrollTo(view(0), 500, 250), 400);
	assert.equal(overviewScrollTo(view(0), 500, 10), 0);
	assert.equal(overviewScrollTo(view(0), 500, 495), 800);
});

test('overviewDrag: moves the content by the thumb distance, within the scroll range', () => {
	assert.equal(overviewDrag(view(0), 500, 0, 100), 200);
	assert.equal(overviewDrag(view(400), 500, 400, -100), 200);
	assert.equal(overviewDrag(view(0), 500, 0, 1000), 800);
	assert.equal(overviewDrag(view(0), 500, 0, -50), 0);
	assert.equal(overviewDrag(view(0, 200, 200), 500, 0, 50), 0);
});

test('overviewMark: places a change relative to the whole content', () => {
	assert.deepEqual(overviewMark(250, 50, 1000), { top: 0.25, height: 0.05 });
	assert.deepEqual(overviewMark(750, 500, 1000), { top: 0.75, height: 0.25 });
	assert.deepEqual(overviewMark(-10, 5, 1000), { top: 0, height: 0.005 });
	assert.deepEqual(overviewMark(10, 5, 0), { top: 0, height: 0 });
});
