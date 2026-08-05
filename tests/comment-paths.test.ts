import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	MigrationEntry,
	isInsideFolder,
	joinVaultPath,
	parentPath,
	pdfBaseName,
	pdfPathForSidecar,
	planMigration,
	rewritePathPrefix,
	sanitizeVaultName,
	sidecarPathForPdf,
	targetCommentFolder,
	validateRootFolder,
} from '../comment-paths';

const FLAT_ROOT = { commentsRootFolder: '', mirrorVaultStructure: false };
const MIRROR_ROOT = { commentsRootFolder: '', mirrorVaultStructure: true };
const FLAT_COMMENTS = { commentsRootFolder: 'Comments', mirrorVaultStructure: false };
const MIRROR_COMMENTS = { commentsRootFolder: 'Comments', mirrorVaultStructure: true };

// --- 1. the four root x mirror combinations -------------------------------

test('targetCommentFolder covers all root x mirror combinations', () => {
	const pdf = 'Papers/Research/Dutta 2024.pdf';
	assert.equal(targetCommentFolder(pdf, FLAT_ROOT), 'Dutta 2024');
	assert.equal(targetCommentFolder(pdf, MIRROR_ROOT), 'Papers/Research/Dutta 2024');
	assert.equal(targetCommentFolder(pdf, FLAT_COMMENTS), 'Comments/Dutta 2024');
	assert.equal(targetCommentFolder(pdf, MIRROR_COMMENTS), 'Comments/Papers/Research/Dutta 2024');
});

test('a PDF at the vault root never produces a leading slash', () => {
	assert.equal(targetCommentFolder('Dutta 2024.pdf', MIRROR_ROOT), 'Dutta 2024');
	assert.equal(targetCommentFolder('Dutta 2024.pdf', MIRROR_COMMENTS), 'Comments/Dutta 2024');
	assert.equal(targetCommentFolder('Dutta 2024.pdf', FLAT_COMMENTS), 'Comments/Dutta 2024');
});

test('flat layout is byte-identical to the pre-setting behaviour', () => {
	// The historical implementation was: sanitize(basename) at the vault root.
	for (const pdf of ['x.pdf', 'a/b/x.pdf', 'a/Weird: Name?.pdf']) {
		assert.equal(targetCommentFolder(pdf, FLAT_ROOT), sanitizeVaultName(pdfBaseName(pdf)));
	}
});

// --- 2. the same-basename collision --------------------------------------

test('mirroring separates two PDFs that share a basename', () => {
	const a = 'Papers/Research/Dutta 2024.pdf';
	const b = 'Archive/Dutta 2024.pdf';
	assert.notEqual(targetCommentFolder(a, MIRROR_COMMENTS), targetCommentFolder(b, MIRROR_COMMENTS));
});

test('without mirroring the two collide, which is why mirroring is the default', () => {
	const a = 'Papers/Research/Dutta 2024.pdf';
	const b = 'Archive/Dutta 2024.pdf';
	assert.equal(targetCommentFolder(a, FLAT_COMMENTS), targetCommentFolder(b, FLAT_COMMENTS));
});

// --- 3. sanitisation ------------------------------------------------------

test('illegal folder characters are replaced', () => {
	assert.equal(sanitizeVaultName('a:b?c|d*e"f<g>h'), 'a_b_c_d_e_f_g_h');
	assert.equal(sanitizeVaultName('a/b\\c'), 'a_b_c');
});

test('a name that sanitises to nothing falls back to Untitled', () => {
	assert.equal(sanitizeVaultName(''), 'Untitled');
	assert.equal(sanitizeVaultName('   '), 'Untitled');
});

test('pdfBaseName strips only a trailing .pdf, case-insensitively', () => {
	assert.equal(pdfBaseName('a/b/Report.PDF'), 'Report');
	assert.equal(pdfBaseName('a/b/Report.pdf.pdf'), 'Report.pdf');
	assert.equal(pdfBaseName('a/b/notapdf'), 'notapdf');
});

// --- 4. root path validation ---------------------------------------------

test('root paths are normalised', () => {
	assert.deepEqual(validateRootFolder(''), { ok: true, path: '' });
	assert.deepEqual(validateRootFolder('   '), { ok: true, path: '' });
	assert.deepEqual(validateRootFolder('/Comments/'), { ok: true, path: 'Comments' });
	assert.deepEqual(validateRootFolder('Comments//Sub'), { ok: true, path: 'Comments/Sub' });
	assert.deepEqual(validateRootFolder('Comments\\Sub'), { ok: true, path: 'Comments/Sub' });
});

test('dangerous or invalid root paths are rejected', () => {
	for (const bad of ['..', 'a/../b', './x', 'C:/Users/kiran', '.obsidian/plugins', 'a/b?c']) {
		const result = validateRootFolder(bad);
		assert.equal(result.ok, false, `expected ${bad} to be rejected`);
	}
});

