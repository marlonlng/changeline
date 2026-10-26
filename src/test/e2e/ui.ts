import { strict as assert } from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangelineApi } from '../../extension';
import { EXTENSION_ID, runAll, test, waitFor } from './harness';
import { closeCdp, setWindowSize, webview, workbench } from './webview';


const ws = process.env['CHANGELINE_E2E_WORKSPACE']!;
let api: ChangelineApi;

const repo = () => api._test.services().repos.repositories.find((r) => fs.realpathSync(r.root) === fs.realpathSync(ws))!;
const read = (rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8');
const closeAll = () => vscode.commands.executeCommand('workbench.action.closeAllEditors');

async function commitFile(rel: string, content: string, message: string): Promise<void> {
	fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
	fs.writeFileSync(path.join(ws, rel), content);
	await repo().stage([rel]);
	await repo().commit({ message });
	await repo().refresh();
}

/** Waits until Local Changes shows the file as modified (not a stale node from before a commit). */
async function changed(rel: string) {
	await repo().refresh();
	const abs = repo().absolutePath(rel);
	return waitFor(() => api._test.changesView.allFiles().find((f) => f.abs === abs && f.change.status === 'M'), `${rel} modified in Local Changes`);
}

const codeLines = (edit: (lines: string[]) => void) => {
	const lines = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};`);
	lines[2] = 'export function greet(name: string): string { return "Hello " + name; }';
	edit(lines);
	return lines.join('\n') + '\n';
};

test('activates', async () => {
	api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ChangelineApi;
	await waitFor(() => api.repositories().length === 1, 'repository');
});

test('diff viewer: highlighting, word diff, whitespace, collapse, F7, unified, include and revert', async () => {
	await commitFile('src/code.ts', codeLines(() => undefined), 'add code');
	fs.writeFileSync(path.join(ws, 'src/code.ts'), codeLines((l) => {
		l[2] = 'export function greet(name: string): string { return "Hi " + name; }';
		l[20] = '  ' + l[20];
		l[35] = 'export const value35 = 3500;';
	}));
	const node = await changed('src/code.ts');
	await vscode.commands.executeCommand('changeline.changes.open', node);
	const w = await webview('Diff: code.ts');
	await w.waitFor(
		`document.querySelectorAll('.diff-body.side .row.ch').length === 3`,
		'three chunks side by side',
		10000,
		`({ rows: document.querySelectorAll('.row.ch').length, body: document.querySelector('.diff-body')?.className, counter: document.querySelector('.jg-toolbar .counter:last-of-type')?.textContent, ws: document.querySelector('select[title="Whitespace"]')?.value, lines: [...document.querySelectorAll('.row.ch .cell.r .code')].map((e) => e.textContent.slice(0, 40)) })`,
	);
	assert.equal(await w.text('.jg-toolbar .counter:last-of-type'), '3 differences');
	assert.ok((await w.count('.diff-body .hl-keyword')) > 0, 'syntax highlighting');
	assert.ok((await w.count('.row.ch .wd')) > 0, 'changed words are highlighted');
	const wordText = await w.eval<string[]>(`[...document.querySelectorAll('.row.ch[data-chunk="0"] .wd')].map((e) => e.textContent)`);
	assert.deepEqual(wordText, ['Hello', 'Hi']);

	await w.click('button[title="Highlight words"]');
	await w.waitFor(`document.querySelectorAll('.row.ch .wd').length === 0`, 'word highlighting off');
	await w.click('button[title="Highlight words"]');
	await w.waitFor(`document.querySelectorAll('.row.ch .wd').length > 0`, 'word highlighting on');

	await w.select('select[title="Whitespace"]', 'all');
	await w.waitFor(`document.querySelectorAll('.row.ch').length === 2`, 'whitespace-only change ignored');
	await w.select('select[title="Whitespace"]', 'none');
	await w.waitFor(`document.querySelectorAll('.row.ch').length === 3`, 'whitespace change shown again');

	const collapsed = async () => w.count('.row.fold');
	if ((await collapsed()) === 0) {
		await w.click('button[title="Collapse unchanged fragments"]');
	}
	await w.waitFor(`document.querySelectorAll('.row.fold').length > 0`, 'unchanged fragments collapsed');
	const folds = await collapsed();
	await w.click('.row.fold');
	await w.waitFor(`document.querySelectorAll('.row.fold').length === ${folds - 1}`, 'fold expanded on click');
	await w.click('button[title="Collapse unchanged fragments"]');
	await w.waitFor(`document.querySelectorAll('.row.fold').length === 0`, 'collapse off');

	const current = () => w.eval<string>(`document.querySelector('.row.ch.current')?.dataset.chunk`);
	const first = Number(await current());
	await w.key('F7');
	await waitFor(async () => Number(await current()) === (first + 1) % 3, 'F7 moves to the next difference');
	await w.key('F7', { shift: true });
	await waitFor(async () => Number(await current()) === first, 'Shift+F7 moves back');

	await w.select('select[title="Viewer"]', 'unified');
	await w.waitFor(`document.querySelectorAll('.diff-body.unified .u-chunk').length === 3`, 'unified viewer');
	assert.ok((await w.count('.u-line.del')) >= 3 && (await w.count('.u-line.ins')) >= 3);
	await w.select('select[title="Viewer"]', 'side');
	await w.waitFor(`document.querySelectorAll('.diff-body.side .row.ch').length === 3`, 'back to side by side');

	const cl = api._test.services().changelists;
	await w.click('.row.ch[data-chunk="2"] input.inc');
	await waitFor(() => cl.getExcludedChunks(node.abs).size === 1, 'chunk excluded on the host');
	await w.waitFor(`document.querySelector('.row.ch[data-chunk="2"]').classList.contains('excluded')`, 'chunk shown as excluded');
	await w.click('.row.ch[data-chunk="2"] input.inc');
	await waitFor(() => cl.getExcludedChunks(node.abs).size === 0, 'chunk included again');

	await w.click('.row.ch[data-chunk="0"] [data-action="revert"]');
	await waitFor(() => read('src/code.ts').includes('"Hello "'), 'first chunk reverted on disk');
	await w.waitFor(`document.querySelectorAll('.row.ch').length === 2`, 'two chunks left');
	assert.ok(read('src/code.ts').includes('value35 = 3500'), 'other chunks untouched');
	await closeAll();
});

test('diff viewer: next / previous file with Alt+Right / Alt+Left', async () => {
	fs.writeFileSync(path.join(ws, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n');
	fs.writeFileSync(path.join(ws, 'b.txt'), 'bee changed\n');
	const node = await changed('a.txt');
	await changed('b.txt');
	await vscode.commands.executeCommand('changeline.changes.open', node);
	const w = await webview(/^Diff: /);
	const shown = () => w.eval<string>(`document.querySelector('.titles .title.r .path, .titles .title .path')?.textContent?.trim()`);
	await waitFor(async () => (await shown())?.endsWith('a.txt'), 'a.txt shown');
	const files = await w.eval<string[]>(`[...document.querySelectorAll('select.file-select option')].map((o) => o.textContent)`);
	assert.ok(files.length >= 3, `files to navigate: ${files.join(', ')}`);
	const index = () => w.eval<string>(`document.querySelector('select.file-select').value`);
	const start = Number(await index());
	await w.key('ArrowRight', { alt: true });
	await waitFor(async () => Number(await index()) === start + 1, 'Alt+Right opens the next file');
	await waitFor(async () => !(await shown())?.endsWith('a.txt'), 'other file shown');
	await w.key('ArrowLeft', { alt: true });
	await waitFor(async () => Number(await index()) === start, 'Alt+Left goes back');
	await closeAll();
	await repo().restore(['a.txt', 'b.txt', 'src/code.ts']);
});

test('conflicts dialog and merge window: accept theirs, resolve simple conflicts, apply non-conflicting, accept left, apply', async () => {
	const r = repo();
	await commitFile('merge.txt', 'one\ntwo\nthree\nfour\nalpha beta gamma\nfive-b\nsix\n', 'merge base');
	await commitFile('side.txt', 'side base\n', 'side base');
	await r.checkout('main', { newBranch: 'theirs-br' });
	for (const i of [1, 2, 3]) {
		await commitFile('theirs-notes.txt', `prep ${i}\n`, `theirs prep ${i}`);
	}
	await commitFile('merge.txt', 'one\ntwo\nthree-theirs\nfour\nalpha beta GAMMA\nfive-b\nsix-theirs\n', 'theirs');
	await commitFile('side.txt', 'side theirs\n', 'side theirs');
	await r.checkout('main');
	await commitFile('merge.txt', 'one-ours\ntwo\nthree-ours\nfour\nALPHA beta gamma\nfive-b\nsix\n', 'ours');
	await commitFile('side.txt', 'side ours\n', 'side ours');
	await r.merge('theirs-br');
	await r.refresh();
	assert.equal(r.state.conflicts.length, 2);

	await vscode.commands.executeCommand('changeline.resolveConflicts');
	const dlg = await webview('Conflicts');
	await dlg.waitFor(`document.querySelectorAll('.trow').length === 2`, 'two conflicting files');
	await dlg.clickText('.trow', 'side.txt');
	await dlg.clickText('.actions .jg-btn', 'Accept Theirs');
	await waitFor(async () => (await r.refresh(), r.state.conflicts.length === 1), 'side.txt resolved');
	assert.equal(read('side.txt'), 'side theirs\n');
	await dlg.waitFor(`document.querySelectorAll('.trow').length === 1`, 'one file left in the dialog');
	await dlg.clickText('.trow', 'merge.txt');
	await dlg.clickText('.actions .jg-btn', 'Merge');

	const m = await webview('Merge: merge.txt');
	const counts = async () => {
		const t = await m.text('.jg-toolbar .counter');
		const x = /(\d+) changes? left · (\d+) conflicts?/.exec(t);
		return x ? { changes: Number(x[1]), conflicts: Number(x[2]) } : t;
	};
	await m.waitFor(`/changes? left/.test(document.querySelector('.jg-toolbar .counter')?.textContent ?? '')`, 'merge model loaded');
	const start = await counts();
	assert.deepEqual(start, { changes: 4, conflicts: 2 }, JSON.stringify(start));
	assert.ok((await m.count('.m-row.change')) >= 4);

	const cur = () => m.eval<string>(`document.querySelector('.m-row.change.current')?.dataset.block`);
	const first = await cur();
	await m.key('F7');
	await waitFor(async () => (await cur()) !== first, 'F7 moves to the next change');

	await m.click('button[title^="Resolve Simple Conflicts"]');
	await waitFor(async () => JSON.stringify(await counts()) === JSON.stringify({ changes: 1, conflicts: 1 }), 'only the real conflict left');
	await m.clickText('.jg-toolbar .jg-btn', 'Apply Non-Conflicting Changes');
	await m.clickText('.jg-menu .item', 'Apply All Non-Conflicting Changes');
	assert.deepEqual(await counts(), { changes: 1, conflicts: 1 });
	await m.click('.m-row.change:not(.resolved) button[title="Accept left change"]');
	await m.click('.m-row.change:not(.resolved) button[title="Ignore right change"]');
	await m.waitFor(`document.querySelector('.jg-toolbar .counter').textContent === 'All changes have been processed'`, 'all processed');
	await m.clickText('.m-footer .jg-btn.primary', 'Apply');
	await waitFor(async () => (await r.refresh(), r.state.conflicts.length === 0), 'merge.txt resolved');
	assert.equal(read('merge.txt'), 'one-ours\ntwo\nthree-ours\nfour\nALPHA beta GAMMA\nfive-b\nsix-theirs\n');
	await r.continueOperation();
	await r.refresh();
	assert.equal(r.state.operation, 'none');
	assert.equal((await r.getCommit('HEAD')).parents.length, 2);
	await closeAll();
});

test('commit message view: inspections, options, commit button, amend, message history, commit template', async () => {
	await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
	const v = await webview('Commit');
	const node = await (async () => {
		fs.writeFileSync(path.join(ws, 'b.txt'), 'bee from the commit view\n');
		return changed('b.txt');
	})();
	api._test.services().changelists.includeOnly([node.abs]);
	await v.type('textarea.message', 'This subject line is much too long for a commit message and it goes on and on and on and on');
	await v.waitFor(`[...document.querySelectorAll('.problems .problem')].some((p) => /Subject line is too long/.test(p.textContent))`, 'subject length inspection');
	await v.type('textarea.message', 'Short subject\nno blank line');
	await v.waitFor(`[...document.querySelectorAll('.problems .problem')].some((p) => /Missing blank line/.test(p.textContent))`, 'blank line inspection');

	await v.click('button[title="Commit Options"]');
	await v.waitFor(`!!document.querySelector('.options')`, 'commit options');
	const signOff = () => api._test.commit.options.signOff;
	const before = signOff();
	await v.clickText('.options label.jg-check', 'Sign-off commit');
	await waitFor(() => signOff() === !before, 'sign-off changed on the host');
	await v.clickText('.options label.jg-check', 'Sign-off commit');
	await waitFor(() => signOff() === before, 'sign-off restored');
	await v.click('button[title="Commit Options"]');

	await v.type('textarea.message', 'Commit from the view\n\nBody text');
	await waitFor(() => api._test.commit.message.startsWith('Commit from the view'), 'message synced to the host');
	await v.waitFor(`!document.querySelector('.footer .jg-btn.primary').disabled`, 'commit button enabled');
	await v.clickText('.footer .jg-btn.primary', 'Commit');
	await waitFor(async () => (await repo().getCommit('HEAD')).subject === 'Commit from the view', 'committed from the button');
	assert.equal((await repo().getContent('HEAD', 'b.txt')).toString(), 'bee from the commit view\n');
	await v.waitFor(`document.querySelector('textarea.message').value === ''`, 'message cleared after commit');

	await v.click('.top-row label.jg-check input');
	await v.waitFor(`document.querySelector('textarea.message').value.startsWith('Commit from the view')`, 'amend loads the last message');
	await v.click('.top-row label.jg-check input');
	await waitFor(() => !api._test.commit.amend, 'amend off');
	await v.type('textarea.message', '');

	await v.click('button[title^="Show Commit Message History"]');
	const wb = await workbench();
	await wb.waitFor(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some((r) => r.offsetParent && r.textContent.includes('Commit from the view'))`, 'message history');
	await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
	await v.waitFor(`document.querySelector('textarea.message').value === ${JSON.stringify('Commit from the view\n\nBody text')}`, 'message from history');

	fs.writeFileSync(path.join(ws, '.gitmessage'), '# Describe the change\nTicket: \n');
	await repo().runOp(['config', 'commit.template', '.gitmessage']);
	fs.writeFileSync(path.join(ws, 'b.txt'), 'bee with template\n');
	api._test.services().changelists.includeOnly([(await changed('b.txt')).abs]);
	await v.type('textarea.message', 'Second commit from the view');
	await waitFor(() => api._test.commit.message === 'Second commit from the view', 'message synced');
	await v.waitFor(`!document.querySelector('.footer .jg-btn.primary').disabled`, 'commit button enabled');
	await v.clickText('.footer .jg-btn.primary', 'Commit');
	await v.waitFor(`document.querySelector('textarea.message').value === 'Ticket:'`, 'template after commit');
	await repo().runOp(['config', '--unset', 'commit.template']);
	fs.rmSync(path.join(ws, '.gitmessage'));
	api._test.commit.setMessage('');
});

