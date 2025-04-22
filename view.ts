import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';

/**
 * Unique identifier for our custom view type
 */
export const VIEW_TYPE_EXAMPLE = 'example-view';

/**
 * Example view that demonstrates how to create a custom view in Obsidian
 */
export class ExampleView extends ItemView {
    private pdfContainer: HTMLElement;
    private currentPdfUrl: string | null = null;

    /**
     * Constructs a new ExampleView
     */
    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    /**
     * Returns the type of the view
     */
    getViewType(): string {
        return VIEW_TYPE_EXAMPLE;
    }

    /**
     * Returns the display text for the view
     */
    getDisplayText(): string {
        return 'Example View';
    }

    /**
     * Called when the view is opened
     */
    async onOpen(): Promise<void> {
        // Clear the container element
        const container = this.containerEl.children[1];
        container.empty();
        
        // Create main content wrapper
        const mainContent = container.createEl('div', { cls: 'main-content-wrapper' });
        mainContent.style.display = 'flex';
        mainContent.style.flexDirection = 'column';
        mainContent.style.height = '100%';
        
        // Create top section for controls
        const controlsSection = mainContent.createEl('div', { cls: 'controls-section' });
        
        // Create a simple header
        const headerEl = controlsSection.createEl('h2', { text: 'Example View' });
        
        // Add a paragraph with some text
        controlsSection.createEl('p', {
            text: 'This is a minimal example of a custom view in Obsidian.'
        });
        
        // Add a button that does something
        const buttonEl = controlsSection.createEl('button', {
            text: 'Click Me',
            cls: 'mod-cta'
        });
        
        // Add a click event to the button
        buttonEl.addEventListener('click', () => {
            const timestamp = new Date().toLocaleTimeString();
            controlsSection.createEl('p', {
                text: `Button clicked at ${timestamp}`,
                cls: 'click-result'
            });
        });

        // Add a horizontal rule for separation
        controlsSection.createEl('hr');

        // Create PDF input section
        const pdfInputSection = controlsSection.createEl('div', { cls: 'pdf-input-section' });
        
        // Add label for the input
        pdfInputSection.createEl('label', {
            text: 'PDF Path (relative to vault root):',
            cls: 'pdf-input-label'
        });

        // Create input container with flex layout
        const inputContainer = pdfInputSection.createEl('div', { cls: 'pdf-input-container' });
        
        // Add the input field
        const pdfInput = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'e.g., My_PDF.pdf',
            cls: 'pdf-path-input'
        });

        // Add a load button
        const loadButton = inputContainer.createEl('button', {
            text: 'Load PDF',
            cls: 'mod-cta'
        });

        // Create container for PDF viewer
        this.pdfContainer = mainContent.createEl('div', { cls: 'pdf-viewer-container' });
        this.pdfContainer.style.display = 'none';
        this.pdfContainer.style.flex = '1';
        this.pdfContainer.style.marginTop = '20px';
        this.pdfContainer.style.position = 'relative';

        // Add click event to the load button
        loadButton.addEventListener('click', async () => {
            const pdfPath = pdfInput.value.trim();
            if (pdfPath) {
                try {
                    // Get the file from the vault
                    const file = this.app.vault.getAbstractFileByPath(pdfPath);
                    
                    if (file instanceof TFile && file.extension === 'pdf') {
                        // Clear previous PDF viewer if any
                        this.pdfContainer.empty();
                        
                        // Revoke previous blob URL if it exists
                        if (this.currentPdfUrl) {
                            URL.revokeObjectURL(this.currentPdfUrl);
                            this.currentPdfUrl = null;
                        }

                        // Get the PDF data as an array buffer
                        const pdfData = await this.app.vault.readBinary(file);
                        
                        // Create a blob URL for the PDF
                        const blob = new Blob([pdfData], { type: 'application/pdf' });
                        this.currentPdfUrl = URL.createObjectURL(blob);
                        
                        // Create iframe for PDF viewer
                        const iframe = this.pdfContainer.createEl('iframe');
                        iframe.style.width = '100%';
                        iframe.style.height = '100%';
                        iframe.style.position = 'absolute';
                        iframe.style.border = 'none';
                        iframe.src = this.currentPdfUrl;
                        
                        // Show the PDF container
                        this.pdfContainer.style.display = 'block';
                        this.pdfContainer.style.height = '600px';
                        
                        // Show success message
                        const successMsg = controlsSection.createEl('p', {
                            text: `Successfully loaded PDF: ${pdfPath}`,
                            cls: 'success-message'
                        });
                        
                        // Remove success message after 3 seconds
                        setTimeout(() => successMsg.remove(), 3000);
                    } else {
                        // Show error message
                        const errorMsg = controlsSection.createEl('p', {
                            text: `Error: ${pdfPath} is not a valid PDF file`,
                            cls: 'error-message'
                        });
                        setTimeout(() => errorMsg.remove(), 3000);
                    }
                } catch (error) {
                    // Show error message
                    const errorMsg = controlsSection.createEl('p', {
                        text: `Error loading PDF: ${error.message}`,
                        cls: 'error-message'
                    });
                    setTimeout(() => errorMsg.remove(), 3000);
                }
            }
        });
    }

    /**
     * Called when the view is closed
     */
    async onClose(): Promise<void> {
        // Clean up blob URL when closing
        if (this.currentPdfUrl) {
            URL.revokeObjectURL(this.currentPdfUrl);
            this.currentPdfUrl = null;
        }
    }
}
