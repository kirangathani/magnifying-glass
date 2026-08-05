/**
 * Shared data types for the annotation sidecar.
 *
 * Kept in their own module (rather than in view.ts) so that `comment-store.ts`
 * and the settings/migration code can use them without importing the view.
 */

export type NormalizedRect = { x: number; y: number; w: number; h: number }; // 0..1 relative to page box
export type PageRects = { pageNumber: number; rects: NormalizedRect[] };

export type PdfAnnotation = {
	id: string;
	createdAt: number;
	selectedText: string;
	// Back-compat: older sidecars may have inline commentText. New flow uses notePath.
	commentText?: string;
	notePath?: string; // vault path to markdown note backing this comment
	anchor: { pageNumber: number; yNorm: number };
	highlights: PageRects[];
};

export type PdfAnnotationsFile = {
	version: 1;
	pdfPath: string;
	annotations: PdfAnnotation[];
};
