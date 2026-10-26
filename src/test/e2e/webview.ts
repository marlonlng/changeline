import { Cdp } from './cdp';
import { waitFor } from './harness';

export class Webview {
	constructor(
		private readonly cdp: Cdp,
		public target: { sessionId: string; contextId: number },
		readonly title: string,
		private readonly matcher: string | RegExp,
	) {}

	/** Evaluates an expression in the webview (promises are awaited). */
	async eval<T = unknown>(expression: string): Promise<T> {
		const params = { expression, awaitPromise: true, returnByValue: true };
		const started = Date.now();
		if (![...sessions.values()].some((s) => s.sessionId === this.target.sessionId && s.contexts.has(this.target.contextId))) {
			const old = this.target;
			this.target = await find(this.matcher, 10000);
			debug(`refound ${this.title}: ${JSON.stringify(old)} -> ${JSON.stringify(this.target)}`);
		}
		const r = await this.cdp.send('Runtime.evaluate', { ...params, contextId: this.target.contextId }, this.target.sessionId);
		if (Date.now() - started > 1000) {
			debug(`slow eval ${Date.now() - started} ms: ${expression.slice(0, 80)}`);
		}
		if (r.exceptionDetails) {
			throw new Error(`${this.title}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
		}
		return r.result.value as T;
	}

	async waitFor(expression: string, what: string, timeout = 10000, explain?: string): Promise<unknown> {
		let last: unknown;
		try {
			return await waitFor(
				() =>
					this.eval(expression).then(
						(v) => ((last = v), v),
						(e: Error) => ((last = e.message), false),
					),
				`${what} (${this.title})`,
				timeout,
			);
		} catch (e) {
			const state = explain ? await this.eval(explain).catch((x: Error) => x.message) : undefined;
			throw new Error(`${(e as Error).message}; last result: ${JSON.stringify(last)}${state !== undefined ? `; state: ${JSON.stringify(state)}` : ''}; using context ${this.target.contextId}; frames: ${await describeFrames()}`);
		}
	}

	count(selector: string): Promise<number> {
		return this.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
	}

	text(selector: string): Promise<string> {
		return this.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
	}

	/** Clicks the element (the nth match), failing when it does not exist. */
	async click(selector: string, nth = 0): Promise<void> {
		const ok = await this.eval<boolean>(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
		if (!ok) {
			throw new Error(`${this.title}: no element ${selector} [${nth}]`);
		}
	}

	/** Chooses an option of a <select> like the user does. */
	async select(selector: string, value: string): Promise<void> {
		const ok = await this.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
		if (!ok) {
			throw new Error(`${this.title}: no select ${selector}`);
		}
	}

	/** Types into an input or textarea (sets the value and fires input events). */
	async type(selector: string, value: string): Promise<void> {
		const ok = await this.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
		if (!ok) {
			throw new Error(`${this.title}: no input ${selector}`);
		}
	}

	/** Clicks the first element matching the selector whose text contains `text`. */
	async clickText(selector: string, text: string): Promise<void> {
		const ok = await this.eval<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
		if (!ok) {
			throw new Error(`${this.title}: no ${selector} with text "${text}"`);
		}
	}

	key(key: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {}, target = 'window'): Promise<unknown> {
		const init = JSON.stringify({ key, shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, bubbles: true, cancelable: true });
		return this.eval(`(${target === 'window' ? 'window' : `document.querySelector(${JSON.stringify(target)})`}).dispatchEvent(new KeyboardEvent('keydown', ${init}))`);
	}
}

const port = Number(process.env['CHANGELINE_CDP_PORT']);
const debug = (m: string) => process.env['CHANGELINE_E2E_DEBUG'] && console.log(`    [cdp] ${m}`);
let cdp: Cdp | undefined;
const sessions = new Map<string, { sessionId: string; contexts: Map<number, number> }>();
let seq = 0;

async function connection(): Promise<Cdp> {
	if (!cdp) {
		if (!port) {
			throw new Error('CHANGELINE_CDP_PORT is not set');
		}
		cdp = await Cdp.connect(port);
		cdp.on((method, params, sessionId) => {
			const s = [...sessions.values()].find((x) => x.sessionId === sessionId);
			if (!s) {
				return;
			}
			if (method.startsWith('Runtime.executionContext')) {
				debug(`${method} ${JSON.stringify(params.context?.id ?? params.executionContextId ?? '')} ${params.context?.origin?.slice(0, 40) ?? ''} session ${sessionId?.slice(0, 6)}`);
			}
			if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) {
				s.contexts.set(params.context.id, ++seq);
			} else if (method === 'Runtime.executionContextDestroyed') {
				s.contexts.delete(params.executionContextId);
			} else if (method === 'Runtime.executionContextsCleared') {
				s.contexts.clear();
			}
		});
	}
	return cdp;
}

/** Finds the webview whose document title matches (waits until it is rendered). */
export async function webview(title: string | RegExp, timeout = 15000): Promise<Webview> {
	const t = await find(title, timeout);
	return new Webview(await connection(), t, t.title, title);
}

async function find(title: string | RegExp, timeout: number): Promise<{ sessionId: string; contextId: number; title: string }> {
	const c = await connection();
	const matches = (t: string) => (typeof title === 'string' ? t === title : title.test(t));
	return waitFor(
		async () => {
			const { targetInfos } = await c.send('Target.getTargets');
			for (const t of targetInfos.filter((x: { type: string; url: string }) => x.type === 'iframe' && x.url.startsWith('vscode-webview:'))) {
				if (!sessions.has(t.targetId)) {
					const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
					sessions.set(t.targetId, { sessionId, contexts: new Map() });
					await c.send('Runtime.enable', {}, sessionId);
				}
			}
			let best: { sessionId: string; contextId: number; title: string; seq: number } | undefined;
			for (const [targetId, s] of sessions) {
				if (!targetInfos.some((x: { targetId: string }) => x.targetId === targetId)) {
					sessions.delete(targetId);
					continue;
				}
				for (const [contextId, created] of s.contexts) {
					const r = await c.send('Runtime.evaluate', { expression: '[document.title, (document.getElementById("app")?.childElementCount ?? 0) > 0]', contextId, returnByValue: true }, s.sessionId).catch(() => undefined);
					const [t, rendered] = (r?.result?.value as [string, boolean] | undefined) ?? [];
					if (typeof t === 'string' && matches(t) && rendered && (!best || created > best.seq)) {
						best = { sessionId: s.sessionId, contextId, title: t, seq: created };
					}
				}
			}
			return best;
		},
		`webview "${title}"`,
		timeout,
	);
}

/** All webview frames with their title and size, for failure messages. */
export async function describeFrames(): Promise<string> {
	const c = await connection();
	const out: string[] = [];
	for (const s of sessions.values()) {
		for (const contextId of s.contexts.keys()) {
			const r = await c.send('Runtime.evaluate', { expression: '[document.title, document.body?.innerHTML.length ?? 0, document.getElementById("app")?.textContent?.slice(0, 60)]', contextId, returnByValue: true }, s.sessionId).catch(() => undefined);
			out.push(`${contextId}:${JSON.stringify(r?.result?.value)}`);
		}
	}
	return out.join(' ');
}

/** The workbench window itself (quick picks, trees, status bar). */
export async function workbench(): Promise<Webview> {
	const c = await connection();
	const { targetInfos } = await c.send('Target.getTargets');
	const page = targetInfos.find((t: { type: string; url: string }) => t.type === 'page' && t.url.includes('workbench'));
	if (!page) {
		throw new Error('workbench page not found');
	}
	if (!sessions.has(page.targetId)) {
		const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
		sessions.set(page.targetId, { sessionId, contexts: new Map() });
		await c.send('Runtime.enable', {}, sessionId);
	}
	const s = sessions.get(page.targetId)!;
	const contextId = await waitFor(async () => {
		for (const id of s.contexts.keys()) {
			const r = await c.send('Runtime.evaluate', { expression: '!!document.querySelector(".monaco-workbench")', contextId: id, returnByValue: true }, s.sessionId).catch(() => undefined);
			if (r?.result?.value) {
				return id;
			}
		}
		return undefined;
	}, 'workbench context');
	return new Webview(c, { sessionId: s.sessionId, contextId }, 'workbench', /workbench/);
}

/** Lays the workbench out for a fixed viewport size, so layout-dependent tests see the same space on every machine. */
export async function setWindowSize(width: number, height: number): Promise<void> {
	const wb = await workbench();
	const c = await connection();
	await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false }, wb.target.sessionId);
	await wb.waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`, 'workbench resized');
	await new Promise((r) => setTimeout(r, 500));
}

export function closeCdp(): void {
	cdp?.close();
	cdp = undefined;
	sessions.clear();
}
