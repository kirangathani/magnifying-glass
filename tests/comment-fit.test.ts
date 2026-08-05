import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chooseClampHeight } from '../comment-fit';

const LINE = 18.2; // 13px * 1.4, the collapsed card's line height
const BUDGET = 9 * LINE; // 163.8px

/** Bottoms of `n` evenly spaced line boxes. */
function lines(n: number, lineHeight = LINE): number[] {
	return Array.from({ length: n }, (_, i) => (i + 1) * lineHeight);
}

// --- 1. content that fits: no clamp, no chevron ---------------------------

test('content shorter than the budget is left unclamped with no chevron', () => {
	const d = chooseClampHeight({ boundaries: lines(3), contentHeight: 3 * LINE, budget: BUDGET });
	assert.equal(d.clampHeight, null);
	assert.equal(d.truncated, false);
});

test('content exactly filling the budget is left unclamped with no chevron', () => {
	const d = chooseClampHeight({ boundaries: lines(9), contentHeight: BUDGET, budget: BUDGET });
	assert.equal(d.clampHeight, null);
	assert.equal(d.truncated, false);
});

test('sub-pixel overshoot within tolerance still counts as fitting', () => {
	const d = chooseClampHeight({
		boundaries: lines(9),
		contentHeight: BUDGET + 0.4,
		budget: BUDGET,
	});
	assert.equal(d.clampHeight, null);
	assert.equal(d.truncated, false);
});

test('empty content is unclamped', () => {
	const d = chooseClampHeight({ boundaries: [], contentHeight: 0, budget: BUDGET });
	assert.equal(d.clampHeight, null);
	assert.equal(d.truncated, false);
});

// --- 2. content that overflows: snap to a whole line, show the chevron ----

test('overflowing content clamps to the last whole line and marks truncation', () => {
	const d = chooseClampHeight({ boundaries: lines(30), contentHeight: 30 * LINE, budget: BUDGET });
	assert.equal(d.clampHeight, 9 * LINE);
	assert.equal(d.truncated, true);
});

test('one line over the budget clamps to nine lines', () => {
	const d = chooseClampHeight({ boundaries: lines(10), contentHeight: 10 * LINE, budget: BUDGET });
	assert.equal(d.clampHeight, 9 * LINE);
	assert.equal(d.truncated, true);
});

test('irregular boundaries (heading + list) clamp to the last one that fits', () => {
	// A 30px heading, then 13 body lines: the tenth boundary overshoots.
	const boundaries = [30, ...Array.from({ length: 13 }, (_, i) => 30 + (i + 1) * LINE)];
	const d = chooseClampHeight({
		boundaries,
		contentHeight: 30 + 13 * LINE,
		budget: BUDGET,
	});
	const expected = Math.max(...boundaries.filter((b) => b <= BUDGET + 0.5));
	assert.equal(d.clampHeight, expected);
	assert.ok(expected < BUDGET, 'clamp must sit strictly below the raw budget here');
	assert.equal(d.truncated, true);
});

test('unordered boundaries are handled', () => {
	const shuffled = [5 * LINE, LINE, 12 * LINE, 3 * LINE, 9 * LINE];
	const d = chooseClampHeight({ boundaries: shuffled, contentHeight: 12 * LINE, budget: BUDGET });
	assert.equal(d.clampHeight, 9 * LINE);
	assert.equal(d.truncated, true);
});

// --- 3. degenerate cases --------------------------------------------------

test('a single element taller than the budget clips at the budget and warns', () => {
	const d = chooseClampHeight({ boundaries: [400], contentHeight: 400, budget: BUDGET });
	assert.equal(d.clampHeight, BUDGET);
	assert.equal(d.truncated, true);
});

test('unmeasurable content taller than the budget still shows the chevron', () => {
	const d = chooseClampHeight({ boundaries: [], contentHeight: 400, budget: BUDGET });
	assert.equal(d.clampHeight, BUDGET);
	assert.equal(d.truncated, true);
});

test('overflow caused only by trailing margin hides no text, so no chevron', () => {
	// Every line fits; the content box is taller purely through bottom margin.
	const d = chooseClampHeight({
		boundaries: lines(9),
		contentHeight: BUDGET + 12,
		budget: BUDGET,
	});
	assert.equal(d.clampHeight, 9 * LINE);
	assert.equal(d.truncated, false);
});

test('a zero budget disables clamping rather than collapsing the card', () => {
	const d = chooseClampHeight({ boundaries: lines(4), contentHeight: 4 * LINE, budget: 0 });
	assert.equal(d.clampHeight, null);
	assert.equal(d.truncated, false);
});

test('non-finite and non-positive boundaries are ignored', () => {
	const d = chooseClampHeight({
		boundaries: [NaN, -5, 0, 9 * LINE, Infinity, 20 * LINE],
		contentHeight: 20 * LINE,
		budget: BUDGET,
	});
	assert.equal(d.clampHeight, 9 * LINE);
	assert.equal(d.truncated, true);
});

// --- 4. the invariant the whole change exists to hold ---------------------

test('the chevron flag always agrees with whether a boundary is hidden', () => {
	const cases: number[][] = [
		lines(1), lines(8), lines(9), lines(10), lines(40),
		[30, 48.2, 66.4, 84.6, 102.8, 121, 139.2, 157.4, 175.6],
		[200],
		[],
	];
	for (const boundaries of cases) {
		const contentHeight = boundaries.length ? Math.max(...boundaries) : 0;
		const d = chooseClampHeight({ boundaries, contentHeight, budget: BUDGET });
		const clamp = d.clampHeight ?? contentHeight;
		const hidden = boundaries.some((b) => b > clamp + 0.5);
		assert.equal(d.truncated, hidden, `mismatch for ${JSON.stringify(boundaries)}`);
		if (d.clampHeight !== null) {
			assert.ok(d.clampHeight <= BUDGET + 0.5, 'clamp never exceeds the budget');
		}
	}
});
