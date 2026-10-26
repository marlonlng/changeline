import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { RpcMessage } from '../shared/types';
import { errorMessage } from '../util';

export type RpcHandlers = Record<string, (params: any) => unknown>;

export class RpcChannel implements vscode.Disposable {
	private subscription: vscode.Disposable;

	constructor(private readonly webview: vscode.Webview, private readonly handlers: RpcHandlers) {
		this.subscription = webview.onDidReceiveMessage(async (msg: RpcMessage) => {
			if (!msg || msg.kind !== 'request') {
				return;
			}
			const handler = this.handlers[msg.method];
			try {
				if (!handler) {
					throw new Error(vscode.l10n.t('Unknown method {0}', msg.method));
				}
				const result = await handler(msg.params);
				void this.webview.postMessage({ kind: 'response', id: msg.id, result } satisfies RpcMessage);
			} catch (e) {
				if (!(e instanceof vscode.CancellationError)) {
					console.error(`[changeline] ${msg.method} failed`, e);
				}
				void this.webview.postMessage({ kind: 'response', id: msg.id, error: errorMessage(e) } satisfies RpcMessage);
			}
		});
	}

	emit(name: string, data?: unknown): void {
		void this.webview.postMessage({ kind: 'event', name, data } satisfies RpcMessage);
	}

	/** Runs a request handler as if the webview had sent the request (end-to-end tests). */
	async call(method: string, params?: unknown): Promise<unknown> {
		const handler = this.handlers[method];
		if (!handler) {
			throw new Error(vscode.l10n.t('Unknown method {0}', method));
		}
		return handler(params);
	}

	dispose(): void {
		this.subscription.dispose();
	}
}

export interface HtmlOptions {
	title: string;
	initial?: unknown;
}

export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, entry: string, options: HtmlOptions): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', ...p)).toString();
	const csp = [
		`default-src 'none'`,
		`font-src ${webview.cspSource}`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`img-src ${webview.cspSource} data: https:`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');
	const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
	const initial = json(options.initial ?? null);
	const l10n = json({ language: vscode.env.language, bundle: vscode.l10n.bundle ?? {} });
	return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="${asset('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${asset('webview', `${entry}.css`)}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">window.__CHANGELINE_INITIAL__ = ${initial}; window.__CHANGELINE_L10N__ = ${l10n};</script>
<script nonce="${nonce}" src="${asset('webview', `${entry}.js`)}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
	};
}

export abstract class WebviewPanelBase implements vscode.Disposable {
	readonly panel: vscode.WebviewPanel;
	protected readonly rpc: RpcChannel;
	protected disposables: vscode.Disposable[] = [];
	private disposed = false;
	private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.onDidDisposeEmitter.event;

	constructor(
		protected readonly extensionUri: vscode.Uri,
		viewType: string,
		title: string,
		entry: string,
		initial: unknown,
		column: vscode.ViewColumn = vscode.ViewColumn.Active,
		options: { retainContextWhenHidden?: boolean; preserveFocus?: boolean; iconPath?: vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } } = {},
	) {
		this.panel = vscode.window.createWebviewPanel(viewType, title, { viewColumn: column, preserveFocus: options.preserveFocus }, {
			...webviewOptions(extensionUri),
			retainContextWhenHidden: options.retainContextWhenHidden ?? true,
		});
		if (options.iconPath) {
			this.panel.iconPath = options.iconPath;
		}
		this.rpc = new RpcChannel(this.panel.webview, this.handlers());
		this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, entry, { title, initial });
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	protected abstract handlers(): RpcHandlers;

	/** Sends a request to the panel's handlers as the webview would (end-to-end tests). */
	request(method: string, params?: unknown): Promise<unknown> {
		return this.rpc.call(method, params);
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.rpc.dispose();
		this.disposables.forEach((d) => d.dispose());
		this.panel.dispose();
		this.onDidDisposeEmitter.fire();
		this.onDidDisposeEmitter.dispose();
	}
}
