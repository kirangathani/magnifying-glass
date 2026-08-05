# PDF Commenter — Obsidian Plugin

## What This Is

An Obsidian plugin that provides a custom PDF viewer with an annotation/commenting system. Users load a vault-relative PDF, view it with zoom controls (including pinch-to-zoom), select text, and create comments anchored to specific positions in the PDF. Comments are backed by individual markdown notes with frontmatter, rendered with Obsidian's `MarkdownRenderer`, and support `[[wikilinks]]`.

## Project Structure

All source files are in the repo root (no `src/` directory).

| File | Role |
|---|---|
| `main.ts` | Plugin entry point. Extends `Plugin`. Registers the custom view type, ribbon icon, and command. |
| `view.ts` | `PdfCommenterView` extends `FileView`. Contains all UI: controls bar, PDF container, comments pane, annotation CRUD, scroll sync, pinch-to-zoom orchestration, highlight rendering, note creation/migration. This is the largest file (~1200 lines). |
| `pdf-viewer.ts` | `PDFViewerComponent`. Wraps pdfjs-dist: loads PDFs, renders pages to canvas, renders text layers for selection, handles zoom with progressive rendering (visible pages first, background render for rest), context menu integration. |
| `context-menu.ts` | `ContextMenu` class. Generic right-click menu positioned at cursor, used for Copy / Comment / Copy to Active Note / Create Note actions. |
| `styles.css` | All CSS. Layout uses flexbox. Purple (`#7c3aed`) accent colour for comment markers and buttons. Uses Obsidian CSS variables for theme compatibility. |
| `pdf.worker.js` | Copied from `pdfjs-dist` at build time by esbuild plugin. Shipped alongside `main.js` in the plugin folder. Loaded at runtime via blob URL to avoid CORS issues with Obsidian's `app://` protocol. |
| `esbuild.config.mjs` | Build config. Single entry point `main.ts` → `main.js` (CJS). Custom plugin `copy-pdf-worker` copies the pdfjs worker file post-build. |
| `wikilink-suggest.ts` | `WikilinkSuggest` class. Inline autocomplete popup for `[[wikilinks]]` in the comment textarea. Fuzzy-filters vault markdown files, keyboard nav, positioned below/above textarea. |
| `types.ts` | Shared sidecar data types (`PdfAnnotation`, `PdfAnnotationsFile`, …). No imports, so any module can use them. |
| `settings.ts` | `PdfCommenterSettings` shape and `DEFAULT_SETTINGS`. Separate from `main.ts` so `view.ts`/`comment-store.ts` can depend on the type without a circular import. |
| `comment-paths.ts` | Pure path arithmetic: comment-folder targets, root validation, prefix-safe rewriting, migration planning. Imports nothing from `obsidian`, so it is unit-testable. |
| `comment-store.ts` | All vault reads/writes for sidecars and comment folders. Single owner of the PDF ↔ sidecar ↔ folder ↔ note relationship, so a rename from the plugin UI and one from the file explorer run identical code. |
| `comment-fit.ts` | Collapsed-card height fitting: measures line boxes, snaps the clamp to the last whole line, and flags truncation so the chevron only appears when text is hidden. Pure decision function (`chooseClampHeight`) plus DOM helpers; no `obsidian` import, so the mock harness reuses it. |
| `bracket-wrap.ts` | Obsidian-style `[` wrapping of a textarea selection (press twice for `[[wikilinks]]`). Pure `wrapSelection` plus a DOM applier that keeps the native undo stack. |
| `marker-layout.ts` | The comment-card collision sweep (`layoutMarkers`): each card at its anchor, pushed down only where cards would overlap. Pure and stateless, shared by `view.ts` and the mock. |
| `tests/` | `node --test` suite over `comment-paths.ts`, `comment-store.ts`, `comment-fit.ts` and `bracket-wrap.ts` (the store runs against an in-memory vault mock in `tests/vault-mock.ts`, with `obsidian` aliased to `tests/obsidian-stub.ts`). |
| `mock/` | Standalone browser harness (see `mock/README.md`). Runs the real viewer, the real fitting pass and the real bracket wrapping outside Obsidian so layout rules can be asserted in a real layout engine. |
| `manifest.json` | Plugin id `pdf-commenter`, name `PDF Commenter`. `minAppVersion: 0.15.0`, `isDesktopOnly: true`. |

