import * as vscode from 'vscode';
import type { Repository } from './git/repository';

const MAX_DIFF = 60000;

/** Whether a language model (for example GitHub Copilot) is available for generating commit messages. */
export async function canGenerateMessage(): Promise<boolean> {
	try {
		return (await vscode.lm.selectChatModels()).length > 0;
	} catch {
		return false;
	}
}

/** The changes a commit message describes: the diff against HEAD of the given files, or of the index in staging area mode. */
export async function commitDiff(repo: Repository, paths: string[] | undefined): Promise<string> {
	const args = paths ? ['diff', 'HEAD', '--no-color', '--', ...paths] : ['diff', '--cached', '--no-color'];
	const out = repo.state.head ? (await repo.run(args).catch(() => ({ stdout: '' }))).stdout : '';
	const untracked = (paths ?? []).filter((p) => repo.state.untracked.some((u) => u.path === p));
	const added = await Promise.all(untracked.map(async (p) => `New file ${p}:\n${(await repo.readWorkingFile(p))?.toString('utf8').slice(0, 4000) ?? ''}`));
	return [out, ...added].join('\n').slice(0, MAX_DIFF);
}

/** The language model used for commit messages, for example the one of GitHub Copilot. */
export async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
	try {
		return (await vscode.lm.selectChatModels())[0];
	} catch {
		return undefined;
	}
}

/** The prompt that asks for a commit message in the style of the repository. */
export function commitPrompt(diff: string, recent: string[]): string {
	return [
		'Write a git commit message for the changes below. Follow the style of the recent commit messages of this repository (language, tense, length, prefixes). Reply with the commit message only, without code fences or explanations.',
		recent.length ? `Recent commit messages:\n${recent.map((m) => `- ${m}`).join('\n')}` : '',
		`Changes:\n${diff}`,
	]
		.filter(Boolean)
		.join('\n\n');
}

/** JetBrains AI Assistant's "Generate Commit Message" through VS Code's language model API; reports the text while it arrives. */
export async function generateCommitMessage(model: Pick<vscode.LanguageModelChat, 'sendRequest'>, diff: string, recent: string[], onText: (text: string) => void, token?: vscode.CancellationToken): Promise<string> {
	const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(commitPrompt(diff, recent))], {}, token);
	let text = '';
	for await (const part of response.text) {
		text += part;
		onText(text.replace(/^```\w*\n?|```$/g, ''));
	}
	return text.replace(/^```\w*\n?|```$/g, '').trim();
}
