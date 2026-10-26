import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { overlayFits, quickInputField } from '../../shared/dialogs';
import type { DialogField, DialogSpec } from '../../shared/types';

const spec = (...fields: DialogField[]): DialogSpec => ({ title: 'Dialog', fields });

test('quickInputField: one text, select or radio field is asked as quick input', () => {
	for (const type of ['text', 'select', 'radio'] as const) {
		assert.equal(quickInputField(spec({ id: 'f', type }))?.id, 'f', type);
	}
});

test('quickInputField: multi-line, list and multi-field dialogs stay dialogs', () => {
	assert.equal(quickInputField(spec({ id: 'message', type: 'textarea' })), undefined);
	assert.equal(quickInputField(spec({ id: 'files', type: 'checklist' })), undefined);
	assert.equal(quickInputField(spec({ id: 'branch', type: 'combo' })), undefined);
	assert.equal(quickInputField(spec({ id: 'name', type: 'text' }, { id: 'checkout', type: 'checkbox' })), undefined);
	assert.equal(quickInputField(spec({ id: 'info', type: 'label' }, { id: 'name', type: 'text' })), undefined);
	assert.equal(quickInputField({ ...spec({ id: 'stash', type: 'radio' }), extraButtons: [{ id: 'drop', label: 'Drop' }] }), undefined);
	assert.equal(quickInputField(spec()), undefined);
});

test('overlayFits: the dialog fits, or the webview is tall enough to scroll it', () => {
	assert.equal(overlayFits({ width: 800, height: 400 }, 300), true);
	assert.equal(overlayFits({ width: 800, height: 260 }, 500), true);
	assert.equal(overlayFits({ width: 800, height: 180 }, 160), true);
	assert.equal(overlayFits({ width: 800, height: 180 }, 300), false);
	assert.equal(overlayFits({ width: 240, height: 900 }, 300), false);
});
