/**
 * Standalone browser harness for the PDF Commenter viewer.
 *
 * It reproduces the plugin's DOM skeleton and drives the REAL PDFViewerComponent
 * from pdf-viewer.ts, so layout/scroll/zoom behaviour observed here is the
 * behaviour the plugin has. Comment markers are faked (plain text instead of
 * MarkdownRenderer) but positioned with the same greedy collision sweep used by
 * view.ts renderCommentMarkers().
 */
import './obsidian-shim';
import { PDFViewerComponent } from '../pdf-viewer';
import { fitCollapsedPreviews } from '../comment-fit';
import { handleBracketKeydown } from '../bracket-wrap';
import { WikilinkSuggest } from '../wikilink-suggest';
import { App } from 'obsidian';
import { auditPreview, PreviewAudit } from './preview-audit';
import { layoutMarkers } from '../marker-layout';

type MockAnnotation = {
    id: string;
    pageNumber: number;
    yNorm: number;
    /** Rendered-markdown stand-in: the same element shapes MarkdownRenderer emits. */
    html: string;
};

const SENTENCE =
    'Comparative analysis of the extraction conditions showed measurable differences between the two preparations across every replicate.';

/**
 * Content matrix for the fitting rules: card heights either side of the 9-line
 * budget, mixed line heights, unbreakable tokens, and an atomic block.
 */
const CONTENT: string[] = [
    // 1 line: no clamp, no chevron.
    '<p>Short note.</p>',
    // ~4 lines at default pane width.
    `<p>${SENTENCE}</p>`,
    // Well over the budget: clamp + chevron.
    `<p>${SENTENCE} ${SENTENCE} ${SENTENCE} ${SENTENCE} ${SENTENCE}</p>`,
    // Mixed line heights: the clamp must not land inside the list.
    `<h3>Method</h3><p>${SENTENCE}</p><ul><li>Steeping time held constant.</li>` +
        `<li>Leaf mass measured to two decimal places.</li><li>${SENTENCE}</li></ul>`,
    // Long unbreakable tokens: allowed to break mid-token, nothing else.
    '<p>See https://example.com/very/long/path/that/cannot/be/broken/at/any/space/segment-one-two-three ' +
        'and Dutta_et_al_2024_comparative_analysis_green_blue_tea_west_bengal.pdf for the source data.</p>',
    // Just under the budget (8 short lines).
    '<p>Line one here.<br>Line two here.<br>Line three here.<br>Line four here.<br>' +
        'Line five here.<br>Line six here.<br>Line seven here.<br>Line eight here.</p>',
    // Atomic block with no line boxes of its own, below the budget's worth of text.
    `<p>${SENTENCE} ${SENTENCE}</p><svg width="80" height="80"><rect width="80" height="80" fill="#fff"/></svg>`,
    // Wikilink-bearing card, to keep the rendered-link path exercised.
    `<p>Cross-reference: <a class="internal-link" href="#">Green tea</a>. ${SENTENCE}</p>`,
];

/**
 * The real annotation set from Sandbox/CyanoCapture_BSA_TPP.pdf, verbatim from
 * its sidecar and comment notes. Loaded with `?fixture=bsa` so the reported
 * misalignment can be reproduced and measured rather than argued about.
 */
const BSA_TPP_FIXTURE: MockAnnotation[] = [
    { id: 'bsa-0', pageNumber: 1, yNorm: 0.04395699786324787,
        html: '<p>Hello. I am testing a comment here.<br>Testing this comment</p>' },
    { id: 'bsa-1', pageNumber: 1, yNorm: 0.2580528846153846,
        html: '<p>Hello! This is a test comment.<br>Testing.<br>Still Testing!<br>Still testing the comment<br>Still doing the tests</p><p>Testinf!!!</p>' },
    { id: 'bsa-2', pageNumber: 1, yNorm: 0.2580528846153846, html: '<p>Test!</p>' },
    { id: 'bsa-3', pageNumber: 1, yNorm: 0.3298076923076923, html: '<p>Test</p>' },
    { id: 'bsa-4', pageNumber: 1, yNorm: 0.3298076923076923,
        html: '<p>testing MOVEMENT</p><p>jnlk<br>nlkl<br>jjklkn<br>kknkkl<br>jll<br>ljnl<br>llnlnk<br>knl</p>' },
    { id: 'bsa-5', pageNumber: 1, yNorm: 0.3298076923076923, html: '<p>Hello</p>' },
];