## Build & Dev

- **Dev mode**: `npm run dev` — esbuild watch mode with inline source maps.
- **Tests**: `npm test` — bundles `tests/*.test.ts` to ESM and runs `node --test`. Only modules that do not need a live Obsidian app are covered.
- **Production**: `npm run build` — type-checks with `tsc -noEmit`, then esbuild with minification, no source maps.
- **Version bump**: `npm run version` — runs `version-bump.mjs`, updates `manifest.json` and `versions.json`.
- Output: `main.js` (gitignored), `pdf.worker.js`, `styles.css`, `manifest.json` go into the plugin folder.

## Key Dependencies

- `pdfjs-dist@2.16.105` — PDF rendering. Version 2.x chosen for compatibility with older Electron (classic workers as `.js`). Loaded via `require('pdfjs-dist/build/pdf.js')`.
- `obsidian` (latest) — Obsidian plugin API (external in esbuild).
- TypeScript 4.7, esbuild 0.17, ESLint with `@typescript-eslint`.

## Conventions

- **Indentation**: Tabs, width 4 (`.editorconfig`).
- **Line endings**: LF.
- **Module format**: ESNext in source, bundled to CJS by esbuild.
- **Target**: ES2018 (esbuild), ES6 (tsconfig).
- **Strict null checks** enabled; `noImplicitAny` enabled.
- No test framework is set up.
- Git branches: `master` (main), `dev` (active development).

## Architecture Notes

### Annotation Data Model

```typescript
type PdfAnnotation = {
    id: string;                    // timestamp + random hex
    createdAt: number;             // epoch ms
    selectedText: string;          // the highlighted PDF text
    commentText?: string;          // legacy inline text (back-compat)
    notePath?: string;             // vault path to backing markdown note
    anchor: { pageNumber: number; yNorm: number }; // normalised Y position on page
    highlights: PageRects[];       // normalised rects for highlight overlay
};
```

### Storage

- **Sidecar JSON**: `<pdfPath>.mg-comments.json` — `PdfAnnotationsFile` with `version: 1`, stores all annotations for a PDF.
- **Per-PDF folder**: A folder named after the PDF (sanitised) holds that PDF's comment notes, one per annotation: `comment-<isoDate>-<id>.md`. Where the folder goes is controlled by two settings: `commentsRootFolder` (default `''` = vault root) and `mirrorVaultStructure` (default `true`, reproducing the PDF's own folder path inside the root so two PDFs sharing a basename do not collide). Created lazily, on the first note written — merely opening a PDF creates nothing.
- **Folder resolution follows the notes, not the settings**: for a PDF that already has annotations, the folder is the parent of a recorded `notePath`, so changing settings never strands or splits existing comments. Only a PDF with no notes yet is placed by the current settings. Relocating existing folders is an explicit, confirmed action (settings button / `reorganise-comment-folders` command), because changing a setting moves nothing on disk and so fires no vault event.
- **Renames and moves**: a single `vault.on('rename')` listener in `main.ts` delegates to `CommentStore`, covering PDFs, comment notes and folders, whether moved from the file explorer, the plugin's own rename box, or Obsidian Sync. `CommentStore` suppresses re-entrancy while performing its own moves.
- **Note format**: YAML frontmatter (`pdfPath`, `annotationId`, `pageNumber`, `yNorm`, `createdAt`) + blockquote of selected text + user comment body.
- On load, annotations missing `notePath` are auto-migrated (notes created, sidecar updated).

### Zoom System

Two-phase zoom for pinch-to-zoom:
1. **Preview phase**: CSS `transform: scale(factor)` on `.pdf-scroll-container` for instant visual feedback.
2. **Commit phase**: After 160ms debounce, calls `PDFViewerComponent.setScale()` which re-renders canvases at the new resolution. Visible pages render first (concurrency 2), remaining pages render in the background via `requestIdleCallback`.

Button zoom (+/- 0.25 steps) skips the preview phase and goes directly to commit. Scale range: 0.5–3.0, default 1.5.

