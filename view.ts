import { ItemView, WorkspaceLeaf } from 'obsidian';

/**
 * Unique identifier for our custom view type
 */
export const VIEW_TYPE_EXAMPLE = 'example-view';

/**
 * Example view that demonstrates how to create a custom view in Obsidian
 */
export class ExampleView extends ItemView {
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
        
        // Create a simple header
        const headerEl = container.createEl('h2', { text: 'Example View' });
        
        // Create some content
        const contentEl = container.createEl('div', { cls: 'example-content' });
        
        // Add a paragraph with some text
        contentEl.createEl('p', {
            text: 'This is a minimal example of a custom view in Obsidian.'
        });
        
        // Add a button that does something
        const buttonEl = contentEl.createEl('button', {
            text: 'Click Me',
            cls: 'mod-cta'
        });
        
        // Add a click event to the button
        buttonEl.addEventListener('click', () => {
            const timestamp = new Date().toLocaleTimeString();
            contentEl.createEl('p', {
                text: `Button clicked at ${timestamp}`,
                cls: 'click-result'
            });
        });

        // Add a horizontal rule for separation
        contentEl.createEl('hr');

        // Create PDF input section
        const pdfInputSection = contentEl.createEl('div', { cls: 'pdf-input-section' });
        
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

        // Add click event to the load button
        loadButton.addEventListener('click', () => {
            const pdfPath = pdfInput.value.trim();
            if (pdfPath) {
                console.log('Attempting to load PDF:', pdfPath);
                // TODO: Implement PDF loading functionality
            }
        });
    }

    /**
     * Called when the view is closed
     */
    async onClose(): Promise<void> {
        // Clean up any resources if needed
    }
}
