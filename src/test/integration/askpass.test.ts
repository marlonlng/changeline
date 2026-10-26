import { strict as assert } from 'node:assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { AskpassCore } from '../../askpass/askpassCore';
import { findGit, GitCli } from '../../git/gitCli';
import { Repository } from '../../git/repository';

const root = path.resolve(__dirname, '../../..');
const mainScript = path.join(root, 'dist', 'askpass-main.js');
let tmp: string;
let gitPath: string;
let gitVersion: string;
let server: http.Server;
let port: number;
const prompts: string[] = [];
let answers: Record<string, string | undefined> = {};
let core: AskpassCore;

/** Minimal smart-HTTP git server (git http-backend) protected by Basic auth. */
function startGitServer(projectRoot: string): Promise<number> {
	server = http.createServer((req, res) => {
		const auth = req.headers.authorization;
		if (auth !== 'Basic ' + Buffer.from('alice:s3cret').toString('base64')) {
			res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="changeline-test"' });
			res.end('auth required');
			return;
		}
		const url = new URL(req.url!, 'http://localhost');
		const child = cp.spawn(gitPath, ['http-backend'], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: projectRoot,
				GIT_HTTP_EXPORT_ALL: '1',
				REQUEST_METHOD: req.method,
				PATH_INFO: decodeURIComponent(url.pathname),
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers['content-type'] ?? '',
				HTTP_CONTENT_ENCODING: (req.headers['content-encoding'] as string) ?? '',
				GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
				REMOTE_USER: 'alice',
				REMOTE_ADDR: '127.0.0.1',
			},
		});
		req.pipe(child.stdin);
		const chunks: Buffer[] = [];
		child.stdout.on('data', (d) => chunks.push(d));
		child.on('close', () => {
			const out = Buffer.concat(chunks);
			const sep = out.indexOf('\r\n\r\n');
			const head = out.slice(0, sep).toString();
			let status = 200;
			const headers: Record<string, string> = {};
			for (const line of head.split('\r\n')) {
				const i = line.indexOf(':');
				const k = line.slice(0, i).trim();
				const v = line.slice(i + 1).trim();
				if (k.toLowerCase() === 'status') {
					status = parseInt(v, 10);
				} else if (k) {
					headers[k] = v;
				}
			}
			res.writeHead(status, headers);
			res.end(out.slice(sep + 4));
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

before(async () => {
	if (!fs.existsSync(mainScript)) {
		throw new Error('Run "node esbuild.mjs" first: dist/askpass-main.js is missing');
	}
	const found = await findGit([]);
	gitPath = found.path;
	gitVersion = found.version;
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'changeline-askpass-'));
	cp.execFileSync(gitPath, ['init', '-q', '--bare', '-b', 'main', path.join(tmp, 'srv', 'repo.git')]);
	cp.execFileSync(gitPath, ['config', 'http.receivepack', 'true'], { cwd: path.join(tmp, 'srv', 'repo.git') });
	port = await startGitServer(path.join(tmp, 'srv'));
	core = new AskpassCore(path.join(tmp, 'scripts'), mainScript, process.execPath, async (p) => {
		prompts.push(p);
		const key = Object.keys(answers).find((k) => p.startsWith(k));
		return key ? answers[key] : undefined;
	});
	await core.start();
});

after(() => {
	core?.dispose();
	server?.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function cli(): Promise<GitCli> {
	const env = await core.env();
	return new GitCli(gitPath, gitVersion, () => undefined, {
		...env,
		HOME: tmp,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
		GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x',
	});
}

test('HTTPS credentials are requested through askpass and push succeeds', async () => {
	const git = await cli();
	const dir = path.join(tmp, 'work');
	fs.mkdirSync(dir);
	await git.exec(dir, ['init', '-q', '-b', 'main']);
	fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
	const repo = (await Repository.open(git, dir))!;
	await repo.stage(['.']);
	await repo.commit({ message: 'first' });
	await repo.addRemote('origin', `http://127.0.0.1:${port}/repo.git`);
	answers = { 'Username for': 'alice', 'Password for': 's3cret' };
	prompts.length = 0;
	const result = await repo.push({ remote: 'origin', source: 'HEAD', remoteBranch: 'main', setUpstream: true });
	assert.equal(result.rejected, false);
	assert.ok(prompts.some((p) => /^Username for 'http:\/\/127\.0\.0\.1:\d+'/.test(p)), `username prompt: ${prompts.join(' | ')}`);
	assert.ok(prompts.some((p) => /^Password for 'http:\/\/alice@127\.0\.0\.1:\d+'/.test(p)), `password prompt: ${prompts.join(' | ')}`);
	const remoteLog = cp.execFileSync(gitPath, ['log', '--format=%s', 'main'], { cwd: path.join(tmp, 'srv', 'repo.git') }).toString().trim();
	assert.equal(remoteLog, 'first');
});

test('cancelled credential prompt makes the operation fail cleanly', async () => {
	const git = await cli();
	const repo = (await Repository.open(git, path.join(tmp, 'work')))!;
	answers = {};
	prompts.length = 0;
	await assert.rejects(() => repo.fetch('origin'), (e: { summary?: string }) => /Authentication cancelled/.test(e.summary ?? ''));
	assert.ok(prompts.length >= 1, 'a prompt was shown');
});

test('SSH key passphrase is requested through SSH_ASKPASS', { skip: process.platform === 'win32' }, async () => {
	const key = path.join(tmp, 'id_test');
	cp.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'pass phrase', '-f', key]);
	const agentOut = cp.execFileSync('ssh-agent', ['-s', '-a', path.join(tmp, 'agent.sock')]).toString();
	const pid = /SSH_AGENT_PID=(\d+)/.exec(agentOut)![1];
	try {
		const env = { ...process.env, ...(await core.env()), SSH_AUTH_SOCK: path.join(tmp, 'agent.sock') };
		answers = { 'Enter passphrase': 'pass phrase' };
		prompts.length = 0;
		const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
			const child = cp.spawn('ssh-add', [key], { env, stdio: ['ignore', 'pipe', 'pipe'] });
			let stderr = '';
			child.stderr.on('data', (d) => (stderr += d));
			const t = setTimeout(() => child.kill(), 20000);
			child.on('close', (status) => {
				clearTimeout(t);
				resolve({ status, stderr });
			});
		});
		assert.equal(r.status, 0, r.stderr);
		assert.ok(prompts.some((p) => p.startsWith('Enter passphrase for')), `prompts: ${prompts.join(' | ')}`);
		const list = cp.execFileSync('ssh-add', ['-l'], { env }).toString();
		assert.match(list, /ED25519/);
	} finally {
		process.kill(Number(pid));
	}
});
