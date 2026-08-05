/**
 * Exercises CommentStore against an in-memory vault: folder resolution, PDF
 * renames and moves, comment-note and comment-folder moves, and the settings
 * migration. These are the paths that touch the user's files, so they are
 * checked here rather than left to manual testing alone.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { App, TAbstractFile } from 'obsidian';
import { CommentStore } from '../comment-store';
import { DEFAULT_SETTINGS, PdfCommenterSettings } from '../settings';
import type { PdfAnnotation, PdfAnnotationsFile } from '../types';
import { MockApp } from './vault-mock';

function setup(overrides: Partial<PdfCommenterSettings> = {}) {
	const app = new MockApp();
	const settings: PdfCommenterSettings = { ...DEFAULT_SETTINGS, ...overrides };
	const store = new CommentStore(app as unknown as App, () => settings);
	// Wire the listener exactly as main.ts does.
	app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
		store.dispatchRename(file, oldPath);
	});
	return { app, settings, store };
}

function annotation(id: string, notePath?: string): PdfAnnotation {
	return {
		id,
		createdAt: 1700000000000,
		selectedText: 'some text',
		notePath,
		anchor: { pageNumber: 1, yNorm: 0.25 },
		highlights: [],
	};
}

function noteContent(pdfPath: string, id: string): string {
	const display = pdfPath.slice(pdfPath.lastIndexOf('/') + 1).replace(/\.pdf$/i, '');
	return (
		`---\n` +
		`pdfPath: "${pdfPath}"\n` +
		`annotationId: "${id}"\n` +
		`pageNumber: 1\n` +
		`yNorm: 0.25\n` +
		`createdAt: "2023-11-14T22:13:20.000Z"\n` +
		`---\n\n` +
		`> some text\n\n` +
		`**Source:** [[${pdfPath}|${display}]] (p. 1)\n\n` +
		`---\n\n` +
		`my comment\n`
	);
}

/** Seed a PDF with one comment whose note lives in `folder`. */
function seedPdfWithComment(app: MockApp, pdfPath: string, folder: string, id = 'ann1') {
	const notePath = `${folder}/comment-2023-11-14-${id}.md`;
	app.vault.seedFile(pdfPath, '%PDF-1.4');
	app.vault.seedFolder(folder);
	app.vault.seedFile(notePath, noteContent(pdfPath, id));
	const sidecar: PdfAnnotationsFile = {
		version: 1,
		pdfPath,
		annotations: [annotation(id, notePath)],
	};
	app.vault.seedFile(`${pdfPath}.mg-comments.json`, JSON.stringify(sidecar, null, 2));
	return { notePath };
}

const readSidecar = (app: MockApp, pdfPath: string): PdfAnnotationsFile =>
	JSON.parse(app.vault.read_(`${pdfPath}.mg-comments.json`) as string);

// --- folder resolution ----------------------------------------------------

test('a new PDF gets a mirrored folder under the root, parents included', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	app.vault.seedFile('Papers/Research/Dutta 2024.pdf', '%PDF');

	const folder = await store.resolveCommentsFolder('Papers/Research/Dutta 2024.pdf', []);

	assert.equal(folder, 'Comments/Papers/Research/Dutta 2024');
	assert.ok(app.vault.exists('Comments'), 'intermediate folder Comments was not created');
	assert.ok(app.vault.exists('Comments/Papers'));
	assert.ok(app.vault.exists('Comments/Papers/Research'));
	assert.ok(app.vault.exists(folder));
});

test('an existing PDF keeps its current folder when the settings change', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/Dutta 2024.pdf', 'Dutta 2024');
	const data = readSidecar(app, 'Papers/Dutta 2024.pdf');

	const folder = await store.resolveCommentsFolder('Papers/Dutta 2024.pdf', data.annotations);

	assert.equal(folder, 'Dutta 2024', 'existing comments must not be split across two folders');
	assert.ok(!app.vault.exists('Comments/Papers/Dutta 2024'), 'no stray folder should be created');
});

