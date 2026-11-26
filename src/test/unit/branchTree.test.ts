import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { groupByPrefix } from '../../shared/branchTree';

const rows = (names: string[], collapsed: string[] = []) =>
	groupByPrefix(names.map((name) => ({ name, item: name })), new Set(collapsed), 'local').map((r) => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `[${r.label} ${r.count}]` : r.label}`);

test('groupByPrefix: prefixes become folders before plain branches', () => {
	assert.deepEqual(rows(['main', 'feature/login', 'feature/ui/menu', 'bugfix/crash', 'develop']), ['[feature 2]', '  [ui 1]', '    menu', '  login', '[bugfix 1]', '  crash', 'main', 'develop']);
});

test('groupByPrefix: collapsed folders hide their branches', () => {
	assert.deepEqual(rows(['feature/a', 'feature/b', 'main'], ['local:feature']), ['[feature 2]', 'main']);
	assert.deepEqual(rows(['origin/main', 'origin/feature/x'], ['local:origin/feature']), ['[origin 2]', '  [feature 1]', '  main']);
});