function buildAnnotations(pageCount: number): MockAnnotation[] {
    if (location.search.includes('bsa')) return BSA_TPP_FIXTURE.filter(a => a.pageNumber <= pageCount);
    const out: MockAnnotation[] = [];
    let n = 0;
    const spec: Array<[number, number]> = [
        [1, 0.12], [1, 0.18], [1, 0.22], [1, 0.65],
        [2, 0.3], [2, 0.34], [3, 0.5], [4, 0.2], [4, 0.8],
    ];
    for (const [page, yNorm] of spec) {
        if (page > pageCount) continue;
        out.push({
            id: `mock-${n}`,
            pageNumber: page,
            yNorm,
            html: CONTENT[n % CONTENT.length],
        });
        n += 1;
    }
    return out;
}

class MockHarness {
    private root: HTMLElement;
    private pdfContainer!: HTMLElement;
    private commentsPane!: HTMLElement;
    private commentsTrack!: HTMLElement;
    private viewerRow!: HTMLElement;
    private resizer!: HTMLElement;
    private zoomLabel!: HTMLElement;
    private statsEl!: HTMLElement;
    private viewer: PDFViewerComponent | null = null;
    private annotations: MockAnnotation[] = [];
    private selectedId: string | null = null;
    private isSyncingScroll = false;
    private isZooming = false;
    private activeSuggest: WikilinkSuggest | null = null;
    private activeTextarea: HTMLTextAreaElement | null = null;
    private activeMarkerObserver: ResizeObserver | null = null;
    private activeMarkerRaf: number | null = null;
    private suggestApp = new App();

    constructor(root: HTMLElement) {
        this.root = root;
        this.buildDom();
    }

    private buildDom(): void {
        const container = this.root;
        container.classList.add('pdf-view-container');

        const controls = container.createDiv({ cls: 'controls-section' });
        const header = controls.createDiv({ cls: 'pdf-header-row' });
        header.createEl('h2', { text: 'Mock viewer (real PDFViewerComponent)' });

        const zoomRow = controls.createDiv({ cls: 'zoom-controls' });
        const zoomOut = zoomRow.createEl('button', { text: '−', cls: 'zoom-btn' });
        this.zoomLabel = zoomRow.createSpan({ text: '150%', cls: 'zoom-label' });
        const zoomIn = zoomRow.createEl('button', { text: '+', cls: 'zoom-btn' });
        this.statsEl = zoomRow.createSpan({ cls: 'mock-stats' });

        this.viewerRow = container.createDiv({ cls: 'pdf-viewer-row' });
        this.pdfContainer = this.viewerRow.createDiv({ cls: 'pdf-viewer-container' });
        this.resizer = this.viewerRow.createDiv({ cls: 'pdf-pane-resizer' });
        this.commentsPane = this.viewerRow.createDiv({ cls: 'pdf-comments-pane' });
        this.commentsTrack = this.commentsPane.createDiv({ cls: 'pdf-comments-track' });

        zoomOut.addEventListener('click', () => void this.stepZoom(-0.25));
        zoomIn.addEventListener('click', () => void this.stepZoom(0.25));

        this.wireScrollSync();
        this.wirePinchZoom();
        this.wireResizer();
        this.observePaneWidth();

        window.addEventListener('resize', () => this.updateStats());
    }

    private wireScrollSync(): void {
        const sync = (from: 'pdf' | 'comments') => {
            if (this.isSyncingScroll) return;
            this.isSyncingScroll = true;
            try {
                if (from === 'pdf') this.commentsPane.scrollTop = this.pdfContainer.scrollTop;
                else this.pdfContainer.scrollTop = this.commentsPane.scrollTop;
            } finally {
                this.isSyncingScroll = false;
            }
        };
        this.pdfContainer.addEventListener('scroll', () => { sync('pdf'); this.updateStats(); }, { passive: true });
        this.commentsPane.addEventListener('scroll', () => sync('comments'), { passive: true });
    }

