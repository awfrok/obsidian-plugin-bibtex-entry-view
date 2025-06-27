import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent } from 'obsidian';

// 1. SETTINGS INTERFACE
// Defines the shape of the plugin's settings object.
// Using an interface provides strong typing, ensuring that settings are accessed and saved correctly.
interface BibtexEntryViewSettings {
    bibFilePath: string;       // Path to the selected .bib file within the vault.
    enableRendering: boolean;  // A toggle to turn the custom rendering on or off.
    fieldSortOrder: string[];  // An array of field names, defining the custom display order. Fields not in this list will be hidden.
}

// 2. DEFAULT SETTINGS
// Provides a fallback configuration for when the plugin is first installed or the settings file is missing.
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '',
    enableRendering: true,
    fieldSortOrder: [
        'author', 'year', 'entrytype', 'title', 'subtitle', 'editor', 
        'booktitle', 'booksubtitle', 'edition', 'journal', 'series', 'volume',
        'number', 'pages', 'address', 'publisher'
    ]
};

// --- DATA STRUCTURE INTERFACES ---
// Defines the structure for a single, parsed field from a BibTeX entry.
interface FieldNameAndValue {
    fieldName: string; // The name of the field (e.g., "author"), preserving its original casing.
    fieldValue: string; // The raw value of the field, with outer delimiters removed.
}

// Defines the final, structured representation of a BibTeX entry, ready for rendering.
interface FormattedBibtexEntry {
    entryType: string;         // The type of the entry (e.g., "article", "book").
    bibkey: string;            // The unique citation key (e.g., "doe2021").
    fields: FieldNameAndValue[]; // An array of the entry's fields, sorted and filtered.
}

// 3. MAIN PLUGIN CLASS
// This is the core of the plugin, extending Obsidian's Plugin class.
export default class BibtexEntryViewPlugin extends Plugin {
    // Holds the currently loaded settings.
    settings: BibtexEntryViewSettings;
    // An in-memory cache (Map) to store BibTeX entries, mapping the citation key to the raw entry string.
    private bibEntries: Map<string, string> = new Map();

