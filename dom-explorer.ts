/**
 * DOM Explorer Utility
 * A developer tool for exploring the DOM structure of Obsidian elements
 */

/**
 * Options for DOM exploration
 */
export interface DomExplorerOptions {
    /** Maximum depth to traverse (default: 50) */
    maxDepth?: number;
    /** Maximum number of children to fully expand for nodes with many children (default: 10) */
    expandedNodeLimit?: number;
}

/**
 * Explores and logs the DOM structure of an HTML element
 * Simplified version that focuses on element names and their children
 * @param element The root element to explore
 * @param options Configuration options
 */
export const exploreDom = (element: HTMLElement, options: DomExplorerOptions = {}): void => {
    const {
        maxDepth = 50,
        expandedNodeLimit = 10
    } = options;
    
    console.log("=== DOM EXPLORER ===");
    console.log(`Max depth set to: ${maxDepth}`);
    
    const explore = (el: HTMLElement, depth = 0, path: number[] = []): void => {
        const indent = ' '.repeat(depth * 2);
        const tagName = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const classes = el.className && typeof el.className === 'string' 
            ? `.${el.className.split(' ').filter(c => c).join('.')}` 
            : '';
        
        const pathStr = path.length ? `[path: ${path.join('→')}]` : '';
        
        console.log(`${indent}${tagName}${id}${classes} ${pathStr}`);
        
        if (depth >= maxDepth) {
            console.log(`${indent}  ... (max depth ${maxDepth} reached)`);
            return;
        }
        
        const children = Array.from(el.children) as HTMLElement[];
        
        if (children.length > 0) {
            if (children.length > expandedNodeLimit && depth > 2) {
                console.log(`${indent}  Children: ${children.length} (showing first ${expandedNodeLimit})`);
                
                children.slice(0, expandedNodeLimit).forEach((child, i) => {
                    explore(child, depth + 1, [...path, i]);
                });
                
                console.log(`${indent}  ... (${children.length - expandedNodeLimit} more children)`);
            } else {
                console.log(`${indent}  Children: ${children.length}`);
                
                children.forEach((child, i) => {
                    explore(child, depth + 1, [...path, i]);
                });
            }
        } else {
            console.log(`${indent}  No children`);
        }
    };
    
    explore(element);
    
    console.log("\n=== ACCESS GUIDE ===");
    console.log("To access elements by path:");
    console.log('const element = container.children[0].children[1]...');
    console.log('// Or with a helper function:');
    console.log('const getByPath = (el, path) => path.reduce((acc, i) => acc?.children[i], el);');
    console.log('const element = getByPath(container, [1, 2, 0, 1]);');
};

/**
 * Helper function to get an element by path
 * @param element The root element
 * @param path Array of indices to traverse
 * @returns The element at the specified path, or null if not found
 */
export const getElementByPath = (element: HTMLElement, path: number[]): HTMLElement | null => {
    if (!element) return null;
    
    let current = element;
    for (const index of path) {
        if (!current.children || !current.children[index]) {
            console.log("Path failed at index:", index);
            return null;
        }
        current = current.children[index] as HTMLElement;
    }
    return current;
}; 