test('a folder merely containing dots is fine', () => {
	assert.deepEqual(validateRootFolder('My.Comments/v2'), { ok: true, path: 'My.Comments/v2' });
});

// --- 5 & 6. migration planning -------------------------------------------

const entries = (...specs: [string, string | null][]): MigrationEntry[] =>
	specs.map(([pdfPath, currentFolder]) => ({ pdfPath, currentFolder }));

test('planMigration moves folders to the configured root', () => {
	const plan = planMigration(
		entries(['Papers/Dutta 2024.pdf', 'Dutta 2024']),
		MIRROR_COMMENTS
	);
	assert.deepEqual(plan.moves, [
		{ pdfPath: 'Papers/Dutta 2024.pdf', from: 'Dutta 2024', to: 'Comments/Papers/Dutta 2024' },
	]);
	assert.deepEqual(plan.skips, []);
});

test('planMigration is idempotent: replanning its own output moves nothing', () => {
	const input = entries(['Papers/A.pdf', 'A'], ['B.pdf', 'B']);
	const first = planMigration(input, MIRROR_COMMENTS);
	assert.equal(first.moves.length, 2);

	const after = input.map((e) => {
		const move = first.moves.find((m) => m.pdfPath === e.pdfPath);
		return move ? { ...e, currentFolder: move.to } : e;
	});
	const second = planMigration(after, MIRROR_COMMENTS);
	assert.deepEqual(second.moves, []);
	assert.ok(second.skips.every((s) => s.reason === 'already-in-place'));
});

test('a PDF with no comments is skipped, never moved', () => {
	const plan = planMigration(entries(['Papers/A.pdf', null]), MIRROR_COMMENTS);
	assert.deepEqual(plan.moves, []);
	assert.equal(plan.skips[0].reason, 'no-comments');
});

test('an occupied target produces a skip with a reason, not a merge', () => {
	const plan = planMigration(
		entries(['Papers/A.pdf', 'A']),
		MIRROR_COMMENTS,
		new Set(['Comments/Papers/A'])
	);
	assert.deepEqual(plan.moves, []);
	assert.equal(plan.skips[0].reason, 'target-exists');
	assert.equal(plan.skips[0].to, 'Comments/Papers/A');
});

test('two PDFs resolving to one target move neither', () => {
	// Only possible without mirroring, which is exactly the collision case.
	const plan = planMigration(
		entries(['Papers/A.pdf', 'A'], ['Archive/A.pdf', 'A_1']),
		FLAT_COMMENTS
	);
	assert.deepEqual(plan.moves, []);
	assert.equal(plan.skips.length, 2);
	assert.ok(plan.skips.every((s) => s.reason === 'duplicate-target'));
});

test('a target that another move is vacating is not treated as occupied', () => {
	// A must end up where B currently is; the runner orders these in passes.
	const plan = planMigration(
		entries(['A.pdf', 'tmp'], ['B.pdf', 'A']),
		{ commentsRootFolder: '', mirrorVaultStructure: false },
		new Set(['tmp', 'A'])
	);
	assert.ok(plan.moves.some((m) => m.pdfPath === 'A.pdf' && m.to === 'A'));
});

// --- 7. prefix-safe path rewriting ---------------------------------------

test('rewritePathPrefix does not match a sibling with a shared prefix', () => {
	assert.equal(
		rewritePathPrefix('Dutta 2024 Notes/x.md', 'Dutta 2024', 'Comments/Dutta 2024'),
		'Dutta 2024 Notes/x.md'
	);
	assert.equal(
		rewritePathPrefix('Dutta 2024/x.md', 'Dutta 2024', 'Comments/Dutta 2024'),
		'Comments/Dutta 2024/x.md'
	);
});

test('isInsideFolder is prefix-safe and excludes the folder itself', () => {
	assert.equal(isInsideFolder('A/b.md', 'A'), true);
	assert.equal(isInsideFolder('AB/b.md', 'A'), false);
	assert.equal(isInsideFolder('A', 'A'), false);
	assert.equal(isInsideFolder('A/b.md', ''), false);
});

// --- misc path helpers ----------------------------------------------------

test('sidecar path round-trips', () => {
	const pdf = 'Papers/Dutta 2024.pdf';
	assert.equal(sidecarPathForPdf(pdf), 'Papers/Dutta 2024.pdf.mg-comments.json');
	assert.equal(pdfPathForSidecar(sidecarPathForPdf(pdf)), pdf);
	assert.equal(pdfPathForSidecar('Papers/notes.md'), null);
});

test('parentPath and joinVaultPath handle root-level items', () => {
	assert.equal(parentPath('a.pdf'), '');
	assert.equal(parentPath('a/b/c.pdf'), 'a/b');
	assert.equal(joinVaultPath('', 'a', '', 'b'), 'a/b');
	assert.equal(joinVaultPath(null, undefined, 'a'), 'a');
});
