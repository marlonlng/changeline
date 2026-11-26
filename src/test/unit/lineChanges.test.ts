import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diffLines, splitLines } from '../../shared/diff';
import { applyLineChanges, chunkForLineChange, LineChange, originalText, revertLineChange, textDelta } from '../../shared/lineChanges';

const change = (originalStartLineNumber: number, originalEndLineNumber: number, modifiedStartLineNumber: number, modifiedEndLineNumber: number): LineChange => ({
	originalStartLineNumber,
	originalEndLineNumber,
	modifiedStartLineNumber,
	modifiedEndLineNumber,
});

const cases: [string, string, string, LineChange][] = [
	['modified line', 'a\nb\nc\n', 'a\nB\nc\n', change(2, 2, 2, 2)],
	['inserted line', 'a\nc\n', 'a\nb\nc\n', change(1, 0, 2, 2)],
	['inserted at the end without newline', 'a\nb', 'a\nb\nc', change(2, 0, 3, 3)],
	['deleted line', 'a\nb\nc\n', 'a\nc\n', change(2, 2, 1, 0)],
	['deleted at the end without newline', 'a\nb', 'a', change(2, 2, 1, 0)],
	['CRLF line endings', 'a\r\nb\r\nc\r\n', 'a\r\nX\r\nc\r\n', change(2, 2, 2, 2)],
];

test('applyLineChanges: applying a change turns the original into the modified text', () => {
	for (const [name, original, modified, c] of cases) {
		assert.equal(applyLineChanges(original, modified, [c]), modified, name);
		assert.equal(revertLineChange(original, modified, [c], 0), original, name);
	}
});

test('revertLineChange: only the chosen change goes back to the original', () => {
	const original = '1\n2\n3\n4\n5\n';
	const modified = '1\nX\n3\n4\nY\n';
	const changes = [change(2, 2, 2, 2), change(5, 5, 5, 5)];
	assert.equal(revertLineChange(original, modified, changes, 0), '1\n2\n3\n4\nY\n');
	assert.equal(revertLineChange(original, modified, changes, 1), '1\nX\n3\n4\n5\n');
});

test('originalText: the replaced or deleted lines, nothing for an insertion', () => {
	assert.equal(originalText('1\n2\n3\n', change(2, 3, 2, 2)), '2\n3\n');
	assert.equal(originalText('a\nb', change(2, 2, 1, 0)), 'b');
	assert.equal(originalText('a\nc\n', change(1, 0, 2, 2)), '');
});

test('chunkForLineChange: maps a quick diff change to the diff viewer chunk', () => {
	const oldLines = splitLines('1\n2\n3\n4\n5\n6\n7\n');
	const newLines = splitLines('1\nX\n3\n4\n6\n7\nY\n');
	const chunks = diffLines(oldLines, newLines);
	assert.equal(chunks.length, 3);
	assert.equal(chunkForLineChange(chunks, change(2, 2, 2, 2)), 0);
	assert.equal(chunkForLineChange(chunks, change(5, 5, 4, 0)), 1);
	assert.equal(chunkForLineChange(chunks, change(7, 0, 7, 7)), 2);
	assert.equal(chunkForLineChange([], change(1, 1, 1, 1)), -1);
});

test('textDelta: replaces only what differs and never splits CRLF', () => {
	assert.deepEqual(textDelta('a\nb\nc\n', 'a\nB\nc\n'), { start: 2, end: 3, text: 'B' });
	assert.deepEqual(textDelta('a\r\nb\r\n', 'a\r\n'), { start: 3, end: 6, text: '' });
	const before = 'x\r\ny';
	const d = textDelta(before, 'x\ny');
	assert.equal(before.slice(0, d.start) + d.text + before.slice(d.end), 'x\ny');
	assert.notEqual(before.charCodeAt(d.start - 1), 13);
	assert.deepEqual(textDelta('same', 'same'), { start: 4, end: 4, text: '' });
});
