import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MARKER_GAP, layoutMarkers } from '../marker-layout';

const G = MARKER_GAP;

/** Every card must clear the previous one by at least the gap. */
function assertNoOverlap(items: { idealTop: number; height: number }[], tops: number[]): void {
	const placed = items
		.map((item, i) => ({ top: tops[i], bottom: tops[i] + item.height }))
		.sort((a, b) => a.top - b.top);
	for (let i = 1; i < placed.length; i++) {
		assert.ok(
			placed[i].top >= placed[i - 1].bottom + G - 1e-9,
			`overlap: ${placed[i].top} < ${placed[i - 1].bottom} + ${G}`,
		);
	}
}

// --- 1. cards that fit stay on their anchors ------------------------------

test('cards with room between them stay exactly on their anchors', () => {
	const items = [
		{ idealTop: 0, height: 40 },
		{ idealTop: 200, height: 40 },
		{ idealTop: 400, height: 40 },
	];
	const { tops, contentBottom } = layoutMarkers(items);
	assert.deepEqual(tops, [0, 200, 400]);
	assert.equal(contentBottom, 440);
	assertNoOverlap(items, tops);
});

test('an empty track lays out to nothing', () => {
	assert.deepEqual(layoutMarkers([]), { tops: [], contentBottom: 0 });
});

test('a single card sits on its anchor', () => {
	assert.deepEqual(layoutMarkers([{ idealTop: 137, height: 40 }]), { tops: [137], contentBottom: 177 });
});

// --- 2. collisions push downward by exactly the gap -----------------------

test('a colliding card is pushed to one gap below its predecessor', () => {
	const items = [
		{ idealTop: 100, height: 80 },
		{ idealTop: 120, height: 40 },
	];
	const { tops } = layoutMarkers(items);
	assert.deepEqual(tops, [100, 190]); // 100 + 80 + 10
	assertNoOverlap(items, tops);
});

test('cards sharing one anchor stack, as three comments on one line must', () => {
	const items = [
		{ idealTop: 396, height: 40 },
		{ idealTop: 396, height: 184 },
		{ idealTop: 396, height: 40 },
	];
	const { tops, contentBottom } = layoutMarkers(items);
	assert.deepEqual(tops, [396, 446, 640]);
	assert.equal(contentBottom, 680);
	assertNoOverlap(items, tops);
});

test('one tall card cascades through every card below it', () => {
	const items = [
		{ idealTop: 0, height: 300 },
		{ idealTop: 50, height: 40 },
		{ idealTop: 100, height: 40 },
		{ idealTop: 150, height: 40 },
	];
	const { tops } = layoutMarkers(items);
	assert.deepEqual(tops, [0, 310, 360, 410]);
	assertNoOverlap(items, tops);
});

// --- 3. the live-typing invariants ----------------------------------------

test('growing a card shifts every card below it by exactly that growth', () => {
	const base = [
		{ idealTop: 0, height: 40 },
		{ idealTop: 60, height: 80 },
		{ idealTop: 100, height: 40 },
		{ idealTop: 400, height: 40 },
	];
	const grown = base.map((it, i) => (i === 1 ? { ...it, height: it.height + 120 } : it));
	const before = layoutMarkers(base).tops;
	const after = layoutMarkers(grown).tops;

	assert.equal(after[0], before[0], 'card above the edited one must not move');
	assert.equal(after[1], before[1], 'the edited card keeps its own top');
	assert.equal(after[2] - before[2], 120, 'the card below moves by the growth');
	assert.equal(after[3], before[3], 'a card with room to spare is unaffected');
});

test('shrinking a card returns its neighbours to their anchors', () => {
	const base = [
		{ idealTop: 0, height: 40 },
		{ idealTop: 60, height: 80 },
		{ idealTop: 100, height: 40 },
	];
	const grown = base.map((it, i) => (i === 1 ? { ...it, height: 400 } : it));
	const beforeTops = layoutMarkers(base).tops;
	layoutMarkers(grown); // the sweep is stateless, so this must not persist
	assert.deepEqual(layoutMarkers(base).tops, beforeTops);
});

test('the sweep is stateless: repeated runs give identical results', () => {
	const items = [
		{ idealTop: 10, height: 100 },
		{ idealTop: 20, height: 100 },
		{ idealTop: 30, height: 100 },
	];
	const first = layoutMarkers(items).tops;
	assert.deepEqual(layoutMarkers(items).tops, first);
	assert.deepEqual(layoutMarkers(items).tops, first);
});

// --- 4. ordering and track height -----------------------------------------

test('unsorted input is placed by anchor but returned in input order', () => {
	const items = [
		{ idealTop: 400, height: 40 },
		{ idealTop: 0, height: 40 },
		{ idealTop: 200, height: 40 },
	];
	const { tops } = layoutMarkers(items);
	assert.deepEqual(tops, [400, 0, 200]);
	assertNoOverlap(items, tops);
});

test('cards with equal anchors keep their input order', () => {
	const items = [
		{ idealTop: 100, height: 30 },
		{ idealTop: 100, height: 30 },
		{ idealTop: 100, height: 30 },
	];
	const { tops } = layoutMarkers(items);
	assert.deepEqual(tops, [100, 140, 180]);
});

test('contentBottom is the bottom of the lowest card', () => {
	const { contentBottom } = layoutMarkers([
		{ idealTop: 0, height: 40 },
		{ idealTop: 500, height: 90 },
	]);
	assert.equal(contentBottom, 590);
});

test('a negative anchor is not allowed to place a card above the track', () => {
	const { tops } = layoutMarkers([{ idealTop: -50, height: 40 }]);
	assert.equal(tops[0], 0);
});

test('a custom gap is honoured', () => {
	const { tops } = layoutMarkers([
		{ idealTop: 0, height: 40 },
		{ idealTop: 0, height: 40 },
	], 25);
	assert.deepEqual(tops, [0, 65]);
});

// --- 5. randomised: no overlap, ever --------------------------------------

test('randomised inputs never overlap and never rise above their anchors', () => {
	let seed = 12345;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let trial = 0; trial < 200; trial++) {
		const n = 1 + Math.floor(rnd() * 12);
		const items = Array.from({ length: n }, () => ({
			idealTop: Math.round(rnd() * 1000),
			height: 20 + Math.round(rnd() * 200),
		}));
		const { tops, contentBottom } = layoutMarkers(items);
		assertNoOverlap(items, tops);
		for (let i = 0; i < n; i++) {
			assert.ok(tops[i] >= items[i].idealTop - 1e-9, 'a card is never placed above its anchor');
		}
		const lowest = Math.max(...items.map((it, i) => tops[i] + it.height));
		assert.equal(contentBottom, lowest);
	}
});
