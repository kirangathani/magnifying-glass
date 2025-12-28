import { ContextMenu, ContextMenuAction } from './context-menu';

// PDF.js types
type PDFDocumentProxy = any;
type PDFPageProxy = any;
type TextContent = any;
type PageViewport = any;

// Load PDF.js using require (CommonJS compatible)
let pdfjsLib: any = null;

function getPdfJs(): any {
    if (pdfjsLib) return pdfjsLib;
    
    try {
        // Use the classic build from pdfjs-dist@2.x for compatibility
        pdfjsLib = require('pdfjs-dist/build/pdf.js');
        // NOTE: We run PDF.js without a worker (see getDocument({ disableWorker: true }) below),
        // because worker URLs are finicky inside Obsidian's plugin environment.
        console.log('PDF.js loaded successfully');
        return pdfjsLib;
    } catch (error) {
        console.error('Failed to load PDF.js:', error);
        throw error;
    }
}

/**
 * Custom PDF Viewer using PDF.js
 * Renders PDF pages with text layer for selection
 */
export class PDFViewerComponent {
    private container: HTMLElement;
    private pdfDoc: PDFDocumentProxy | null = null;
    private currentScale: number = 1.5;
    private pageContainers: Map<number, HTMLElement> = new Map();
    private contextMenu: ContextMenu;
    private onTextSelected: ((text: string) => void) | null = null;
    private workerSrc?: string;
    private revokeWorkerSrc?: boolean;
    private previewScale: number | null = null;

    constructor(
        container: HTMLElement,
        contextMenuActions: ContextMenuAction[],
        options?: { workerSrc?: string; revokeWorkerSrc?: boolean }
    ) {
        this.container = container;
        this.container.classList.add('pdf-viewer');
        this.workerSrc = options?.workerSrc;
        this.revokeWorkerSrc = options?.revokeWorkerSrc;
        
        // Create context menu
        this.contextMenu = new ContextMenu(contextMenuActions);
        
        // Set up right-click handler
        this.container.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
        
        // Set up selection change handler
        this.container.addEventListener('mouseup', () => this.handleSelectionChange());
    }

    /**
     * Apply a temporary visual-only zoom (CSS transform) without re-rendering pages.
     * This is useful for pinch-to-zoom gestures; callers should later call setScale()
     * to re-render at the new scale and then clearPreviewScale().
     */
    setPreviewScale(scale: number): void {
        this.previewScale = scale;
        const scrollContainer = this.container.querySelector('.pdf-scroll-container') as HTMLElement | null;
        if (!scrollContainer) return;

        const factor = scale / (this.currentScale || 1);
        scrollContainer.style.transformOrigin = '0 0';
        scrollContainer.style.transform = `scale(${factor})`;
    }

    /**
     * Remove any temporary preview zoom transform.
     */
    clearPreviewScale(): void {
        this.previewScale = null;
        const scrollContainer = this.container.querySelector('.pdf-scroll-container') as HTMLElement | null;
        if (!scrollContainer) return;
        scrollContainer.style.transform = '';
        scrollContainer.style.transformOrigin = '';
    }

