import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassCore, classifyPrompt } from './askpassCore';

export class AskpassServer implements vscode.Disposable {
	private core: AskpassCore;
	private usernames = new Map<string, string>();

	constructor(scriptsDir: string, extensionPath: string) {
		this.core = new AskpassCore(scriptsDir, path.join(extensionPath, 'dist', 'askpass-main.js'), process.execPath, (p) => this.prompt(p));
	}

	start(): Promise<void> {
		return this.core.start();
	}

	env(): Promise<NodeJS.ProcessEnv> {
		return this.core.env();
	}

	private async prompt(prompt: string): Promise<string | undefined> {
		const kind = classifyPrompt(prompt || vscode.l10n.t('Git credentials'));
		if (kind.yesNo) {
			const choice = await vscode.window.showWarningMessage(prompt, { modal: true }, vscode.l10n.t('Yes'));
			return choice ? 'yes' : 'no';
		}
		if (!kind.secret && kind.host && this.usernames.has(kind.host)) {
			return this.usernames.get(kind.host);
		}
		const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Git Authentication'), prompt: prompt || vscode.l10n.t('Git credentials'), password: kind.secret, ignoreFocusOut: true });
		if (value !== undefined && !kind.secret && kind.host) {
			this.usernames.set(kind.host, value);
		}
		return value;
	}

	dispose(): void {
		this.core.dispose();
	}
}
