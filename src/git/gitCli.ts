import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: string[],
		readonly exitCode: number | null,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(message);
		this.name = 'GitError';
	}

	/** First meaningful stderr line, suitable for a notification. */
	get summary(): string {
		if (/unable to read askpass response|could not read (Username|Password)/i.test(this.stderr)) {
			return 'Authentication cancelled: no credentials were entered.';
		}
		const lines = (this.stderr || this.stdout || this.message)
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('hint:'));
		const important = lines.find((l) => /^(error|fatal):/i.test(l)) ?? lines[0] ?? this.message;
		return important.replace(/^(error|fatal):\s*/i, '');
	}
}

export interface ExecOptions {
	input?: string | Buffer;
	env?: NodeJS.ProcessEnv;
	acceptExitCodes?: number[];
	log?: boolean;
	cancel?: { onCancellationRequested(listener: () => void): { dispose(): void } };
	onStderr?: (chunk: string) => void;
	maxBuffer?: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface BufferResult {
	stdout: Buffer;
	stderr: string;
	exitCode: number;
}

export type GitLogger = (line: string, kind: 'command' | 'output' | 'error') => void;

export class GitCli {
	constructor(
		readonly path: string,
		readonly version: string,
		private readonly logger: GitLogger,
		private readonly baseEnv: NodeJS.ProcessEnv = {},
	) {}

	versionAtLeast(major: number, minor: number): boolean {
		const m = /(\d+)\.(\d+)/.exec(this.version);
		if (!m) {
			return true;
		}
		const [maj, min] = [Number(m[1]), Number(m[2])];
		return maj > major || (maj === major && min >= minor);
	}

	async exec(cwd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
		const r = await this.execBuffer(cwd, args, options);
		return { stdout: r.stdout.toString('utf8'), stderr: r.stderr, exitCode: r.exitCode };
	}

	execBuffer(cwd: string, args: string[], options: ExecOptions = {}): Promise<BufferResult> {
		const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_PAGER: 'cat',
			PAGER: 'cat',
			LANGUAGE: 'en_US.UTF-8',
			LC_MESSAGES: 'C',
			GIT_TERMINAL_PROMPT: '0',
			...this.baseEnv,
			...options.env,
		};
		const started = Date.now();
		if (options.log) {
			this.logger(`git ${args.map(quoteArg).join(' ')}`, 'command');
		}
		return new Promise<BufferResult>((resolve, reject) => {
			let child: cp.ChildProcess;
			try {
				child = cp.spawn(this.path, fullArgs, { cwd, env, windowsHide: true });
			} catch (e) {
				reject(e);
				return;
			}
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let size = 0;
			const max = options.maxBuffer ?? 512 * 1024 * 1024;
			child.stdout!.on('data', (d: Buffer) => {
				size += d.length;
				if (size <= max) {
					out.push(d);
				}
			});
			child.stderr!.on('data', (d: Buffer) => {
				err.push(d);
				options.onStderr?.(d.toString('utf8'));
			});
			const sub = options.cancel?.onCancellationRequested(() => child.kill());
			child.on('error', (e) => {
				sub?.dispose();
				reject(e);
			});
			child.on('close', (code) => {
				sub?.dispose();
				const stdout = Buffer.concat(out);
				const stderr = Buffer.concat(err).toString('utf8');
				const exitCode = code ?? -1;
				if (options.log) {
					const output = stderr.trim();
					if (output) {
						this.logger(output, exitCode === 0 ? 'output' : 'error');
					}
					if (exitCode !== 0) {
						this.logger(`exit code ${exitCode} (${Date.now() - started} ms)`, 'error');
					}
				}
				if (exitCode !== 0 && !(options.acceptExitCodes ?? []).includes(exitCode)) {
					const text = stdout.toString('utf8');
					reject(new GitError(`git ${args[0]} failed: ${firstLine(stderr) || firstLine(text) || `exit code ${exitCode}`}`, args, code, text, stderr));
					return;
				}
				resolve({ stdout, stderr, exitCode });
			});
			if (options.input !== undefined) {
				child.stdin!.on('error', () => {
				});
				child.stdin!.end(options.input);
			} else {
				child.stdin!.end();
			}
		});
	}

	spawn(cwd: string, args: string[], env?: NodeJS.ProcessEnv): cp.ChildProcess {
		return cp.spawn(this.path, ['-c', 'core.quotepath=false', ...args], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...this.baseEnv, ...env },
			windowsHide: true,
		});
	}
}

function firstLine(s: string): string {
	return s
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith('hint:')) ?? '';
}

function quoteArg(a: string): string {
	return /^[\w@%+=:,./^~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export async function findGit(hints: (string | undefined)[]): Promise<{ path: string; version: string }> {
	const candidates: string[] = [];
	for (const h of hints) {
		if (h) {
			candidates.push(h);
		}
	}
	candidates.push('git');
	if (process.platform === 'darwin') {
		candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
	} else if (process.platform === 'win32') {
		for (const base of [process.env['ProgramW6432'], process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LocalAppData'] && path.join(process.env['LocalAppData'], 'Programs')]) {
			if (base) {
				candidates.push(path.join(base, 'Git', 'cmd', 'git.exe'));
			}
		}
	} else {
		candidates.push('/usr/bin/git', '/usr/local/bin/git');
	}
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) {
			continue;
		}
		const version = await new Promise<string | undefined>((resolve) => {
			cp.execFile(candidate, ['--version'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
				if (err) {
					resolve(undefined);
					return;
				}
				const m = /git version\s+(\S+)/.exec(stdout);
				resolve(m ? m[1] : undefined);
			});
		});
		if (version) {
			return { path: candidate, version };
		}
	}
	throw new Error('Git executable not found. Install Git or set "changeline.path".');
}
