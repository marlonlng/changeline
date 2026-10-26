import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

const noThrottling = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];

const SUITES = process.env['CHANGELINE_E2E_SUITE'] ? [process.env['CHANGELINE_E2E_SUITE']] : ['suite.js', 'ui.js', 'locale.js'];

const suiteArgs: Record<string, string[]> = { 'locale.js': ['--locale=de'] };

/** Registers an empty German language pack in the user data folder, so VS Code resolves the display language "de" without downloading one; core texts stay English. */
function stubLanguagePack(userData: string): void {
	const translations = path.join(userData, 'stub-language-pack-de.json');
	fs.writeFileSync(translations, JSON.stringify({ contents: {} }));
	fs.writeFileSync(path.join(userData, 'languagepacks.json'), JSON.stringify({ de: { hash: 'changeline-e2e', label: 'Deutsch', translations: { vscode: translations } } }));
}

async function runSuite(suite: string): Promise<void> {
	const root = path.resolve(__dirname, '../../..');
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'changeline-e2e-'));
	const gitConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jggc-')), 'gitconfig');
	fs.writeFileSync(gitConfig, '[user]\n\tname = E2E Tester\n\temail = e2e@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
	const gitEnv = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
	const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: workspace, stdio: 'pipe', env: { ...process.env, ...gitEnv } });
	git('init', '-q', '-b', 'main');
	fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
	fs.writeFileSync(path.join(workspace, 'b.txt'), 'bee\n');
	git('add', '.');
	git('commit', '-qm', 'initial commit');
	git('checkout', '-qb', 'feature');
	fs.writeFileSync(path.join(workspace, 'b.txt'), 'bee feature\n');
	git('commit', '-qam', 'feature change');
	git('checkout', '-q', 'main');
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jgud-'));
	if (suite === 'locale.js') {
		stubLanguagePack(userData);
	}
	const cdpPort = await freePort();
	console.log(`\n${suite}`);
	try {
		await runTests({
			extensionDevelopmentPath: root,
			extensionTestsPath: path.join(__dirname, suite),
			launchArgs: [workspace, `--user-data-dir=${userData}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${cdpPort}`, ...noThrottling, ...(suiteArgs[suite] ?? [])],
			extensionTestsEnv: { CHANGELINE_E2E_WORKSPACE: workspace, CHANGELINE_CDP_PORT: String(cdpPort), ...gitEnv },
		});
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(userData, { recursive: true, force: true });
		fs.rmSync(path.dirname(gitConfig), { recursive: true, force: true });
	}
}

async function main() {
	let failed = 0;
	for (const suite of SUITES) {
		try {
			await runSuite(suite);
		} catch {
			failed++;
		}
	}
	if (failed) {
		console.error(`${failed} of ${SUITES.length} e2e suites failed`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
