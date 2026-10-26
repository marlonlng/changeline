import * as vscode from 'vscode';
import type { DialogField, DialogResult, DialogSpec } from '../shared/types';
import { cleanErrors, DialogValidator } from './dialogOverlay';

/** Asks a single-field dialog with VS Code's quick input: an input box for text, a quick pick for a choice. */
export async function showQuickInputDialog(spec: DialogSpec, field: DialogField, validate?: DialogValidator): Promise<DialogResult | undefined> {
	const value = field.type === 'text' ? await askText(spec, field, validate) : await pickOption(spec, field, validate);
	return value === undefined ? undefined : { button: 'ok', values: { [field.id]: value } };
}

async function fieldError(field: DialogField, value: string, validate?: DialogValidator): Promise<string | undefined> {
	if (field.required && !value) {
		return vscode.l10n.t('{0} is required', (field.label ?? vscode.l10n.t('Value')).replace(/:$/, ''));
	}
	if (field.pattern && value && !new RegExp(field.pattern).test(value)) {
		return field.patternMessage ?? vscode.l10n.t('Invalid value');
	}
	const errors = cleanErrors(validate ? await validate({ [field.id]: value }, 'ok') : undefined);
	return errors[field.id] ?? Object.values(errors)[0];
}

function askText(spec: DialogSpec, field: DialogField, validate?: DialogValidator): Thenable<string | undefined> {
	const prompt = [spec.description, field.label?.replace(/:$/, ''), field.description].filter(Boolean).join(' · ');
	return vscode.window.showInputBox({
		title: spec.title,
		prompt: prompt || undefined,
		value: typeof field.value === 'string' ? field.value : '',
		placeHolder: field.placeholder,
		validateInput: (v) => fieldError(field, v, validate),
	});
}

function pickOption(spec: DialogSpec, field: DialogField, validate?: DialogValidator): Promise<string | undefined> {
	const items = (field.options ?? []).map((o) => ({ label: o.label, detail: o.description, value: o.value }));
	const qp = vscode.window.createQuickPick<(typeof items)[number]>();
	qp.title = spec.title;
	qp.placeholder = spec.description ?? field.label?.replace(/:$/, '');
	qp.items = items;
	const current = items.find((i) => i.value === field.value);
	if (current) {
		qp.activeItems = [current];
	}
	return new Promise((resolve) => {
		let accepted = false;
		qp.onDidAccept(async () => {
			const item = qp.selectedItems[0] ?? qp.activeItems[0];
			if (!item) {
				return;
			}
			const error = await fieldError(field, item.value, validate);
			if (error) {
				void vscode.window.showErrorMessage(error);
				return;
			}
			accepted = true;
			resolve(item.value);
			qp.hide();
		});
		qp.onDidHide(() => {
			qp.dispose();
			if (!accepted) {
				resolve(undefined);
			}
		});
		qp.show();
	});
}
