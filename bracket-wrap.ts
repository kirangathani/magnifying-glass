/**
 * Obsidian-style bracket wrapping for the inline comment editor.
 *
 * Typing `[` with text selected wraps the selection and leaves the inner text
 * selected, so a second `[` turns `[word]` into `[[word]]` without any
 * special-casing. With no selection the keystroke is left alone (plain typing).
 *
 * `wrapSelection` is pure so it can be unit-tested under node;
 * `applyWrapToTextarea` is the only DOM-touching part.
 */

export type WrapResult = {
	/** Full textarea value after the wrap. */
	value: string;
	/** Text that replaces the current selection. */
	inserted: string;
	/** Selection start after the wrap (start of the inner text). */
	selectionStart: number;
	/** Selection end after the wrap (end of the inner text). */
	selectionEnd: number;
};

/**
 * Wrap `[start, end)` of `value` in `open`/`close`, keeping the original text
 * selected inside the new brackets. Returns null when there is no selection, so
 * the caller can let the keystroke type normally.
 */
export function wrapSelection(
	value: string,
	start: number,
	end: number,
	open = '[',
	close = ']',
): WrapResult | null {
	const lo = Math.max(0, Math.min(start, end));
	const hi = Math.min(value.length, Math.max(start, end));
	if (lo >= hi) return null;

	const selected = value.slice(lo, hi);
	const inserted = `${open}${selected}${close}`;
	return {
		value: value.slice(0, lo) + inserted + value.slice(hi),
		inserted,
		selectionStart: lo + open.length,
		selectionEnd: lo + open.length + selected.length,
	};
}

/**
 * Apply a wrap to a textarea.
 *
 * `execCommand('insertText')` is used where available because it keeps the
 * native undo stack intact (assigning `.value` clears it) and fires `input`
 * itself. The fallback assigns the value and dispatches `input` manually so
 * auto-resize and the dirty flag still run.
 */
export function applyWrapToTextarea(textarea: HTMLTextAreaElement, result: WrapResult): void {
	const doc = textarea.ownerDocument;
	let inserted = false;
	try {
		inserted = doc.execCommand('insertText', false, result.inserted);
	} catch {
		inserted = false;
	}

	if (!inserted) {
		textarea.value = result.value;
	}
	textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
	// `execCommand` fires `input` from inside itself, i.e. before the selection
	// above is restored, so listeners would see a bare cursor sitting after a
	// half-typed `[[` and (in the suggester's case) pop open. Re-announce the
	// edit now that the selection is correct; listeners here are idempotent.
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Keydown handler: wrap the selection on `[`. Returns true when the keystroke
 * was consumed, so the caller can `preventDefault()`.
 */
export function handleBracketKeydown(textarea: HTMLTextAreaElement, e: KeyboardEvent): boolean {
	if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey) return false;
	const result = wrapSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd);
	if (!result) return false;
	applyWrapToTextarea(textarea, result);
	return true;
}