    // This method is called once when the plugin is enabled.
    async onload() {
        // Load settings from disk, merging them with defaults.
        await this.loadSettings();
        
        // Add the plugin's settings tab to the Obsidian settings window.
        // The separate style.css file is loaded automatically by Obsidian.
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        // Register a file-watcher event. This automatically reloads the .bib file
        // whenever it is modified, ensuring the view is always up-to-date.
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file.path === this.settings.bibFilePath) {
                await this.loadBibFile();
                this.app.workspace.updateOptions(); // Force a refresh of open views.
            }
        }));

        // Use `onLayoutReady` to ensure the entire Obsidian workspace is loaded
        // before we perform file operations and register processors.
        this.app.workspace.onLayoutReady(async () => {
            await this.loadBibFile();

            // Register a processor for markdown code blocks with the language "bibkey".
            this.registerMarkdownCodeBlockProcessor("bibkey", (source, element, context) => {
                // If rendering is disabled in settings, simply display the original code block.
                if (!this.settings.enableRendering) {
                    element.createEl('pre').createEl('code', { text: `\`\`\`bibkey\n${source}\n\`\`\`` });
                    return;
                }

                // Get the citation key from the code block's source.
                const bibkey = source.trim();
                if (!bibkey) return; // Do nothing if the block is empty.

                // Look up the raw BibTeX entry from our in-memory map.
                const bibEntry = this.bibEntries.get(bibkey);
                element.empty(); // Clear the container provided by Obsidian.

                if (bibEntry) {
                    // If the entry is found, parse, filter, and sort it.
                    const parsedEntry = this.formatAndSortBibtexEntry(bibEntry);
                    if (parsedEntry) {
                        // Create the HTML structure for the rendered entry.
                        const entryPre = element.createEl('pre');
                        const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view' });
                        
                        // Render the citation key.
                        entryCode.createEl('span', { text: parsedEntry.bibkey, cls: 'bibkey' });
                        
                        // Loop through the sorted fields and render each one.
                        parsedEntry.fields.forEach((field) => {
                            entryCode.appendText('\n');
                            entryCode.createEl('span', { text: field.fieldName, cls: 'bibtex-field-name' });
                            entryCode.createEl('span', { text: ': ', cls: 'bibtex-field-name' });
                            entryCode.createEl('span',{ text: field.fieldValue, cls: 'bibtex-field-value' } )
                        });
                    }
                } else {
                    // If the bibkey is not found, render an error state.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view bibtex-error' });
                    entryCode.createEl('span', {
                        text: bibkey,
                        cls: 'bibkey-invalid-key'
                    });
                }
            });

            // Trigger a refresh of the workspace to apply the processor to any open documents.
            this.app.workspace.updateOptions();
        });
    }

    // This method is called when the plugin is disabled.
    onunload() {
        // Clear the cached BibTeX data. No need to remove styles as Obsidian handles the style.css file.
        this.bibEntries.clear();
    }

    // --- Settings Management ---
    // Loads settings from Obsidian's data store.
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    // Saves the current settings to disk and reloads the data.
    async saveSettings() {
        await this.saveData(this.settings);
        await this.loadBibFile(); // Reload the .bib file as settings may have changed.
        this.app.workspace.updateOptions(); // Refresh views.
    }
    
    // --- BibTeX Data Management ---
    // Reads and parses the .bib file specified in the settings.
    async loadBibFile() {
        this.bibEntries.clear(); // Clear existing entries before loading new ones.
        const { bibFilePath } = this.settings;

        if (!bibFilePath) return; // Do nothing if no file path is set.

        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        if (!(bibFile instanceof TFile)) {
            new Notice(`BibtexEntryView: Could not find file at: ${bibFilePath}`);
            return;
        }

        try {
            const content = await this.app.vault.read(bibFile);
            this.parseBibtexEntry(content);
            // new Notice(`BibtexEntryView: Loaded ${this.bibEntries.size} entries.`);
        } catch (error) {
            new Notice('BibtexEntryView: Error reading or parsing .bib file.');
            console.error('BibtexEntryView Error:', error);
        }
    }
    
    // Parses the string content of a .bib file into the in-memory map.
    private parseBibtexEntry(content: string) {
        // This regex robustly finds BibTeX entries, handling nested braces correctly.
        const entryRegex = /@\w+\s*\{[^,]+,(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\s*\}/gs;
        const entries = content.match(entryRegex);

        if (!entries) return;

        // For each raw entry string found, extract its key and store it in the map.
        for (const fullEntry of entries) {
            const keyMatch = fullEntry.match(/^@\w+\s*\{([\w\d\-_\.]+?)\s*[,}]/);
            if (keyMatch && keyMatch[1]) {
                const bibkey = keyMatch[1].trim();
                this.bibEntries.set(bibkey, fullEntry.trim());
            }
        }
    }

    // Parses a single raw BibTeX entry string, filters its fields, and sorts them.
    private formatAndSortBibtexEntry(entry: string): FormattedBibtexEntry | null {
        try {
            // Extract the header (@type{key,) to get the type and key.
            const headerMatch = entry.match(/^@(\w+)\s*\{\s*([^,]+),/);
            if (!headerMatch) return null;

            const entryType = headerMatch[1];
            const bibkey = headerMatch[2];
            // Isolate the body of the entry, containing all the fields.
            const body = entry.substring(headerMatch[0].length, entry.lastIndexOf('}'));

            // Regex to find all key = {value} or key = "value" pairs.
            const fieldRegex = /\s*(\w+)\s*=\s*({(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*}|"(?:[^"\\]|\\.)*")/g;
            const allParsedFields: FieldNameAndValue[] = [];
            let match;

            while ((match = fieldRegex.exec(body)) !== null) {
                const fieldName = match[1];
                
                // Extract the value part (everything after the '=').
                const valueMatch = match[0].match(/=\s*(.*)/s);
                let fieldValuePart = valueMatch ? valueMatch[1].trim() : '';
                
                // Remove only the outermost braces or quotes.
                if ((fieldValuePart.startsWith('{') && fieldValuePart.endsWith('}')) || (fieldValuePart.startsWith('"') && fieldValuePart.endsWith('"'))) {
                    fieldValuePart = fieldValuePart.slice(1, -1);
                }

                allParsedFields.push({ fieldName, fieldValue: fieldValuePart });
            }
            
            // Add the entryType as a pseudo-field so it can be sorted and displayed.
            allParsedFields.push({ fieldName: 'entrytype', fieldValue: entryType });
            
            // NEW LOGIC: Filter fields to only include those present in the sort order list.
            const priorityOrder = this.settings.fieldSortOrder.map(f => f.toLowerCase());
            let fieldsToRender = allParsedFields.filter(field => priorityOrder.includes(field.fieldName.toLowerCase()));

            // --- Sorting Logic ---
            let primaryField: FieldNameAndValue | undefined;

            // Find the index of the 'author' field within the *filtered* list.
            const authorIndex = fieldsToRender.findIndex(f => f.fieldName.toLowerCase() === 'author');
            if (authorIndex !== -1) {
                // If author exists, remove it from the list and set it as the primary field.
                primaryField = fieldsToRender.splice(authorIndex, 1)[0];
            } else {
                // If no author, check for an 'editor' field to use as the primary instead.
                const editorIndex = fieldsToRender.findIndex(f => f.fieldName.toLowerCase() === 'editor');
                if (editorIndex !== -1) {
                    primaryField = fieldsToRender.splice(editorIndex, 1)[0];
                }
            }
            
            // Sort the *remaining* fields according to the user-defined priority list.
            fieldsToRender.sort((a, b) => {
                const fieldNameA = a.fieldName.toLowerCase();
                const fieldNameB = b.fieldName.toLowerCase();
                
                const sortIndexA = priorityOrder.indexOf(fieldNameA);
                const sortIndexB = priorityOrder.indexOf(fieldNameB);

                // Since all fields are guaranteed to be in the priorityOrder, we can just compare their indices.
                // A check for -1 is not strictly necessary here but is good practice.
                if (sortIndexA !== -1 && sortIndexB !== -1) return sortIndexA - sortIndexB;
                return 0; // Should not be reached if filtering is correct.
            });
            
            // Reconstruct the final list, adding the primary field back to the start.
            const sortedFields = primaryField ? [primaryField, ...fieldsToRender] : fieldsToRender;

            return { entryType, bibkey, fields: sortedFields };
        } catch (error) {
            console.error("BibtexEntryView: Error formatting entry, returning null.", error);
            return null;
        }
    }
}

// 4. SETTINGS TAB CLASS
// Defines the UI for the plugin's settings page.
class BibtexEntryViewSettingTab extends PluginSettingTab {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // This method is called when the settings tab is opened.
    display(): void {
        const { containerEl } = this;
        containerEl.empty(); // Clear the tab to prevent duplicate elements.
        
        new Setting(containerEl)
            .setName('Enable rendering')
            .setDesc('If disabled, bibkey code blocks will not be rendered.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableRendering)
                .onChange((value) => {
                    this.plugin.settings.enableRendering = value;
                }));
        
        containerEl.createEl('h2', { text: 'Bib file' });

        new Setting(containerEl)
            .setName('Current .bib file in the vault')
            .setDesc('This is the file the plugin is currently using.')
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setPlaceholder('No file selected')
                .setDisabled(true) // This is for display only.
            );
        
        new Setting(containerEl)
            .setName('Select or import a .bib file')
            .setDesc('Choose a file from your vault or import one from your computer.')
            .addButton(button => button
                .setButtonText('Select from vault')
                .setTooltip('Select a .bib file in your vault')
                .onClick(() => {
                    new BibFileSelectionModal(this.app, (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        this.display(); // Refresh the settings screen to show the new path.
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import to vault')
                .setTooltip('Beware: This will overwrite any file with the same name in the vault.')
                .onClick(() => {
                    // Create a temporary file input element to open the system file picker.
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
                            if (existingFile instanceof TFile) {
                                await this.app.vault.modify(existingFile, content);
                            } else {
                                await this.app.vault.create(newPath, content);
                            }
                            
                            this.plugin.settings.bibFilePath = newPath;
                            this.display(); // Refresh to show new path.
                        } catch (error) {
                            new Notice(`BibtexEntryView: Error importing file: ${error.message}`);
                        }
                    };
                    fileInput.click();
                }));
        
        containerEl.createEl('h2', { text: 'Customize rendering' });

        new Setting(containerEl)
            .setName('Fields to display and sort')
            .setDesc('List the fields you want to display, in the order you want them to appear. Fields not in this list will be hidden. \nNote: Author and editor fields have a special priority. When author field is in the bibtex entry, author field is rendered in the first line; when author field is missed in the bibtex entry, editor field is rendered in the first line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join('\n'))
                    .onChange((value) => {
                        // Update settings in memory; they will be saved when the tab closes.
                        this.plugin.settings.fieldSortOrder = value.split('\n').map(field => field.trim()).filter(Boolean);
                    });
                text.inputEl.rows = 10;
                text.inputEl.cols = 30;
            });
    }

    // This method is called when the user navigates away from the settings tab.
    hide(): void {
        // Save all settings changes at once.
        this.plugin.saveSettings();
    }
}

// 5. FILE SELECTION MODAL
// A popup window for selecting a .bib file from the vault.
class BibFileSelectionModal extends Modal {
    onChooseFile: (path: string) => void;
    private bibFiles: TFile[];

    constructor(app: App, onChooseFile: (path: string) => void) {
        super(app);
        this.onChooseFile = onChooseFile; // Callback to run when a file is chosen.
        // Get all files in the vault, filter for .bib extension, and sort them.
        this.bibFiles = this.app.vault.getFiles()
            .filter(file => file.extension === 'bib')
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    // Called when the modal is opened.
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select BibTeX File from Vault' });

        // Add a search input to filter the file list.
        const searchInput = new TextComponent(contentEl)
            .setPlaceholder('Search for .bib files...');
        searchInput.inputEl.style.width = '100%';
        searchInput.inputEl.style.marginBottom = '10px';
        
        const listEl = contentEl.createEl('div');
        
        // Function to render the list of files based on the search filter.
        const updateList = (filter: string) => {
            listEl.empty();
            const filtered = this.bibFiles.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
            
            if (!filtered.length) {
                listEl.createEl('p', { text: 'No matching .bib files found.' });
                return;
            }

            filtered.forEach(file => {
                const item = listEl.createEl('div', { text: file.path, cls: 'bibtex-file-item' });
                item.addEventListener('click', () => {
                    this.onChooseFile(file.path); // Execute the callback.
                    this.close(); // Close the modal.
                });
            });
        };

        searchInput.onChange(updateList);
        updateList(''); // Initially render the full list.
    }

    // Called when the modal is closed.
    onClose() {
        this.contentEl.empty();
    }
}
