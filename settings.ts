/**
 * Plugin settings shape and defaults.
 *
 * Lives in its own module so `view.ts` and `comment-store.ts` can depend on the
 * settings type without importing `main.ts` (which imports them back).
 */

export interface PdfCommenterSettings {
	accentColor: string;
	useObsidianAccent: boolean;
	darkMode: 'auto' | 'light' | 'dark';

	/**
	 * Vault-relative folder that all per-PDF comment folders live under.
	 * Empty string means the vault root, which is the historical behaviour.
	 */
	commentsRootFolder: string;

	/**
	 * When true, the PDF's own folder path is reproduced inside the root, so
	 * `Papers/Research/x.pdf` gets `<root>/Papers/Research/x/`. This keeps two
	 * PDFs that share a basename in different folders from colliding on one
	 * comment folder.
	 */
	mirrorVaultStructure: boolean;

	/**
	 * When true, moving or renaming a PDF relocates its comment folder to the
	 * new mirrored target. Turning this off leaves comment folders where they
	 * are; comments keep working either way, because the folder for an existing
	 * PDF is resolved from its notes' recorded paths, not recomputed.
	 */
	followPdfMoves: boolean;
}

export const DEFAULT_SETTINGS: PdfCommenterSettings = {
	accentColor: '#7c3aed',
	useObsidianAccent: false,
	darkMode: 'auto',
	commentsRootFolder: '',
	mirrorVaultStructure: true,
	followPdfMoves: true,
};
