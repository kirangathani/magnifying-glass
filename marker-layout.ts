/**
 * Vertical placement of comment cards in the comments track.
 *
 * Every card wants to sit at its anchor (`idealTop`). Cards may not overlap, so
 * a card whose anchor falls inside its predecessor is pushed down. The sweep is
 * stateless — it is recomputed from the ideal tops on every run — so a card that
 * grows while being edited pushes its neighbours down, and they return to their
 * anchors when it shrinks again.
 *
 * Pure: no DOM, no `obsidian`, so it is unit-testable and shared with the mock.
 */

/** Vertical space left between adjacent cards, in px. */
export const MARKER_GAP = 10;

export type LayoutItem = {
	/** Where the card's anchor puts it, in track coordinates. */
	idealTop: number;
	/** Measured card height, in px. */
	height: number;
};

export type LayoutResult = {
	/** Placed top for each input item, in the order given. */
	tops: number[];
	/** Bottom of the last placed card — the height the track must cover. */
	contentBottom: number;
};

/**
 * Place cards top-down, never overlapping.
 *
 * Input order is preserved in the output, but placement follows ascending
 * `idealTop`, so callers may pass items in any order.
 */
export function layoutMarkers(items: LayoutItem[], gap: number = MARKER_GAP): LayoutResult {
	const tops = new Array<number>(items.length).fill(0);
	if (items.length === 0) return { tops, contentBottom: 0 };

	const order = items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => a.item.idealTop - b.item.idealTop || a.index - b.index);

	let nextAvailableTop = 0;
	let contentBottom = 0;
	for (const { item, index } of order) {
		const top = Math.max(item.idealTop, nextAvailableTop);
		tops[index] = top;
		const bottom = top + item.height;
		nextAvailableTop = bottom + gap;
		contentBottom = bottom;
	}

	return { tops, contentBottom };
}
