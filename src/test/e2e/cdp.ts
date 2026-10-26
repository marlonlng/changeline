export interface TargetInfo {
	targetId: string;
	type: string;
	url: string;
	title: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

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

	send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	on(listener: (method: string, params: any, sessionId?: string) => void): void {
		this.listeners.push(listener);
	}

	close(): void {
		this.ws.close();
	}
}