test('log: graph, labels, details, merge parents, text filter, highlight, collapse linear branches, branches pane', async () => {
	await vscode.commands.executeCommand('changeline.showLog');
	const v = await webview('Log');
	await v.waitFor(`document.querySelectorAll('.commit-row').length >= 10`, 'commits listed');
	assert.ok((await v.count('.commit-row svg.graph circle')) >= 10, 'graph nodes');
	const labels = await v.eval<string[]>(`[...document.querySelectorAll('.ref-label')].map((e) => e.textContent.trim())`);
	for (const l of ['main', 'feature', 'theirs-br']) {
		assert.ok(labels.some((x) => x.includes(l)), `label ${l} in ${labels.join(', ')}`);
	}
	const rows = () => v.count('.commit-row');

	await v.clickText('.commit-row .subject .text', "Merge branch 'theirs-br'");
	await v.waitFor(`!!document.querySelector('.details-pane select.parent-select')`, 'parent selection for the merge commit');
	await v.waitFor(`document.querySelector('.details-title')?.textContent === '3 files changed'`, 'changes relative to the first parent', 10000, `document.querySelector('.details-title')?.textContent`);
	await v.select('.details-pane select.parent-select', '1');
	await v.waitFor(`document.querySelector('.details-title')?.textContent === '1 file changed'`, 'changes relative to the second parent', 10000, `document.querySelector('.details-title')?.textContent`);
	assert.match(await v.text('.commit-info .subject'), /^Merge branch 'theirs-br'/);

	const all = await rows();
	await v.type('.search input[type="search"]', 'side');
	await v.key('Enter', {}, '.search input[type="search"]');
	await v.waitFor(`document.querySelectorAll('.commit-row').length === 4`, 'filtered by text', 10000, `[...document.querySelectorAll('.commit-row .subject .text')].map((e) => e.textContent)`);
	assert.deepEqual(await v.eval(`[...document.querySelectorAll('.commit-row .subject .text')].map((e) => e.textContent)`), ["Merge branch 'theirs-br'", 'side ours', 'side theirs', 'side base']);
	await v.type('.search input[type="search"]', '');
	await v.key('Enter', {}, '.search input[type="search"]');
	await v.waitFor(`document.querySelectorAll('.commit-row').length === ${all}`, 'filter cleared');

	await v.click('button[title="View Options"]');
	await v.clickText('.jg-menu .item', 'Highlight Current Branch');
	await v.waitFor(`document.querySelectorAll('.commit-row.dim').length > 0`, 'commits outside the current branch dimmed');
	await v.click('button[title="View Options"]');
	await v.clickText('.jg-menu .item', 'Highlight Current Branch');
	await v.waitFor(`document.querySelectorAll('.commit-row.dim').length === 0`, 'highlight off');
	await v.click('button[title="View Options"]');
	await v.clickText('.jg-menu .item', 'Collapse Linear Branches');
	await v.waitFor(`document.querySelectorAll('.collapsed-marker').length === 1 && document.querySelectorAll('.commit-row').length === ${all - 2}`, 'linear run collapsed');
	await v.click('.collapsed-marker');
	await v.waitFor(`document.querySelectorAll('.commit-row').length === ${all}`, 'run expanded');
	await v.click('button[title="View Options"]');
	await v.clickText('.jg-menu .item', 'Collapse Linear Branches');

	await v.clickText('.branches-pane .jg-row .name', 'feature');
	const featureTip = (await repo().revParse('feature'))!;
	await waitFor(() => api._test.logView.current?.selectedCommits[0]?.hash === featureTip, 'feature tip selected');
	const ctx = await v.eval<{ webviewSection: string; hash: string }>(`JSON.parse(document.querySelector('.commit-row.selected').dataset.vscodeContext)`);
	assert.equal(ctx.webviewSection, 'commit');
	assert.equal(ctx.hash, featureTip);
});

