export interface TargetInfo {
	targetId: string;
	type: string;
	url: string;
	title: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class CdpTimeoutError extends Error {}

const ANSWER_TIMEOUT_MS = 15000;

export class Cdp {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners: ((method: string, params: any, sessionId?: string) => void)[] = [];

	private constructor(private readonly ws: WebSocket) {
		ws.onmessage = (e: MessageEvent) => {
			const msg = JSON.parse(String(e.data));
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) {
					p?.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
				} else {
					p?.resolve(msg.result);
				}
			} else {
				for (const l of this.listeners) {
					l(msg.method, msg.params, msg.sessionId);
				}
			}
		};
	}

	/** Connects to the browser endpoint of the VS Code window. */
	static async connect(port: number): Promise<Cdp> {
		const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
		const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
		const ws = new WS(version.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('CDP connection failed'));
		});
		return new Cdp(ws);
	}

	/** Sends a command; rejects with CdpTimeoutError when the browser does not answer in time, so a hung frame cannot block a test. */
	send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpTimeoutError(`CDP ${method} got no answer within ${ANSWER_TIMEOUT_MS} ms`));
			}, ANSWER_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
		});
	}

	on(listener: (method: string, params: any, sessionId?: string) => void): void {
		this.listeners.push(listener);
	}

	close(): void {
		this.ws.close();
	}
}
