/**
 * Measurement helpers for the collapsed-card fitting rules.
 *
 * These assertions need a real layout engine (line boxes, wrapping), so they run
 * in the browser harness rather than under node.
 */

export type PreviewAudit = {
	id: string;
	/** Full content height with the clamp removed. */
	contentHeight: number;
	/** Visible content height. */
	visibleHeight: number;
	/** Whether the marker carries the is-truncated flag. */
	truncated: boolean;
	/** Whether the chevron pseudo-element is actually rendered. */
	chevronShown: boolean;
	/** Line boxes crossing the clip edge — must be 0 (todo item 3). */
	straddlingLines: number;
	/** Wrapped mid-word despite fitting on a line — must be 0 (todo item 2). */
	midWordBreaks: number;
};

const EPS = 0.5;

function lineRects(preview: HTMLElement): DOMRect[] {
	const doc = preview.ownerDocument;
	const walker = doc.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
	const rects: DOMRect[] = [];
	let node = walker.nextNode();
	while (node) {
		if (node.nodeValue && node.nodeValue.trim()) {
			const range = doc.createRange();
			range.selectNodeContents(node);
			for (const r of Array.from(range.getClientRects())) {
				if (r.height > 0) rects.push(r);
			}
		}
		node = walker.nextNode();
	}
	return rects;
}

/** Group a text node's characters into rendered lines. */
function linesOfTextNode(node: Text): { text: string; start: number }[] {
	const doc = node.ownerDocument;
	const value = node.nodeValue ?? '';
	const out: { text: string; start: number }[] = [];
	let currentTop: number | null = null;
	let start = 0;

	for (let i = 0; i < value.length; i++) {
		const range = doc.createRange();
		range.setStart(node, i);
		range.setEnd(node, i + 1);
		const rect = range.getBoundingClientRect();
		if (rect.height === 0 && rect.width === 0) continue; // collapsed whitespace
		if (currentTop === null) {
			currentTop = rect.top;
		} else if (Math.abs(rect.top - currentTop) > EPS) {
			out.push({ text: value.slice(start, i), start });
			start = i;
			currentTop = rect.top;
		}
	}
	if (start < value.length) out.push({ text: value.slice(start), start });
	return out;
}

/** Width of the whole word straddling `index`, in px, or null if unmeasurable. */
function wordWidthAt(node: Text, index: number): number | null {
	const value = node.nodeValue ?? '';
	let lo = index;
	let hi = index;
	while (lo > 0 && !/\s/.test(value[lo - 1])) lo -= 1;
	while (hi < value.length && !/\s/.test(value[hi])) hi += 1;
	if (hi <= lo) return null;
	const range = node.ownerDocument.createRange();
	range.setStart(node, lo);
	range.setEnd(node, hi);
	// A split word reports one rect per line; the intrinsic width is their sum.
	return Array.from(range.getClientRects()).reduce((sum, r) => sum + r.width, 0);
}

/**
 * Count line breaks that fall inside a word which would have fitted on a line of
 * its own. A word wider than the card still has to break, and is not counted.
 */
function countMidWordBreaks(preview: HTMLElement): number {
	const doc = preview.ownerDocument;
	const cs = doc.defaultView?.getComputedStyle(preview);
	const contentWidth =
		preview.clientWidth -
		(parseFloat(cs?.paddingLeft ?? '0') || 0) -
		(parseFloat(cs?.paddingRight ?? '0') || 0);

	const walker = doc.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
	let count = 0;
	let node = walker.nextNode() as Text | null;
	while (node) {
		const value = node.nodeValue ?? '';
		if (value.trim()) {
			const segments = linesOfTextNode(node);
			for (let s = 1; s < segments.length; s++) {
				const idx = segments[s].start;
				const before = value[idx - 1];
				const after = value[idx];
				if (!before || !after) continue;
				if (/\s/.test(before) || /\s/.test(after)) continue; // clean break
				const width = wordWidthAt(node, idx);
				if (width !== null && width <= contentWidth + EPS) count += 1;
			}
		}
		node = walker.nextNode() as Text | null;
	}
	return count;
}

export function auditPreview(marker: HTMLElement): PreviewAudit | null {
	// The clamp lives on the inner body, so that is where the clip edge is.
	const preview =
		marker.querySelector<HTMLElement>('.pdf-comment-preview-body') ??
		marker.querySelector<HTMLElement>('.pdf-comment-preview');
	if (!preview) return null;
	const doc = preview.ownerDocument;
	const view = doc.defaultView;
	const cs = view?.getComputedStyle(preview);
	const padTop = parseFloat(cs?.paddingTop ?? '0') || 0;
	const padBottom = parseFloat(cs?.paddingBottom ?? '0') || 0;

	const rect = preview.getBoundingClientRect();
	// overflow:hidden clips at the padding box.
	const clipBottom = rect.bottom - (parseFloat(cs?.borderBottomWidth ?? '0') || 0);

	let straddling = 0;
	for (const r of lineRects(preview)) {
		if (r.top < clipBottom - EPS && r.bottom > clipBottom + EPS) straddling += 1;
	}

	// The chevron is drawn on the card itself, not on the clamped body.
	const card = marker.querySelector<HTMLElement>('.pdf-comment-preview');
	const after = card ? view?.getComputedStyle(card, '::after') : null;
	const chevronShown = !!after && after.content !== 'none' && after.display !== 'none';

	return {
		id: marker.dataset.annotationId ?? '',
		contentHeight: Math.round(preview.scrollHeight - padTop - padBottom),
		visibleHeight: Math.round(preview.clientHeight - padTop - padBottom),
		truncated: marker.classList.contains('is-truncated'),
		chevronShown,
		straddlingLines: straddling,
		midWordBreaks: countMidWordBreaks(preview),
	};
}
