import type { RpcMessage } from '../../src/shared/types';

interface VsCodeApi {
	postMessage(msg: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi: VsCodeApi = acquireVsCodeApi();

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(data: any) => void>>();

window.addEventListener('message', (e: MessageEvent<RpcMessage>) => {
	const msg = e.data;
	if (!msg || typeof msg !== 'object') {
		return;
	}
	if (msg.kind === 'response') {
		const p = pending.get(msg.id);
		if (p) {
			pending.delete(msg.id);
			if (msg.error !== undefined) {
				p.reject(new Error(msg.error));
			} else {
				p.resolve(msg.result);
			}
		}
	} else if (msg.kind === 'event') {
		for (const l of listeners.get(msg.name) ?? []) {
			l(msg.data);
		}
	}
});

export function call<T = unknown>(method: string, params?: unknown): Promise<T> {
	const id = nextId++;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
		vscodeApi.postMessage({ kind: 'request', id, method, params } satisfies RpcMessage);
	});
}

/** Fire and forget call; errors are shown by the host. */
export function send(method: string, params?: unknown): void {
	call(method, params).catch((e) => console.warn(method, e));
}

export function on<T = any>(name: string, cb: (data: T) => void): () => void {
	let set = listeners.get(name);
	if (!set) {
		set = new Set();
		listeners.set(name, set);
	}
	set.add(cb);
	return () => set!.delete(cb);
}

export const initial: any = (window as any).__CHANGELINE_INITIAL__;

export function getState<T>(): Partial<T> {
	return (vscodeApi.getState() as Partial<T>) ?? {};
}

export function patchState<T>(patch: Partial<T>): void {
	vscodeApi.setState({ ...(getState<T>() as object), ...patch });
}
