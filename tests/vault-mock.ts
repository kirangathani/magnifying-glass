/**
 * In-memory stand-in for the parts of the Obsidian vault that CommentStore
 * uses, so the rename/move/migration logic can be exercised without Obsidian.
 *
 * It deliberately reproduces the API's sharp edges rather than being permissive:
 *   - `createFolder` does NOT create parent folders (so a missing ensureFolder
 *     call surfaces as a failure rather than passing silently)
 *   - `create` refuses to write into a folder that does not exist
 *   - `renameFile` refuses to overwrite an existing path
 *   - renaming a folder fires ONE rename event, for the folder, exactly as
 *     Obsidian does; the children's paths change without individual events
 */
import { TAbstractFile, TFile, TFolder, normalizePath } from './obsidian-stub';

type RenameListener = (file: TAbstractFile, oldPath: string) => void;

export class MockVault {
	files = new Map<string, TAbstractFile>();
	contents = new Map<string, string>();
	private listeners: RenameListener[] = [];

	on(name: 'rename', cb: RenameListener): void {
		if (name === 'rename') this.listeners.push(cb);
	}

	private emitRename(file: TAbstractFile, oldPath: string): void {
		for (const cb of [...this.listeners]) cb(file, oldPath);
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.files.get(normalizePath(path)) ?? null;
	}

	getFiles(): TFile[] {
		return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.files.values()];
	}

	private parentOf(path: string): string {
		const p = normalizePath(path);
		const idx = p.lastIndexOf('/');
		return idx === -1 ? '' : p.slice(0, idx);
	}

	private requireParent(path: string): void {
		const parent = this.parentOf(path);
		if (!parent) return;
		if (!(this.files.get(parent) instanceof TFolder)) {
			throw new Error(`Folder does not exist: ${parent}`);
		}
	}

	async createFolder(path: string): Promise<TFolder> {
		const p = normalizePath(path);
		if (this.files.has(p)) throw new Error(`Already exists: ${p}`);
		this.requireParent(p);
		const folder = new TFolder(p);
		this.files.set(p, folder);
		return folder;
	}

	async create(path: string, content: string): Promise<TFile> {
		const p = normalizePath(path);
		if (this.files.has(p)) throw new Error(`Already exists: ${p}`);
		this.requireParent(p);
		const file = new TFile(p);
		this.files.set(p, file);
		this.contents.set(p, content);
		return file;
	}

	async read(file: TFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error(`Not found: ${file.path}`);
		return content;
	}

	async modify(file: TFile, content: string): Promise<void> {
		if (!this.files.has(file.path)) throw new Error(`Not found: ${file.path}`);
		this.contents.set(file.path, content);
	}

	/** Mirrors `fileManager.renameFile`, including the event it fires. */
	async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
		const from = file.path;
		const to = normalizePath(newPath);
		if (this.files.has(to)) throw new Error(`Already exists: ${to}`);
		this.requireParent(to);

		if (file instanceof TFolder) {
			const affected = [...this.files.values()].filter(
				(f) => f.path === from || f.path.startsWith(from + '/')
			);
			for (const f of affected) {
				const next = f.path === from ? to : to + f.path.slice(from.length);
				this.files.delete(f.path);
				const content = this.contents.get(f.path);
				if (content !== undefined) {
					this.contents.delete(f.path);
					this.contents.set(next, content);
				}
				f.path = next;
				this.files.set(next, f);
			}
		} else {
			this.files.delete(from);
			const content = this.contents.get(from);
			if (content !== undefined) {
				this.contents.delete(from);
				this.contents.set(to, content);
			}
			file.path = to;
			this.files.set(to, file);
		}

		this.emitRename(file, from);
	}

	// --- test helpers -----------------------------------------------------

	/** Create a folder and every missing parent. */
	seedFolder(path: string): void {
		let prefix = '';
		for (const seg of normalizePath(path).split('/').filter(Boolean)) {
			prefix = prefix ? `${prefix}/${seg}` : seg;
			if (!this.files.has(prefix)) this.files.set(prefix, new TFolder(prefix));
		}
	}

	seedFile(path: string, content = ''): TFile {
		const p = normalizePath(path);
		const parent = this.parentOf(p);
		if (parent) this.seedFolder(parent);
		const file = new TFile(p);
		this.files.set(p, file);
		this.contents.set(p, content);
		return file;
	}

	read_(path: string): string | undefined {
		return this.contents.get(normalizePath(path));
	}

	exists(path: string): boolean {
		return this.files.has(normalizePath(path));
	}

	paths(): string[] {
		return [...this.files.keys()].sort();
	}
}

export class MockApp {
	vault = new MockVault();
	fileManager = {
		renameFile: (file: TAbstractFile, newPath: string) => this.vault.renameFile(file, newPath),
	};
	metadataCache = {
		getFileCache: (file: TFile) => {
			const content = this.vault.contents.get(file.path);
			if (!content) return null;
			const match = /^---\n([\s\S]*?)\n---/.exec(content);
			if (!match) return null;
			const frontmatter: Record<string, string> = {};
			for (const line of match[1].split('\n')) {
				const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
				if (!kv) continue;
				frontmatter[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
			}
			return { frontmatter };
		},
	};
}
