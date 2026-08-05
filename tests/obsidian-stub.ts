/**
 * Minimal stand-in for the `obsidian` module, aliased in by tests/build.mjs.
 *
 * Only what `comment-store.ts` actually touches: the file classes it uses for
 * `instanceof` checks, and `normalizePath`. The behaviour of the vault itself
 * lives in `vault-mock.ts`.
 */

export class TAbstractFile {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
	get name(): string {
		const idx = this.path.lastIndexOf('/');
		return idx === -1 ? this.path : this.path.slice(idx + 1);
	}
}

export class TFile extends TAbstractFile {
	get extension(): string {
		const name = this.name;
		const idx = name.lastIndexOf('.');
		return idx === -1 ? '' : name.slice(idx + 1);
	}
	get basename(): string {
		const name = this.name;
		const idx = name.lastIndexOf('.');
		return idx === -1 ? name : name.slice(0, idx);
	}
}

export class TFolder extends TAbstractFile {}

export function normalizePath(path: string): string {
	return String(path ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter(Boolean)
		.join('/');
}

// Present so `import { App } from 'obsidian'` resolves; used only as a type.
export class App {}
