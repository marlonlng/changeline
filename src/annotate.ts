import * as vscode from 'vscode';
import { fromGitUri, toGitUri } from './content';
import { commitFileTarget, openDiff } from './diff';
import { BlameCommit, BlameLine, UNCOMMITTED_HASH } from './git/parsers';
import type { Repository } from './git/repository';
import { services } from './services';
import { config, formatDate, shortHash, showError } from './util';
import type { CommandContext } from './commands/common';

interface Annotation {
	repo: Repository;
	path: string;
	revision?: string;
	lines: BlameLine[];
	commits: Map<string, BlameCommit>;
}

const ENABLED_COMMANDS = ['changeline.showLog', 'changeline.annotate.showDiff', 'changeline.copyText', 'changeline.annotate.previous', 'changeline.annotate.close'];

export class BlameController implements vscode.Disposable {
	private annotations = new Map<string, Annotation>();
	private decoration: vscode.TextEditorDecorationType;
	private disposables: vscode.Disposable[] = [];
	private timers = new Map<string, NodeJS.Timeout>();

	constructor() {
		this.decoration = vscode.window.createTextEditorDecorationType({ rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
		this.disposables.push(
			this.decoration,
			vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.render(e))),
			vscode.window.onDidChangeActiveTextEditor((e) => this.updateContext(e)),
			vscode.workspace.onDidChangeTextDocument((e) => this.scheduleUpdate(e.document)),
			vscode.workspace.onDidCloseTextDocument((d) => this.annotations.delete(d.uri.toString())),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('changeline.annotate')) {
					vscode.window.visibleTextEditors.forEach((ed) => this.render(ed));
				}
			}),
		);
	}

	private updateContext(editor = vscode.window.activeTextEditor): void {
		void vscode.commands.executeCommand('setContext', 'changeline.annotateActive', !!editor && this.annotations.has(editor.document.uri.toString()));
	}

	isActive(uri: vscode.Uri): boolean {
		return this.annotations.has(uri.toString());
	}

	async toggle(editor: vscode.TextEditor): Promise<void> {
		const key = editor.document.uri.toString();
		if (this.annotations.has(key)) {
			this.close(editor.document.uri);
			return;
		}
		await this.annotate(editor);
	}

	close(uri: vscode.Uri): void {
		this.annotations.delete(uri.toString());
		for (const e of vscode.window.visibleTextEditors) {
			if (e.document.uri.toString() === uri.toString()) {
				e.setDecorations(this.decoration, []);
			}
		}
		this.updateContext();
	}

	private async annotate(editor: vscode.TextEditor): Promise<void> {
		const doc = editor.document;
		let repo: Repository | undefined;
		let path: string;
		let revision: string | undefined;
		const git = fromGitUri(doc.uri);
		if (git) {
			repo = services().repos.getByRoot(git.repo);
			path = git.path;
			revision = git.ref && !git.ref.startsWith(':') ? git.ref : undefined;
		} else {
			repo = services().repos.getRepository(doc.uri);
			path = repo ? repo.relativePath(doc.uri.fsPath) : '';
		}
		if (!repo || !path) {
			void vscode.window.showWarningMessage(vscode.l10n.t('The file is not under Git version control.'));
			return;
		}
		if (!git && repo.state.untracked.some((u) => u.path === path)) {
			void vscode.window.showWarningMessage(vscode.l10n.t('The file is not committed yet; there is nothing to annotate.'));
			return;
		}
		try {
			const blame = await repo.blame(path, {
				contents: !revision && doc.uri.scheme === 'file' ? doc.getText() : undefined,
				revision,
				ignoreWhitespace: config('annotate.ignoreWhitespace', false),
			});
			this.annotations.set(doc.uri.toString(), { repo, path, revision, lines: blame.lines, commits: blame.commits });
			for (const e of vscode.window.visibleTextEditors) {
				if (e.document === doc) {
					this.render(e);
				}
			}
			this.updateContext(editor);
		} catch (e) {
			await showError(e, vscode.l10n.t('Annotate failed'));
		}
	}

	private scheduleUpdate(doc: vscode.TextDocument): void {
		const key = doc.uri.toString();
		const a = this.annotations.get(key);
		if (!a || a.revision) {
			return;
		}
		const t = this.timers.get(key);
		if (t) {
			clearTimeout(t);
		}
		this.timers.set(key, setTimeout(async () => {
			this.timers.delete(key);
			try {
				const blame = await a.repo.blame(a.path, { contents: doc.getText(), ignoreWhitespace: config('annotate.ignoreWhitespace', false) });
				this.annotations.set(key, { ...a, lines: blame.lines, commits: blame.commits });
				vscode.window.visibleTextEditors.filter((e) => e.document === doc).forEach((e) => this.render(e));
			} catch {
			}
		}, 600));
	}

	private render(editor: vscode.TextEditor): void {
		const a = this.annotations.get(editor.document.uri.toString());
		if (!a) {
			return;
		}
		const showAuthor = config('annotate.showAuthor', true);
		const showDate = config('annotate.showDate', true);
		const showHash = config('annotate.showCommitHash', false);
		const colorMode = config<'age' | 'author' | 'none'>('annotate.colors', 'age');
		const dark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light && vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.HighContrastLight;
		const times = [...a.commits.values()].filter((c) => c.hash !== UNCOMMITTED_HASH).map((c) => c.authorTime).sort((x, y) => x - y);
		const oldest = times[0] ?? 0;
		const newest = times[times.length - 1] ?? 1;
		const authors = [...new Set([...a.commits.values()].map((c) => c.author))];
		const texts = new Map<string, string>();
		let width = 0;
		for (const c of a.commits.values()) {
			const parts: string[] = [];
			if (c.hash === UNCOMMITTED_HASH) {
				parts.push(vscode.l10n.t('Not Committed Yet'));
			} else {
				if (showHash) {
					parts.push(c.hash.slice(0, 8));
				}
				if (showDate) {
					parts.push(formatDate(c.authorTime).slice(0, 10));
				}
				if (showAuthor) {
					parts.push(formatName(c.author, c.authorMail));
				}
			}
			const t = parts.join(' ');
			texts.set(c.hash, t);
			width = Math.max(width, t.length);
		}
		width = Math.min(width, 40);
		const decorations: vscode.DecorationOptions[] = [];
		let previous: string | undefined;
		const fg = new vscode.ThemeColor('editorLineNumber.foreground');
		for (const line of a.lines) {
			const idx = line.line - 1;
			if (idx >= editor.document.lineCount) {
				continue;
			}
			const commit = a.commits.get(line.hash)!;
			const first = line.hash !== previous;
			previous = line.hash;
			let bg: string | undefined;
			if (colorMode === 'age' && commit.hash !== UNCOMMITTED_HASH) {
				const ratio = newest === oldest ? 1 : (commit.authorTime - oldest) / (newest - oldest);
				bg = dark ? `rgba(104, 151, 187, ${(0.06 + ratio * 0.3).toFixed(3)})` : `rgba(70, 120, 200, ${(0.05 + ratio * 0.22).toFixed(3)})`;
			} else if (colorMode === 'author') {
				const hue = (authors.indexOf(commit.author) * 67) % 360;
				bg = `hsla(${hue}, 55%, ${dark ? 40 : 70}%, 0.28)`;
			}
			const text = first ? pad(texts.get(line.hash) ?? '', width) : pad('', width);
			decorations.push({
				range: new vscode.Range(idx, 0, idx, 0),
				hoverMessage: this.hover(a, commit),
				renderOptions: {
					before: {
						contentText: text.replace(/ /g, ' '),
						width: `${width + 2}ch`,
						color: commit.hash === UNCOMMITTED_HASH ? new vscode.ThemeColor('changeline.modifiedForeground') : fg,
						backgroundColor: bg,
						margin: '0 12px 0 0',
						fontStyle: 'normal',
						fontWeight: 'normal',
						textDecoration: 'none; font-family: var(--vscode-editor-font-family); padding-left: 4px; box-sizing: content-box',
					},
				},
			});
		}
		editor.setDecorations(this.decoration, decorations);
	}

	private hover(a: Annotation, c: BlameCommit): vscode.MarkdownString {
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = { enabledCommands: ENABLED_COMMANDS };
		md.supportHtml = false;
		if (c.hash === UNCOMMITTED_HASH) {
			md.appendMarkdown(vscode.l10n.t('**Not Committed Yet**  \nLocal change'));
			return md;
		}
		const args = (x: unknown) => encodeURIComponent(JSON.stringify(x));
		md.appendMarkdown(`$(git-commit) \`${shortHash(c.hash)}\` **${escapeMd(c.author)}** ${c.authorMail ? `<${escapeMd(c.authorMail)}>` : ''}  \n`);
		md.appendMarkdown(`${new Date(c.authorTime * 1000).toLocaleString()}\n\n`);
		md.appendMarkdown(`${escapeMd(c.summary)}\n\n---\n\n`);
		md.appendMarkdown(
			[
				`[$(history) Show in Git Log](command:changeline.showLog?${args([{ repo: a.repo.root, hash: c.hash }])})`,
				`[$(diff) Show Diff](command:changeline.annotate.showDiff?${args([{ repo: a.repo.root, hash: c.hash, path: c.filename }])})`,
				`[$(copy) Copy Revision](command:changeline.copyText?${args([c.hash])})`,
				c.previous ? `[$(arrow-left) Annotate Previous Revision](command:changeline.annotate.previous?${args([{ repo: a.repo.root, hash: c.previous.hash, path: c.previous.filename }])})` : '',
				`[$(close) Close Annotations](command:changeline.annotate.close)`,
			].filter(Boolean).join(' · '),
		);
		return md;
	}

	dispose(): void {
		for (const t of this.timers.values()) {
			clearTimeout(t);
		}
		this.disposables.forEach((d) => d.dispose());
	}
}

