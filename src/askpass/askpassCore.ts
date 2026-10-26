import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { askpassSocketPath } from '../paths';

export type PromptHandler = (prompt: string) => Promise<string | undefined>;

export class AskpassCore {
	private server?: net.Server;
	readonly socketPath: string;

	constructor(
		private readonly scriptsDir: string,
		private readonly mainScript: string,
		private readonly nodePath: string,
		private readonly prompt: PromptHandler,
	) {
		const id = crypto.randomBytes(6).toString('hex');
		this.socketPath = askpassSocketPath(id);
	}

	async start(): Promise<void> {
		this.server = net.createServer((socket) => {
			let buf = '';
			let answered = false;
			socket.on('data', async (d) => {
				buf += d.toString('utf8');
				if (answered || !buf.includes('\n')) {
					return;
				}
				answered = true;
				let answer: string | undefined;
				try {
					const { argv } = JSON.parse(buf) as { argv: string[] };
					answer = await this.prompt(argv.join(' ').trim());
				} catch {
					answer = undefined;
				}
				socket.end(JSON.stringify({ answer }));
			});
			socket.on('error', () => undefined);
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(this.socketPath, () => resolve());
		});
	}

	/** Environment variables that route git's and ssh's prompts to this server. */
	async env(): Promise<NodeJS.ProcessEnv> {
		const script = path.join(this.scriptsDir, 'askpass.sh');
		await fs.promises.mkdir(this.scriptsDir, { recursive: true });
		await fs.promises.writeFile(script, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$CHANGELINE_ASKPASS_NODE" "$CHANGELINE_ASKPASS_MAIN" "$@"\n', { mode: 0o755 });
		await fs.promises.chmod(script, 0o755);
		return {
			GIT_ASKPASS: script,
			SSH_ASKPASS: script,
			SSH_ASKPASS_REQUIRE: 'force',
			DISPLAY: process.env['DISPLAY'] ?? ':0',
			CHANGELINE_ASKPASS_NODE: this.nodePath,
			CHANGELINE_ASKPASS_MAIN: this.mainScript,
			CHANGELINE_ASKPASS_HANDLE: this.socketPath,
		};
	}

	dispose(): void {
		this.server?.close();
		if (process.platform !== 'win32') {
			fs.rmSync(this.socketPath, { force: true });
		}
	}
}

/** Kind of prompt git or ssh is asking for. */
export function classifyPrompt(prompt: string): { secret: boolean; host?: string; yesNo: boolean } {
	return {
		secret: /password|passphrase|token|PIN/i.test(prompt),
		host: /'([^']+)'/.exec(prompt)?.[1],
		yesNo: /\(yes\/no/i.test(prompt),
	};
}
