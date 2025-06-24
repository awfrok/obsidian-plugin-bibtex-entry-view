import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, TextAreaComponent } from 'obsidian';

// 1. SETTINGS INTERFACE: Defines the shape of our plugin's data
// This interface ensures that any settings object we use has the correct properties and types.
// It helps prevent errors by enabling TypeScript's static type-checking.
interface BibtexEntryViewSettings {
    bibFilePath: string;
    enableRendering: boolean; 
    fieldSortOrder: string[]; 
    fieldsToRemove: string[]; // --- NEW: Setting for fields to remove ---
}

// 2. DEFAULT SETTINGS: Provides default values for a fresh installation
// This constant holds the initial settings for when the plugin is first installed
// or when the settings data file is missing or corrupt.
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '',
    enableRendering: true,
    fieldSortOrder: [
        'author', 'editor', 'year', 'title', 'subtitle', 
        'booktitle', 'booksubtitle', 'edition', 'journal', 'series', 'volume', 
        'number', 'pages', 'address', 'publisher'
    ],
    // --- NEW: Default fields to remove ---
    fieldsToRemove: [
        'abstract', 'creationdate', 'modificationdate', 'citationkey', 'language', 'keywords'
    ]
}

// --- UPDATED: Interface for parsed BibTeX data to be rendered ---
interface ParsedBibtexField {
    fieldName: string;
    fieldValue: string; // Stores the raw value without brackets
}

interface FormattedBibtexEntry {
    entryType: string;
    bibkey: string;
    fields: ParsedBibtexField[];
}


// 3. MAIN PLUGIN CLASS: This is the heart of the plugin
// It extends Obsidian's Plugin class and contains the core logic.
export default class BibtexEntryViewPlugin extends Plugin {
    // This will hold the plugin's current settings.
    settings: BibtexEntryViewSettings;
    // This Map will store the BibTeX data in memory for fast access.
    // The key is the bibkey (e.g., "einstein1905"), and the value is the full BibTeX entry string.
    private bibEntries: Map<string, string> = new Map();

    // ONLOAD: This method runs once when the plugin is enabled.
    async onload() {
        console.log('BibtexEntryView Plugin: Loading...');

        // Load any settings saved on disk, merging them with the defaults.
        await this.loadSettings();
        
        // --- NEW: Inject custom CSS for persistent styling ---
        this.addStyles();

        // Add the settings tab to Obsidian's settings window.
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        // Defer the initial loading and processor registration until the entire Obsidian workspace is fully ready.
        // This is the standard, safe way to avoid startup errors.
        this.app.workspace.onLayoutReady(async () => {
            // First, load the data from the BibTeX file.
            await this.loadBibFile();

            // --- UPDATED: Use the more efficient registerMarkdownCodeBlockProcessor ---
            // This processor specifically targets code blocks with the "bibkey" language.
            this.registerMarkdownCodeBlockProcessor("bibkey", (source, element, context) => {
                // If auto-rendering is turned off, we must manually reconstruct the original code block to make it visible.
                if (!this.settings.enableRendering) {
                    element.createEl('pre').createEl('code', { text: source });
                    return;
                }

                const bibkey = source.trim();
                if (!bibkey) return;

                const bibEntry = this.bibEntries.get(bibkey);

                // 'element' is the container div provided by Obsidian. We don't need to empty it or replace it.
                if (bibEntry) {
                    const parsedEntry = this.reorderAndFormatBibtex(bibEntry);
                    if (parsedEntry) {
                        const entryPre = element.createEl('pre');
                        const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view' });
                        
                        // Build the styled entry programmatically.
                        entryCode.createEl('span', { text: parsedEntry.bibkey, cls: 'bibkey' });
                        
                        parsedEntry.fields.forEach((field) => {
                            entryCode.appendText('\n');
                            entryCode.createEl('span', { text: field.fieldName, cls: 'bibtex-field-name' });
                            entryCode.appendText(': ');
                            entryCode.createEl('span',{ text: field.fieldValue, cls: 'bibtex-field-value' } )
                        });
                    }
                } else {
                    // If the bibkey is not found, render an error message.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view bibtex-error' });
                    entryCode.createEl('span', {
                        text: bibkey,
                        cls: 'bibkey-invalid-key'
                    });
                }
            });

            // Force any currently open documents to re-render to apply our new processor.
            this.app.workspace.updateOptions();
        });
    }