test('a file squatting on the target path is stepped past, not overwritten', async () => {
	const { app, store } = setup({ commentsRootFolder: '', mirrorVaultStructure: false });
	app.vault.seedFile('Report.pdf', '%PDF');
	app.vault.seedFile('Report', 'a file, not a folder');

	const folder = await store.resolveCommentsFolder('Report.pdf', []);

	assert.equal(folder, 'Report_1');
	assert.equal(app.vault.read_('Report'), 'a file, not a folder');
});

test('a file on an intermediate segment of the root fails loudly', async () => {
	// The root is set to `Foo`, then a *file* called `Foo` appears. Creating the
	// folder is impossible; the caller must find out rather than silently lose
	// the comment.
	const { app, store } = setup({ commentsRootFolder: 'Foo', mirrorVaultStructure: true });
	app.vault.seedFile('Papers/A.pdf', '%PDF');
	app.vault.seedFile('Foo', 'a file, not a folder');

	await assert.rejects(
		() => store.resolveCommentsFolder('Papers/A.pdf', []),
		/"Foo" is a file, not a folder/
	);
});

test('a failed folder chain leaves no half-created folders behind', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Foo/Bar/Baz', mirrorVaultStructure: false });
	app.vault.seedFile('A.pdf', '%PDF');
	app.vault.seedFolder('Foo');
	app.vault.seedFile('Foo/Bar', 'a file, not a folder');
	const before = app.vault.paths();

	await assert.rejects(() => store.resolveCommentsFolder('A.pdf', []));

	assert.deepEqual(app.vault.paths(), before, 'partial folders were created before failing');
});

test('two PDFs sharing a basename get separate folders when mirroring', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	app.vault.seedFile('Papers/Dutta 2024.pdf', '%PDF');
	app.vault.seedFile('Archive/Dutta 2024.pdf', '%PDF');

	const a = await store.resolveCommentsFolder('Papers/Dutta 2024.pdf', []);
	const b = await store.resolveCommentsFolder('Archive/Dutta 2024.pdf', []);

	assert.notEqual(a, b);
	assert.equal(a, 'Comments/Papers/Dutta 2024');
	assert.equal(b, 'Comments/Archive/Dutta 2024');
});

// --- PDF renamed ----------------------------------------------------------

test('renaming a PDF moves the sidecar, the folder and the note references', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/Old Name.pdf', 'Comments/Papers/Old Name');

	const pdf = app.vault.getAbstractFileByPath('Papers/Old Name.pdf');
	await app.vault.renameFile(pdf!, 'Papers/New Name.pdf');
	await store.whenIdle();

	assert.ok(app.vault.exists('Papers/New Name.pdf.mg-comments.json'), 'sidecar did not follow');
	assert.ok(!app.vault.exists('Papers/Old Name.pdf.mg-comments.json'));
	assert.ok(app.vault.exists('Comments/Papers/New Name'), 'comment folder did not follow');

	const data = readSidecar(app, 'Papers/New Name.pdf');
	assert.equal(data.pdfPath, 'Papers/New Name.pdf');
	assert.ok(data.annotations[0].notePath?.startsWith('Comments/Papers/New Name/'));

	const note = app.vault.read_(data.annotations[0].notePath as string) as string;
	assert.match(note, /pdfPath: "Papers\/New Name\.pdf"/);
	assert.ok(note.includes('[[Papers/New Name.pdf|New Name]]'), `wikilink not updated:\n${note}`);
	assert.ok(!note.includes('Old Name'), 'stale references remain in the note');
});

test('the source wikilink is replaced, not spliced into a doubled alias', async () => {
	const { app, store } = setup({ commentsRootFolder: '', mirrorVaultStructure: false });
	seedPdfWithComment(app, 'A.pdf', 'A');

	const pdf = app.vault.getAbstractFileByPath('A.pdf');
	await app.vault.renameFile(pdf!, 'B.pdf');
	await store.whenIdle();

	const data = readSidecar(app, 'B.pdf');
	const note = app.vault.read_(data.annotations[0].notePath as string) as string;
	const links = note.match(/\[\[[^\]]*\]\]/g) ?? [];
	assert.deepEqual(links, ['[[B.pdf|B]]']);
});

// --- PDF moved ------------------------------------------------------------

