/**
 * All vault-side reads and writes for the comment sidecars and their per-PDF
 * folders.
 *
 * This is the single place that knows how a PDF, its `.mg-comments.json`
 * sidecar, its comment folder and its comment notes relate. The view, the
 * rename listener and the settings migration all go through here, so a rename
 * done from the plugin UI and one done from Obsidian's file explorer run
 * exactly the same code.
 */
import { App, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import type { PdfAnnotation, PdfAnnotationsFile } from './types';
import type { PdfCommenterSettings } from './settings';
import {
	MigrationEntry,
	MigrationPlan,
	isInsideFolder,
	joinVaultPath,
	parentPath,
	pdfPathForSidecar,
	planMigration,
	rewritePathPrefix,
	sidecarPathForPdf,
	targetCommentFolder,
} from './comment-paths';

export type MigrationResult = {
	moved: MigrationPlan['moves'];
	failed: { move: MigrationPlan['moves'][number]; error: string }[];
};

export class CommentStore {
	private app: App;
	private getSettings: () => PdfCommenterSettings;

	/**
	 * Depth counter guarding against re-entrancy: every vault mutation this
	 * class performs fires Obsidian rename events, which would otherwise come
	 * straight back into `handleRename`.
	 */
	private suppressDepth = 0;

	/** In-flight rename handling, so callers can await settled state. */
	private pending = new Set<Promise<void>>();

	constructor(app: App, getSettings: () => PdfCommenterSettings) {
		this.app = app;
		this.getSettings = getSettings;
	}

	// -----------------------------------------------------------------------
	// Sidecar access
	// -----------------------------------------------------------------------

	sidecarPathFor(pdfPath: string): string {
		return sidecarPathForPdf(pdfPath);
	}

	sidecarFileFor(pdfPath: string): TFile | null {
		const af = this.app.vault.getAbstractFileByPath(sidecarPathForPdf(pdfPath));
		return af instanceof TFile ? af : null;
	}

	async readSidecar(pdfPath: string): Promise<PdfAnnotationsFile | null> {
		const file = this.sidecarFileFor(pdfPath);
		if (!file) return null;
		try {
			const parsed = JSON.parse(await this.app.vault.read(file)) as PdfAnnotationsFile;
			if (parsed?.version !== 1 || !Array.isArray(parsed.annotations)) return null;
			return parsed;
		} catch (e) {
			console.warn('[comment-store] failed to read sidecar', file.path, e);
			return null;
		}
	}

	async writeSidecar(pdfPath: string, data: PdfAnnotationsFile): Promise<void> {
		const path = sidecarPathForPdf(pdfPath);
		const json = JSON.stringify(data, null, 2);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, json);
		} else {
			await this.app.vault.create(path, json);
		}
	}

	// -----------------------------------------------------------------------
	// Folder resolution
	// -----------------------------------------------------------------------

	/**
	 * The folder a PDF's comments already live in, derived from the notes
	 * themselves rather than recomputed from settings. Returns null when no
	 * annotation has a note on disk yet.
	 */
	folderFromAnnotations(annotations: PdfAnnotation[]): string | null {
		for (const ann of annotations) {
			if (!ann.notePath) continue;
			if (this.app.vault.getAbstractFileByPath(ann.notePath) instanceof TFile) {
				return parentPath(ann.notePath);
			}
		}
		// Fall back to a recorded path even if the note is missing, so a folder
		// the user emptied by hand is still preferred over relocating.
		for (const ann of annotations) {
			if (ann.notePath) return parentPath(ann.notePath);
		}
		return null;
	}

	/**
	 * Create every missing segment of a folder path.
	 *
	 * The whole chain is checked before anything is created, so a file sitting
	 * on an intermediate segment fails cleanly instead of leaving half the
	 * folders behind.
	 */
	async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized || normalized === '/') return;
		const segments = normalized.split('/').filter(Boolean);

		const prefixes: string[] = [];
		let prefix = '';
		for (const seg of segments) {
			prefix = prefix ? `${prefix}/${seg}` : seg;
			prefixes.push(prefix);
		}

		for (const p of prefixes) {
			const existing = this.app.vault.getAbstractFileByPath(p);
			if (existing && !(existing instanceof TFolder)) {
				throw new Error(`Cannot create the comments folder: "${p}" is a file, not a folder.`);
			}
		}

		for (const p of prefixes) {
			if (this.app.vault.getAbstractFileByPath(p) instanceof TFolder) continue;
			try {
				await this.app.vault.createFolder(p);
			} catch (e) {
				// Another caller may have created it between the check and here.
				if (!(this.app.vault.getAbstractFileByPath(p) instanceof TFolder)) throw e;
			}
		}
	}

	/**
	 * Resolve (and create) the folder to write this PDF's comment notes into.
	 *
	 * Existing comments win over settings: if notes are already recorded
	 * somewhere, that folder is reused, so changing the root or the mirroring
	 * toggle never strands or splits an existing PDF's comments. Only a PDF
	 * with no notes yet gets placed by the current settings.
	 */
	async resolveCommentsFolder(pdfPath: string, annotations: PdfAnnotation[]): Promise<string> {
		const existing = this.folderFromAnnotations(annotations);
		if (existing && this.app.vault.getAbstractFileByPath(existing) instanceof TFolder) {
			return existing;
		}

		const target = targetCommentFolder(pdfPath, this.getSettings());
		let candidate = target;
		let i = 0;
		// Loop only to step past a *file* squatting on the path; a folder is reused.
		for (;;) {
			const af = this.app.vault.getAbstractFileByPath(candidate);
			if (!af) {
				await this.ensureFolder(candidate);
				return candidate;
			}
			if (af instanceof TFolder) return candidate;
			i += 1;
			candidate = `${target}_${i}`;
		}
	}

	// -----------------------------------------------------------------------
	// Rename / move handling
	// -----------------------------------------------------------------------

	/** True while this class is performing its own vault mutations. */
	get isSuppressed(): boolean {
		return this.suppressDepth > 0;
	}

	private async runInternal<T>(fn: () => Promise<T>): Promise<T> {
		this.suppressDepth += 1;
		try {
			return await fn();
		} finally {
			this.suppressDepth -= 1;
		}
	}

	/**
	 * Entry point for `vault.on('rename')`. Tracks the returned promise so
	 * callers can await the resulting bookkeeping with `whenIdle()`.
	 */
	dispatchRename(file: TAbstractFile, oldPath: string): void {
		if (this.isSuppressed) return;
		const p = this.handleRename(file, oldPath)
			.catch((e) => console.error('[comment-store] rename handling failed:', e))
			.finally(() => this.pending.delete(p));
		this.pending.add(p);
	}

	/** Resolve once all in-flight rename bookkeeping has finished. */
	async whenIdle(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.all([...this.pending]);
		}
	}

	private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (file instanceof TFolder) {
			await this.handleFolderMoved(oldPath, file.path);
			return;
		}
		if (!(file instanceof TFile)) return;
		if (file.extension === 'pdf') {
			await this.handlePdfMoved(oldPath, file.path);
			return;
		}
		if (file.extension === 'md') {
			await this.handleCommentNoteMoved(file);
		}
	}

	/**
	 * A PDF was renamed or moved. Bring the sidecar, the comment folder and
	 * every comment note back in line with the new path.
	 */
	async handlePdfMoved(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;
		await this.runInternal(async () => {
			// 1. The sidecar's name is derived from the PDF path, so it has to follow.
			//    If the PDF moved because its parent folder moved, the sidecar is a
			//    sibling and has already come along; that case is a no-op here.
			let sidecar = this.sidecarFileFor(newPath);
			if (!sidecar) {
				const old = this.app.vault.getAbstractFileByPath(sidecarPathForPdf(oldPath));
				if (old instanceof TFile) {
					await this.app.fileManager.renameFile(old, sidecarPathForPdf(newPath));
					sidecar = this.sidecarFileFor(newPath);
				}
			}
			if (!sidecar) return; // this PDF has no comments

			const data = await this.readSidecar(newPath);
			if (!data) return;
			data.pdfPath = newPath;

			// 2. Keep the comment folder mirroring the PDF's new location.
			if (this.getSettings().followPdfMoves) {
				const current = this.folderFromAnnotations(data.annotations);
				const target = targetCommentFolder(newPath, this.getSettings());
				if (current && current !== target) {
					const folder = this.app.vault.getAbstractFileByPath(current);
					if (folder instanceof TFolder && !this.app.vault.getAbstractFileByPath(target)) {
						try {
							const parent = parentPath(target);
							if (parent) await this.ensureFolder(parent);
							await this.app.fileManager.renameFile(folder, target);
							for (const ann of data.annotations) {
								if (ann.notePath) ann.notePath = rewritePathPrefix(ann.notePath, current, target);
							}
						} catch (e) {
							console.warn('[comment-store] could not relocate comment folder:', current, '->', target, e);
						}
					}
				}
			}

			await this.writeSidecar(newPath, data);

			// 3. Comment notes embed the PDF path in frontmatter and in a wikilink.
			await this.updateNotesForPdfPathChange(data.annotations, oldPath, newPath);
		});
	}

	/**
	 * A markdown file moved. If it is one of our comment notes, repoint the
	 * sidecar entry at its new path so the comment is not treated as orphaned.
	 */
	private async handleCommentNoteMoved(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as { pdfPath?: unknown; annotationId?: unknown } | undefined;
		const pdfPath = typeof fm?.pdfPath === 'string' ? fm.pdfPath : null;
		const annotationId = typeof fm?.annotationId === 'string' ? fm.annotationId : null;
		if (!pdfPath || !annotationId) return; // not one of ours (or cache not built yet)

		await this.runInternal(async () => {
			const data = await this.readSidecar(pdfPath);
			if (!data) return;
			const ann = data.annotations.find((a) => a.id === annotationId);
			if (!ann || ann.notePath === file.path) return;
			ann.notePath = file.path;
			await this.writeSidecar(pdfPath, data);
		});
	}

	/**
	 * A folder moved. Two things can be affected: comment notes that live
	 * inside it, and PDFs that live inside it (whose comment folders should
	 * follow them).
	 */
	private async handleFolderMoved(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;

		await this.runInternal(async () => {
			for (const sidecarFile of this.allSidecarFiles()) {
				const pdfPath = pdfPathForSidecar(sidecarFile.path);
				if (!pdfPath) continue;
				const data = await this.readSidecar(pdfPath);
				if (!data) continue;
				let dirty = false;
				for (const ann of data.annotations) {
					if (ann.notePath && isInsideFolder(ann.notePath, oldPath)) {
						ann.notePath = rewritePathPrefix(ann.notePath, oldPath, newPath);
						dirty = true;
					}
				}
				if (dirty) await this.writeSidecar(pdfPath, data);
			}
		});

		// PDFs inside the moved folder did not each fire a rename event, so
		// handle their relocation explicitly.
		const moved = this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'pdf' && isInsideFolder(f.path, newPath));
		for (const pdf of moved) {
			const formerPath = joinVaultPath(oldPath, pdf.path.slice(newPath.length + 1));
			await this.handlePdfMoved(formerPath, pdf.path);
		}
	}

	/** Rewrite `pdfPath` frontmatter and the `**Source:**` wikilink in comment notes. */
	async updateNotesForPdfPathChange(
		annotations: PdfAnnotation[],
		oldPdfPath: string,
		newPdfPath: string
	): Promise<void> {
		if (oldPdfPath === newPdfPath) return;
		const newDisplay = (() => {
			const base = newPdfPath.slice(newPdfPath.lastIndexOf('/') + 1);
			return base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base;
		})();

		for (const ann of annotations) {
			if (!ann.notePath) continue;
			const noteFile = this.app.vault.getAbstractFileByPath(ann.notePath);
			if (!(noteFile instanceof TFile)) continue;

			try {
				const md = await this.app.vault.read(noteFile);
				let updated = md;

				// Frontmatter: replace the pdfPath line inside the leading block only.
				const fmMatch = /^---\n([\s\S]*?)\n---/.exec(md);
				if (fmMatch) {
					const rewrittenFm = fmMatch[0].replace(
						/^pdfPath:.*$/m,
						`pdfPath: "${newPdfPath.replace(/"/g, '\\"')}"`
					);
					updated = rewrittenFm + md.slice(fmMatch[0].length);
				}

				// Body: the source wikilink, which stores the full path plus an alias.
				// Replace the whole link rather than splicing the path, which is what
				// produced doubled aliases (`[[new|xx]]`) in the previous implementation.
				const linkRe = new RegExp(`\\[\\[${escapeRegExp(oldPdfPath)}(\\|[^\\]]*)?\\]\\]`, 'g');
				updated = updated.replace(linkRe, `[[${newPdfPath}|${newDisplay}]]`);

				if (updated !== md) await this.app.vault.modify(noteFile, updated);
			} catch (e) {
				console.warn('[comment-store] failed to update note for PDF move:', ann.notePath, e);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Migration
	// -----------------------------------------------------------------------

	allSidecarFiles(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.path.endsWith('.mg-comments.json'));
	}

	/** Build the list of PDFs with comments and where those comments currently live. */
	async collectMigrationEntries(): Promise<MigrationEntry[]> {
		const entries: MigrationEntry[] = [];
		for (const sidecar of this.allSidecarFiles()) {
			const pdfPath = pdfPathForSidecar(sidecar.path);
			if (!pdfPath) continue;
			if (!(this.app.vault.getAbstractFileByPath(pdfPath) instanceof TFile)) continue;
			const data = await this.readSidecar(pdfPath);
			if (!data) continue;
			entries.push({ pdfPath, currentFolder: this.folderFromAnnotations(data.annotations) });
		}
		return entries;
	}

	/** Plan the reorganisation without touching anything. */
	async planReorganisation(): Promise<MigrationPlan> {
		const entries = await this.collectMigrationEntries();
		const existing = new Set(this.app.vault.getAllLoadedFiles().map((f) => f.path));
		return planMigration(entries, this.getSettings(), existing);
	}

	/**
	 * Execute a plan. Moves are retried in passes because one folder's target
	 * can be another folder's current location; a pass that makes no progress
	 * ends the loop and the remainder is reported as failed.
	 */
	async runReorganisation(plan: MigrationPlan): Promise<MigrationResult> {
		const result: MigrationResult = { moved: [], failed: [] };
		let remaining = [...plan.moves];

		await this.runInternal(async () => {
			for (;;) {
				const blocked: typeof remaining = [];
				let progressed = false;

				for (const move of remaining) {
					const folder = this.app.vault.getAbstractFileByPath(move.from);
					if (!(folder instanceof TFolder)) {
						result.failed.push({ move, error: 'source folder no longer exists' });
						continue;
					}
					if (this.app.vault.getAbstractFileByPath(move.to)) {
						blocked.push(move);
						continue;
					}
					try {
						const parent = parentPath(move.to);
						if (parent) await this.ensureFolder(parent);
						await this.app.fileManager.renameFile(folder, move.to);
						await this.repointSidecar(move.pdfPath, move.from, move.to);
						result.moved.push(move);
						progressed = true;
					} catch (e) {
						result.failed.push({ move, error: e instanceof Error ? e.message : String(e) });
					}
				}

				remaining = blocked;
				if (!progressed || remaining.length === 0) break;
			}

			for (const move of remaining) {
				result.failed.push({ move, error: 'target path is occupied' });
			}
		});

		return result;
	}

	private async repointSidecar(pdfPath: string, oldFolder: string, newFolder: string): Promise<void> {
		const data = await this.readSidecar(pdfPath);
		if (!data) return;
		let dirty = false;
		for (const ann of data.annotations) {
			if (ann.notePath && isInsideFolder(ann.notePath, oldFolder)) {
				ann.notePath = rewritePathPrefix(ann.notePath, oldFolder, newFolder);
				dirty = true;
			}
		}
		if (dirty) await this.writeSidecar(pdfPath, data);
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
