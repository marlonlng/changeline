import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangelineApi } from '../../extension';
import { chunkKey, diffLines, splitLines } from '../../shared/diff';
import { EXTENSION_ID } from './harness';
import { closeCdp, webview } from './webview';

const out = process.env['CHANGELINE_SHOTS_DIR']!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ShotArea {
	selector: string;
	margin?: number;
	maxHeight?: number;
}

/** Captures the VS Code window below the title bar, or only the given element, through the Chrome DevTools Protocol. */
async function shot(name: string, area?: ShotArea): Promise<void> {
	await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
	await sleep(200);
	const targets = (await (await fetch('http://127.0.0.1:9333/json/list')).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
	const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url));
	if (!page) {
		throw new Error('workbench page not found: ' + JSON.stringify(targets.map((t) => t.url)));
	}
	const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
	const ws = new WS(page.webSocketDebuggerUrl);
	const pending = new Map<number, (msg: { result?: any; error?: unknown }) => void>();
	let nextId = 0;
	ws.onmessage = (e: MessageEvent) => {
		const msg = JSON.parse(String(e.data));
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error('CDP connection failed'));
	});
	const send = (method: string, params: unknown) =>
		new Promise<any>((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, (msg) => (msg.result ? resolve(msg.result) : reject(new Error(JSON.stringify(msg.error)))));
			ws.send(JSON.stringify({ id, method, params }));
		});
	const expression = area
		? `(() => { const r = document.querySelector(${JSON.stringify(area.selector)}).getBoundingClientRect(); const m = ${area.margin ?? 0}; const x = Math.max(0, r.left - m); const y = Math.max(0, r.top - m); return { x, y, width: Math.min(innerWidth, r.right + m) - x, height: Math.min(innerHeight, r.bottom + m, y + ${area.maxHeight ?? 100000}) - y }; })()`
		: `(() => { const top = document.querySelector('.part.titlebar')?.getBoundingClientRect().bottom ?? 0; return { x: 0, y: top, width: innerWidth, height: innerHeight - top }; })()`;
	try {
		const clip = (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
		const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
		fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
	} finally {
		ws.close();
	}
	console.log(`  📸 ${name}.png`);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		console.log(`  ✖ ${name}: ${(e as Error).stack ?? e}`);
	}
}