    // ONUNLOAD: This method runs when the plugin is disabled.
    onunload() {
        console.log('BibtexEntryView Plugin: Unloading...');
        // Clear the in-memory BibTeX data to free up resources.
        this.bibEntries.clear();
        // --- NEW: Remove the custom styles when the plugin is disabled ---
        this.removeStyles();
    }
    
    // --- NEW: Methods to manage the plugin's stylesheet ---
    addStyles() {
        // Create a style element and add our CSS rules.
        // This is more robust than inline styles and prevents flickering.
        const css = `
            .bibkey {
                color: var(--text-accent);
                font-weight: bold;
            }
            .bibtex-field-name, .bibtex-entrytype {
                color: var(--text-muted);
            }
            .bibkey-invalid-key {
                color: red;
                text-decoration: line-through;
            }
        `;
        const styleEl = document.createElement('style');
        styleEl.id = 'bibtex-entry-view-styles'; // Give it an ID for easy removal later
        styleEl.appendChild(document.createTextNode(css));
        document.head.appendChild(styleEl);
    }

    removeStyles() {
        // Find our style element by its ID and remove it to keep Obsidian clean when the plugin unloads.
        const styleEl = document.getElementById('bibtex-entry-view-styles');
        if (styleEl) {
            styleEl.remove();
        }
    }


    // --- Data Management Methods ---

