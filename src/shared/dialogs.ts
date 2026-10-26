import type { DialogField, DialogSpec } from './types';

export const OVERLAY_MIN_WIDTH = 280;
export const OVERLAY_MIN_SCROLL_HEIGHT = 240;
export const OVERLAY_PADDING = 8;

/** The field of a dialog that consists of nothing but one text, select or radio field, so it can be asked with a quick input. */
export function quickInputField(spec: DialogSpec): DialogField | undefined {
	const [field, ...rest] = spec.fields;
	if (!field || rest.length || spec.extraButtons?.length) {
		return undefined;
	}
	return field.type === 'text' || field.type === 'select' || field.type === 'radio' ? field : undefined;
}

/** Whether a dialog overlay can be shown in a webview of this size: the dialog fits, or the webview is tall enough to scroll it. */
export function overlayFits(viewport: { width: number; height: number }, dialogHeight: number): boolean {
	if (viewport.width < OVERLAY_MIN_WIDTH) {
		return false;
	}
	return dialogHeight + 2 * OVERLAY_PADDING <= viewport.height || viewport.height >= OVERLAY_MIN_SCROLL_HEIGHT;
}
