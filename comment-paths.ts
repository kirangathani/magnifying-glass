/**
 * Pure path arithmetic for comment folders.
 *
 * Deliberately free of any `obsidian` import so it can be unit-tested with
 * `node --test` outside Obsidian. Anything in here that needs the vault
 * (creating folders, moving files) belongs in `comment-store.ts` instead.
 */

/** Settings subset that determines where a PDF's comment folder goes. */
export type CommentFolderSettings = {
	commentsRootFolder: string;
	mirrorVaultStructure: boolean;
};

/**
 * Collapse a path to vault form: forward slashes, no empty segments, no
 * leading or trailing slash. Does NOT resolve `.` or `..` — those are rejected
 * outright by `validateRootFolder`.
 */
export function normalizeVaultPath(input: string): string {
	return String(input ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter((seg) => seg.length > 0)
		.join('/');
}

/** Join path fragments, dropping empty ones. */
export function joinVaultPath(...parts: (string | null | undefined)[]): string {
	return normalizeVaultPath(parts.filter((p) => !!p).join('/'));
}

/** The containing folder of a path, or '' for a vault-root item. */
export function parentPath(path: string): string {
	const p = normalizeVaultPath(path);
	const idx = p.lastIndexOf('/');
	return idx === -1 ? '' : p.slice(0, idx);
}

/** The last segment of a path. */
export function baseName(path: string): string {
	const p = normalizeVaultPath(path);
	const idx = p.lastIndexOf('/');
	return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Make a string safe to use as a vault folder name.
 *
 * Kept byte-identical to the original implementation in view.ts: changing it
 * would make the plugin stop finding comment folders it created previously.
 */
export function sanitizeVaultName(name: string): string {
	return (name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled';
}

/** `Papers/Dutta 2024.pdf` -> `Dutta 2024`. */
export function pdfBaseName(pdfPath: string): string {
	const name = baseName(String(pdfPath ?? '')) || 'PDF';
	return name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name;
}

/** Sidecar JSON path for a PDF. Derived from the PDF path by convention. */
export function sidecarPathForPdf(pdfPath: string): string {
	return `${pdfPath}.mg-comments.json`;
}

/** True if `path` names a sidecar file. */
export function isSidecarPath(path: string): boolean {
	return path.endsWith('.mg-comments.json');
}

/** The PDF a sidecar belongs to, or null if the path is not a sidecar. */
export function pdfPathForSidecar(sidecarPath: string): string | null {
	if (!isSidecarPath(sidecarPath)) return null;
	return sidecarPath.slice(0, -'.mg-comments.json'.length);
}

export type RootValidation = { ok: true; path: string } | { ok: false; error: string };

/**
 * Validate and normalise a user-entered comments root.
 * Empty input is valid and means "vault root".
 */
export function validateRootFolder(input: string): RootValidation {
	const raw = String(input ?? '').trim();
	if (/^[A-Za-z]:/.test(raw)) {
		return { ok: false, error: 'Use a path relative to the vault root, not an absolute path.' };
	}

	const normalized = normalizeVaultPath(raw);
	if (normalized === '') return { ok: true, path: '' };

	const segments = normalized.split('/');
	for (const seg of segments) {
		if (seg === '.' || seg === '..') {
			return { ok: false, error: 'Path segments "." and ".." are not allowed.' };
		}
		if (/[\\:*?"<>|]/.test(seg)) {
			return { ok: false, error: 'Path contains characters that are not allowed in a folder name.' };
		}
	}
	if (segments[0].toLowerCase() === '.obsidian') {
		return { ok: false, error: 'The comments folder cannot live inside the .obsidian config folder.' };
	}

	return { ok: true, path: normalized };
}

/**
 * Where a PDF's comment folder *should* go under the current settings.
 *
 * Note this is the target for a PDF that has no comment folder yet. For a PDF
 * that already has comments, the store resolves the folder from the notes'
 * recorded paths instead, so changing settings never silently strands notes.
 */
export function targetCommentFolder(pdfPath: string, settings: CommentFolderSettings): string {
	const root = normalizeVaultPath(settings.commentsRootFolder);
	const mirrorDir = settings.mirrorVaultStructure ? parentPath(pdfPath) : '';
	return joinVaultPath(root, mirrorDir, sanitizeVaultName(pdfBaseName(pdfPath)));
}

/**
 * True if `path` is inside `folder`. Prefix-safe: `Dutta 2024 Notes/x.md` is
 * NOT inside `Dutta 2024`.
 */
export function isInsideFolder(path: string, folder: string): boolean {
	if (!folder) return false;
	return normalizeVaultPath(path).startsWith(normalizeVaultPath(folder) + '/');
}

/** Re-root a path from one folder to another; returns it unchanged if not inside. */
export function rewritePathPrefix(path: string, oldFolder: string, newFolder: string): string {
	if (!isInsideFolder(path, oldFolder)) return path;
	const rest = normalizeVaultPath(path).slice(normalizeVaultPath(oldFolder).length + 1);
	return joinVaultPath(newFolder, rest);
}

// ---------------------------------------------------------------------------
// Migration planning
// ---------------------------------------------------------------------------

export type MigrationEntry = {
	pdfPath: string;
	/** Folder the PDF's comment notes currently live in, or null if it has none. */
	currentFolder: string | null;
};

export type MigrationMove = { pdfPath: string; from: string; to: string };

export type MigrationSkipReason =
	| 'no-comments'
	| 'already-in-place'
	| 'target-exists'
	| 'duplicate-target';

export type MigrationSkip = {
	pdfPath: string;
	from: string | null;
	to: string;
	reason: MigrationSkipReason;
};

export type MigrationPlan = { moves: MigrationMove[]; skips: MigrationSkip[] };

export const MIGRATION_SKIP_LABELS: Record<MigrationSkipReason, string> = {
	'no-comments': 'no comments yet',
	'already-in-place': 'already in the right place',
	'target-exists': 'something already exists at the target path',
	'duplicate-target': 'two PDFs resolve to the same target folder',
};

/**
 * Work out which comment folders need moving under the given settings.
 *
 * Never produces a move that would merge two folders or overwrite an existing
 * path — those become skips with a stated reason, so the confirmation dialog
 * can show the user exactly what will not be touched.
 *
 * @param existingPaths paths that already exist in the vault (files or folders)
 */
export function planMigration(
	entries: MigrationEntry[],
	settings: CommentFolderSettings,
	existingPaths: Set<string> = new Set()
): MigrationPlan {
	const moves: MigrationMove[] = [];
	const skips: MigrationSkip[] = [];

	type Candidate = { pdfPath: string; from: string; to: string };
	const candidates: Candidate[] = [];
	// Targets that are already occupied by a folder we are deliberately leaving alone.
	const settled = new Set<string>();

	for (const entry of entries) {
		const to = targetCommentFolder(entry.pdfPath, settings);
		if (!entry.currentFolder) {
			skips.push({ pdfPath: entry.pdfPath, from: null, to, reason: 'no-comments' });
			continue;
		}
		if (normalizeVaultPath(entry.currentFolder) === to) {
			settled.add(to);
			skips.push({ pdfPath: entry.pdfPath, from: entry.currentFolder, to, reason: 'already-in-place' });
			continue;
		}
		candidates.push({ pdfPath: entry.pdfPath, from: normalizeVaultPath(entry.currentFolder), to });
	}

	// Two PDFs wanting the same destination: move neither, so nothing is merged.
	const targetCounts = new Map<string, number>();
	for (const c of candidates) targetCounts.set(c.to, (targetCounts.get(c.to) ?? 0) + 1);

	// A path is blocked if it exists in the vault and is not itself about to be vacated.
	const vacated = new Set(candidates.map((c) => c.from));

	for (const c of candidates) {
		if ((targetCounts.get(c.to) ?? 0) > 1) {
			skips.push({ pdfPath: c.pdfPath, from: c.from, to: c.to, reason: 'duplicate-target' });
			continue;
		}
		if (settled.has(c.to) || (existingPaths.has(c.to) && !vacated.has(c.to))) {
			skips.push({ pdfPath: c.pdfPath, from: c.from, to: c.to, reason: 'target-exists' });
			continue;
		}
		moves.push({ pdfPath: c.pdfPath, from: c.from, to: c.to });
	}

	return { moves, skips };
}