    // Loads the plugin's settings from the data.json file in the plugin's folder.
    async loadSettings() {
        // Object.assign merges the default settings with any saved settings.
        // This ensures that new settings added in an update get a default value.
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    // Saves the plugin's current settings to the data.json file.
    async saveSettings() {
        await this.saveData(this.settings);
    }
    
    // Reads the content of the .bib file specified in the settings and parses it.
    public async loadBibFile() {
        // Clear any old data first.
        this.bibEntries.clear();
        const { bibFilePath } = this.settings;

        if (!bibFilePath) {
            console.warn('BibtexEntryView Plugin: No BibTeX file path specified.');
            return;
        }

        // Use Obsidian's API to get a reference to the file by its path.
        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        // Check if the file exists and is actually a file (not a folder).
        if (!(bibFile instanceof TFile)) {
            new Notice(`BibTeX Plugin: Could not find file at: ${bibFilePath}`);
            return;
        }

        try {
            // Read the file's content and parse it.
            const content = await this.app.vault.read(bibFile);
            this.parseBibtexContent(content);
            new Notice(`BibTeX Plugin: Loaded ${this.bibEntries.size} entries.`);
        } catch (error) {
            new Notice('BibTeX Plugin: Error reading or parsing .bib file.');
            console.error('BibTeX Plugin Error:', error);
        }
    }
    
    // Parses the raw string content from a .bib file into the in-memory map.
    private parseBibtexContent(content: string) {
        // Split the file by the '@' symbol, which marks the start of each new entry.
        // .slice(1) is used to discard the text before the first '@'.
        for (const rawEntry of content.split('@').slice(1)) {
            const fullEntry = '@' + rawEntry.trim();
            // This regex extracts the bibkey from the entry (e.g., "einstein1905").
            const keyMatch = rawEntry.match(/^\s*\w+\s*\{([\w\d\-_\.]+?)\s*[,}]/);
            if (keyMatch && keyMatch[1]) {
                const bibkey = keyMatch[1].trim();
                // If a key is found, store the full entry in the map.
                this.bibEntries.set(bibkey, fullEntry);
            }
        }
    }

    /**
     * Parses a BibTeX entry, reorders its fields, and returns a structured object.
     * @param entry The raw string of a single BibTeX entry.
     * @returns A structured object for rendering, or null on failure.
     */
    private reorderAndFormatBibtex(entry: string): FormattedBibtexEntry | null {
        try {
            // Step 1: Extract the header (e.g., @article{einstein1905,)
            const headerMatch = entry.match(/^@(\w+)\s*\{\s*([^,]+),/);
            if (!headerMatch) return null; // Return null if parsing fails

            const entryType = headerMatch[1];
            const bibkey = headerMatch[2];
            const body = entry.substring(headerMatch[0].length, entry.length - 1).trim();

            // Step 2: Extract all key-value fields into a map.
            const fieldRegex = /\s*(\w+)\s*=\s*({(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*}|"(?:[^"\\]|\\.)*")/g;
            const fields = new Map<string, string>();
            let match;
            while ((match = fieldRegex.exec(body)) !== null) {
                const fieldName = match[1].toLowerCase();
                const fullFieldString = match[0].trim();
                fields.set(fieldName, fullFieldString);
            }
            
            // Step 3: Remove fields we never want to show, based on user settings.
            const fieldsToRemove = this.settings.fieldsToRemove;
            fieldsToRemove.forEach(fieldName => fields.delete(fieldName.toLowerCase()));

            // Step 4: Build the final list of fields in the desired order.
            const orderedFields: ParsedBibtexField[] = [];
            
            // --- UPDATED: Use the sort order from settings ---
            const priorityOrder = this.settings.fieldSortOrder;
            
            // Helper function to process and add a field to our ordered list.
            const addField = (fieldName: string) => {
                const fullFieldString = fields.get(fieldName)!;
                const separatorIndex = fullFieldString.indexOf('=');
                
                const namePart = fullFieldString.substring(0, separatorIndex).trim();
                let valuePart = fullFieldString.substring(separatorIndex + 1).trim();

                // Strip wrapping braces or quotes from the value
                if ((valuePart.startsWith('{') && valuePart.endsWith('}')) || (valuePart.startsWith('"') && valuePart.endsWith('"'))) {
                    valuePart = valuePart.slice(1, -1);
                }

                // Remove any remaining curly brackets from the value
                valuePart = valuePart.replace(/[{}]/g, '');

                orderedFields.push({
                    fieldName: namePart,
                    fieldValue: valuePart
                });
                fields.delete(fieldName);
            }

            // Handle the special case for author/editor. Use author if it exists; otherwise, use editor.
            if (fields.has('author')) {
                addField('author');
                fields.delete('editor'); // Prevent editor from appearing again later
            } else if (fields.has('editor')) {
                addField('editor');
            }

            const prioritySet = new Set(['author', 'editor']); // Keep track of fields already added

            // Iterate through our priority list and add the fields in order.
            for (const fieldName of priorityOrder) {
                if (prioritySet.has(fieldName)) continue; // Skip author/editor, already handled

                if (fields.has(fieldName)) {
                    // Ensure subtitle/booksubtitle only appear if their parent title exists.
                    if (fieldName === 'subtitle' && !prioritySet.has('title')) continue;
                    if (fieldName === 'booksubtitle' && !prioritySet.has('booktitle')) continue;

                    addField(fieldName);
                    prioritySet.add(fieldName);
                }
            }
            
            // Add any remaining fields (that were not in the priority list) in alphabetical order.
            const remainingKeys = Array.from(fields.keys()).sort();
            for (const fieldName of remainingKeys) {
                addField(fieldName);
            }

            // Step 5: Return the structured object
            return { entryType, bibkey, fields: orderedFields };
        } catch (error) {
            console.error("BibTeX Plugin: Error reordering fields, returning null.", error);
            return null; // On any failure, return null.
        }
    }
}

// 4. SETTINGS TAB CLASS: Defines the UI for the plugin's settings
class BibtexEntryViewSettingTab extends PluginSettingTab {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // This method is called by Obsidian to render the settings UI.
    display(): void {
        const { containerEl } = this;
        containerEl.empty(); // Clear previous settings to prevent duplication
        containerEl.createEl('h2', { text: 'BibTeX Entry View Settings' });
        
        // --- NEW: Toggle to enable/disable rendering ---
        new Setting(containerEl)
            .setName('Enable Rendering')
            .setDesc('Turn on or off rendering `bibkey` blocks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableRendering)
                .onChange(async (value) => {
                    this.plugin.settings.enableRendering = value;
                    await this.plugin.saveSettings();
                    this.plugin.app.workspace.updateOptions(); // --- UPDATED: Explicitly update workspace
                    new Notice('Rendering setting updated.');
                }));
        
        // A read-only text field to show the user which file is currently active.
        new Setting(containerEl)
            .setName('Current BibTeX File in the Vault')
            .setDesc('The vault-relative path of the .bib file currently in use.')
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setDisabled(true) // Makes the field non-editable
            );
        
        // A setting with two buttons for choosing a file.
        new Setting(containerEl)
            .setName('Select BibTeX File')
            .setDesc('Choose a file from your vault or import one from your computer.')
            .addButton(button => button
                .setButtonText('Browse Vault')
                .setTooltip('Select a .bib file already in your vault')
                .onClick(() => {
                    // Opens our custom file selection modal.
                    new BibFileSelectionModal(this.app, async (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        await this.plugin.saveSettings();
                        await this.plugin.loadBibFile();
                        this.plugin.app.workspace.updateOptions();
                        this.display(); // Re-render the settings tab to show the new path
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import External File')
                .setTooltip('Copy a .bib file from your computer into the vault')
                .setCta() // Makes the button more prominent
                .onClick(() => {
                    // This creates a hidden file input element and programmatically "clicks" it
                    // to open the system's native file browser.
                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.accept = '.bib';
                    fileInput.onchange = async () => {
                        if (!fileInput.files || fileInput.files.length === 0) return;
                        
                        const file = fileInput.files[0];
                        const content = await file.text();
                        const newPath = file.name;

                        try {
                            const existingFile = this.app.vault.getAbstractFileByPath(newPath);
                            // If a file with the same name exists, overwrite it. Otherwise, create a new file.
                            if (existingFile instanceof TFile) {
                                await this.app.vault.modify(existingFile, content);
                                new Notice(`Overwrote existing file: ${newPath}`);
                            } else {
                                await this.app.vault.create(newPath, content);
                                new Notice(`Imported and saved file as: ${newPath}`);
                            }
                            
                            // Update the settings to use the newly imported file.
                            this.plugin.settings.bibFilePath = newPath;
                            await this.plugin.saveSettings();
                            await this.plugin.loadBibFile();
                            this.plugin.app.workspace.updateOptions();
                            this.display();
                        } catch (error) {
                            new Notice(`Error importing file: ${error.message}`);
                        }
                    };
                    fileInput.click();
                }));
        
        // --- NEW: Setting to customize field sort order ---
        new Setting(containerEl)
            .setName('Field Sort Order')
            .setDesc('List the BibTeX fields in the order you want them to be rendered. One field name per line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join('\n'))
                    .onChange(async (value) => {
                        // Parse the text area content into an array
                        const newOrder = value.split('\n').map(field => field.trim()).filter(field => field.length > 0);
                        this.plugin.settings.fieldSortOrder = newOrder;
                        await this.plugin.saveSettings();
                        this.plugin.app.workspace.updateOptions();
                    });
                text.inputEl.rows = 10;
                text.inputEl.cols = 30;
            });
            
        // --- NEW: Setting to customize which fields are removed ---
        new Setting(containerEl)
            .setName('Fields to Remove')
            .setDesc('List the BibTeX fields you want to remove from the rendering. One field name per line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldsToRemove.join('\n'))
                    .onChange(async (value) => {
                        const newFieldsToRemove = value.split('\n').map(field => field.trim()).filter(field => field.length > 0);
                        this.plugin.settings.fieldsToRemove = newFieldsToRemove;
                        await this.plugin.saveSettings();
                        this.plugin.app.workspace.updateOptions();
                    });
                text.inputEl.rows = 6;
                text.inputEl.cols = 30;
            });
    }
}

// 5. FILE SELECTION MODAL: The popup for browsing vault files
class BibFileSelectionModal extends Modal {
    onChooseFile: (path: string) => void;
    private bibFiles: TFile[];

    constructor(app: App, onChooseFile: (path: string) => void) {
        super(app); // Corrected this line
        this.onChooseFile = onChooseFile;
        // Get all files in the vault, filter for .bib extension, and sort them alphabetically.
        this.bibFiles = this.app.vault.getFiles()
            .filter(file => file.extension === 'bib')
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    // This is called when the modal is opened.
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select BibTeX File from Vault' });

        // Add a search bar to filter the list of files.
        const searchInput = new TextComponent(contentEl)
            .setPlaceholder('Search for .bib files...');
        searchInput.inputEl.style.width = '100%';
        searchInput.inputEl.style.marginBottom = '10px';
        
        const listEl = contentEl.createEl('div');
        
        const updateList = (filter: string) => {
            listEl.empty();
            const filtered = this.bibFiles.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
            if (!filtered.length) {
                listEl.createEl('p', { text: 'No matching .bib files found.' });
                return;
            }
            // Create a clickable div for each found file.
            filtered.forEach(file => {
                const item = listEl.createEl('div', { text: file.path, cls: 'bibtex-file-item' });
                item.style.cssText = 'cursor: pointer; padding: 8px 10px; border-radius: var(--radius-s);';
                // Add a hover effect for better UX.
                item.onmouseover = () => item.style.backgroundColor = 'var(--background-modifier-hover)';
                item.onmouseout = () => item.style.backgroundColor = 'transparent';
                // When a file is clicked, call the callback function and close the modal.
                item.onclick = () => {
                    this.onChooseFile(file.path);
                    this.close();
                };
            });
        };

        // Update the list whenever the search input changes.
        searchInput.onChange(updateList);
        updateList(''); // Initially display all files
    }

    // This is called when the modal is closed.
    onClose() {
        this.contentEl.empty();
    }
}
