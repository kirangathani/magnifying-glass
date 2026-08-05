import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { wrapSelection } from '../bracket-wrap';

/** Apply a wrap the way a keystroke would, returning the next editor state. */
function press(value: string, start: number, end: number) {
	const r = wrapSelection(value, start, end);
	if (!r) return null;
	return { value: r.value, start: r.selectionStart, end: r.selectionEnd };
}

// --- 1. the core behaviour ------------------------------------------------

test('no selection returns null so the key types normally', () => {
	assert.equal(wrapSelection('hello', 2, 2), null);
	assert.equal(wrapSelection('', 0, 0), null);
});

test('one press wraps the selection and keeps the inner text selected', () => {
	const s = press('hello world', 6, 11);
	assert.deepEqual(s, { value: 'hello [world]', start: 7, end: 12 });
	assert.equal(s!.value.slice(s!.start, s!.end), 'world');
});

test('two presses produce a wikilink, still with the word selected', () => {
	const first = press('hello world', 6, 11)!;
	const second = press(first.value, first.start, first.end)!;
	assert.equal(second.value, 'hello [[world]]');
	assert.equal(second.value.slice(second.start, second.end), 'world');
});

test('three presses nest a third time (no special-casing)', () => {
	let s = press('word', 0, 4)!;
	s = press(s.value, s.start, s.end)!;
	s = press(s.value, s.start, s.end)!;
	assert.equal(s.value, '[[[word]]]');
	assert.equal(s.value.slice(s.start, s.end), 'word');
});

// --- 2. selection edge cases ---------------------------------------------

test('a backwards selection wraps the same range', () => {
	assert.deepEqual(press('hello world', 11, 6), { value: 'hello [world]', start: 7, end: 12 });
});

test('a selection at the very start of the buffer', () => {
	assert.deepEqual(press('abc def', 0, 3), { value: '[abc] def', start: 1, end: 4 });
});

test('a selection at the very end of the buffer', () => {
	assert.deepEqual(press('abc def', 4, 7), { value: 'abc [def]', start: 5, end: 8 });
});

test('the whole buffer selected', () => {
	assert.deepEqual(press('abc', 0, 3), { value: '[abc]', start: 1, end: 4 });
});

test('a multi-line selection is wrapped as one unit', () => {
	const s = press('one\ntwo\nthree', 0, 7)!;
	assert.equal(s.value, '[one\ntwo]\nthree');
	assert.equal(s.value.slice(s.start, s.end), 'one\ntwo');
});

test('a selection containing brackets is wrapped verbatim', () => {
	assert.equal(press('see [[note]] here', 4, 12)!.value, 'see [[[note]]] here');
});

test('a selection adjacent to existing brackets does not absorb them', () => {
	const s = press('[x] y', 4, 5)!;
	assert.equal(s.value, '[x] [y]');
});

test('out-of-range offsets are clamped to the buffer', () => {
	assert.deepEqual(press('abc', -3, 99), { value: '[abc]', start: 1, end: 4 });
});

test('whitespace-only and multi-word selections are preserved exactly', () => {
	assert.equal(press('a  b', 1, 3)!.value, 'a[  ]b');
	assert.equal(press('two words here', 0, 9)!.value, '[two words] here');
});

// --- 3. custom delimiters -------------------------------------------------

test('custom delimiters wrap and offset correctly', () => {
	const r = wrapSelection('word', 0, 4, '[[', ']]')!;
	assert.equal(r.value, '[[word]]');
	assert.equal(r.inserted, '[[word]]');
	assert.equal(r.selectionStart, 2);
	assert.equal(r.selectionEnd, 6);
});

test('inserted text is exactly what replaces the selection', () => {
	const r = wrapSelection('hello world', 6, 11)!;
	assert.equal(r.inserted, '[world]');
	assert.equal('hello world'.slice(0, 6) + r.inserted + 'hello world'.slice(11), r.value);
});
