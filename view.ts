import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';

export const VIEW_TYPE_EXAMPLE = 'example-view';

type NormalizedRect = { x: number; y: number; w: number; h: number }; // 0..1 relative to page box
type PageRects = { pageNumber: number; rects: NormalizedRect[] };
type PdfAnnotation = {
    id: string;
    createdAt: number;
    selectedText: string;
    anchor: { pageNumber: number; yNorm: number };
    highlights: PageRects[];
};
type PdfAnnotationsFile = {
    version: 1;
    pdfPath: string;
    annotations: PdfAnnotation[];
};

function normalizePluginDir(input: string): string {
    // Handle values like:
    // - "magnifying-glass"
    // - ".obsidian/plugins/magnifying-glass"
    // - ".obsidian\\plugins\\magnifying-glass"
    const s = String(input ?? '').replace(/\\/g, '/');
    const parts = s.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
}

async function createPdfJsWorkerBlobUrl(pluginDir: string, basePath?: string): Promise<string | undefined> {
    // Desktop-only: use Node fs to read the worker file from the plugin folder and create a blob URL.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');

        if (!basePath) {
            console.warn('[pdf-worker] basePath is undefined');
            return undefined;
        }

        const normalizedDir = normalizePluginDir(pluginDir);
        const workerPath = path.join(basePath, '.obsidian', 'plugins', normalizedDir, 'pdf.worker.js');
        if (!fs.existsSync(workerPath)) {
            console.warn('[pdf-worker] worker not found at', workerPath);
            return undefined;
        }

        const workerCode = fs.readFileSync(workerPath, 'utf8');
        // Use a blob URL to avoid CORS restrictions from `app://obsidian.md` when loading module workers.
        const blob = new Blob([workerCode], { type: 'text/javascript' });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.warn('[pdf-worker] failed to build workerSrc:', e);
        return undefined;
    }
}

async function resolvePdfWorkerSrc(
    pluginDirCandidates: string[],
    basePath?: string
): Promise<string | undefined> {
    for (const dir of pluginDirCandidates) {
        if (!dir) continue;
        const src = await createPdfJsWorkerBlobUrl(dir, basePath);
        if (src) return src;
    }
    return undefined;
}

// Lazy load PDF viewer to avoid import issues
let PDFViewerComponent: any = null;
async function getPDFViewerComponent() {
    if (!PDFViewerComponent) {
        const module = await import('./pdf-viewer');
        PDFViewerComponent = module.PDFViewerComponent;
    }
    return PDFViewerComponent;
}

export class ExampleView extends ItemView {
    private pdfContainer: HTMLElement;
    private pdfViewer: any = null;
    private controlsSection: HTMLElement;
    private viewerRow: HTMLElement;
    private commentsPane: HTMLElement;
    private commentsTrack: HTMLElement;
    private annotations: PdfAnnotation[] = [];
    private currentPdfPath: string | null = null;
    private isSyncingScroll = false;
    private pluginId: string;
    private pluginDir: string;

    constructor(leaf: WorkspaceLeaf, opts: { pluginId: string; pluginDir: string }) {
        super(leaf);
        this.pluginId = opts.pluginId;
        this.pluginDir = opts.pluginDir;
    }

    getViewType(): string {
        return VIEW_TYPE_EXAMPLE;
    }

    getDisplayText(): string {
        return 'PDF Viewer';
    }

    private getContextMenuActions(): any[] {
        return [
            {
                id: 'copy',
                label: 'Copy',
                icon: '📋',
                callback: (text: string) => {
                    navigator.clipboard.writeText(text);
                    console.log('Copied to clipboard:', text);
                }
            },
            {
                id: 'comment',
                label: 'Comment',
                icon: '💬',
                callback: (text: string) => {
                    // Fire-and-forget; the context menu callback is sync
                    void this.handleCommentAction(text);
                }
            },
            {
                id: 'copy-to-note',
                label: 'Copy to Active Note',
                icon: '📝',
                callback: (text: string) => {
                    this.copyToActiveNote(text);
                }
            },
            {
                id: 'create-note',
                label: 'Create Note from Selection',
                icon: '➕',
                callback: (text: string) => {
                    this.createNoteFromSelection(text);
                }
            }
        ];
    }