    /** Port of view.ts pinch handling: CSS-transform preview, debounced commit. */
    private wirePinchZoom(): void {
        let pinchTargetScale: number | null = null;
        let pinchCommitTimer: number | null = null;
        const clampScale = (s: number) => Math.max(0.5, Math.min(3, s));

        const anchorByScroll = () => {
            const A = this.pdfContainer.clientHeight / 2;
            const centerY = this.pdfContainer.scrollTop + A;
            const pages = Array.from(this.pdfContainer.querySelectorAll<HTMLElement>('.pdf-page-container'));
            for (const pageEl of pages) {
                const top = pageEl.offsetTop;
                if (centerY < top || centerY > top + pageEl.offsetHeight) continue;
                if (!pageEl.offsetHeight) continue;
                const pageNumber = Number(pageEl.dataset.pageNumber ?? NaN);
                if (!Number.isFinite(pageNumber)) continue;
                return { pageNumber, yNorm: Math.max(0, Math.min(1, (centerY - top) / pageEl.offsetHeight)) };
            }
            return null;
        };

        const restoreAnchor = (anchor: { pageNumber: number; yNorm: number } | null) => {
            if (!anchor) return;
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${anchor.pageNumber}"]`
            );
            if (!pageEl) return;
            const next = pageEl.offsetTop + anchor.yNorm * pageEl.offsetHeight - this.pdfContainer.clientHeight / 2;
            if (Number.isFinite(next)) this.pdfContainer.scrollTop = Math.max(0, next);
        };