test('moving a PDF to another folder relocates its comment folder', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'Comments/Papers/A');
	app.vault.seedFolder('Archive');

	const pdf = app.vault.getAbstractFileByPath('Papers/A.pdf');
	await app.vault.renameFile(pdf!, 'Archive/A.pdf');
	await store.whenIdle();

	assert.ok(app.vault.exists('Archive/A.pdf.mg-comments.json'));
	assert.ok(app.vault.exists('Comments/Archive/A'));
	const data = readSidecar(app, 'Archive/A.pdf');
	assert.equal(data.annotations[0].notePath, 'Comments/Archive/A/comment-2023-11-14-ann1.md');
	assert.ok(app.vault.exists(data.annotations[0].notePath as string), 'note is not at its recorded path');
});

test('with followPdfMoves off the folder stays put but comments still resolve', async () => {
	const { app, store } = setup({
		commentsRootFolder: 'Comments',
		mirrorVaultStructure: true,
		followPdfMoves: false,
	});
	seedPdfWithComment(app, 'Papers/A.pdf', 'Comments/Papers/A');
	app.vault.seedFolder('Archive');

	const pdf = app.vault.getAbstractFileByPath('Papers/A.pdf');
	await app.vault.renameFile(pdf!, 'Archive/A.pdf');
	await store.whenIdle();

	assert.ok(app.vault.exists('Comments/Papers/A'), 'folder should not have moved');
	const data = readSidecar(app, 'Archive/A.pdf');
	assert.equal(data.pdfPath, 'Archive/A.pdf', 'sidecar must follow the PDF regardless');
	const folder = await store.resolveCommentsFolder('Archive/A.pdf', data.annotations);
	assert.equal(folder, 'Comments/Papers/A', 'existing comments must still be found');
});

test('a PDF with no comments is a no-op, and creates nothing', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments' });
	app.vault.seedFile('Papers/Empty.pdf', '%PDF');
	const before = app.vault.paths();

	const pdf = app.vault.getAbstractFileByPath('Papers/Empty.pdf');
	await app.vault.renameFile(pdf!, 'Papers/Empty2.pdf');
	await store.whenIdle();

	assert.deepEqual(
		app.vault.paths().filter((p) => p !== 'Papers/Empty2.pdf'),
		before.filter((p) => p !== 'Papers/Empty.pdf')
	);
});

// --- notes and folders moved by the user ---------------------------------

test('moving a comment note updates its recorded path instead of orphaning it', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	const { notePath } = seedPdfWithComment(app, 'Papers/A.pdf', 'Comments/Papers/A');
	app.vault.seedFolder('Elsewhere');

	const note = app.vault.getAbstractFileByPath(notePath);
	await app.vault.renameFile(note!, 'Elsewhere/moved.md');
	await store.whenIdle();

	const data = readSidecar(app, 'Papers/A.pdf');
	assert.equal(data.annotations[0].notePath, 'Elsewhere/moved.md');
});

test('moving an unrelated markdown note touches nothing', async () => {
	const { app, store } = setup();
	seedPdfWithComment(app, 'A.pdf', 'A');
	app.vault.seedFile('Notes/random.md', '# just a note\n');
	const sidecarBefore = app.vault.read_('A.pdf.mg-comments.json');

	const note = app.vault.getAbstractFileByPath('Notes/random.md');
	await app.vault.renameFile(note!, 'Notes/renamed.md');
	await store.whenIdle();

	assert.equal(app.vault.read_('A.pdf.mg-comments.json'), sidecarBefore);
});

test('moving a comment folder by hand rewrites the recorded note paths', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'Comments/Papers/A');
	app.vault.seedFolder('Somewhere');

	const folder = app.vault.getAbstractFileByPath('Comments/Papers/A');
	await app.vault.renameFile(folder!, 'Somewhere/A');
	await store.whenIdle();

	const data = readSidecar(app, 'Papers/A.pdf');
	assert.equal(data.annotations[0].notePath, 'Somewhere/A/comment-2023-11-14-ann1.md');
	assert.ok(app.vault.exists(data.annotations[0].notePath as string));
});