test('dialogs: New Branch validates the name and creates the branch without checkout', async () => {
	void vscode.commands.executeCommand('changeline.newBranch', repo());
	const d = await webview(/^Create New Branch from /);
	await d.type('.field input[type="text"]', 'bad name');
	await d.waitFor(`document.querySelector('.field .error')?.textContent === 'Branch name cannot contain whitespace' && document.querySelector('.buttons .jg-btn.primary').disabled`, 'invalid name rejected');
	await d.type('.field input[type="text"]', 'feature');
	await d.waitFor(`document.querySelector('.field .error')?.textContent === "Branch 'feature' already exists"`, 'existing branch rejected');
	await d.type('.field input[type="text"]', 'ui-branch');
	await d.waitFor(`!document.querySelector('.field .error') && !document.querySelector('.buttons .jg-btn.primary').disabled`, 'valid name accepted');
	await d.clickText('.field.check label.jg-check', 'Checkout branch');
	await d.clickText('.buttons .jg-btn.primary', 'Create');
	await waitFor(async () => (await repo().revParse('refs/heads/ui-branch')) === (await repo().revParse('HEAD')), 'branch created');
	await repo().refresh();
	assert.equal(repo().state.branch, 'main', 'not checked out');
});

const dialogTabs = () =>
	vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('changeline.dialog'));

