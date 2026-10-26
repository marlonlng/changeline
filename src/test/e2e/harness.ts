import * as path from 'path';

export const EXTENSION_ID: string = (() => {
	const pkg = require(path.resolve(__dirname, '../../../package.json')) as { publisher: string; name: string };
	return `${pkg.publisher}.${pkg.name}`;
})();

const tests: { name: string; fn: () => Promise<void> }[] = [];

export function test(name: string, fn: () => Promise<void>): void {
	tests.push({ name, fn });
}

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeout = 10000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) {
			return v;
		}
		if (Date.now() - start > timeout) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

export async function runAll(): Promise<void> {
	let failed = 0;
	for (const t of tests) {
		const start = Date.now();
		try {
			await Promise.race([t.fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 90 s')), 90000))]);
			console.log(`  ✔ ${t.name} (${Date.now() - start} ms)`);
		} catch (e) {
			failed++;
			console.log(`  ✖ ${t.name}\n    ${(e as Error).stack ?? e}`);
		}
	}
	console.log(`\n${tests.length - failed} passed, ${failed} failed`);
	if (failed) {
		throw new Error(`${failed} e2e test(s) failed`);
	}
}
