/**
 * Minimal `obsidian` module stub for the browser harness.
 *
 * Only what WikilinkSuggest needs: a vault that lists markdown files, a
 * metadata cache, and a fuzzy scorer. The DOM helpers (`createDiv`, …) come
 * from obsidian-shim.ts, which patches the prototypes globally.
 */

export class TFile {
	path: string;
	basename: string;
	extension = 'md';
	parent: { path: string } | null;

	constructor(path: string) {
		this.path = path;
		const name = path.split('/').pop() ?? path;
		this.basename = name.replace(/\.md$/, '');
		const dir = path.slice(0, Math.max(0, path.length - name.length - 1));
		this.parent = { path: dir || '/' };
	}
}

const FILES = [
	'Notes/Green tea.md',
	'Notes/Blue tea.md',
	'Notes/West Bengal.md',
	'Projects/Tea production.md',
	'Daily/2026-08-05.md',
].map((p) => new TFile(p));

export class App {
	vault = {
		getMarkdownFiles: (): TFile[] => FILES,
	};
	metadataCache = {
		getFileCache: (): { frontmatter?: Record<string, unknown> } | null => null,
	};
}

/** Substring-and-subsequence scorer standing in for Obsidian's fuzzy search. */
export function prepareFuzzySearch(query: string): (text: string) => { score: number } | null {
	const q = query.toLowerCase();
	return (text: string) => {
		const t = text.toLowerCase();
		if (!q) return { score: 0 };
		const idx = t.indexOf(q);
		if (idx !== -1) return { score: -idx };
		let i = 0;
		for (const ch of t) {
			if (ch === q[i]) i += 1;
			if (i === q.length) return { score: -100 };
		}
		return null;
	};
}
