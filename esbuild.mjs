import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
	bundle: true,
	sourcemap: production ? false : 'linked',
	minify: production,
	logLevel: 'info',
	legalComments: 'none',
	metafile: true,
};

const builds = [
	{
		...common,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		external: ['vscode'],
	},
	{
		...common,
		entryPoints: ['src/askpass/askpassMain.ts'],
		outfile: 'dist/askpass-main.js',
		platform: 'node',
		format: 'cjs',
		target: 'node18',
	},
	{
		...common,
		entryPoints: {
			log: 'webview-src/log/main.tsx',
			diff: 'webview-src/diff/main.tsx',
			merge: 'webview-src/merge/main.tsx',
			dialog: 'webview-src/dialog/main.tsx',
			push: 'webview-src/push/main.tsx',
			rebase: 'webview-src/rebase/main.tsx',
			conflicts: 'webview-src/conflicts/main.tsx',
			commitMessage: 'webview-src/commitMessage/main.tsx',
			compare: 'webview-src/compare/main.tsx',
			pullRequests: 'webview-src/pullRequests/main.tsx',
		},
		outdir: 'dist/webview',
		platform: 'browser',
		format: 'iife',
		target: 'es2020',
		jsx: 'automatic',
		jsxImportSource: 'preact',
		loader: { '.css': 'css' },
	},
];

mkdirSync('dist/codicons', { recursive: true });
cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/codicons/codicon.css');
cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/codicons/codicon.ttf');

/**
 * The bundles drop license comments, so the licenses of everything they
 * contain (and of the copied codicon font) go into dist/ThirdPartyNotices.txt.
 */
function writeNotices(results) {
	const packages = new Set(['@vscode/codicons']);
	for (const r of results) {
		for (const input of Object.keys(r.metafile.inputs)) {
			const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
			if (m) {
				packages.add(m[1]);
			}
		}
	}
	const sections = [...packages].sort().map((name) => {
		const dir = `node_modules/${name}`;
		const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
		const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying)/i.test(f)).sort();
		if (!files.length) {
			throw new Error(`No license file found for bundled package ${name}`);
		}
		const texts = files.map((f) => readFileSync(`${dir}/${f}`, 'utf8').trim()).join('\n\n');
		return `${name} ${pkg.version} (${pkg.license})\n${pkg.homepage ?? pkg.repository?.url ?? ''}\n\n${texts}`;
	});
	const header = 'Changeline includes the following third-party software. Their licenses are reproduced below.\n';
	writeFileSync('dist/ThirdPartyNotices.txt', [header, ...sections].join(`\n\n${'='.repeat(78)}\n\n`) + '\n');
}

if (watch) {
	const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
	await Promise.all(contexts.map((c) => c.watch()));
} else {
	writeNotices(await Promise.all(builds.map((b) => esbuild.build(b))));
}