    private async copyToActiveNote(text: string): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            const content = await this.app.vault.read(activeFile);
            await this.app.vault.modify(activeFile, content + '\n\n' + text);
            console.log('Added to note:', activeFile.path);
        } else {
            console.log('No active markdown file');
        }
    }

    private async createNoteFromSelection(text: string): Promise<void> {
        const fileName = `PDF Extract ${Date.now()}.md`;
        await this.app.vault.create(fileName, text);
        console.log('Created note:', fileName);
    }

    async onOpen(): Promise<void> {
        console.log('=== PDF VIEWER ONOPEN START ===');
        try {
            const container = this.contentEl;
            container.empty();
            container.addClass('pdf-view-container');
            // Force sane layout so content can't end up effectively zero-height/invisible due to parent styles.
            // (We keep this minimal; visuals are handled by styles.css)
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.height = '100%';
            container.style.overflow = 'hidden';
            container.style.minHeight = '0';
            
            // Create controls section
            this.controlsSection = container.createEl('div', { cls: 'controls-section' });
            
            // Header
            this.controlsSection.createEl('h2', { text: 'PDF Viewer' });
            
            // PDF input section
            const pdfInputSection = this.controlsSection.createEl('div', { cls: 'pdf-input-section' });
            
            pdfInputSection.createEl('label', {
                text: 'PDF Path (relative to vault root):',
                cls: 'pdf-input-label'
            });

            const inputContainer = pdfInputSection.createEl('div', { cls: 'pdf-input-container' });
            
            const pdfInput = inputContainer.createEl('input', {
                type: 'text',
                placeholder: 'e.g., My_PDF.pdf',
                cls: 'pdf-path-input'
            });

            const loadButton = inputContainer.createEl('button', {
                text: 'Load PDF',
                cls: 'mod-cta'
            });

            // Zoom controls
            const zoomContainer = pdfInputSection.createEl('div', { cls: 'zoom-controls' });
            
            const zoomOutBtn = zoomContainer.createEl('button', { text: '−', cls: 'zoom-btn' });
            const zoomLabel = zoomContainer.createEl('span', { text: '150%', cls: 'zoom-label' });
            const zoomInBtn = zoomContainer.createEl('button', { text: '+', cls: 'zoom-btn' });

            // Disable zoom controls while loading/zooming
            let isLoadingPdf = false;
            let isZooming = false;
            const updateZoomButtonsState = () => {
                const enabled = Boolean(this.pdfViewer) && !isLoadingPdf && !isZooming;
                zoomOutBtn.disabled = !enabled;
                zoomInBtn.disabled = !enabled;
            };
            // Initial state (no PDF loaded yet)
            updateZoomButtonsState();

            // Viewer row (PDF left + comments right), below the input/controls section
            this.viewerRow = container.createEl('div', { cls: 'pdf-viewer-row' });

            // Create PDF container (left)
            this.pdfContainer = this.viewerRow.createEl('div', { cls: 'pdf-viewer-container' });
            this.pdfContainer.style.minHeight = '0';

            // Create empty comments pane (right)
            this.commentsPane = this.viewerRow.createEl('div', { cls: 'pdf-comments-pane' });
            this.commentsTrack = this.commentsPane.createEl('div', { cls: 'pdf-comments-track' });

            // Scroll sync so comment markers align with PDF content while scrolling
            const syncScroll = (from: 'pdf' | 'comments') => {
                if (this.isSyncingScroll) return;
                this.isSyncingScroll = true;
                try {
                    if (from === 'pdf') {
                        this.commentsPane.scrollTop = this.pdfContainer.scrollTop;
                    } else {
                        this.pdfContainer.scrollTop = this.commentsPane.scrollTop;
                    }
                } finally {
                    this.isSyncingScroll = false;
                }
            };
            this.pdfContainer.addEventListener('scroll', () => syncScroll('pdf'), { passive: true });
            this.commentsPane.addEventListener('scroll', () => syncScroll('comments'), { passive: true });

            // Load button handler
            loadButton.addEventListener('click', async () => {
                const pdfPath = pdfInput.value.trim();
                if (!pdfPath) {
                    this.showMessage('Please enter a PDF path', 'error');
                    return;
                }

                try {
                    isLoadingPdf = true;
                    updateZoomButtonsState();
                    this.currentPdfPath = pdfPath;
                    this.annotations = [];
                    this.renderCommentMarkers();
                    this.renderHighlights();

                    console.log('Loading PDF:', pdfPath);
                    const file = this.app.vault.getAbstractFileByPath(pdfPath);
                    
                    if (file instanceof TFile && file.extension === 'pdf') {
                        const pdfData = await this.app.vault.readBinary(file);
                        console.log('PDF data loaded, size:', pdfData.byteLength);
                        
                        // Destroy previous viewer
                        if (this.pdfViewer) {
                            this.pdfViewer.destroy();
                        }
                        
                        // Create new viewer (lazy loaded)
                        const ViewerClass = await getPDFViewerComponent();
                        // IMPORTANT: `plugin:` URLs can't be loaded as module workers from `app://obsidian.md` (CORS).
                        // Use a blob URL created from the on-disk worker file instead.
                        const adapter: any = this.app.vault.adapter as any;
                        const basePath =
                            (typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : undefined) ??
                            (adapter?.basePath as string | undefined);
                        const runtimeDir =
                            (this.app as any)?.plugins?.plugins?.[this.pluginId]?.manifest?.dir as string | undefined;
                        const candidates: string[] = Array.from(
                            new Set([this.pluginDir, runtimeDir, this.pluginId].filter((v): v is string => Boolean(v)))
                        );
                        const workerSrc = await resolvePdfWorkerSrc(candidates, basePath);
                        console.log('[pdf-worker] basePath=', basePath, 'candidates=', candidates, 'workerSrc=', workerSrc);
                        if (!workerSrc) {
                            throw new Error(`[pdf-worker] Could not resolve workerSrc. basePath=${basePath} candidates=${candidates.join(',')}`);
                        }
                        this.pdfViewer = new ViewerClass(
                            this.pdfContainer,
                            this.getContextMenuActions(),
                            { workerSrc, revokeWorkerSrc: true }
                        );
                        
                        // Load the PDF
                        await this.pdfViewer.loadPdf(pdfData);
                        // Pages are fully rendered when loadPdf resolves
                        await this.loadAnnotationsForCurrentPdf();
                        this.updateCommentsTrackHeight();
                        this.renderCommentMarkers();
                        this.renderHighlights();
                        
                        // Show success
                        this.showMessage(`Loaded: ${pdfPath} (${this.pdfViewer.getPageCount()} pages)`, 'success');
                        
                        // Update zoom label
                        zoomLabel.textContent = `${Math.round(this.pdfViewer.getScale() * 100)}%`;
                    } else {
                        this.showMessage(`Error: ${pdfPath} is not a valid PDF file`, 'error');
                    }
                } catch (error: any) {
                    console.error('Error loading PDF:', error);
                    this.showMessage(`Error: ${error.message}`, 'error');
                    // Ensure we don't leave a half-initialized viewer around
                    if (this.pdfViewer) {
                        try { this.pdfViewer.destroy(); } catch { /* ignore */ }
                        this.pdfViewer = null;
                    }
                } finally {
                    isLoadingPdf = false;
                    updateZoomButtonsState();
                    this.updateCommentsTrackHeight();
                    this.renderCommentMarkers();
                    this.renderHighlights();
                }
            });

            // Zoom handlers
            zoomOutBtn.addEventListener('click', async () => {
                if (this.pdfViewer) {
                    try {
                        isZooming = true;
                        updateZoomButtonsState();
                        const newScale = Math.max(0.5, this.pdfViewer.getScale() - 0.25);
                        await this.pdfViewer.setScale(newScale);
                        zoomLabel.textContent = `${Math.round(newScale * 100)}%`;
                    } finally {
                        isZooming = false;
                        updateZoomButtonsState();
                        this.updateCommentsTrackHeight();
                        this.renderCommentMarkers();
                        this.renderHighlights();
                    }
                }
            });

            zoomInBtn.addEventListener('click', async () => {
                if (this.pdfViewer) {
                    try {
                        isZooming = true;
                        updateZoomButtonsState();
                        const newScale = Math.min(3, this.pdfViewer.getScale() + 0.25);
                        await this.pdfViewer.setScale(newScale);
                        zoomLabel.textContent = `${Math.round(newScale * 100)}%`;
                    } finally {
                        isZooming = false;
                        updateZoomButtonsState();
                        this.updateCommentsTrackHeight();
                        this.renderCommentMarkers();
                        this.renderHighlights();
                    }
                }
            });
            
            console.log('PDF VIEWER contentEl innerHTML:', container.innerHTML);
            console.log('=== PDF VIEWER ONOPEN COMPLETE ===');
            
        } catch (error) {
            console.error('PDF Viewer onOpen error:', error);
        }
    }

    private showMessage(text: string, type: 'success' | 'error'): void {
        const msg = this.controlsSection.createEl('p', {
            text,
            cls: `${type}-message`
        });
        setTimeout(() => msg.remove(), 3000);
    }

    async onClose(): Promise<void> {
        if (this.pdfViewer) {
            this.pdfViewer.destroy();
            this.pdfViewer = null;
        }
    }

    private updateCommentsTrackHeight(): void {
        if (!this.commentsTrack || !this.pdfContainer) return;
        // Keep the comments track the same scrollable height as the PDF container content
        this.commentsTrack.style.height = `${this.pdfContainer.scrollHeight}px`;
    }

    private renderCommentMarkers(): void {
        if (!this.commentsTrack || !this.pdfContainer) return;
        this.commentsTrack.empty();

        for (const a of this.annotations) {
            const pageEl = this.pdfContainer.querySelector(
                `.pdf-page-container[data-page-number="${a.anchor.pageNumber}"]`
            ) as HTMLElement | null;
            if (!pageEl) continue;

            const topPx = pageEl.offsetTop + (a.anchor.yNorm * pageEl.offsetHeight);
            const marker = this.commentsTrack.createEl('div', { cls: 'pdf-comment-marker' });
            // Align the TOP of the marker to the computed pixel Y
            marker.style.top = `${topPx}px`;
        }
    }

    private renderHighlights(): void {
        if (!this.pdfContainer) return;

        const pages = Array.from(this.pdfContainer.querySelectorAll('.pdf-page-container')) as HTMLElement[];
        for (const pageEl of pages) {
            let layer = pageEl.querySelector('.pdf-highlight-layer') as HTMLElement | null;
            if (!layer) {
                layer = pageEl.createEl('div', { cls: 'pdf-highlight-layer' });
            }
            layer.empty();
        }

        // Draw rects per page from all annotations
        for (const ann of this.annotations) {
            for (const pr of ann.highlights) {
                const pageEl = this.pdfContainer.querySelector(
                    `.pdf-page-container[data-page-number="${pr.pageNumber}"]`
                ) as HTMLElement | null;
                if (!pageEl) continue;

                const layer = pageEl.querySelector('.pdf-highlight-layer') as HTMLElement | null;
                if (!layer) continue;

                const pageW = pageEl.clientWidth || pageEl.offsetWidth;
                const pageH = pageEl.clientHeight || pageEl.offsetHeight;
                if (!pageW || !pageH) continue;

                for (const r of pr.rects) {
                    const el = layer.createEl('div', { cls: 'pdf-highlight-rect' });
                    el.style.left = `${r.x * pageW}px`;
                    el.style.top = `${r.y * pageH}px`;
                    el.style.width = `${r.w * pageW}px`;
                    el.style.height = `${r.h * pageH}px`;
                }
            }
        }
    }

    private getAnnotationsPathForPdf(pdfPath: string): string {
        return `${pdfPath}.mg-comments.json`;
    }

    private async loadAnnotationsForCurrentPdf(): Promise<void> {
        if (!this.currentPdfPath) return;

        const sidecar = this.getAnnotationsPathForPdf(this.currentPdfPath);
        try {
            const af = this.app.vault.getAbstractFileByPath(sidecar);
            if (!(af instanceof TFile)) {
                this.annotations = [];
                return;
            }

            const raw = await this.app.vault.read(af);
            const parsed = JSON.parse(raw) as PdfAnnotationsFile;
            if (parsed?.version !== 1 || parsed?.pdfPath !== this.currentPdfPath || !Array.isArray(parsed.annotations)) {
                this.annotations = [];
                return;
            }

            this.annotations = parsed.annotations;
        } catch (e) {
            console.warn('[annotations] Failed to load annotations:', e);
            this.annotations = [];
        }
    }

    private async saveAnnotationsForCurrentPdf(): Promise<void> {
        if (!this.currentPdfPath) return;
        const sidecar = this.getAnnotationsPathForPdf(this.currentPdfPath);

        const payload: PdfAnnotationsFile = {
            version: 1,
            pdfPath: this.currentPdfPath,
            annotations: this.annotations,
        };
        const json = JSON.stringify(payload, null, 2);

        const existing = this.app.vault.getAbstractFileByPath(sidecar);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, json);
        } else {
            await this.app.vault.create(sidecar, json);
        }
    }

    private getSelectionHighlightRectsFromCurrentSelection(): PageRects[] {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];

        const range = selection.getRangeAt(0);
        const rects = Array.from(range.getClientRects()).filter(r => r && r.width > 0.5 && r.height > 0.5);
        if (!rects.length) return [];

        const out = new Map<number, NormalizedRect[]>();

        for (const rect of rects) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const elAtPoint = document.elementFromPoint(cx, cy);
            const pageEl = elAtPoint?.closest?.('.pdf-page-container') as HTMLElement | null;
            if (!pageEl) continue;

            const pageNumber = Number(pageEl.dataset.pageNumber ?? pageEl.getAttribute('data-page-number') ?? NaN);
            if (!Number.isFinite(pageNumber)) continue;

            const pageRect = pageEl.getBoundingClientRect();
            if (!pageRect.width || !pageRect.height) continue;

            // Normalize to page box, clamp to [0..1]
            const x = (rect.left - pageRect.left) / pageRect.width;
            const y = (rect.top - pageRect.top) / pageRect.height;
            const w = rect.width / pageRect.width;
            const h = rect.height / pageRect.height;

            const nr: NormalizedRect = {
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
                w: Math.max(0, Math.min(1, w)),
                h: Math.max(0, Math.min(1, h)),
            };

            const arr = out.get(pageNumber) ?? [];
            arr.push(nr);
            out.set(pageNumber, arr);
        }

        return Array.from(out.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([pageNumber, rects]) => ({ pageNumber, rects }));
    }

    private async handleCommentAction(selectedText: string): Promise<void> {
        const text = String(selectedText ?? '').trim();
        if (!text) return;

        const anchor = this.getSelectionAnchorFromCurrentSelection();
        if (!anchor) {
            console.log('[comment] No selection anchor available');
            return;
        }

        const highlights = this.getSelectionHighlightRectsFromCurrentSelection();
        const ann: PdfAnnotation = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            createdAt: Date.now(),
            selectedText: text,
            anchor,
            highlights,
        };

        this.annotations.push(ann);
        this.updateCommentsTrackHeight();
        this.renderCommentMarkers();
        this.renderHighlights();
        await this.saveAnnotationsForCurrentPdf();

        console.log('[comment]', {
            selectedText: text,
            pageNumber: anchor.pageNumber,
            yNorm: anchor.yNorm,
            yPercent: Math.round(anchor.yNorm * 10000) / 100, // 2dp
            highlightPages: highlights.map(h => h.pageNumber),
        });
    }

    private getSelectionAnchorFromCurrentSelection(): { pageNumber: number; yNorm: number } | null {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || rect.height === 0) return null;

        // Find the page element containing the selection
        const anchorEl =
            selection.anchorNode instanceof Element
                ? selection.anchorNode
                : selection.anchorNode?.parentElement ?? null;
        const commonEl =
            range.commonAncestorContainer instanceof Element
                ? range.commonAncestorContainer
                : range.commonAncestorContainer?.parentElement ?? null;

        const pageEl =
            (anchorEl?.closest?.('.pdf-page-container') ?? commonEl?.closest?.('.pdf-page-container')) as
                | HTMLElement
                | null;
        if (!pageEl) return null;

        const pageRect = pageEl.getBoundingClientRect();
        if (!pageRect || pageRect.height === 0) return null;

        const centerY = rect.top + rect.height / 2;
        let yNorm = (centerY - pageRect.top) / pageRect.height;
        yNorm = Math.max(0, Math.min(1, yNorm));

        const pageNumber = Number(pageEl.dataset.pageNumber ?? pageEl.getAttribute('data-page-number') ?? NaN);
        if (!Number.isFinite(pageNumber)) return null;

        return { pageNumber, yNorm };
    }
}
