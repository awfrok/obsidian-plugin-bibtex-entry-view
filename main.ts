import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, TextAreaComponent } from 'obsidian';

// 1. SETTINGS INTERFACE: Defines the shape of our plugin's data
// This interface ensures that any settings object we use has the correct properties and types.
// It helps prevent errors by enabling TypeScript's static type-checking.
interface BibtexEntryViewSettings {
    bibFilePath: string;
    enableRendering: boolean; 
    fieldSortOrder: string[]; 
    fieldsToRemove: string[];
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
    fieldsToRemove: [
        'abstract', 'creationdate', 'modificationdate', 'citationkey', 'language', 'keywords'
    ]
}

// --- UPDATED: Interface for parsed BibTeX data to be rendered ---
// This defines the structure for a single field after it has been parsed.
interface ParsedBibtexField {
    fieldName: string;
    fieldValue: string; // Stores the raw value without brackets
}

// This defines the structure for a fully parsed and ready-to-render BibTeX entry.
interface FormattedBibtexEntry {
    entryType: string;
    bibkey: string;
    fields: ParsedBibtexField[];
}


// 3. MAIN PLUGIN CLASS: This is the heart of the plugin
// It extends Obsidian's Plugin class and contains the core logic.
export default class BibtexEntryViewPlugin extends Plugin {
    settings: BibtexEntryViewSettings;
    private bibEntries: Map<string, string> = new Map();