/** JetBrains "Names" option of the annotation gutter. */
function formatName(author: string, mail: string): string {
	const parts = author.trim().split(/\s+/);
	switch (config<string>('annotate.nameFormat', 'full')) {
		case 'first':
			return parts[0];
		case 'last':
			return parts[parts.length - 1];
		case 'initials':
			return parts.map((p) => p[0]?.toUpperCase() ?? '').join('');
		case 'email':
			return mail || author;
		default:
			return author.length > 24 ? parts[0] : author;
	}
}

function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function escapeMd(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export function registerAnnotateCommands(ctx: CommandContext, blame: BlameController): void {
	ctx.register('changeline.annotate', async (uri?: vscode.Uri) => {
		let editor = vscode.window.activeTextEditor;
		if (uri && (!editor || editor.document.uri.toString() !== uri.toString())) {
			editor = await vscode.window.showTextDocument(uri);
		}
		if (editor) {
			await blame.toggle(editor);
		}
	});
	ctx.register('changeline.annotate.close', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			blame.close(editor.document.uri);
		}
	});
	ctx.register('changeline.annotate.showDiff', async (arg: { repo: string; hash: string; path: string }) => {
		const repo = services().repos.getByRoot(arg.repo);
		if (!repo) {
			return;
		}
		const c = await repo.getCommit(arg.hash);
		const files = await repo.getCommitFiles(c.hash, c.parents);
		const index = Math.max(0, files.findIndex((f) => f.path === arg.path));
		await openDiff({ targets: files.map((f) => commitFileTarget(repo, c, f)), index });
	});
	ctx.register('changeline.annotate.previous', async (arg: { repo: string; hash: string; path: string }) => {
		const repo = services().repos.getByRoot(arg.repo);
		if (!repo) {
			return;
		}
		const editor = await vscode.window.showTextDocument(toGitUri(repo, arg.hash, arg.path), { preview: false });
		if (!blame.isActive(editor.document.uri)) {
			await blame.toggle(editor);
		}
	});
}