test('moving a folder of PDFs relocates their comment folders too', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'Comments/Papers/A');
	app.vault.seedFolder('Archive');

	const folder = app.vault.getAbstractFileByPath('Papers');
	await app.vault.renameFile(folder!, 'Archive/Papers');
	await store.whenIdle();

	// The sidecar is a sibling of the PDF, so it came along with the folder.
	assert.ok(app.vault.exists('Archive/Papers/A.pdf.mg-comments.json'));
	const data = readSidecar(app, 'Archive/Papers/A.pdf');
	assert.equal(data.pdfPath, 'Archive/Papers/A.pdf');
	assert.ok(app.vault.exists('Comments/Archive/Papers/A'), 'comment folder did not follow the PDFs');
	assert.equal(data.annotations[0].notePath, 'Comments/Archive/Papers/A/comment-2023-11-14-ann1.md');
});

// --- migration ------------------------------------------------------------

test('the migration moves existing folders under the configured root', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'A');
	seedPdfWithComment(app, 'B.pdf', 'B', 'ann2');

	const plan = await store.planReorganisation();
	assert.equal(plan.moves.length, 2);

	const result = await store.runReorganisation(plan);
	assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
	assert.ok(app.vault.exists('Comments/Papers/A'));
	assert.ok(app.vault.exists('Comments/B'));

	const a = readSidecar(app, 'Papers/A.pdf');
	assert.equal(a.annotations[0].notePath, 'Comments/Papers/A/comment-2023-11-14-ann1.md');
	assert.ok(app.vault.exists(a.annotations[0].notePath as string));
});

test('running the migration twice is a no-op the second time', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'A');

	await store.runReorganisation(await store.planReorganisation());
	const after = app.vault.paths();

	const secondPlan = await store.planReorganisation();
	assert.deepEqual(secondPlan.moves, []);
	await store.runReorganisation(secondPlan);
	assert.deepEqual(app.vault.paths(), after);
});

test('the migration refuses to merge into an occupied folder', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'A');
	app.vault.seedFile('Comments/Papers/A/someone-elses-note.md', 'not ours');

	const plan = await store.planReorganisation();
	assert.deepEqual(plan.moves, []);
	assert.equal(plan.skips[0].reason, 'target-exists');

	await store.runReorganisation(plan);
	assert.equal(app.vault.read_('Comments/Papers/A/someone-elses-note.md'), 'not ours');
	assert.ok(app.vault.exists('A'), 'the original folder should be untouched');
});

test('a move whose target another move is vacating still completes', async () => {
	// A currently sits where B needs to end up; the runner retries in passes.
	const { app, store } = setup({ commentsRootFolder: '', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'B', 'annA');
	seedPdfWithComment(app, 'B.pdf', 'C', 'annB');

	const plan = await store.planReorganisation();
	const result = await store.runReorganisation(plan);

	assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
	assert.ok(app.vault.exists('Papers/A'));
	assert.ok(app.vault.exists('B'));
	assert.equal(
		readSidecar(app, 'B.pdf').annotations[0].notePath,
		'B/comment-2023-11-14-annB.md'
	);
});

test('a PDF with no comments yet is never moved by the migration', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments' });
	app.vault.seedFile('Papers/Empty.pdf', '%PDF');
	app.vault.seedFile(
		'Papers/Empty.pdf.mg-comments.json',
		JSON.stringify({ version: 1, pdfPath: 'Papers/Empty.pdf', annotations: [] })
	);

	const plan = await store.planReorganisation();
	assert.deepEqual(plan.moves, []);
	assert.equal(plan.skips[0].reason, 'no-comments');
});

// --- re-entrancy ----------------------------------------------------------

test('the store ignores the rename events its own operations produce', async () => {
	const { app, store } = setup({ commentsRootFolder: 'Comments', mirrorVaultStructure: true });
	seedPdfWithComment(app, 'Papers/A.pdf', 'A');

	let dispatched = 0;
	app.vault.on('rename', () => { dispatched += 1; });

	await store.runReorganisation(await store.planReorganisation());
	await store.whenIdle();

	assert.ok(dispatched > 0, 'the mock should have fired a rename event');
	// The sidecar must reflect exactly one relocation, not a cascade of them.
	const data = readSidecar(app, 'Papers/A.pdf');
	assert.equal(data.annotations[0].notePath, 'Comments/Papers/A/comment-2023-11-14-ann1.md');
});
