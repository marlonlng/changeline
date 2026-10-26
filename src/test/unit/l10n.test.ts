import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';

const root = path.resolve(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
		const rel = path.join(dir, e.name);
		if (e.isDirectory()) {
			return rel === path.join('src', 'test') ? [] : sourceFiles(rel);
		}
		return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [rel] : [];
	});
}

interface Messages {
	keys: Map<string, string>;
	dynamic: string[];
}

/** Collects the messages passed to vscode.l10n.t, t, tx and plural in extension and webview code. */
function collectMessages(): Messages {
	const keys = new Map<string, string>();
	const dynamic: string[] = [];
	for (const file of [...sourceFiles('src'), ...sourceFiles('webview-src')]) {
		const text = fs.readFileSync(path.join(root, file), 'utf8');
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		const webview = file.startsWith('webview-src');
		const where = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
		const literals = (n: ts.Expression): string[] | undefined => {
			if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
				return [n.text];
			}
			if (ts.isConditionalExpression(n)) {
				const a = literals(n.whenTrue);
				const b = literals(n.whenFalse);
				return a && b ? [...a, ...b] : undefined;
			}
			if (ts.isParenthesizedExpression(n)) {
				return literals(n.expression);
			}
			return undefined;
		};
		const add = (n: ts.Expression) => {
			const found = literals(n);
			if (found) {
				found.forEach((k) => keys.set(k, where(n)));
			} else {
				dynamic.push(`${where(n)} ${n.getText(sf)}`);
			}
		};
		const visit = (n: ts.Node) => {
			if (ts.isCallExpression(n) && n.arguments.length) {
				const callee = n.expression.getText(sf);
				const isDefinition = (name: string) => {
					const fn = ts.findAncestor(n, ts.isFunctionDeclaration);
					return fn?.name?.text === name;
				};
				if (callee === 'vscode.l10n.t' || callee === 'l10n.t' || (webview && (callee === 't' || callee === 'tx'))) {
					if (!isDefinition('plural')) {
						add(n.arguments[0]);
					}
				} else if (callee === 'plural' && n.arguments.length === 3) {
					add(n.arguments[1]);
					add(n.arguments[2]);
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	return { keys, dynamic };
}

const placeholders = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
const codicon = (s: string) => /^\$\([a-z~-]+\)/.exec(s)?.[0];
const commandLinks = (s: string) => [...s.matchAll(/\(command:[^)]+\)/g)].map((m) => m[0]).sort();
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Record<string, string>;

test('l10n: every UI message is a static string', () => {
	assert.deepEqual(collectMessages().dynamic, []);
});

test('l10n: every UI message has a German translation and the bundle has no stale entries', () => {
	const { keys } = collectMessages();
	const de = readJson('l10n/bundle.l10n.de.json');
	const missing = [...keys].filter(([k]) => !(k in de)).map(([k, at]) => `${at} ${JSON.stringify(k)}`);
	const stale = Object.keys(de).filter((k) => !keys.has(k));
	assert.deepEqual(missing, [], `${missing.length} messages without German translation`);
	assert.deepEqual(stale, [], `${stale.length} translations no longer used`);
});

test('l10n: translations keep placeholders and codicons', () => {
	const de = readJson('l10n/bundle.l10n.de.json');
	for (const [en, translated] of Object.entries(de)) {
		assert.ok(translated.trim(), `empty translation for ${JSON.stringify(en)}`);
		assert.deepEqual(placeholders(translated), placeholders(en), `placeholders of ${JSON.stringify(en)}`);
		assert.equal(codicon(translated), codicon(en), `codicon of ${JSON.stringify(en)}`);
	}
});

test('l10n: the extension package includes the translation files', () => {
	const included = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').filter((l) => l.startsWith('!'));
	for (const entry of ['!package.nls.json', '!package.nls.de.json', '!l10n/*.json']) {
		assert.ok(included.includes(entry), `.vscodeignore keeps ${entry.slice(1)}`);
	}
	assert.equal((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { l10n?: string }).l10n, './l10n');
});

test('l10n: package.json texts are localized in English and German', () => {
	const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	const en = readJson('package.nls.json');
	const de = readJson('package.nls.de.json');
	const referenced = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
	assert.deepEqual(referenced.filter((k) => !(k in en)), [], 'keys used in package.json but missing in package.nls.json');
	assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
	for (const [key, text] of Object.entries(de)) {
		assert.ok(text.trim(), `empty translation for ${key}`);
		assert.deepEqual(commandLinks(text), commandLinks(en[key]), `command links of ${key}`);
	}
});