    /**
     * Load a PDF from an ArrayBuffer
     */
    async loadPdf(data: ArrayBuffer): Promise<void> {
        try {
            // Get PDF.js library
            const pdfjs = getPdfJs();
            if (this.workerSrc && pdfjs?.GlobalWorkerOptions) {
                pdfjs.GlobalWorkerOptions.workerSrc = this.workerSrc;
            }
            // Ensure no stale preview transform survives a fresh load.
            this.clearPreviewScale();
            
            // Clear previous content
            this.container.empty();
            this.pageContainers.clear();
            
            // Load the PDF document
            const loadingTask = pdfjs.getDocument({ data });
            this.pdfDoc = await loadingTask.promise;
            
            console.log(`PDF loaded: ${this.pdfDoc.numPages} pages`);
            
            // Create scroll container
            const scrollContainer = document.createElement('div');
            scrollContainer.className = 'pdf-scroll-container';
            this.container.appendChild(scrollContainer);
            
            // Render all pages
            for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
                await this.renderPage(pageNum, scrollContainer);
            }
        } catch (error) {
            console.error('Error loading PDF:', error);
            throw error;
        }
    }

    /**
     * Render a single page
     */
    private async renderPage(pageNum: number, scrollContainer: HTMLElement): Promise<void> {
        if (!this.pdfDoc) return;
        
        const pdfjs = getPdfJs();
        const page = await this.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: this.currentScale });
        
        // Create page container
        const pageContainer = document.createElement('div');
        pageContainer.className = 'pdf-page-container';
        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;
        pageContainer.dataset.pageNumber = String(pageNum);
        this.pageContainers.set(pageNum, pageContainer);
        
        // Create canvas for rendering
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        const context = canvas.getContext('2d');
        if (!context) return;
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        // Render the page to canvas
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        pageContainer.appendChild(canvas);
        
        // Create text layer for selection
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'pdf-text-layer';
        
        // Get text content
        const textContent = await page.getTextContent();
        
        // Render text layer
        await this.renderTextLayer(textLayerDiv, textContent, viewport, pdfjs);
        
        pageContainer.appendChild(textLayerDiv);
        scrollContainer.appendChild(pageContainer);
    }

    /**
     * Render the text layer for a page
     */
    private async renderTextLayer(
        container: HTMLElement,
        textContent: TextContent,
        viewport: PageViewport,
        pdfjs: any
    ): Promise<void> {
        // Use PDF.js built-in text layer renderer for correct positioning/selection.
        container.innerHTML = '';
        container.classList.add('textLayer');

        if (typeof pdfjs.renderTextLayer === 'function') {
            const task = pdfjs.renderTextLayer({
                textContent,
                container,
                viewport,
                textDivs: [],
                enhanceTextSelection: true,
            });
            // pdfjs-dist@2 returns { promise }
            if (task?.promise) await task.promise;
            return;
        }

        // Fallback: keep our simple renderer if renderTextLayer isn't available.
        for (const item of textContent.items) {
            if ('str' in item && (item as any).str) {
                const textItem = item as any;
                const span = document.createElement('span');
                span.textContent = textItem.str;
                const tx = pdfjs.Util.transform(viewport.transform, textItem.transform);
                const fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
                const left = tx[4];
                const top = tx[5] - fontHeight;
                span.style.left = `${left}px`;
                span.style.top = `${top}px`;
                span.style.fontSize = `${fontHeight}px`;
                span.style.fontFamily = textItem.fontName || 'sans-serif';
                container.appendChild(span);
            }
        }
    }

    /**
     * Handle right-click context menu
     */
    private handleContextMenu(e: MouseEvent): void {
        const selectedText = this.getSelectedText();
        if (selectedText) {
            e.preventDefault();
            this.contextMenu.show(e.clientX, e.clientY, selectedText);
        }
    }

    /**
     * Handle text selection changes
     */
    private handleSelectionChange(): void {
        const selectedText = this.getSelectedText();
        if (selectedText && this.onTextSelected) {
            this.onTextSelected(selectedText);
        }
    }

    /**
     * Get currently selected text
     */
    getSelectedText(): string {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return '';
        
        // Check if selection is within our container
        const anchorNode = selection.anchorNode;
        if (anchorNode && this.container.contains(anchorNode)) {
            return selection.toString().trim();
        }
        
        return '';
    }

    /**
     * Set callback for text selection
     */
    setOnTextSelected(callback: (text: string) => void): void {
        this.onTextSelected = callback;
    }

    /**
     * Set zoom level
     */
    async setScale(scale: number): Promise<void> {
        if (scale === this.currentScale || !this.pdfDoc) return;
        // A real re-render should always happen from a clean visual state.
        this.clearPreviewScale();
        
        this.currentScale = scale;
        
        // Re-render all pages with new scale
        const scrollContainer = this.container.querySelector('.pdf-scroll-container');
        if (scrollContainer) {
            scrollContainer.innerHTML = '';
            this.pageContainers.clear();
            
            for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
                await this.renderPage(pageNum, scrollContainer as HTMLElement);
            }
        }
    }

    /**
     * Get current scale
     */
    getScale(): number {
        return this.currentScale;
    }

    /**
     * Get number of pages
     */
    getPageCount(): number {
        return this.pdfDoc?.numPages ?? 0;
    }

    /**
     * Clean up resources
     */
    destroy(): void {
        this.contextMenu.hide();
        this.clearPreviewScale();
        if (this.pdfDoc) {
            this.pdfDoc.destroy();
            this.pdfDoc = null;
        }
        this.pageContainers.clear();

        if (this.revokeWorkerSrc && this.workerSrc?.startsWith('blob:')) {
            try { URL.revokeObjectURL(this.workerSrc); } catch { /* ignore */ }
        }
    }
}