export async function run(): Promise<void> {
	const api = (await vscode.extensions.getExtension(EXTENSION_ID)!.activate()) as ChangelineApi;
	const s = api._test.services();
	const repo = s.repos.repositories[0];
	const view = api._test.changesView;
	await repo.refresh();
	await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
	await vscode.commands.executeCommand('workbench.action.closePanel');
	await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);

	await step('commit tool window', async () => {
		const cl = s.changelists;
		const price = cl.create('Price calculation');
		const cleanup = cl.create('Cleanup');
		await sleep(400);
		const files = view.allFiles();
		const priceFile = files.find((f) => f.change.path.endsWith('PriceCalculator.php'))!;
		cl.move([priceFile.abs], price.id);
		const login = files.find((f) => f.change.path.endsWith('LoginController.php'))!;
		const head = (await repo.getContent('HEAD', login.change.path)).toString();
		const work = fs.readFileSync(login.abs, 'utf8');
		const ol = splitLines(head);
		const nl = splitLines(work);
		const keys = diffLines(ol, nl).map((c) => chunkKey(c, ol, nl));
		if (keys.length > 1) {
			cl.moveChunk(login.abs, keys[keys.length - 1], cleanup.id);
		}
		await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
		await vscode.commands.executeCommand('changeline.changes.focus');
		await sleep(1200);
		await view.expandAll();
		api._test.commit.setMessage('Add rate limiting to the login form\n\nRefuses requests after five failed attempts.');
		await sleep(1500);
		await shot('01-commit-tool-window');
	});

	await step('diff viewer', async () => {
		const login = view.allFiles().find((f) => f.change.path.endsWith('LoginController.php'))!;
		await vscode.commands.executeCommand('changeline.changes.open', login);
		await sleep(2200);
		await shot('02-diff-viewer');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	await step('git log', async () => {
		await vscode.commands.executeCommand('changeline.showLog');
		await sleep(800);
		await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel').then(undefined, () => undefined);
		await sleep(2500);
		const logView = await webview('Log');
		await logView.clickText('.commit-row .subject .text', 'Document rate limiting');
		await sleep(1200);
		await shot('03-git-log', { selector: '.part.panel', maxHeight: 400 });
		const log = api._test.logView.current!;
		void vscode.commands.executeCommand('changeline.log.editMessage', { logId: log.id, hash: repo.state.head });
		await sleep(1500);
		await shot('14-edit-commit-message', { selector: '.part.panel', maxHeight: 520 });
		log.dialogs.dispose();
		await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel').then(undefined, () => undefined);
		await vscode.commands.executeCommand('workbench.action.closePanel');
	});

	await step('branches popup', async () => {
		void vscode.commands.executeCommand('changeline.branches');
		await sleep(1500);
		await shot('04-branches-popup', { selector: '.quick-input-widget', margin: 8 });
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
		await sleep(300);
	});

	await step('vcs operations', async () => {
		void vscode.commands.executeCommand('changeline.vcsOperations');
		await sleep(1200);
		await shot('05-vcs-operations', { selector: '.quick-input-widget', margin: 8 });
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
	});

	await step('annotate', async () => {
		const doc = await vscode.workspace.openTextDocument(path.join(repo.root, 'Classes/Controller/LoginController.php'));
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('changeline.annotate');
		await sleep(1500);
		await shot('06-annotate');
		await vscode.commands.executeCommand('changeline.annotate.close');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	await step('shelf and stash', async () => {
		const notes = repo.state.untracked.find((u) => u.path === 'notes.txt');
		if (notes) {
			await s.shelf.shelve('Notes for later', [{ repo, change: notes }]);
		}
		fs.writeFileSync(path.join(repo.root, 'docs/note0.md'), 'changed for stash\n');
		await repo.refresh();
		await repo.stash({ message: 'WIP experiment', paths: ['docs/note0.md'] });
		await vscode.commands.executeCommand('workbench.view.extension.changeline-commit');
		await vscode.commands.executeCommand('changeline.shelf.focus');
		await vscode.commands.executeCommand('changeline.stash.focus');
		await sleep(1500);
		await shot('07-shelf-and-stash');
	});

	await step('push dialog', async () => {
		await vscode.commands.executeCommand('changeline.push', repo);
		await sleep(2000);
		await shot('08-push-dialog');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	await step('interactive rebase', async () => {
		const base = await repo.revParse('HEAD~3');
		await vscode.commands.executeCommand('changeline.interactiveRebase', { repo: repo.root, base });
		await sleep(2000);
		await shot('09-interactive-rebase');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	await step('pull requests', async () => {
		const mr = (iid: number, title: string, state: string, author: string) => ({
			iid, title, state, author: { username: author }, created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-21T09:00:00Z', web_url: `http://x/${iid}`,
			source_branch: 'feature/rate-limit', target_branch: 'main', sha: 'abc', labels: ['backend'], description: 'Refuses login attempts after **five failures** within ten minutes.\n\n- adds `RateLimiter`\n- adds tests',
			diff_refs: { base_sha: 'b', start_sha: 'b', head_sha: 'abc' }, reviewers: [{ username: 'anna' }], merge_status: 'can_be_merged', head_pipeline: { status: 'success' },
		});
		const server = http.createServer((req, res) => {
			const p = new URL(req.url!, 'http://x').pathname.replace(/^\/api\/v4(\/projects\/[^/]+)?/, '');
			const json = (o: unknown) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(o));
			};
			if (p === '/merge_requests') {
				return json([mr(12, 'Add rate limiting to the login form', 'opened', 'marlon'), mr(11, 'Translate newsletter templates', 'opened', 'lea'), mr(9, 'Fix rounding in PriceCalculator', 'merged', 'jonas')]);
			}
			if (p === '/merge_requests/12') {
				return json(mr(12, 'Add rate limiting to the login form', 'opened', 'marlon'));
			}
			if (p === '/merge_requests/12/commits') {
				return json([{ id: 'abc1234', message: 'Add RateLimiter service', author_name: 'Marlon Lange', created_at: '2026-10-19T09:00:00Z' }]);
			}
			if (p === '/merge_requests/12/changes') {
				return json({ changes: [{ new_path: 'Classes/Service/RateLimiter.php', old_path: 'Classes/Service/RateLimiter.php', new_file: true, diff: '+<?php\n' }] });
			}
			if (p === '/merge_requests/12/notes') {
				return json([{ id: 1, author: { username: 'anna' }, created_at: '2026-10-20T10:00:00Z', body: 'Could the limit be configurable?' }]);
			}
			if (p === '/merge_requests/12/approvals') {
				return json({ approved_by: [{ user: { username: 'anna' } }] });
			}
			if (p === '/merge_requests/12/discussions') {
				return json([]);
			}
			if (p === '/user') {
				return json({ username: 'marlon' });
			}
			res.writeHead(404);
			res.end('{}');
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as { port: number }).port;
		await vscode.workspace.getConfiguration('changeline').update('gitlab.hosts', ['127.0.0.1'], vscode.ConfigurationTarget.Global);
		await s.context.secrets.store('changeline.token.gitlab.127.0.0.1', 'shots');
		await repo.addRemote('upstream', `http://127.0.0.1:${port}/acme/site-package.git`);
		api._test.hosting.forgetHosting();
		await vscode.commands.executeCommand('changeline.pullRequests.focus');
		await sleep(1500);
		await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel').then(undefined, () => undefined);
		api._test.pullRequests.refresh();
		await sleep(2500);
		await shot('10-pull-requests');
		await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel').then(undefined, () => undefined);
		await vscode.commands.executeCommand('workbench.action.closePanel');
		server.close();
	});

	await step('conflicts', async () => {
		await repo.rollback(repo.state.changes, true);
		await repo.refresh();
		await repo.checkout('main', { newBranch: 'conflict-a', force: true });
		fs.writeFileSync(path.join(repo.root, 'Classes/Service/PriceCalculator.php'), '<?php\n\nfinal class PriceCalculator\n{\n    public function gross(float $net): float\n    {\n        return $net * 1.07;\n    }\n}\n');
		await repo.stage(['.']);
		await repo.commit({ message: 'Reduced VAT' });
		await repo.checkout('main', { newBranch: 'conflict-b' });
		fs.writeFileSync(path.join(repo.root, 'Classes/Service/PriceCalculator.php'), "<?php\n\nfinal class PriceCalculator\n{\n    public function gross(float $net, string $country = 'DE'): float\n    {\n        return $net * (1 + self::RATES[$country]);\n    }\n}\n");
		await repo.stage(['.']);
		await repo.commit({ message: 'VAT per country' });
		await repo.merge('conflict-a');
		await repo.refresh();
		await vscode.commands.executeCommand('changeline.resolveConflicts');
		await sleep(1500);
		await shot('11-conflicts-dialog');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const conflict = view.allFiles().find((f) => f.group === 'conflicts');
		void vscode.commands.executeCommand('changeline.changes.open', conflict);
		await sleep(2500);
		await shot('12-merge-window');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await sleep(500);
		await shot('13-merge-state-status-bar');
		await repo.abortOperation();
	});
	closeCdp();
}
