import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Opens a VS Code instance with a sample repository and captures screenshots of Changeline's UI. */
async function main() {
	const root = path.resolve(__dirname, '../../..');
	const out = process.argv[2] ?? path.join(root, 'screenshots');
	fs.mkdirSync(out, { recursive: true });
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'changeline-shots-'));
	const ws = path.join(base, 'site-package');
	const remote = path.join(base, 'remote.git');
	fs.mkdirSync(ws);
	fs.mkdirSync(remote);
	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=Marlon Lange', '-c', 'user.email=marlon@example.com', ...args], { cwd, stdio: 'pipe' });
	git(remote, 'init', '-q', '--bare', '-b', 'main');
	git(ws, 'init', '-q', '-b', 'main');
	const write = (rel: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
		fs.writeFileSync(path.join(ws, rel), content);
	};
	write('Classes/Controller/LoginController.php', '<?php\n\nnamespace Vendor\\Site\\Controller;\n\nfinal class LoginController\n{\n    public function loginAction(string $username): void\n    {\n        $user = $this->users->find($username);\n    }\n}\n');
	write('Classes/Service/PriceCalculator.php', '<?php\n\nfinal class PriceCalculator\n{\n    public function gross(float $net): float\n    {\n        return $net * 1.19;\n    }\n}\n');
	write('Resources/Private/Language/de.locallang.xlf', '<xliff/>\n');
	write('composer.json', '{\n  "name": "vendor/site"\n}\n');
	git(ws, 'add', '.');
	git(ws, 'commit', '-qm', 'Initial site package');
	for (const [i, msg] of ['Add login controller', 'Add price calculator', 'Translate login form', 'Fix rounding in PriceCalculator'].entries()) {
		write(`docs/note${i}.md`, `${msg}\n`);
		git(ws, 'add', '.');
		git(ws, 'commit', '-qm', msg);
	}
	git(ws, 'remote', 'add', 'origin', remote);
	git(ws, 'push', '-q', '-u', 'origin', 'main');
	git(ws, 'checkout', '-qb', 'feature/newsletter');
	write('Classes/Controller/NewsletterController.php', '<?php\n\nfinal class NewsletterController\n{\n}\n');
	git(ws, 'add', '.');
	git(ws, 'commit', '-qm', 'Add newsletter subscription');
	git(ws, 'checkout', '-q', 'main');
	git(ws, 'checkout', '-qb', 'feature/rate-limit');
	git(ws, 'tag', 'v1.0.0', 'main');
	write('Classes/Service/RateLimiter.php', '<?php\n\nfinal class RateLimiter\n{\n}\n');
	git(ws, 'add', '.');
	git(ws, 'commit', '-qm', 'Add RateLimiter service');
	git(ws, 'merge', '-q', '--no-ff', 'feature/newsletter', '-m', "Merge branch 'feature/newsletter' into feature/rate-limit");
	for (const [file, content, msg] of [
		['Configuration/RateLimit.yaml', 'login:\n  attempts: 5\n', 'Configure login attempts'],
		['Classes/Service/RateLimitLogger.php', '<?php\n\nfinal class RateLimitLogger\n{\n}\n', 'Log refused logins'],
		['Documentation/RateLimit.md', '# Rate limiting\n', 'Document rate limiting'],
	]) {
		write(file, content);
		git(ws, 'add', '.');
		git(ws, 'commit', '-qm', msg);
	}
	write('Classes/Controller/LoginController.php', '<?php\n\nnamespace Vendor\\Site\\Controller;\n\nfinal class LoginController implements LoggerAwareInterface\n{\n    public function loginAction(string $username): void\n    {\n        if (!$this->limiter->allow($username)) {\n            return;\n        }\n        $user = $this->users->find(trim($username));\n    }\n}\n');
	write('Classes/Service/PriceCalculator.php', '<?php\n\nfinal class PriceCalculator\n{\n    public function gross(float $net, float $rate = 0.19): float\n    {\n        return round($net * (1 + $rate), 2);\n    }\n}\n');
	write('Tests/Unit/RateLimiterTest.php', '<?php\n');
	fs.rmSync(path.join(ws, 'composer.json'));
	write('notes.txt', 'todo\n');
	git(ws, 'add', 'Tests/Unit/RateLimiterTest.php');
	const userData = path.join(base, 'user-data');
	fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
	fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
		'workbench.colorTheme': 'Default Dark Modern',
		'window.zoomLevel': 0,
		'workbench.startupEditor': 'none',
		'git.enabled': false,
		'chat.commandCenter.enabled': false,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
	}));
	try {
		await runTests({
			extensionDevelopmentPath: root,
			extensionTestsPath: path.join(__dirname, 'shots.js'),
			launchArgs: [ws, `--user-data-dir=${userData}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=9333'],
			extensionTestsEnv: { CHANGELINE_SHOTS_DIR: out, CHANGELINE_E2E_WORKSPACE: ws, CHANGELINE_CDP_PORT: '9333' },
		});
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