### Collapsed Comment Cards

A collapsed card shows at most 9 lines. The clamp is applied by `comment-fit.ts` after render, not by CSS alone, because CSS cannot tell where the last fully visible line ends or whether anything is hidden:

- The clamp lives on an inner `.pdf-comment-preview-body`, never on the padded `.pdf-comment-preview`. Bottom padding inside an `overflow: hidden` box masks nothing — clamping the padded card leaves the next line visible inside the padding.
- Boundaries are measured with `Range.getClientRects()` over text nodes (plus atomic blocks such as images), so mixed line heights from headings and lists are handled. Note these are glyph rects, ~2–3px shorter than the line box.
- The clamp snaps down to the lowest boundary that fits, so a line is never cut in half. Card heights therefore vary by up to one line — deliberate.
- `.is-truncated` on the marker is what draws the chevron, so it appears only when a boundary sits below the clamp. A card whose overflow is pure trailing margin gets no chevron.
- The pass is re-run from `repositionMarkers()`, the single re-layout entry point (pane drag, `ResizeObserver`, `swapSelection`), because rewrapped text changes both the clamp point and whether anything is hidden.

### Marker Layout

`layoutMarkers()` (`marker-layout.ts`) places each card at `pageEl.offsetTop + yNorm * pageEl.offsetHeight` and pushes a card down only when it would overlap the one above, leaving a 10px gap. It is **stateless** — recomputed from the ideal tops on every run — so growth is never ratcheted in: a card that grows while being edited pushes its neighbours down, and they return to their anchors when it shrinks.

Consequence worth knowing: several comments anchored to the same line of the PDF cannot all sit beside it, and since displacement is downward-only it accumulates. Measured on `Sandbox/CyanoCapture_BSA_TPP.pdf`, where three comments share one anchor, the last card sits 388px below its highlight. The stored anchors are exact (`yNorm` equals the highlight-rect centre); this is the layout policy, not a bug. `mock/index.html?fixture=bsa` reproduces it, and `mock.alignmentReport()` measures the drift.

Three call sites drive the sweep:
- `renderCommentMarkers()` — full rebuild; swaps the staged cards into the live track *before* measuring, because `.pdf-comments-staging` is 0px wide (a card measures 6 × 186 there versus 293 × 77 live).
- `repositionMarkers({ refit })` — pane width changes (`refit: true`, re-runs the collapsed-card clamp) and live editing (`refit: false`, heights changed but wrapping did not).
- `observeActiveMarkerHeight()` — a `ResizeObserver` on the selected card, rAF-throttled to one sweep per frame, so a growing editor reflows its neighbours as you type. Observing the card rather than hooking `input` also covers paste, suggester insertion, undo and IME.

The track height is `max(pdfContainer.scrollHeight, lastCardBottom)`, applied unconditionally so shrinking text reclaims the space.

### Scroll Sync

The comments pane and PDF container have synchronised scroll positions. Comment markers are absolutely positioned in `.pdf-comments-track`, whose coordinate space matches the PDF container's scroll space.

### PDF.js Worker Loading

The worker file cannot be loaded via `plugin:` URLs due to CORS restrictions in Obsidian's `app://obsidian.md` origin. Instead, the plugin reads the worker file from disk using Node `fs`, creates a `Blob`, and generates a blob URL. Resolution tries multiple candidate directory names (`pluginDir`, runtime manifest `dir`, `pluginId`) to handle dev/production mismatches.

## Known Issues / Debt

- No automated tests for the view layer (UI, zoom, scroll sync); `comment-paths.ts`, `comment-store.ts`, `comment-fit.ts` and `bracket-wrap.ts` are covered by `npm test`. Layout rules that need a real layout engine are asserted in the mock harness via `mock.auditSummary()` (jsdom has no line boxes, so it cannot check them).
- No way to delete a comment that already has content.
- No error recovery if sidecar JSON is corrupted.
- Annotations are tied to absolute text positions; replacing the PDF with a different version silently misaligns them.
- Comment hotkey is `Ctrl+Alt+M`; save comment is `Ctrl/Cmd+Enter` when textarea is focused.
- Empty comments (no text typed) are auto-deleted on deselect.
