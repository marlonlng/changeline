import { AsyncLocalStorage } from 'async_hooks';
import type * as vscode from 'vscode';
import type { DialogResult, DialogSpec, DialogValues } from '../shared/types';
import type { RpcHandlers } from './host';

export type ValidationErrors = Partial<Record<string, string>>;
export type DialogValidator = (values: DialogValues, button: string) => ValidationErrors | undefined | Promise<ValidationErrors | undefined>;

export interface DialogSurface {
	visible(): boolean;
	reveal(): void;
}

export const UNAVAILABLE = Symbol('overlay unavailable');
const SHOW_TIMEOUT_MS = 3000;

const origin = new AsyncLocalStorage<DialogOverlay>();
let counter = 0;

/** Runs `fn` so that the dialogs it opens appear as an overlay in the given webview. */
export function withDialogOrigin<T>(overlay: DialogOverlay | undefined, fn: () => T): T {
	return overlay ? origin.run(overlay, fn) : fn();
}

/** The overlay of the webview the current command was started from. */
export function dialogOrigin(): DialogOverlay | undefined {
	return origin.getStore();
}

export function cleanErrors(errors: ValidationErrors | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(errors ?? {})) {
		if (v) {
			out[k] = v;
		}
	}
	return out;
}

interface OpenDialog {
	id: number;
	validate?: DialogValidator;
	timer: ReturnType<typeof setTimeout>;
	finish(result: DialogResult | undefined | typeof UNAVAILABLE): void;
}

export class DialogOverlay implements vscode.Disposable {
	private current?: OpenDialog;
	private ready = false;

	constructor(private readonly emit: (name: string, data: unknown) => void, private readonly surface: DialogSurface) {}

	/** Shows the dialog as a modal overlay; UNAVAILABLE when the webview is hidden, still loading, busy or too small for it. */
	show(spec: DialogSpec, validate?: DialogValidator): Promise<DialogResult | undefined | typeof UNAVAILABLE> {
		if (this.current || !this.ready || !this.surface.visible()) {
			return Promise.resolve(UNAVAILABLE);
		}
		const id = ++counter;
		return new Promise((resolve) => {
			const finish = (result: DialogResult | undefined | typeof UNAVAILABLE) => {
				if (this.current?.id !== id) {
					return;
				}
				clearTimeout(this.current.timer);
				this.current = undefined;
				this.emit('dialog.close', { id });
				resolve(result);
			};
			this.current = { id, validate, finish, timer: setTimeout(() => finish(UNAVAILABLE), SHOW_TIMEOUT_MS) };
			this.surface.reveal();
			this.emit('dialog.open', { id, spec });
		});
	}

	handlers(): RpcHandlers {
		return {
			'dialog.ready': () => {
				this.ready = true;
			},
			'dialog.shown': (p: { id: number; fits: boolean }) => {
				const c = this.current;
				if (c?.id === p.id) {
					clearTimeout(c.timer);
					if (!p.fits) {
						c.finish(UNAVAILABLE);
					}
				}
			},
			'dialog.validate': async (p: { id: number; values: DialogValues; button: string }) => {
				const c = this.current;
				return c?.id === p.id && c.validate ? cleanErrors(await c.validate(p.values, p.button)) : {};
			},
			'dialog.submit': async (p: { id: number; values: DialogValues; button: string }) => {
				const c = this.current;
				if (c?.id !== p.id) {
					return { ok: true };
				}
				if (c.validate && p.button !== 'cancel') {
					const errors = cleanErrors(await c.validate(p.values, p.button));
					if (Object.keys(errors).length) {
						return { errors };
					}
				}
				c.finish(p.button === 'cancel' ? undefined : { button: p.button, values: p.values });
				return { ok: true };
			},
		};
	}

	/** Forgets the loaded webview, e.g. before its HTML is set again. */
	reset(): void {
		this.ready = false;
		this.current?.finish(undefined);
	}

	dispose(): void {
		this.reset();
	}
}
