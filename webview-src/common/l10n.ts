import type { ComponentChildren } from 'preact';

interface L10nData {
	language: string;
	bundle: Record<string, string>;
}

const data: L10nData = (window as unknown as { __CHANGELINE_L10N__?: L10nData }).__CHANGELINE_L10N__ ?? { language: 'en', bundle: {} };

export const language = data.language;

/** Translates a message with the bundle VS Code loaded for its display language and fills {0}, {1}, … */
export function t(message: string, ...args: (string | number)[]): string {
	const text = data.bundle[message] ?? message;
	return text.replace(/\{(\d+)\}/g, (match, index) => (args[Number(index)] !== undefined ? String(args[Number(index)]) : match));
}

/** Localized count with a singular and a plural message, e.g. plural(n, '{0} file', '{0} files'). */
export function plural(n: number, one: string, other: string): string {
	return t(n === 1 ? one : other, n);
}

/** Like `t`, but the placeholders take JSX elements, so sentences with markup can change their word order. */
export function tx(message: string, ...args: ComponentChildren[]): ComponentChildren[] {
	const text = data.bundle[message] ?? message;
	return text.split(/(\{\d+\})/).map((part) => {
		const m = /^\{(\d+)\}$/.exec(part);
		return m ? args[Number(m[1])] : part;
	});
}
