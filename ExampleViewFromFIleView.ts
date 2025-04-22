// import { FileView, WorkspaceLeaf, TFile } from 'obsidian';

// /**
//  * Unique identifier for our custom view type
//  */
// export const VIEW_TYPE_EXAMPLE = 'example-view';

// /**
//  * Example view that demonstrates how to create a custom view in Obsidian
//  */
// export class ExampleView extends FileView {
//     /**
//      * Constructs a new ExampleView
//      */
//     constructor(leaf: WorkspaceLeaf) {
//         super(leaf);
//     }

//     /**
//      * Returns the type of the view
//      */
//     getViewType(): string {
//         return VIEW_TYPE_EXAMPLE;
//     }

//     /**
//      * Returns the display text for the view
//      */
//     getDisplayText(): string {
//         return 'Example View';
//     }

//     /**
//      * Called when the view is opened
//      */
//     async onOpen(): Promise<void> {
//         console.log("We have opened the file:)");
//         console.log("Container element structure:", this.containerEl);
//         console.log("Container children:", this.containerEl.children);
        
//         // Clear the container element
//         const container = this.containerEl.children[1];
//         if (container) {
//             console.log("There is a container we have found!");
//             console.log("Container before empty:", container.innerHTML);
//         }
        
//         container.empty();
//         console.log("Container after empty:", container.innerHTML);
        
//         // Create a simple header
//         const headerEl = container.createEl('h2', { text: 'Example View' });
//         console.log("Created header element:", headerEl);
        
//         // Create some content
//         const contentEl = container.createEl('div', { cls: 'example-content' });
//         console.log("Created content element:", contentEl);
        
//         // Add a paragraph with some text
//         contentEl.createEl('p', {
//             text: 'This is a minimal example of a custom view in Obsidian.'
//         });
        
//         // Add a button that does something
//         const buttonEl = contentEl.createEl('button', {
//             text: 'Click Me',
//             cls: 'mod-cta'
//         });
        
//         // Add a click event to the button
//         buttonEl.addEventListener('click', () => {
//             const timestamp = new Date().toLocaleTimeString();
//             contentEl.createEl('p', {
//                 text: `Button clicked at ${timestamp}`,
//                 cls: 'click-result'
//             });
//         });
        
//         console.log("Final container HTML:", container.innerHTML);
//     }

//     /**
//      * Check if the file extension is supported
//      */
//     canAcceptExtension(extension: string): boolean {
//         return extension.toLowerCase() === 'pdf';
//     }

//     /**
//      * Called when a file is loaded
//      */
//     async onLoadFile(file: TFile): Promise<void> {
//         // This will be implemented later for PDF-specific functionality
//         console.log("PDF file loaded:", file.path);
//     }

//     /**
//      * Called when a file is unloaded
//      */
//     async onUnloadFile(file: TFile): Promise<void> {
//         // Clean up any PDF resources if needed
//     }

//     /**
//      * Called when the view is closed
//      */
//     async onClose(): Promise<void> {
//         // Clean up any resources if needed
//     }
// }
