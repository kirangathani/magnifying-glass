import {
	AbstractInputSuggest,
	App,
	FileSystemAdapter,
	FuzzySuggestModal,
	Modal,
	Notice,
	Plugin,
	PluginManifest,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import { statSync } from 'fs';
import { join } from 'path';
import { VIEW_TYPE_PDF_COMMENTER, PdfCommenterView } from './view';
import { CommentStore } from './comment-store';
import { MIGRATION_SKIP_LABELS, MigrationPlan, validateRootFolder } from './comment-paths';
import { DEFAULT_SETTINGS, PdfCommenterSettings } from './settings';

type AppWithViewRegistry = App & {
	viewRegistry: {
		registerExtensions(exts: string[], type: string): void;
		unregisterExtensions(exts: string[]): void;
	};
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return null;
	return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function darkenHex(hex: string, amount: number): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;
	const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	const r = clamp(rgb.r * (1 - amount));
	const g = clamp(rgb.g * (1 - amount));
	const b = clamp(rgb.b * (1 - amount));
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function lightenHex(hex: string, amount: number): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;
	const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	const r = clamp(rgb.r + (255 - rgb.r) * amount);
	const g = clamp(rgb.g + (255 - rgb.g) * amount);
	const b = clamp(rgb.b + (255 - rgb.b) * amount);
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function resolveColorToHex(color: string): string | null {
	const el = activeDocument.body.createDiv();
	el.style.color = color;
	const computed = getComputedStyle(el).color;
	el.remove();
	const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
	if (!m) return null;
	const r = parseInt(m[1]);
	const g = parseInt(m[2]);
	const b = parseInt(m[3]);
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function getObsidianAccentHex(): string {
	const raw = getComputedStyle(activeDocument.body).getPropertyValue('--interactive-accent').trim();
	if (!raw) return '#7c3aed';
	return resolveColorToHex(raw) ?? '#7c3aed';
}

function applyAccentColor(color: string): void {
	const rgb = hexToRgb(color);
	if (!rgb) return;
	const { r, g, b } = rgb;
	const hover = darkenHex(color, 0.12);

	const body = activeDocument.body;
	body.style.setProperty('--pdf-commenter-accent', color);
	body.style.setProperty('--pdf-commenter-accent-hover', hover);
	body.style.setProperty('--pdf-commenter-accent-25', `rgba(${r}, ${g}, ${b}, 0.25)`);
	body.style.setProperty('--pdf-commenter-accent-35', `rgba(${r}, ${g}, ${b}, 0.35)`);
	body.style.setProperty('--pdf-commenter-accent-40', `rgba(${r}, ${g}, ${b}, 0.4)`);
	body.style.setProperty('--pdf-commenter-accent-12', `rgba(${r}, ${g}, ${b}, 0.12)`);
	body.style.setProperty('--pdf-commenter-accent-light', lightenHex(color, 0.3));
}

function clearAccentColor(): void {
	const props = [
		'--pdf-commenter-accent', '--pdf-commenter-accent-hover',
		'--pdf-commenter-accent-25', '--pdf-commenter-accent-35',
		'--pdf-commenter-accent-40', '--pdf-commenter-accent-12',
		'--pdf-commenter-accent-light',
	];
	const body = activeDocument.body;
	for (const p of props) body.style.removeProperty(p);
}

class PdfFileSuggestModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(f => f.extension === 'pdf');
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		void this.app.workspace.getLeaf(false).openFile(item);
	}
}

export default class PdfCommenterPlugin extends Plugin {
	settings: PdfCommenterSettings = DEFAULT_SETTINGS;
	store!: CommentStore;
	private darkModeObserver: MutationObserver | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new CommentStore(this.app, () => this.settings);
		this.applyAccent();
		this.applyDarkMode();
		this.addSettingTab(new PdfCommenterSettingTab(this.app, this));
		// Register the custom view
		this.registerView(
			VIEW_TYPE_PDF_COMMENTER,
			// NOTE: Obsidian's runtime manifest includes `dir` (folder name under .obsidian/plugins).
			// This can differ from `id` during development if the folder name doesn't match.
			(leaf) => new PdfCommenterView(leaf, {
				pluginId: this.manifest.id,
				pluginDir: (this.manifest as PluginManifest & { dir?: string }).dir ?? this.manifest.id,
				store: this.store,
			})
		);

		// A PDF, a comment note or a comment folder moving anywhere in the vault
		// (file explorer, quick switcher, sync, or the plugin's own rename box)
		// all funnel through here, so the bookkeeping is identical in every case.
		// Obsidian's `rename` event fires for moves as well as renames.
		this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			void (async () => {
				this.store.dispatchRename(file, oldPath);
				await this.store.whenIdle();
				this.refreshOpenViews();
			})();
		}));

		this.addCommand({
			id: 'reorganise-comment-folders',
			name: 'Move existing comment folders to the configured location',
			callback: () => { void this.reorganiseCommentFolders(); },
		});

		// Claim .pdf extension from built-in viewer (viewRegistry is an undocumented Obsidian API)
		(this.app as AppWithViewRegistry).viewRegistry.unregisterExtensions(['pdf']);
		this.registerExtensions(['pdf'], VIEW_TYPE_PDF_COMMENTER);

		// Ribbon icon opens a fuzzy file picker filtered to PDFs
		this.addRibbonIcon("eye", "Open PDF", () => {
			new PdfFileSuggestModal(this.app).open();
		});

		// Command to open PDF picker
		this.addCommand({
			id: "open-pdf-viewer",
			name: "Open PDF",
			callback: () => {
				new PdfFileSuggestModal(this.app).open();
			}
		});
	}

	onunload(): void {
		this.darkModeObserver?.disconnect();
		this.darkModeObserver = null;
		activeDocument.body.classList.remove('pdf-commenter-dark');
		clearAccentColor();
		const registry = (this.app as AppWithViewRegistry).viewRegistry;
		registry.unregisterExtensions(['pdf']);
		registry.registerExtensions(['pdf'], 'pdf');
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PdfCommenterSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Re-read sidecars into any open PDF view after files moved underneath it. */
	refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_COMMENTER)) {
			const view = leaf.view;
			if (view instanceof PdfCommenterView) void view.refreshAfterExternalChange();
		}
	}

	/**
	 * Changing a setting moves nothing on disk, so relocating existing comment
	 * folders is an explicit, confirmed action rather than a side effect.
	 */
	async reorganiseCommentFolders(): Promise<void> {
		let plan: MigrationPlan;
		try {
			plan = await this.store.planReorganisation();
		} catch (e) {
			new Notice(`PDF Commenter: could not plan the move — ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		if (plan.moves.length === 0) {
			const movable = plan.skips.filter(s => s.reason !== 'no-comments' && s.reason !== 'already-in-place');
			if (movable.length === 0) {
				new Notice('PDF Commenter: every comment folder is already in the right place.');
				return;
			}
		}

		new MigrationConfirmModal(this.app, plan, async () => {
			const result = await this.store.runReorganisation(plan);
			this.refreshOpenViews();
			const failed = result.failed.length;
			new Notice(
				`PDF Commenter: moved ${result.moved.length} comment folder${result.moved.length === 1 ? '' : 's'}` +
				(failed ? `, ${failed} could not be moved (see console).` : '.')
			);
			if (failed) console.warn('[pdf-commenter] failed moves:', result.failed);
		}).open();
	}

	/**
	 * Timestamp of the loaded main.js. The manifest version is identical in a
	 * dev vault and a released install, so this is what tells you whether the
	 * build you are looking at contains your unpushed work.
	 */
	getBuildStamp(): string | null {
		try {
			const adapter = this.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) return null;
			const dir = (this.manifest as PluginManifest & { dir?: string }).dir;
			if (!dir) return null;
			const mtime = statSync(join(adapter.getBasePath(), dir, 'main.js')).mtime;
			const pad = (n: number) => String(n).padStart(2, '0');
			return `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ` +
				`${pad(mtime.getHours())}:${pad(mtime.getMinutes())}:${pad(mtime.getSeconds())}`;
		} catch {
			return null;
		}
	}

	applyAccent(): void {
		const color = this.settings.useObsidianAccent
			? getObsidianAccentHex()
			: this.settings.accentColor;
		applyAccentColor(color);
	}

	applyDarkMode(): void {
		this.darkModeObserver?.disconnect();
		this.darkModeObserver = null;

		const resolve = () => {
			const mode = this.settings.darkMode;
			const body = activeDocument.body;
			let isDark: boolean;
			if (mode === 'auto') {
				isDark = body.classList.contains('theme-dark');
			} else {
				isDark = mode === 'dark';
			}
			body.classList.toggle('pdf-commenter-dark', isDark);
			if (this.settings.useObsidianAccent) this.applyAccent();
		};

		resolve();

		if (this.settings.darkMode === 'auto') {
			this.darkModeObserver = new MutationObserver(() => resolve());
			this.darkModeObserver.observe(activeDocument.body, { attributes: true, attributeFilter: ['class'] });
		}
	}
}

/** Inline folder autocomplete for the comments-root text field. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== '/')
			.filter(f => f.path.toLowerCase().contains(q))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger('input');
		this.close();
	}
}

/**
 * Shows exactly which folders will move and which will be left alone, with the
 * reason, before anything is touched.
 */
class MigrationConfirmModal extends Modal {
	constructor(app: App, private plan: MigrationPlan, private onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Move comment folders' });

		if (this.plan.moves.length === 0) {
			contentEl.createEl('p', { text: 'Nothing can be moved. See the list below for why.' });
		} else {
			contentEl.createEl('p', {
				text: `${this.plan.moves.length} comment folder${this.plan.moves.length === 1 ? '' : 's'} will be moved. ` +
					'Links to the notes inside them are updated by Obsidian.',
			});
			const list = contentEl.createEl('ul', { cls: 'pdf-commenter-migration-list' });
			for (const move of this.plan.moves) {
				const li = list.createEl('li');
				li.createEl('code', { text: move.from });
				li.createSpan({ text: '  →  ' });
				li.createEl('code', { text: move.to });
			}
		}

		// "no comments yet" is noise here: nothing exists to move.
		const notable = this.plan.skips.filter(s => s.reason !== 'no-comments' && s.reason !== 'already-in-place');
		if (notable.length > 0) {
			contentEl.createEl('h3', { text: 'Left alone' });
			const list = contentEl.createEl('ul', { cls: 'pdf-commenter-migration-list' });
			for (const skip of notable) {
				const li = list.createEl('li');
				li.createEl('code', { text: skip.from ?? skip.pdfPath });
				li.createSpan({ text: ` — ${MIGRATION_SKIP_LABELS[skip.reason]}` });
			}
		}

		const alreadyOk = this.plan.skips.filter(s => s.reason === 'already-in-place').length;
		if (alreadyOk > 0) {
			contentEl.createEl('p', {
				cls: 'pdf-commenter-migration-note',
				text: `${alreadyOk} folder${alreadyOk === 1 ? ' is' : 's are'} already in the right place.`,
			});
		}

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton(btn => btn
				.setButtonText(`Move ${this.plan.moves.length} folder${this.plan.moves.length === 1 ? '' : 's'}`)
				.setCta()
				.setDisabled(this.plan.moves.length === 0)
				.onClick(() => {
					this.close();
					void this.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class PdfCommenterSettingTab extends PluginSettingTab {
	plugin: PdfCommenterPlugin;

	constructor(app: App, plugin: PdfCommenterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const build = this.plugin.getBuildStamp();
		containerEl.createEl('p', {
			cls: 'pdf-commenter-build-stamp',
			text: `Version ${this.plugin.manifest.version}` + (build ? ` — build ${build}` : ''),
		});

		containerEl.createEl('h3', { text: 'Comment storage' });

		let rootError: HTMLElement | null = null;
		new Setting(containerEl)
			.setName('Comments folder')
			.setDesc('Vault-relative folder that all per-PDF comment folders live under. Leave empty for the vault root.')
			.addText(text => {
				/** Returns the normalised path, or an error message. */
				const check = (value: string): { path: string } | { error: string } => {
					const result = validateRootFolder(value);
					if (!result.ok) return { error: result.error };
					const clash = this.app.vault.getAbstractFileByPath(result.path);
					if (result.path && clash && !(clash instanceof TFolder)) {
						return { error: `"${result.path}" is an existing file, not a folder.` };
					}
					return { path: result.path };
				};

				const showError = (message: string | null) => {
					rootError?.setText(message ?? '');
					// The field keeps showing the rejected text, so mark it: an
					// inline message alone is easy to miss under the autocomplete.
					text.inputEl.toggleClass('pdf-commenter-input-invalid', message !== null);
				};

				text.setPlaceholder('e.g. Comments')
					.setValue(this.plugin.settings.commentsRootFolder)
					.onChange(async (value) => {
						const result = check(value);
						if ('error' in result) {
							showError(result.error);
							return;
						}
						showError(null);
						this.plugin.settings.commentsRootFolder = result.path;
						await this.plugin.saveSettings();
					});

				// Leaving the field invalid would otherwise strand the user on a
				// value that was never saved, so revert to what is actually in use.
				text.inputEl.addEventListener('blur', () => {
					const result = check(text.inputEl.value);
					if (!('error' in result)) return;
					new Notice(`PDF Commenter: ${result.error} Reverted to "${this.plugin.settings.commentsRootFolder || 'vault root'}".`);
					text.setValue(this.plugin.settings.commentsRootFolder);
					showError(null);
				});

				new FolderSuggest(this.app, text.inputEl);
			});
		rootError = containerEl.createEl('p', { cls: 'pdf-commenter-setting-error', text: '' });

		new Setting(containerEl)
			.setName('Mirror the vault folder structure')
			.setDesc('Reproduce each PDF\'s own folder path inside the comments folder. Keeps two PDFs that share a filename in different folders from sharing one comment folder.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.mirrorVaultStructure)
				.onChange(async (value) => {
					this.plugin.settings.mirrorVaultStructure = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Follow PDF moves')
			.setDesc('When a PDF is renamed or moved, relocate its comment folder to match. Comments keep working either way.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.followPdfMoves)
				.onChange(async (value) => {
					this.plugin.settings.followPdfMoves = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Move existing comment folders here')
			.setDesc('Changing the settings above only affects PDFs commented on from now on. Use this to relocate the folders that already exist. You will see exactly what will move before anything is touched.')
			.addButton(btn => btn
				.setButtonText('Review and move')
				.onClick(() => { void this.plugin.reorganiseCommentFolders(); })
			);

		containerEl.createEl('h3', { text: 'Appearance' });

		new Setting(containerEl)
			.setName('Use Obsidian accent colour')
			.setDesc('Match the accent colour you have set in Obsidian\'s appearance settings.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useObsidianAccent)
				.onChange(async (value) => {
					this.plugin.settings.useObsidianAccent = value;
					this.plugin.applyAccent();
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (!this.plugin.settings.useObsidianAccent) {
			new Setting(containerEl)
				.setName('Accent colour')
				.setDesc('The colour used for comment markers, highlights, and buttons.')
				.addColorPicker(picker => picker
					.setValue(this.plugin.settings.accentColor)
					.onChange(async (value) => {
						this.plugin.settings.accentColor = value;
						this.plugin.applyAccent();
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName('Appearance')
			.setDesc('Control light or dark appearance for comment cards and controls.')
			.addDropdown(dropdown => dropdown
				.addOption('auto', 'Follow Obsidian theme')
				.addOption('light', 'Always light')
				.addOption('dark', 'Always dark')
				.setValue(this.plugin.settings.darkMode)
				.onChange(async (value) => {
					this.plugin.settings.darkMode = value as 'auto' | 'light' | 'dark';
					this.plugin.applyDarkMode();
					await this.plugin.saveSettings();
				})
			);
	}
}
