import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangelineApi } from '../../extension';
import { EXTENSION_ID, runAll, test, waitFor } from './harness';
import { closeCdp, webview } from './webview';

const ws = process.env['CHANGELINE_E2E_WORKSPACE']!;

test('German display language: manifest and UI messages are translated', async () => {
	assert.equal(vscode.env.language, 'de');
	const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
	const commands = (ext.packageJSON as { contributes: { commands: { command: string; title: { value: string } }[] } }).contributes.commands;
	assert.equal(commands.find((c) => c.command === 'changeline.updateProject')?.title.value, 'Projekt aktualisieren…');
	const api = (await ext.activate()) as ChangelineApi;
	fs.writeFileSync(path.join(ws, 'neu.txt'), 'neu\n');
	await vscode.commands.executeCommand('changeline.changes.refresh');
	const view = api._test.changesView;
	await waitFor(() => view.allFiles().find((f) => f.change.path === 'neu.txt'), 'neu.txt as unversioned');
	const labels = view.getChildren().map((n) => view.getTreeItem(n).label);
	assert.ok(labels.includes('Unversionierte Dateien'), `group labels: ${labels.join(', ')}`);
});

test('German display language: webviews use the German bundle', async () => {
	await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
	const v = await webview('Commit');
	await v.waitFor(`document.documentElement.lang === 'de' && document.querySelector('textarea.message')?.placeholder === 'Commit-Nachricht'`, 'German commit message placeholder');
});

export async function run(): Promise<void> {
	try {
		await runAll();
	} finally {
		closeCdp();
	}
}
