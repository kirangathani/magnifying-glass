/**
 * Bundle the test files (TypeScript) to plain ESM so `node --test` can run them.
 * Only pure modules are testable this way — anything importing `obsidian` needs
 * the real app.
 */
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, 'build');

fs.rmSync(outdir, { recursive: true, force: true });

const entryPoints = fs
	.readdirSync(here)
	.filter((f) => f.endsWith('.test.ts'))
	.map((f) => path.join(here, f));

if (entryPoints.length === 0) {
	console.error('[tests] no *.test.ts files found');
	process.exit(1);
}

await esbuild.build({
	entryPoints,
	outdir,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node18',
	// The package is CJS by default, so emit .mjs to keep the ESM output loadable.
	outExtension: { '.js': '.mjs' },
	external: ['node:*'],
	// Swap the real plugin API for a stub so store logic can run under node.
	alias: { obsidian: path.join(here, 'obsidian-stub.ts') },
	logLevel: 'warning',
});

console.log(`[tests] built ${entryPoints.length} test file(s) to ${path.relative(process.cwd(), outdir)}`);