    // ONLOAD: This method runs once when the plugin is enabled.
    async onload() {
        // Load any settings saved on disk, merging them with the defaults.
        await this.loadSettings();
        
        // Inject custom CSS for persistent styling
        this.addStyles();

        // Add the settings tab to Obsidian's settings window.
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        // Register a file watcher to automatically reload the .bib file on change
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file.path === this.settings.bibFilePath) {
                await this.loadBibFile();
                this.app.workspace.updateOptions(); // Refresh views to show changes
            }
        }));

        // Defer the initial loading and processor registration until the entire Obsidian workspace is fully ready.
        // This is the standard, safe way to avoid startup errors.
        this.app.workspace.onLayoutReady(async () => {
            await this.loadBibFile();

            // Use the more efficient registerMarkdownCodeBlockProcessor.
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

                // 'element' is the container div provided by Obsidian.
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
                            entryCode.createEl('span', { text: ': ', cls: 'bibtex-field-name' });
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
        // Clear the in-memory BibTeX data and remove custom styles to keep Obsidian clean.
        this.bibEntries.clear();
        this.removeStyles();
    }
    
    // --- Stylesheet Management ---
    addStyles() {
        // Create a style element and add our CSS rules.
        // This is more robust than inline styles and prevents flickering.
        const css = `
            .bibkey {
                color: var(--text-accent);
                font-weight: bold;
            }
            .bibtex-field-name, .bibtex-entrytype {
                opacity: 0.5;
            }
            .bibtex-field-value {
                opacity: 0.65;
                font-weight: bold;
            }
            .bibkey-invalid-key {
                color: red;
                opacity: 0.5;
                text-decoration: line-through;
            }
        `;
        const styleEl = document.createElement('style');
        styleEl.id = 'bibtex-entry-view-styles'; // Give it an ID for easy removal later
        styleEl.appendChild(document.createTextNode(css));
        document.head.appendChild(styleEl);
    }

    removeStyles() {
        // Find our style element by its ID and remove it.
        const styleEl = document.getElementById('bibtex-entry-view-styles');
        if (styleEl) {
            styleEl.remove();
        }
    }


    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // After saving settings, always reload the bib file and refresh views
        await this.loadBibFile();
        this.app.workspace.updateOptions();
    }
    
    // --- Bibtexentry Management ---
    public async loadBibFile() {
        this.bibEntries.clear();
        const { bibFilePath } = this.settings;

        if (!bibFilePath) {
            return; // Don't show a notice if no file is selected yet.
        }

        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        if (!(bibFile instanceof TFile)) {
            new Notice(`BibTeX Plugin: Could not find file at: ${bibFilePath}`);
            return;
        }

        try {
            const content = await this.app.vault.read(bibFile);
            this.parseBibtexContent(content);
            new Notice(`BibTeX Plugin: Loaded ${this.bibEntries.size} entries.`);
        } catch (error) {
            new Notice('BibTeX Plugin: Error reading or parsing .bib file.');
            console.error('BibTeX Plugin Error:', error);
        }
    }
    
    private parseBibtexContent(content: string) {
        for (const rawEntry of content.split('@').slice(1)) {
            const fullEntry = '@' + rawEntry.trim();
            const keyMatch = rawEntry.match(/^\s*\w+\s*\{([\w\d\-_\.]+?)\s*[,}]/);
            if (keyMatch && keyMatch[1]) {
                const bibkey = keyMatch[1].trim();
                this.bibEntries.set(bibkey, fullEntry);
            }
        }
    }

    private reorderAndFormatBibtex(entry: string): FormattedBibtexEntry | null {
        try {
            const headerMatch = entry.match(/^@(\w+)\s*\{\s*([^,]+),/);
            if (!headerMatch) return null;

            const entryType = headerMatch[1];
            const bibkey = headerMatch[2];
            const body = entry.substring(headerMatch[0].length, entry.length - 1).trim();

            const fieldRegex = /\s*(\w+)\s*=\s*({(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*}|"(?:[^"\\]|\\.)*")/g;
            const fields = new Map<string, string>();
            let match;
            while ((match = fieldRegex.exec(body)) !== null) {
                const fieldName = match[1].toLowerCase();
                const fullFieldString = match[0].trim();
                fields.set(fieldName, fullFieldString);
            }
            
            this.settings.fieldsToRemove.forEach(fieldName => fields.delete(fieldName.toLowerCase()));

            const orderedFields: ParsedBibtexField[] = [];
            const priorityOrder = this.settings.fieldSortOrder;
            
            const addField = (fieldName: string) => {
                const fullFieldString = fields.get(fieldName)!;
                const separatorIndex = fullFieldString.indexOf('=');
                
                const namePart = fullFieldString.substring(0, separatorIndex).trim();
                let valuePart = fullFieldString.substring(separatorIndex + 1).trim();

                if ((valuePart.startsWith('{') && valuePart.endsWith('}')) || (valuePart.startsWith('"') && valuePart.endsWith('"'))) {
                    valuePart = valuePart.slice(1, -1);
                }

                valuePart = valuePart.replace(/[{}]/g, '');

                orderedFields.push({
                    fieldName: namePart,
                    fieldValue: valuePart
                });
                fields.delete(fieldName);
            }

            if (fields.has('author')) {
                addField('author');
            } else if (fields.has('editor')) {
                addField('editor');
            }
            
            for (const fieldName of priorityOrder) {
                if (fields.has(fieldName)) {
                    addField(fieldName);
                }
            }
            
            const remainingKeys = Array.from(fields.keys()).sort();
            for (const fieldName of remainingKeys) {
                addField(fieldName);
            }

            return { entryType, bibkey, fields: orderedFields };
        } catch (error) {
            console.error("BibTeX Plugin: Error reordering fields, returning null.", error);
            return null;
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

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        new Setting(containerEl)
            .setName('Enable rendering')
            .setDesc('Turn on or off rendering for `bibkey` code blocks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableRendering)
                .onChange(async (value) => {
                    this.plugin.settings.enableRendering = value;
                    await this.plugin.saveSettings();
                    new Notice('Rendering setting updated.');
                }));
        
        new Setting(containerEl)
            .setName('Current .bib file')
            .setDesc('The path to the .bib file this plugin is using, relative to your vault root.')
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setDisabled(true)
            );
        
        new Setting(containerEl)
            .setName('Select or import file')
            .setDesc('Choose a file from your vault or import one from your computer.')
            .addButton(button => button
                .setButtonText('Browse vault')
                .setTooltip('Select a .bib file already in your vault')
                .onClick(() => {
                    new BibFileSelectionModal(this.app, async (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        await this.plugin.saveSettings();
                        this.display();
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import external file')
                .setTooltip('Copy a .bib file from your computer into the vault. This will overwrite any file with the same name.')
                .onClick(() => {
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
                                new Notice(`Overwrote existing file: ${newPath}`);
                            } else {
                                await this.app.vault.create(newPath, content);
                                new Notice(`Imported and saved file as: ${newPath}`);
                            }
                            
                            this.plugin.settings.bibFilePath = newPath;
                            await this.plugin.saveSettings();
                            this.display();
                        } catch (error) {
                            new Notice(`Error importing file: ${error.message}`);
                        }
                    };
                    fileInput.click();
                }));
        
        new Setting(containerEl)
            .setName('Field sort order')
            .setDesc('List the BibTeX fields in the order you want them to be rendered. One field name per line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join('\n'))
                    .onChange(async (value) => {
                        const newOrder = value.split('\n').map(field => field.trim()).filter(field => field.length > 0);
                        this.plugin.settings.fieldSortOrder = newOrder;
                    });
                text.inputEl.rows = 10;
                text.inputEl.cols = 30;
            });
            
        new Setting(containerEl)
            .setName('Fields to remove')
            .setDesc('List the BibTeX fields you want to remove from the rendering. One field name per line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldsToRemove.join('\n'))
                    .onChange(async (value) => {
                        const newFieldsToRemove = value.split('\n').map(field => field.trim()).filter(field => field.length > 0);
                        this.plugin.settings.fieldsToRemove = newFieldsToRemove;
                        await this.plugin.saveSettings();
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
        super(app);
        this.onChooseFile = onChooseFile;
        this.bibFiles = this.app.vault.getFiles()
            .filter(file => file.extension === 'bib')
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select BibTeX File from Vault' });

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
            filtered.forEach(file => {
                const item = listEl.createEl('div', { text: file.path, cls: 'bibtex-file-item' });
                item.style.cssText = 'cursor: pointer; padding: 8px 10px; border-radius: var(--radius-s);';
                item.onmouseover = () => item.style.backgroundColor = 'var(--background-modifier-hover)';
                item.onmouseout = () => item.style.backgroundColor = 'transparent';
                item.onclick = () => {
                    this.onChooseFile(file.path);
                    this.close();
                };
            });
        };

        searchInput.onChange(updateList);
        updateList('');
    }

    onClose() {
        this.contentEl.empty();
    }
}