test('dialogs from the log open as overlay in the log: edit commit message, Escape cancels', async () => {
	await commitFile('overlay.txt', 'overlay\n', 'overlay before');
	await vscode.commands.executeCommand('changeline.showLog');
	const log = await webview('Log');
	const logId = api._test.logView.current!.id;
	void vscode.commands.executeCommand('changeline.log.editMessage', { logId, hash: (await repo().revParse('HEAD'))! });
	await log.waitFor(`document.querySelector('.jg-dialog-overlay:not(.measuring) textarea')?.value.startsWith('overlay before')`, 'edit message overlay in the log');
	assert.equal(dialogTabs().length, 0, 'no dialog tab');
	await log.type('.jg-dialog-overlay textarea', 'overlay after');
	await log.clickText('.jg-dialog-overlay .buttons .jg-btn.primary', 'OK');
	await waitFor(async () => (await repo().getCommit('HEAD')).subject === 'overlay after', 'message changed');
	await log.waitFor(`!document.querySelector('.jg-dialog-overlay')`, 'overlay closed after OK');

	void vscode.commands.executeCommand('changeline.log.editMessage', { logId, hash: (await repo().revParse('HEAD'))! });
	await log.waitFor(`!!document.querySelector('.jg-dialog-overlay:not(.measuring) textarea')`, 'overlay opened again');
	await log.key('Escape', {}, '.jg-dialog-overlay textarea');
	await log.waitFor(`!document.querySelector('.jg-dialog-overlay')`, 'Escape closes the overlay');
	assert.equal((await repo().getCommit('HEAD')).subject, 'overlay after');
});

