import * as os from 'os';
import * as path from 'path';

export type PathApi = typeof path.posix;

const forPlatform = (platform: NodeJS.Platform): PathApi => (platform === 'win32' ? path.win32 : path.posix);

/** True when `p` is `root` or inside it. On Windows the comparison ignores case (drive letters differ between git and VS Code). */
export function isInside(p: string, root: string, api: PathApi = path): boolean {
	const rel = api.relative(root, p);
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel));
}

/** `p` relative to `root` with forward slashes, the way git prints paths. */
export function toGitPath(root: string, p: string, api: PathApi = path): string {
	return api.relative(root, api.normalize(p)).split(api.sep).join('/');
}

/** Absolute path of a path git printed (forward slashes) relative to `root`. */
export function fromGitPath(root: string, rel: string, api: PathApi = path): string {
	return api.join(root, ...rel.split('/'));
}

/** Normalized key for maps and comparisons; case-insensitive on Windows and macOS (their default file systems). */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
	const n = forPlatform(platform).normalize(p);
	return platform === 'win32' || platform === 'darwin' ? n.toLowerCase() : n;
}

/** Address of the askpass server: a named pipe on Windows, a unix socket elsewhere. */
export function askpassSocketPath(id: string, platform: NodeJS.Platform = process.platform, tmpDir = os.tmpdir()): string {
	return platform === 'win32' ? `\\\\.\\pipe\\changeline-askpass-${id}` : path.posix.join(tmpDir, `changeline-askpass-${id}.sock`);
}

/** Path for scripts that git runs through `sh` (Git for Windows accepts forward slashes, backslashes would be escapes). */
export function shellPath(p: string, api: PathApi = path): string {
	return p.split(api.sep).join('/');
}
