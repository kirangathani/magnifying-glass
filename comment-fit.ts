/**
 * Height fitting for collapsed comment cards.
 *
 * A collapsed card shows at most `budget` pixels of content. Clipping at a raw
 * pixel budget cuts the last line of text in half, because rendered markdown
 * (headings, lists, inter-paragraph margins) does not sit on a regular
 * line-height grid. So the clamp is snapped down to the bottom of the last line
 * box that fits entirely, and the "there is more below" chevron is shown only
 * when something is actually hidden.
 *
 * `chooseClampHeight` is pure so it can be unit-tested under node; the DOM
 * helpers below only touch the document when called, so this module is safe to
 * import outside a browser.
 */

/** Content-box height budget for a collapsed card, in line boxes. */
export const MAX_PREVIEW_LINES = 9;

/** Fallback line-height multiplier when the computed value is `normal`. */
const FALLBACK_LINE_HEIGHT_RATIO = 1.4;

export type ClampInput = {
	/**
	 * Candidate clip boundaries relative to the content-box top: the bottom of
	 * every line box, plus the bottom of atomic blocks (images, rules) that have
	 * no line boxes of their own. Order does not matter.
	 */
	boundaries: number[];
	/** Full unclamped content height (content box, excluding padding). */
	contentHeight: number;
	/** Maximum content height a collapsed card may show. */
	budget: number;
	/** Sub-pixel tolerance; browsers report fractional rects. */
	epsilon?: number;
};

export type ClampDecision = {
	/** Content-box max-height to apply, or null to leave the card unclamped. */
	clampHeight: number | null;
	/** Whether content is hidden — i.e. whether to draw the chevron. */
	truncated: boolean;
};

/**
 * Decide where to clip a collapsed card so no line is cut in half.
 *
 * - Content within budget: no clamp, no chevron (the card hugs its content).
 * - Content over budget: clamp to the lowest boundary that still fits; the
 *   chevron is shown when any boundary falls below that clamp.
 * - Nothing fits (a single element taller than the whole budget): clip at the
 *   budget and show the chevron. A mid-line cut is unavoidable there.
 */
export function chooseClampHeight(input: ClampInput): ClampDecision {
	const eps = input.epsilon ?? 0.5;
	const budget = input.budget;
	if (!(budget > 0)) return { clampHeight: null, truncated: false };

	const boundaries = input.boundaries.filter((b) => Number.isFinite(b) && b > 0);
	const lowest = boundaries.length ? Math.max(...boundaries) : input.contentHeight;

	// Everything fits: no clamp and, by definition, nothing is hidden.
	if (input.contentHeight <= budget + eps) return { clampHeight: null, truncated: false };

	const fitting = boundaries.filter((b) => b <= budget + eps);
	const clampHeight = fitting.length ? Math.max(...fitting) : Math.min(budget, input.contentHeight);

	// Content can exceed the budget purely through trailing margin/padding while
	// every line still fits — that hides no text, so no chevron.
	return { clampHeight, truncated: lowest > clampHeight + eps };
}

/** Vertical padding + border of an element, split top/bottom. */
function verticalInsets(el: HTMLElement): { top: number; bottom: number } {
	const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
	if (!cs) return { top: 0, bottom: 0 };
	const n = (v: string) => parseFloat(v) || 0;
	return {
		top: n(cs.paddingTop) + n(cs.borderTopWidth),
		bottom: n(cs.paddingBottom) + n(cs.borderBottomWidth),
	};
}

/** The card's one-line height, used as the unit for the content budget. */
export function lineHeightOf(el: HTMLElement): number {
	const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
	if (!cs) return 0;
	const lh = parseFloat(cs.lineHeight);
	if (Number.isFinite(lh) && lh > 0) return lh;
	const fs = parseFloat(cs.fontSize);
	return Number.isFinite(fs) && fs > 0 ? fs * FALLBACK_LINE_HEIGHT_RATIO : 0;
}

/**
 * Measure every clip boundary inside a preview, relative to its content-box top.
 *
 * Line boxes come from `Range.getClientRects()` over text nodes, which is the
 * only way to see where a line actually ends when children have mixed
 * line-heights. Atomic elements contribute their own bottom edge, since they
 * produce no line boxes.
 */
export function measureBoundaries(preview: HTMLElement): { boundaries: number[]; contentHeight: number } {
	const doc = preview.ownerDocument;
	const insets = verticalInsets(preview);
	const contentTop = preview.getBoundingClientRect().top + insets.top;
	const boundaries: number[] = [];

	const walker = doc.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if (node.nodeValue && node.nodeValue.trim()) {
			const range = doc.createRange();
			range.selectNodeContents(node);
			for (const rect of Array.from(range.getClientRects())) {
				if (rect.height > 0) boundaries.push(rect.bottom - contentTop);
			}
			range.detach?.();
		}
		node = walker.nextNode();
	}

	for (const el of Array.from(preview.querySelectorAll('img, svg, canvas, video, hr'))) {
		const rect = el.getBoundingClientRect();
		if (rect.height > 0) boundaries.push(rect.bottom - contentTop);
	}

	return {
		boundaries,
		contentHeight: Math.max(0, preview.scrollHeight - insets.top - insets.bottom),
	};
}

/**
 * Fit a batch of collapsed markers in three passes (reset → read → write) so the
 * browser lays out once per pass instead of once per card.
 */
export function fitCollapsedPreviews(markers: HTMLElement[]): void {
	type Job = { marker: HTMLElement; body: HTMLElement; insetTotal: number };
	const jobs: Job[] = [];

	// Pass 1 (write): drop any previous clamp so the content measures in full.
	for (const marker of markers) {
		// The clamp goes on the inner body, not the padded card: bottom padding
		// on an overflow:hidden box does not mask anything, so a clamp there
		// leaves the next line visible inside the padding.
		const body =
			marker.querySelector<HTMLElement>('.pdf-comment-preview-body') ??
			marker.querySelector<HTMLElement>('.pdf-comment-preview');
		if (!body) continue;
		body.style.maxHeight = 'none';
		const insets = verticalInsets(body);
		jobs.push({ marker, body, insetTotal: insets.top + insets.bottom });
	}

	// Pass 2 (read): measure everything before touching the DOM again.
	const decisions = jobs.map((job) => {
		const { boundaries, contentHeight } = measureBoundaries(job.body);
		return chooseClampHeight({
			boundaries,
			contentHeight,
			budget: MAX_PREVIEW_LINES * lineHeightOf(job.body),
		});
	});

	// Pass 3 (write): apply the clamp and the chevron flag.
	for (let i = 0; i < jobs.length; i++) {
		const { marker, body, insetTotal } = jobs[i];
		const { clampHeight, truncated } = decisions[i];
		body.style.maxHeight = clampHeight === null ? 'none' : `${clampHeight + insetTotal}px`;
		marker.classList.toggle('is-truncated', truncated);
	}
}