test('single-choice dialogs are quick picks: reset from the log', async () => {
	const before = (await repo().revParse('HEAD'))!;
	await commitFile('reset-pick.txt', 'pick\n', 'reset pick');
	void vscode.commands.executeCommand('changeline.log.resetToHere', { logId: api._test.logView.current!.id, hash: before });
	const rows = await waitFor(async () => {
		const r = await quickPickRows();
		return r.length === 4 && r;
	}, 'reset types in a quick pick');
	assert.deepEqual(rows.map((r) => /^(Soft|Mixed|Hard|Keep)/.exec(r)?.[1]), ['Soft', 'Mixed', 'Hard', 'Keep']);
	assert.equal(dialogTabs().length, 0, 'no dialog tab');
	const wb = await workbench();
	await wb.eval(`(() => { const i = document.querySelector('.quick-input-widget .quick-input-box input'); i.value = 'Keep'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await waitFor(async () => (await quickPickRows())[0]?.startsWith('Keep'), 'filtered to Keep');
	await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
	await waitFor(async () => (await repo().revParse('HEAD')) === before, 'branch reset');
	assert.equal(fs.existsSync(path.join(ws, 'reset-pick.txt')), false, 'keep reset removed the committed file');
});

test('dialogs from the Commit tool window open as overlay in the commit message view', async () => {
	await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
	const wb = await workbench();
	const toggleLocalChanges = () => wb.eval(`[...document.querySelectorAll('.pane-header')].find((h) => h.textContent.includes('Local Changes')).click()`);
	const expanded = () => wb.eval<boolean>(`[...document.querySelectorAll('.pane-header')].find((h) => h.textContent.includes('Local Changes')).getAttribute('aria-expanded') === 'true'`);
	if (await expanded()) {
		await toggleLocalChanges();
	}
	try {
		const cv = await webview('Commit');
		await cv.waitFor(`window.innerHeight >= 240`, 'commit message view has room', 10000, `window.innerHeight`);
		void vscode.commands.executeCommand('changeline.changes.newChangelist');
		await cv.waitFor(`!!document.querySelector('.jg-dialog-overlay:not(.measuring) input[type="text"]')`, 'new changelist overlay');
		assert.equal(dialogTabs().length, 0, 'no dialog tab');
		await cv.type('.jg-dialog-overlay input[type="text"]', 'Overlay list');
		await cv.clickText('.jg-dialog-overlay .buttons .jg-btn.primary', 'OK');
		const list = await waitFor(() => api._test.services().changelists.findByName('Overlay list'), 'changelist created');
		await cv.waitFor(`!document.querySelector('.jg-dialog-overlay')`, 'overlay closed');
		api._test.services().changelists.remove(list.id);
	} finally {
		if (!(await expanded())) {
			await toggleLocalChanges();
		}
	}
});

test('interactive rebase dialog: drop with the toolbar, reword with the R key', async () => {
	await commitFile('rb1.txt', '1\n', 'rb one');
	await commitFile('rb2.txt', '2\n', 'rb two');
	await commitFile('rb3.txt', '3\n', 'rb three');
	const base = (await repo().revParse('HEAD~3'))!;
	await vscode.commands.executeCommand('changeline.interactiveRebase', { repo: repo().root, base });
	const v = await webview('Rebasing main');
	await v.waitFor(`document.querySelectorAll('.entry').length === 3`, 'three commits');
	assert.deepEqual(await v.eval(`[...document.querySelectorAll('.entry .name')].map((e) => e.textContent)`), ['rb three', 'rb two', 'rb one']);
	await v.clickText('.entry .name', 'rb two');
	await v.click('button.action-btn[title^="Remove the commit"]');
	await v.waitFor(`[...document.querySelectorAll('.entry')].find((e) => e.textContent.includes('rb two')).classList.contains('action-drop')`, 'rb two marked as drop');
	await v.clickText('.entry .name', 'rb three');
	await v.key('r');
	await v.waitFor(`!!document.querySelector('.message-editor textarea')`, 'message editor for reword', 10000, `[...document.querySelectorAll('.entry')].map((e) => e.className + ' ' + e.textContent.slice(0, 30))`);
	await v.type('.message-editor textarea', 'rb three (reworded)');
	await v.clickText('.footer .jg-btn.primary', 'Start Rebasing');
	await waitFor(async () => (await repo().getCommit('HEAD')).subject === 'rb three (reworded)', 'rebased');
	assert.equal((await repo().getCommit('HEAD~1')).subject, 'rb one');
	assert.ok(!fs.existsSync(path.join(ws, 'rb2.txt')), 'dropped commit removed');
});

test('push dialog: commits to push, new branch marker, push to a remote', async () => {
	const r = repo();
	const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'jg-remote-'));
	cp.execFileSync('git', ['init', '-q', '--bare', remote]);
	await r.addRemote('origin', remote);
	await r.runOp(['push', '-u', 'origin', 'main']);
	await commitFile('push.txt', 'push me\n', 'to be pushed');
	const lsRemote = (ref: string) => cp.execFileSync('git', ['ls-remote', remote, ref]).toString().split('\t')[0];
	await vscode.commands.executeCommand('changeline.push', r);
	let v = await webview(/^Push Commits/);
	await v.waitFor(`document.querySelectorAll('.commit').length === 1`, 'one commit to push');
	assert.equal(await v.text('.commit .name'), 'to be pushed');
	await v.clickText('.footer .jg-btn.primary', 'Push');
	await waitFor(async () => lsRemote('refs/heads/main') === (await r.revParse('HEAD')), 'main pushed');

	await r.checkout('main', { newBranch: 'push-new' });
	await commitFile('push2.txt', 'new branch\n', 'on a new branch');
	await vscode.commands.executeCommand('changeline.push', r);
	v = await webview(/^Push Commits/);
	await v.waitFor(`!!document.querySelector('.new-badge') && document.querySelectorAll('.commit').length === 1`, 'new branch marker');
	await v.clickText('.footer .jg-btn.primary', 'Push');
	await waitFor(async () => lsRemote('refs/heads/push-new') === (await r.revParse('HEAD')), 'new branch pushed');
	await r.checkout('main');
	await closeAll();
});

/** The rows of the open quick pick as the workbench renders them. */
async function quickPickRows(): Promise<string[]> {
	const wb = await workbench();
	return wb.eval<string[]>(`[...document.querySelectorAll('.quick-input-widget .quick-input-list .monaco-list-row')].filter((r) => r.offsetParent).map((r) => r.textContent.trim())`);
}

test('branches popup: sections, favorites star, branch actions, compare with branch', async () => {
	const r = repo();
	await r.createTag('v-ui', 'HEAD');
	const picks: vscode.QuickPick<any>[] = [];
	const w = vscode.window as any;
	const create = w.createQuickPick;
	w.createQuickPick = () => {
		const qp = create();
		picks.push(qp);
		return qp;
	};
	try {
		void vscode.commands.executeCommand('changeline.branches');
		const qp = await waitFor(() => picks.find((p) => p.items.length > 5), 'branches quick pick');
		const rows = await waitFor(async () => {
			const x = await quickPickRows();
			return x.some((t) => t.includes('feature')) && x;
		}, 'branches shown in the workbench');
		assert.ok(rows.some((t) => t.includes('Update Project')), rows.join('\n'));
		const all = qp.items.map((i: vscode.QuickPickItem) => `${i.label} ${i.description ?? ''}`).join('\n');
		for (const t of ['Update Project', 'Commit...', 'Push...', 'New Branch...', 'Checkout Tag or Revision', 'Local', 'main', 'feature', 'ui-branch', 'Remote', 'origin/main', 'Tags', 'v-ui']) {
			assert.ok(all.includes(t), `"${t}" in the popup:\n${all}`);
		}
		const featureItem = () => qp.items.find((i: any) => i.ref?.shortName === 'feature');
		const wb = await workbench();
		const clicked = await wb.eval<boolean>(`(() => { const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find((r) => r.textContent.includes('feature') && !r.textContent.includes('/')); const a = row?.querySelector('.action-label'); if (!a) return false; a.click(); return true; })()`);
		assert.ok(clicked, 'star button found');
		await waitFor(() => featureItem()?.buttons?.[0]?.tooltip === 'Remove from Favorites', 'feature is a favorite');
		const local = qp.items.slice(qp.items.findIndex((i: any) => i.label === 'Local') + 1, qp.items.findIndex((i: any) => i.label === 'Remote')).map((i: any) => i.ref?.shortName);
		assert.deepEqual(local, ['main', 'feature', 'push-new', 'theirs-br', 'ui-branch'], qp.items.map((i: any) => i.label).join(' | '));
		assert.equal(qp.items.find((i: any) => i.ref?.shortName === 'main').buttons[0].tooltip, 'Remove from Favorites');

		qp.activeItems = [featureItem()];
		await wb.waitFor(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row.focused')].some((r) => /feature/.test(r.textContent))`, 'feature row focused', 10000, `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map((r) => r.className + ':' + r.textContent.trim()).join(' | ')`);
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		await waitFor(async () => (await quickPickRows()).some((t) => t.includes("Compare with 'main'")), 'branch actions');
		const actions = (await quickPickRows()).join('\n');
		for (const t of ['Checkout', "New Branch from 'feature'", "Checkout and Rebase onto 'main'", "Compare with 'main'", 'Show Diff with Working Tree', "Rebase 'main' onto 'feature'", "Merge 'feature' into 'main'", 'Push...', 'Rename...', 'Show in Log', 'Delete']) {
			assert.ok(actions.includes(t), `"${t}" in the branch actions:\n${actions}`);
		}
		await wb.eval(`(() => { const i = document.querySelector('.quick-input-widget .quick-input-box input'); i.value = 'Compare with'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		await waitFor(async () => (await quickPickRows())[0]?.includes("Compare with 'main'"), 'filtered to compare');
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		const c = await webview('Compare main with feature');
		await c.waitFor(`[...document.querySelectorAll('.section .name')].some((e) => e.textContent === 'feature change')`, 'commit only in feature');
		await c.clickText('.tabs .tab', 'Files');
		await c.waitFor(`document.querySelector('.files-only')?.textContent.includes('b.txt')`, 'changed file listed');
		await closeAll();
	} finally {
		w.createQuickPick = create;
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
	}
});

test('VCS operations popup lists the Git actions', async () => {
	const w = vscode.window as any;
	const show = w.showQuickPick;
	let items: vscode.QuickPickItem[] = [];
	w.showQuickPick = (picks: vscode.QuickPickItem[], ...rest: unknown[]) => {
		items = picks;
		return show(picks, ...rest);
	};
	try {
		void vscode.commands.executeCommand('changeline.vcsOperations');
		await waitFor(async () => (await quickPickRows()).some((t) => t.includes('Commit...')), 'VCS operations popup');
		const all = items.map((i) => i.label).join('\n');
		for (const t of ['Commit...', 'Push...', 'Update Project...', 'Pull...', 'Fetch', 'Branches...', 'New Branch...', 'New Tag...', 'Merge...', 'Rebase...', 'Reset HEAD...', 'Stash Changes...', 'Unstash Changes...', 'Shelve Changes...', 'Rollback...', 'Show Git Log', 'Create Pull Request...']) {
			assert.ok(all.includes(t), `"${t}" in the popup:\n${all}`);
		}
	} finally {
		w.showQuickPick = show;
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
	}
});

test('Local Changes tree: group by directory', async () => {
	fs.writeFileSync(path.join(ws, 'src/code.ts'), read('src/code.ts') + '// grouped\n');
	fs.writeFileSync(path.join(ws, 'a.txt'), read('a.txt') + 'grouped\n');
	await changed('src/code.ts');
	await changed('a.txt');
	await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
	await vscode.commands.executeCommand('changeline.changes.focus');
	const wb = await workbench();
	const tree = () =>
		wb.eval<[number, string][]>(`(() => { const pane = [...document.querySelectorAll('.pane')].find((p) => p.querySelector('.pane-header')?.textContent.includes('Local Changes')); return pane ? [...pane.querySelectorAll('.monaco-list-row')].map((r) => [Number(r.getAttribute('aria-level')), r.querySelector('.label-name')?.textContent ?? '']) : []; })()`);
	await vscode.commands.executeCommand('changeline.changes.groupByDirectory');
	await api._test.changesView.expandAll();
	await waitFor(async () => {
		const rows = await tree();
		const dir = rows.find(([, n]) => n === 'src');
		const file = rows.find(([, n]) => n === 'code.ts');
		return dir && file && file[0] === dir[0] + 1;
	}, 'code.ts below a src node');
	await vscode.commands.executeCommand('changeline.changes.groupByNone');
	await waitFor(async () => {
		const rows = await tree();
		const file = rows.find(([, n]) => n === 'code.ts');
		const a = rows.find(([, n]) => n === 'a.txt');
		return !rows.some(([, n]) => n === 'src') && file && a && file[0] === a[0];
	}, 'flat list');
	await repo().restore(['src/code.ts', 'a.txt']);
});

test('pull requests panel (GitLab API mock): list, state and text filters, details, comment, approve', async () => {
	const mr = (iid: number, title: string, state: string, author: string) => ({
		iid, title, state, author: { username: author }, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-21T09:00:00Z', web_url: `http://x/${iid}`,
		source_branch: `feature/${iid}`, target_branch: 'main', sha: 'abc', labels: ['backend'], description: 'Refuses logins after **five failures**.',
		diff_refs: { base_sha: 'b', start_sha: 'b', head_sha: 'abc' }, reviewers: [{ username: 'anna' }], merge_status: 'can_be_merged', head_pipeline: { status: 'success' },
	});
	const all = [mr(12, 'Add rate limiting', 'opened', 'marlon'), mr(11, 'Translate templates', 'opened', 'lea'), mr(9, 'Fix rounding', 'merged', 'jonas')];
	const posted: { path: string; body: any }[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (d) => (raw += d));
		req.on('end', () => {
			const url = new URL(req.url!, 'http://x');
			const p = url.pathname.replace(/^\/api\/v4(\/projects\/[^/]+)?/, '');
			const json = (o: unknown) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(o));
			};
			if (req.method === 'POST') {
				posted.push({ path: p, body: raw ? JSON.parse(raw) : undefined });
				return json({});
			}
			const state = url.searchParams.get('state');
			const routes: Record<string, unknown> = {
				'/merge_requests': all.filter((m) => !state || state === 'all' || m.state === state),
				'/merge_requests/12': all[0],
				'/merge_requests/12/commits': [{ id: 'abc1234', message: 'Add RateLimiter service', author_name: 'Marlon', created_at: '2026-10-19T09:00:00Z' }],
				'/merge_requests/12/changes': { changes: [{ new_path: 'Classes/RateLimiter.php', old_path: 'Classes/RateLimiter.php', new_file: true, diff: '+<?php\n' }] },
				'/merge_requests/12/notes': [{ id: 1, author: { username: 'anna' }, created_at: '2026-10-20T10:00:00Z', body: 'Could the limit be configurable?' }],
				'/merge_requests/12/approvals': { approved_by: [{ user: { username: 'anna' } }] },
				'/merge_requests/12/discussions': [],
				'/user': { username: 'marlon' },
			};
			if (p in routes) {
				return json(routes[p]);
			}
			res.writeHead(404);
			res.end('{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as { port: number }).port;
	const s = api._test.services();
	await vscode.workspace.getConfiguration('changeline').update('gitlab.hosts', ['127.0.0.1'], vscode.ConfigurationTarget.Global);
	await s.context.secrets.store('changeline.token.gitlab.127.0.0.1', 'ui-test');
	await repo().addRemote('upstream', `http://127.0.0.1:${port}/acme/site.git`);
	try {
		api._test.hosting.forgetHosting();
		await vscode.commands.executeCommand('changeline.pullRequests.focus');
		api._test.pullRequests.refresh();
		const v = await webview('Pull Requests');
		await v.waitFor(`document.querySelectorAll('.pr-item').length === 2`, 'open merge requests', 15000);
		assert.deepEqual(await v.eval(`[...document.querySelectorAll('.pr-item .pr-title')].map((e) => e.textContent.trim())`), ['!12 Add rate limiting', '!11 Translate templates']);
		await v.select('.jg-toolbar select', 'merged');
		await v.waitFor(`document.querySelectorAll('.pr-item').length === 1 && document.querySelector('.pr-item .pr-title').textContent.includes('Fix rounding')`, 'merged filter');
		await v.select('.jg-toolbar select', 'open');
		await v.waitFor(`document.querySelectorAll('.pr-item').length === 2`, 'open again');
		await v.type('.jg-toolbar .search input', 'templates');
		await v.waitFor(`document.querySelectorAll('.pr-item').length === 1`, 'text filter');
		await v.type('.jg-toolbar .search input', '');
		await v.click('button[title="Only my pull requests"]');
		await v.waitFor(`document.querySelectorAll('.pr-item').length === 1 && document.querySelector('.pr-item').textContent.includes('marlon')`, 'only mine');
		await v.click('button[title="Only my pull requests"]');

		await v.clickText('.pr-item', 'Add rate limiting');
		await v.waitFor(`!!document.querySelector('.pr-details .overview strong')`, 'markdown description');
		assert.equal(await v.text('.pr-details .overview strong'), 'five failures');
		await v.waitFor(`document.querySelector('.reviewers')?.textContent.includes('anna') && document.querySelector('.reviewers').textContent.includes('approved')`, 'reviewer approved');
		await v.waitFor(`document.querySelector('.timeline')?.textContent.includes('Could the limit be configurable?')`, 'comment in the timeline');
		await v.clickText('.tabs .tab', 'Commits');
		await v.waitFor(`document.querySelector('.pr-details')?.textContent.includes('Add RateLimiter service')`, 'commits tab');
		await v.clickText('.tabs .tab', 'Files');
		await v.waitFor(`document.querySelector('.pr-details')?.textContent.includes('RateLimiter.php')`, 'files tab');
		await v.clickText('.tabs .tab', 'Overview');

		await v.type('.composer textarea', 'Looks good to me');
		await v.clickText('.composer-buttons .jg-btn', 'Comment');
		await waitFor(() => posted.find((x) => x.path === '/merge_requests/12/notes'), 'comment posted');
		assert.equal(posted.find((x) => x.path === '/merge_requests/12/notes')!.body.body, 'Looks good to me');
		await v.clickText('.composer-buttons .jg-btn', 'Approve');
		await waitFor(() => posted.some((x) => x.path === '/merge_requests/12/approve'), 'approved');
	} finally {
		server.close();
		await repo().removeRemote('upstream');
		await vscode.workspace.getConfiguration('changeline').update('gitlab.hosts', undefined, vscode.ConfigurationTarget.Global);
	}
});

