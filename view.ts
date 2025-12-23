import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';

export const VIEW_TYPE_EXAMPLE = 'example-view';

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
}
