import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bandPath, mapOffset } from '../../shared/linkedPanes';

test('mapOffset: equal parts map one to one, changes of different size are stretched', () => {
	const anchors: [number, number][] = [
		[0, 0],
		[100, 100],
		[200, 120],
		[400, 320],
	];
	assert.equal(mapOffset(anchors, 50), 50);
	assert.equal(mapOffset(anchors, 150), 110);
	assert.equal(mapOffset(anchors, 300), 220);
	assert.equal(mapOffset(anchors, 500), 420);
	assert.equal(mapOffset([], 42), 42);
});

test('mapOffset: an empty side of a change maps to its single position', () => {
	const anchors: [number, number][] = [
		[0, 0],
		[100, 100],
		[100, 160],
		[300, 360],
	];
	assert.equal(mapOffset(anchors, 100), 100);
	assert.equal(mapOffset(anchors, 200), 260);
});

test('bandPath: curves from the left change to the right change', () => {
	assert.equal(bandPath({ top: 10, height: 20 }, { top: 40, height: 0 }, 52), 'M0 10 C26 10 26 40 52 40 L52 40 C26 40 26 30 0 30 Z');
});