test('Commit icon badge: each changed file once, shelf and stash not added', async () => {
	const r = repo();
	const s = api._test.services();
	await commitFile('stash-me.txt', 'stash base\n', 'stash base');
	await commitFile('shelve-me.txt', 'shelf base\n', 'shelf base');
	fs.writeFileSync(path.join(ws, 'stash-me.txt'), 'stashed\n');
	await r.refresh();
	await r.stash({ message: 'badge stash', paths: ['stash-me.txt'] });
	fs.writeFileSync(path.join(ws, 'shelve-me.txt'), 'shelved\n');
	await r.refresh();
	await s.shelf.shelve('badge shelf', [{ repo: r, change: r.state.changes.find((c) => c.path === 'shelve-me.txt')! }]);

	const head = (await r.getContent('HEAD', 'a.txt')).toString();
	const lines = head.split('\n');
	lines[0] = 'FIRST';
	lines[lines.length - 2] = 'LAST';
	fs.writeFileSync(path.join(ws, 'a.txt'), lines.join('\n'));
	fs.writeFileSync(path.join(ws, 'b.txt'), read('b.txt') + 'badge\n');
	const a = await changed('a.txt');
	await changed('b.txt');
	const { diffLines, splitLines, chunkKey } = await import('../../shared/diff');
	const ol = splitLines(head);
	const nl = splitLines(read('a.txt'));
	const keys = diffLines(ol, nl).map((c) => chunkKey(c, ol, nl));
	assert.equal(keys.length, 2);
	const second = s.changelists.create('Badge');
	s.changelists.moveChunk(a.abs, keys[1], second.id);
	await waitFor(() => api._test.changesView.groups.filter((g) => g.files.some((f) => f.abs === a.abs)).length === 2, 'a.txt in two changelists');

	await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
	await r.refresh();
	const expected = 2 + r.state.untracked.length;
	const wb = await workbench();
	const badgeOf = `[...document.querySelectorAll('.activitybar .action-item')].find((i) => (i.querySelector('.action-label')?.getAttribute('aria-label') ?? '').startsWith('Commit'))?.querySelector('.badge-content')?.textContent`;
	await wb.waitFor(
		`${badgeOf} === '${expected}'`,
		`badge ${expected} on the Commit icon`,
		10000,
		`[...document.querySelectorAll('.activitybar .action-item')].map((i) => (i.querySelector('.action-label')?.getAttribute('aria-label') ?? '?') + '=' + (i.querySelector('.badge-content')?.textContent ?? ''))`,
	);
	const headers = await wb.eval<string[]>(`[...document.querySelectorAll('.pane-header')].map((h) => h.textContent.trim())`);
	assert.ok(headers.some((h) => /^Shelf.*\d+ changelists?/.test(h)), headers.join(' | '));
	assert.ok(headers.some((h) => /^Stash.*\d+ stash(es)?/.test(h)), headers.join(' | '));

	s.changelists.remove(second.id);
	await r.restore(['a.txt', 'b.txt']);
});

export async function run(): Promise<void> {
	try {
		const [width, height] = (process.env['CHANGELINE_E2E_WINDOW'] ?? '1280x800').split('x').map(Number);
		await setWindowSize(width, height);
		await runAll();
	} finally {
		closeCdp();
	}
}