        this.pdfContainer.addEventListener('wheel', (e: WheelEvent) => {
            if (!e.ctrlKey || !this.viewer) return;
            e.preventDefault();
            if (this.isZooming) return;

            const currentScale = this.viewer.getScale();
            const base = pinchTargetScale ?? currentScale;
            const next = clampScale(base * Math.exp(-e.deltaY * 0.002));
            pinchTargetScale = next;

            const oldF = base / (currentScale || 1);
            const newF = next / (currentScale || 1);
            if (oldF > 0 && newF > 0) {
                const A = this.pdfContainer.clientHeight / 2;
                const nextScrollTop = this.pdfContainer.scrollTop + A * (1 / oldF - 1 / newF);
                if (Number.isFinite(nextScrollTop)) this.pdfContainer.scrollTop = Math.max(0, nextScrollTop);
            }

            this.viewer.setPreviewScale(next);
            this.zoomLabel.textContent = `${Math.round(next * 100)}%`;
            this.updateStats();

            if (pinchCommitTimer) window.clearTimeout(pinchCommitTimer);
            pinchCommitTimer = window.setTimeout(() => {
                void (async () => {
                    if (!this.viewer || pinchTargetScale == null) return;
                    const anchor = anchorByScroll();
                    try {
                        this.isZooming = true;
                        await this.viewer.setScale(pinchTargetScale);
                        this.viewer.clearPreviewScale();
                        restoreAnchor(anchor);
                        this.zoomLabel.textContent = `${Math.round(this.viewer.getScale() * 100)}%`;
                    } finally {
                        this.isZooming = false;
                        this.updateCommentsTrackHeight();
                        this.renderCommentMarkers();
                        pinchTargetScale = null;
                        this.updateStats();
                    }
                })();
            }, 160);
        }, { passive: false });
    }

    /** Prototype of the draggable comments-pane divider (todo item 3). */
    private wireResizer(): void {
        const MIN_PANE = 280;
        let dragging = false;
        let moved = false;
        let rafId: number | null = null;

        const widthFromClientX = (clientX: number): number => {
            const rowRect = this.viewerRow.getBoundingClientRect();
            const raw = rowRect.right - clientX;
            const max = Math.max(MIN_PANE, rowRect.width * 0.6);
            return Math.round(Math.max(MIN_PANE, Math.min(max, raw)));
        };

        this.resizer.addEventListener('pointerdown', (e: PointerEvent) => {
            dragging = true;
            moved = false;
            this.resizer.setPointerCapture(e.pointerId);
            this.resizer.classList.add('is-dragging');
            e.preventDefault();
        });

        this.resizer.addEventListener('pointermove', (e: PointerEvent) => {
            if (!dragging) return;
            moved = true;
            this.setPaneWidth(widthFromClientX(e.clientX));
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                this.repositionMarkers();
                this.updateStats();
            });
        });

        const end = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            try { this.resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            this.resizer.classList.remove('is-dragging');
            if (!moved) return;
            this.updateCommentsTrackHeight();
            this.repositionMarkers();
            this.updateStats();
        };
        this.resizer.addEventListener('pointerup', end);
        this.resizer.addEventListener('pointercancel', end);

        this.resizer.addEventListener('dblclick', () => {
            this.commentsPane.style.flex = '';
            this.commentsPane.style.width = '';
            this.updateCommentsTrackHeight();
            this.repositionMarkers();
            this.updateStats();
        });
    }

    /** Mirrors view.ts observeCommentsPaneWidth(). */
    private observePaneWidth(): void {
        let lastWidth = this.commentsPane.clientWidth;
        let rafId: number | null = null;
        const ro = new ResizeObserver(() => {
            const w = this.commentsPane.clientWidth;
            if (w === lastWidth) return;
            lastWidth = w;
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                this.repositionMarkers();
                this.updateStats();
            });
        });
        ro.observe(this.commentsPane);
    }

    setPaneWidth(px: number): void {
        this.commentsPane.style.flex = `0 0 ${px}px`;
        this.commentsPane.style.width = `${px}px`;
    }

    private async stepZoom(delta: number): Promise<void> {
        if (!this.viewer) return;
        const next = Math.max(0.5, Math.min(3, this.viewer.getScale() + delta));
        this.isZooming = true;
        try {
            await this.viewer.setScale(next);
            this.zoomLabel.textContent = `${Math.round(next * 100)}%`;
        } finally {
            this.isZooming = false;
            this.updateCommentsTrackHeight();
            this.renderCommentMarkers();
            this.updateStats();
        }
    }

    async setScale(scale: number): Promise<void> {
        if (!this.viewer) return;
        this.isZooming = true;
        try {
            await this.viewer.setScale(scale);
            this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
        } finally {
            this.isZooming = false;
            this.updateCommentsTrackHeight();
            this.renderCommentMarkers();
            this.updateStats();
        }
    }

    /** Timings for the scroll-smoothness diagnosis (todo item 4). */
    timing: Record<string, number> = {};

    async load(url: string): Promise<void> {
        const tFetch = performance.now();
        const res = await fetch(url);
        const data = await res.arrayBuffer();
        this.timing.fetchMs = Math.round(performance.now() - tFetch);
        this.viewer = new PDFViewerComponent(this.pdfContainer, [], { workerSrc: './pdf.worker.js' });
        const tRender = performance.now();
        // loadPdf() renders EVERY page before it resolves; nothing is interactive until then.
        await this.viewer.loadPdf(data);
        this.timing.eagerRenderAllPagesMs = Math.round(performance.now() - tRender);
        this.timing.pageCount = this.viewer.getPageCount();
        this.annotations = buildAnnotations(this.viewer.getPageCount());
        this.updateCommentsTrackHeight();
        this.renderCommentMarkers();
        this.updateStats();
    }

    private updateCommentsTrackHeight(): void {
        this.commentsTrack.style.height = `${this.pdfContainer.scrollHeight}px`;
    }

    /** Mirrors view.ts renderCommentMarkers() layout maths with fake content. */
    renderCommentMarkers(): void {
        this.disconnectActiveMarkerObserver();
        this.commentsTrack.empty();
        const items: { ann: MockAnnotation; idealTop: number; el: HTMLElement }[] = [];
        for (const a of this.annotations) {
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${a.pageNumber}"]`
            );
            if (!pageEl) continue;
            items.push({ ann: a, idealTop: pageEl.offsetTop + a.yNorm * pageEl.offsetHeight, el: null! });
        }
        items.sort((a, b) => a.idealTop - b.idealTop);

        for (const item of items) {
            const marker = this.commentsTrack.createDiv({ cls: 'pdf-comment-marker' });
            const isSelected = item.ann.id === this.selectedId;
            if (!isSelected) marker.classList.add('is-collapsed');
            marker.classList.toggle('is-selected', isSelected);
            marker.dataset.annotationId = item.ann.id;
            if (isSelected) {
                this.buildEditor(marker, item.ann);
            } else {
                const preview = marker.createDiv({ cls: 'pdf-comment-preview' });
                const body = preview.createDiv({ cls: 'pdf-comment-preview-body' });
                body.innerHTML = item.ann.html;
            }
            marker.addEventListener('click', () => {
                this.selectedId = this.selectedId === item.ann.id ? null : item.ann.id;
                this.renderCommentMarkers();
            });
            item.el = marker;
        }

        // Same fitting pass the plugin runs (comment-fit.ts).
        fitCollapsedPreviews(items.map(i => i.el).filter(el => el.classList.contains('is-collapsed')));

        const { tops, contentBottom } = layoutMarkers(
            items.map(i => ({ idealTop: i.idealTop, height: i.el.offsetHeight })),
        );
        items.forEach((item, i) => { item.el.style.top = `${tops[i]}px`; });
        this.applyTrackHeight(contentBottom);
    }

    /** Mirrors view.ts applyCommentsTrackHeight(). */
    private applyTrackHeight(contentBottom: number): void {
        const height = Math.max(this.pdfContainer.scrollHeight, Math.ceil(contentBottom));
        this.commentsTrack.style.height = `${height}px`;
    }

    /**
     * Real textarea for the selected card, wired exactly as view.ts wires it, so
     * the bracket-wrap keystrokes can be driven from DevTools.
     */
    private buildEditor(marker: HTMLElement, ann: MockAnnotation): void {
        const editor = marker.createDiv({ cls: 'pdf-comment-inline-editor' });
        const textarea = editor.createEl('textarea', { cls: 'pdf-comment-inline-textarea' });
        textarea.setAttribute('rows', '3');
        textarea.setAttribute('placeholder', 'Write a comment… (supports [[backlinks]])');
        textarea.value = ann.html.replace(/<[^>]+>/g, '');
        editor.createDiv({ cls: 'pdf-comment-inline-footer' })
            .createEl('button', { cls: 'pdf-comment-inline-save', text: 'Save' });

        textarea.addEventListener('click', (e) => e.stopPropagation());
        textarea.addEventListener('keydown', (e) => {
            if (handleBracketKeydown(textarea, e)) e.preventDefault();
        });
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        });

        this.activeSuggest?.destroy();
        this.activeSuggest = new WikilinkSuggest(this.suggestApp, textarea);
        this.activeTextarea = textarea;
        this.observeActiveMarkerHeight(marker);
    }

    /** Mirrors view.ts observeActiveMarkerHeight(): live reflow while typing. */
    private observeActiveMarkerHeight(marker: HTMLElement): void {
        this.disconnectActiveMarkerObserver();
        let lastHeight = marker.offsetHeight;
        this.activeMarkerObserver = new ResizeObserver(() => {
            const height = marker.offsetHeight;
            if (height === lastHeight) return;
            lastHeight = height;
            if (this.activeMarkerRaf != null) return;
            this.activeMarkerRaf = requestAnimationFrame(() => {
                this.activeMarkerRaf = null;
                this.sweepCount += 1;
                this.repositionMarkers({ refit: false });
            });
        });
        this.activeMarkerObserver.observe(marker);
    }

    private disconnectActiveMarkerObserver(): void {
        this.activeMarkerObserver?.disconnect();
        this.activeMarkerObserver = null;
        if (this.activeMarkerRaf != null) {
            cancelAnimationFrame(this.activeMarkerRaf);
            this.activeMarkerRaf = null;
        }
    }

    /** Sweeps triggered by the live-typing observer, for throttling assertions. */
    sweepCount = 0;

    /** Marker tops keyed by annotation id, for before/after comparisons. */
    markerTops(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const el of Array.from(this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-marker'))) {
            out[el.dataset.annotationId ?? ''] = Math.round(parseFloat(el.style.top) || 0);
        }
        return out;
    }

    /** Track height versus the PDF content height, for the shrink-back check. */
    trackHeights(): Record<string, number> {
        return {
            track: Math.round(parseFloat(this.commentsTrack.style.height) || 0),
            pdfScrollHeight: this.pdfContainer.scrollHeight,
        };
    }

    /**
     * Where each card sits versus where its anchor says it should sit.
     * `drift` is how far the collision sweep pushed it off its anchor.
     */
    alignmentReport(): Array<Record<string, number | string>> {
        const rows: Array<Record<string, number | string>> = [];
        for (const a of this.annotations) {
            const marker = this.commentsTrack.querySelector<HTMLElement>(
                `.pdf-comment-marker[data-annotation-id="${a.id}"]`
            );
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${a.pageNumber}"]`
            );
            if (!marker || !pageEl) continue;
            const idealTop = pageEl.offsetTop + a.yNorm * pageEl.offsetHeight;
            const placedTop = parseFloat(marker.style.top) || 0;
            rows.push({
                id: a.id,
                yNorm: +a.yNorm.toFixed(4),
                height: marker.offsetHeight,
                idealTop: Math.round(idealTop),
                placedTop: Math.round(placedTop),
                drift: Math.round(placedTop - idealTop),
            });
        }
        return rows.sort((x, y) => (x.idealTop as number) - (y.idealTop as number));
    }

    /** Per-card measurements for the collapsed-card fitting rules. */
    auditPreviews(): PreviewAudit[] {
        const markers = Array.from(this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-marker.is-collapsed'));
        return markers.map(m => auditPreview(m)).filter((a): a is PreviewAudit => a !== null);
    }

    /** One-line verdict: every fitting invariant across the current layout. */
    auditSummary(): Record<string, number | boolean> {
        const audits = this.auditPreviews();
        return {
            cards: audits.length,
            chevronMismatches: audits.filter(a => a.chevronShown !== a.truncated).length,
            straddlingLines: audits.reduce((n, a) => n + a.straddlingLines, 0),
            midWordBreaks: audits.reduce((n, a) => n + a.midWordBreaks, 0),
            chevronsShown: audits.filter(a => a.chevronShown).length,
            markerOverlaps: this.countMarkerOverlaps(),
            pass:
                audits.every(a => a.chevronShown === a.truncated && a.straddlingLines === 0 && a.midWordBreaks === 0) &&
                this.countMarkerOverlaps() === 0,
        };
    }

    /** Select a card by index so the editor (and bracket wrapping) can be driven. */
    selectCard(index: number): HTMLTextAreaElement | null {
        const ann = this.annotations[index];
        if (!ann) return null;
        this.selectedId = ann.id;
        this.renderCommentMarkers();
        this.activeTextarea?.focus();
        return this.activeTextarea;
    }

    /** Mirrors view.ts repositionMarkers(): re-measure heights, re-run the sweep. */
    repositionMarkers(opts?: { refit?: boolean }): void {
        const markers = Array.from(this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-marker'));
        if (opts?.refit !== false) {
            fitCollapsedPreviews(markers.filter(m => m.classList.contains('is-collapsed')));
        }
        const positioned: { el: HTMLElement; idealTop: number }[] = [];
        for (const marker of markers) {
            const ann = this.annotations.find(a => a.id === marker.dataset.annotationId);
            if (!ann) continue;
            const pageEl = this.pdfContainer.querySelector<HTMLElement>(
                `.pdf-page-container[data-page-number="${ann.pageNumber}"]`
            );
            if (!pageEl) continue;
            positioned.push({ el: marker, idealTop: pageEl.offsetTop + ann.yNorm * pageEl.offsetHeight });
        }

        const { tops, contentBottom } = layoutMarkers(
            positioned.map(p => ({ idealTop: p.idealTop, height: p.el.offsetHeight })),
        );
        positioned.forEach((p, i) => { p.el.style.top = `${tops[i]}px`; });
        this.applyTrackHeight(contentBottom);
    }

    /** Geometry snapshot used to verify the horizontal-scroll fix (todo item 2). */
    measure(): Record<string, number | boolean | string> {
        const page = this.pdfContainer.querySelector<HTMLElement>('.pdf-page-container');
        const sc = this.pdfContainer.querySelector<HTMLElement>('.pdf-scroll-container');
        const pageW = page?.offsetWidth ?? 0;
        const clientW = this.pdfContainer.clientWidth;
        const scrollW = this.pdfContainer.scrollWidth;
        return {
            scale: this.viewer?.getScale() ?? 0,
            pageWidth: pageW,
            containerClientWidth: clientW,
            containerScrollWidth: scrollW,
            // How much horizontal scroll range exists beyond the paper itself.
            overflowBeyondPage: Math.max(0, scrollW - Math.max(pageW, clientW)),
            maxScrollLeft: Math.max(0, scrollW - clientW),
            pageWiderThanViewport: pageW > clientW,
            scrollContainerTransform: sc ? getComputedStyle(sc).transform : 'none',
            commentsPaneWidth: this.commentsPane.offsetWidth,
            markerOverlaps: this.countMarkerOverlaps(),
        };
    }

    /** 0 means the collision sweep is holding. */
    countMarkerOverlaps(): number {
        const markers = Array.from(this.commentsTrack.querySelectorAll<HTMLElement>('.pdf-comment-marker'));
        const boxes = markers
            .map(m => ({ top: parseFloat(m.style.top) || 0, h: m.offsetHeight }))
            .sort((a, b) => a.top - b.top);
        let overlaps = 0;
        for (let i = 1; i < boxes.length; i++) {
            if (boxes[i].top < boxes[i - 1].top + boxes[i - 1].h) overlaps += 1;
        }
        return overlaps;
    }

    private updateStats(): void {
        const m = this.measure();
        this.statsEl.textContent =
            `page ${m.pageWidth}px | client ${m.containerClientWidth}px | scrollW ${m.containerScrollWidth}px | ` +
            `dead space ${m.overflowBeyondPage}px | overlaps ${m.markerOverlaps}`;
    }
}

const harness = new MockHarness(document.body.createDiv({ cls: 'mock-root' }));
(window as unknown as Record<string, unknown>).mock = harness;
void harness.load('./test.pdf');
