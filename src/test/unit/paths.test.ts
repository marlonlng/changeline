import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { askpassSocketPath, fromGitPath, isInside, pathKey, shellPath, toGitPath } from '../../paths';

const win = path.win32;
const root = win.normalize('C:/Users/me/repo');

test('Windows: files are inside the repository regardless of drive letter case and slashes', () => {
	assert.equal(root, 'C:\\Users\\me\\repo');
	assert.equal(isInside('c:\\Users\\me\\repo\\src\\a.ts', root, win), true);
	assert.equal(isInside('C:/Users/me/repo/src/a.ts', root, win), true);
	assert.equal(isInside('c:\\users\\ME\\Repo', root, win), true, 'the root itself, other case');
	assert.equal(isInside('C:\\Users\\me\\repo2\\a.ts', root, win), false, 'sibling with the same prefix');
	assert.equal(isInside('C:\\Users\\me\\a.ts', root, win), false);
	assert.equal(isInside('D:\\Users\\me\\repo\\a.ts', root, win), false, 'other drive');
	assert.equal(isInside('C:\\Users\\me\\repo\\..hidden', root, win), true, 'file name starting with two dots');
	assert.equal(isInside('\\\\server\\share\\repo\\a.ts', '\\\\server\\share\\repo', win), true, 'UNC path');
	assert.equal(isInside('\\\\server\\other\\repo\\a.ts', '\\\\server\\share\\repo', win), false);
});

test('Windows: paths are converted between git (forward slashes) and the file system', () => {
	assert.equal(toGitPath(root, 'c:\\Users\\me\\repo\\Src\\Sub Dir\\A.ts', win), 'Src/Sub Dir/A.ts');
	assert.equal(toGitPath(root, 'C:/Users/me/repo/src/a.ts', win), 'src/a.ts');
	assert.equal(toGitPath(root, root, win), '');
	assert.equal(fromGitPath(root, 'src/sub dir/a.ts', win), 'C:\\Users\\me\\repo\\src\\sub dir\\a.ts');
	assert.equal(fromGitPath(root, 'a.ts', win), 'C:\\Users\\me\\repo\\a.ts');
	assert.equal(shellPath('C:\\Users\\me\\AppData\\Local\\changeline\\sequence-editor.sh', win), 'C:/Users/me/AppData/Local/changeline/sequence-editor.sh');
});

test('path keys: case-insensitive on Windows and macOS, exact on Linux', () => {
	assert.equal(pathKey('C:\\Users\\Me\\Repo\\A.txt', 'win32'), pathKey('c:/users/me/repo/a.txt', 'win32'));
	assert.equal(pathKey('C:\\repo\\.\\src\\..\\a.txt', 'win32'), 'c:\\repo\\a.txt');
	assert.equal(pathKey('/Users/me/Repo/A.txt', 'darwin'), pathKey('/users/me/repo/a.txt', 'darwin'));
	assert.notEqual(pathKey('/home/me/Repo/A.txt', 'linux'), pathKey('/home/me/repo/a.txt', 'linux'));
	assert.equal(pathKey('/home/me/repo/./a.txt', 'linux'), '/home/me/repo/a.txt');
});

test('POSIX: containment and git paths', () => {
	const px = path.posix;
	assert.equal(isInside('/home/me/repo/src/a.ts', '/home/me/repo', px), true);
	assert.equal(isInside('/home/me/repo2/a.ts', '/home/me/repo', px), false);
	assert.equal(isInside('/home/me/Repo/a.ts', '/home/me/repo', px), false, 'case-sensitive');
	assert.equal(toGitPath('/home/me/repo', '/home/me/repo/src/a.ts', px), 'src/a.ts');
	assert.equal(fromGitPath('/home/me/repo', 'src/a.ts', px), '/home/me/repo/src/a.ts');
});

test('askpass server address: named pipe on Windows, unix socket elsewhere', () => {
	assert.equal(askpassSocketPath('abc123', 'win32'), '\\\\.\\pipe\\changeline-askpass-abc123');
	assert.equal(askpassSocketPath('abc123', 'linux', '/tmp'), '/tmp/changeline-askpass-abc123.sock');
	assert.equal(askpassSocketPath('abc123', 'darwin', '/var/folders/x/T'), '/var/folders/x/T/changeline-askpass-abc123.sock');
});
