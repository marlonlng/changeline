import * as vscode from 'vscode';
import { services } from '../services';
import type { DialogResult, DialogSpec, DialogValues } from '../shared/types';
import { RpcHandlers, WebviewPanelBase } from './host';

export type ValidationErrors = Partial<Record<string, string>>;
export type DialogValidator = (values: DialogValues, button: string) => ValidationErrors | undefined | Promise<ValidationErrors | undefined>;

export class DialogPanel extends WebviewPanelBase {
	private resolveResult!: (r: DialogResult | undefined) => void;
	readonly result = new Promise<DialogResult | undefined>((r) => (this.resolveResult = r));
	private settled = false;

	static open(spec: DialogSpec, validate?: DialogValidator): Promise<DialogResult | undefined> {
		const d = new DialogPanel(spec, validate);
		return d.result;
	}

	private constructor(private readonly spec: DialogSpec, private readonly validate?: DialogValidator) {
		super(services().context.extensionUri, 'changeline.dialog', spec.title, 'dialog', spec, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
	}

	protected handlers(): RpcHandlers {
		return {
			validate: async (p: { values: DialogValues; button: string }) => clean(this.validate ? await this.validate(p.values, p.button) : undefined),
			submit: async (p: { values: DialogValues; button: string }) => {
				if (this.validate && p.button !== 'cancel') {
					const errors = clean(await this.validate(p.values, p.button));
					if (Object.keys(errors).length) {
						return { errors };
					}
				}
				this.finish(p.button === 'cancel' ? undefined : { button: p.button, values: p.values });
				return { ok: true };
			},
		};
	}

	private finish(r: DialogResult | undefined): void {
		if (!this.settled) {
			this.settled = true;
			this.resolveResult(r);
		}
		this.dispose();
	}

	override dispose(): void {
		if (!this.settled) {
			this.settled = true;
			this.resolveResult(undefined);
		}
		super.dispose();
	}
}

function clean(errors: ValidationErrors | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(errors ?? {})) {
		if (v) {
			out[k] = v;
		}
	}
	return out;
}

type DialogResponder = (spec: DialogSpec) => DialogResult | undefined;
let responder: DialogResponder | undefined;

/** Test seam: answers dialogs without showing them (used by the end-to-end tests). */
export function setDialogResponder(r: DialogResponder | undefined): void {
	responder = r;
}

export async function showDialog(spec: DialogSpec, validate?: DialogValidator): Promise<DialogResult | undefined> {
	if (responder) {
		const result = responder(spec);
		if (result && validate) {
			const errors = clean(await validate(result.values, result.button));
			if (Object.keys(errors).length) {
				throw new Error(vscode.l10n.t('Dialog "{0}" rejected the answer: {1}', spec.title, JSON.stringify(errors)));
			}
		}
		return result;
	}
	return DialogPanel.open(spec, validate);
}
