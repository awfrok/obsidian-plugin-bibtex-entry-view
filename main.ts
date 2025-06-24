import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, TextAreaComponent } from 'obsidian';

// 1. SETTINGS INTERFACE
interface BibtexEntryViewSettings {
    bibFilePath: string;
    enableRendering: boolean;
    fieldSortOrder: string[];
    fieldsToRemove: string[];
}

// 2. DEFAULT SETTINGS
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '',
    enableRendering: true,
    fieldSortOrder: [
        'author', 'year', 'title', 'subtitle', 'editor', 
        'booktitle', 'booksubtitle', 'edition', 'journal', 'series', 'volume',
        'number', 'pages', 'address', 'publisher'
    ],
    fieldsToRemove: [
        'abstract', 'creationdate', 'modificationdate', 'citationkey', 'language', 'keywords'
    ]
};

// --- DATA STRUCTURE INTERFACES ---
interface ParsedBibtexField {
    fieldName: string; // Keeps original casing
    fieldValue: string;
}

interface FormattedBibtexEntry {
    entryType: string;
    bibkey: string;
    fields: ParsedBibtexField[];
}

// 3. MAIN PLUGIN CLASS
export default class BibtexEntryViewPlugin extends Plugin {
    settings: BibtexEntryViewSettings;
    private bibEntries: Map<string, string> = new Map();

    async onload() {
        await this.loadSettings();
        
        this.addStyles();
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file.path === this.settings.bibFilePath) {
                await this.loadBibFile();
                this.app.workspace.updateOptions();
            }
        }));

        this.app.workspace.onLayoutReady(async () => {
            await this.loadBibFile();

            this.registerMarkdownCodeBlockProcessor("bibkey", (source, element, context) => {
                if (!this.settings.enableRendering) {
                    element.createEl('pre').createEl('code', { text: `\`\`\`bibkey\n${source}\n\`\`\`` });
                    return;
                }

                const bibkey = source.trim();
                if (!bibkey) return;

                const bibEntry = this.bibEntries.get(bibkey);
                element.empty(); // Clear the container

                if (bibEntry) {
                    const parsedEntry = this.formatAndSortBibtexEntry(bibEntry);
                    if (parsedEntry) {
                        const entryPre = element.createEl('pre');
                        const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view' });
                        
                        entryCode.createEl('span', { text: parsedEntry.bibkey, cls: 'bibkey' });
                        
                        parsedEntry.fields.forEach((field) => {
                            entryCode.appendText('\n');
                            entryCode.createEl('span', { text: field.fieldName, cls: 'bibtex-field-name' });
                            entryCode.createEl('span', { text: ': ', cls: 'bibtex-field-name' });
                            entryCode.createEl('span',{ text: field.fieldValue, cls: 'bibtex-field-value' } )
                        });
                    }
                } else {
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view bibtex-error' });
                    entryCode.createEl('span', {
                        text: bibkey,
                        cls: 'bibkey-invalid-key'
                    });
                }
            });

            this.app.workspace.updateOptions();
        });
    }

    onunload() {
        this.bibEntries.clear();
        this.removeStyles();
    }
    
    // --- Stylesheet Management ---
    addStyles() {
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
                color: var(--text-error);
                opacity: 0.6;
                text-decoration: line-through;
            }
            .bibtex-file-item {
                cursor: pointer; 
                padding: 8px 10px; 
                border-radius: var(--radius-s);
            }
            .bibtex-file-item:hover {
                background-color: var(--background-modifier-hover);
            }
        `;
        const styleEl = document.createElement('style');
        styleEl.id = 'bibtex-entry-view-styles';
        styleEl.appendChild(document.createTextNode(css));
        document.head.appendChild(styleEl);
    }

    removeStyles() {
        const styleEl = document.getElementById('bibtex-entry-view-styles');
        if (styleEl) {
            styleEl.remove();
        }
    }

    // --- Settings Management ---
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        await this.loadBibFile();
        this.app.workspace.updateOptions();
    }
    
    // --- BibTeX Data Management ---
    async loadBibFile() {
        this.bibEntries.clear();
        const { bibFilePath } = this.settings;

        if (!bibFilePath) {
            return;
        }

        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        if (!(bibFile instanceof TFile)) {
            new Notice(`BibtexEntryView: Could not find file at: ${bibFilePath}`);
            return;
        }

        try {
            const content = await this.app.vault.read(bibFile);
            this.parseBibtexContent(content);
            //new Notice(`BibtexEntryView: Loaded ${this.bibEntries.size} entries.`);
        } catch (error) {
            new Notice('BibtexEntryView: Error reading or parsing .bib file.');
            console.error('BibtexEntryView Error:', error);
        }
    }
    
    private parseBibtexContent(content: string) {
        // Regex to match a complete BibTeX entry, robustly handling nested braces.
        const entryRegex = /@\w+\s*\{[^,]+,(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\s*\}/gs;
        const entries = content.match(entryRegex);

        if (!entries) {
            return;
        }

        for (const fullEntry of entries) {
            const keyMatch = fullEntry.match(/^@\w+\s*\{([\w\d\-_\.]+?)\s*[,}]/);
            if (keyMatch && keyMatch[1]) {
                const bibkey = keyMatch[1].trim();
                this.bibEntries.set(bibkey, fullEntry.trim());
            }
        }
    }

    private formatAndSortBibtexEntry(entry: string): FormattedBibtexEntry | null {
        try {
            const headerMatch = entry.match(/^@(\w+)\s*\{\s*([^,]+),/);
            if (!headerMatch) return null;

            const entryType = headerMatch[1];
            const bibkey = headerMatch[2];
            const body = entry.substring(headerMatch[0].length, entry.lastIndexOf('}'));

            const fieldRegex = /\s*(\w+)\s*=\s*({(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*}|"(?:[^"\\]|\\.)*")/g;
            const parsedFields: ParsedBibtexField[] = [];
            let match;

            const fieldsToRemoveLower = this.settings.fieldsToRemove.map(f => f.toLowerCase());

            while ((match = fieldRegex.exec(body)) !== null) {
                const fieldName = match[1];
                const fieldNameLower = fieldName.toLowerCase();

                if (fieldsToRemoveLower.includes(fieldNameLower)) {
                    continue;
                }

                // Extract the value part, which is everything after the '='
                const valueMatch = match[0].match(/=\s*(.*)/s);
                let fieldValuePart = valueMatch ? valueMatch[1].trim() : '';
                
                // Remove only the outermost braces or quotes
                if ((fieldValuePart.startsWith('{') && fieldValuePart.endsWith('}')) || (fieldValuePart.startsWith('"') && fieldValuePart.endsWith('"'))) {
                    fieldValuePart = fieldValuePart.slice(1, -1);
                }

                parsedFields.push({
                    fieldName: fieldName, // Keep original casing
                    fieldValue: fieldValuePart
                });
            }

            // REFACTORED AND CORRECTED SORTING LOGIC
            let primaryField: ParsedBibtexField | undefined;
            let remainingFields = [...parsedFields];

            // Determine if author exists and extract it as the primary field.
            const authorIndex = remainingFields.findIndex(f => f.fieldName.toLowerCase() === 'author');
            if (authorIndex !== -1) {
                primaryField = remainingFields.splice(authorIndex, 1)[0];
            } else {
                // If no author, determine if editor exists and extract it as the primary field.
                const editorIndex = remainingFields.findIndex(f => f.fieldName.toLowerCase() === 'editor');
                if (editorIndex !== -1) {
                    primaryField = remainingFields.splice(editorIndex, 1)[0];
                }
            }
            
            const priorityOrder = this.settings.fieldSortOrder.map(f => f.toLowerCase());
            
            // Sort the *remaining* fields based on the user's sort order.
            remainingFields.sort((a, b) => {
                const fieldNameA = a.fieldName.toLowerCase();
                const fieldNameB = b.fieldName.toLowerCase();
                
                const sortIndexA = priorityOrder.indexOf(fieldNameA);
                const sortIndexB = priorityOrder.indexOf(fieldNameB);

                if (sortIndexA !== -1 && sortIndexB !== -1) return sortIndexA - sortIndexB;
                if (sortIndexA !== -1) return -1;
                if (sortIndexB !== -1) return 1;
                return fieldNameA.localeCompare(fieldNameB);
            });
            
            // Reconstruct the final list, prepending the primary field if it was found.
            const sortedFields = primaryField ? [primaryField, ...remainingFields] : remainingFields;

            return { entryType, bibkey, fields: sortedFields };
        } catch (error) {
            console.error("BibtexEntryView: Error formatting entry, returning null.", error);
            return null;
        }
    }
}

// 4. SETTINGS TAB CLASS
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
            .setDesc('If disabled, bibkey code blocks will not be rendered.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableRendering)
                .onChange((value) => {
                    this.plugin.settings.enableRendering = value;
                }));
        
        containerEl.createEl('h2', { text: 'Bib file' });

        new Setting(containerEl)
            .setName('Current .bib file')
            .setDesc('This is the file the plugin is currently using.')
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setPlaceholder('No file selected')
                .setDisabled(true)
            );
        
        new Setting(containerEl)
            .setName('Select or import a .bib file')
            .setDesc('Choose a file from your vault or import one from your computer.')
            .addButton(button => button
                .setButtonText('Select from vault')
                .setTooltip('Select a .bib file already in your vault')
                .onClick(() => {
                    new BibFileSelectionModal(this.app, (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        this.display(); // Refresh the settings screen
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import to vault')
                .setTooltip('This will overwrite any file with the same name in the vault.')
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
                                // new Notice(`Overwrote existing file: ${newPath}`);
                            } else {
                                await this.app.vault.create(newPath, content);
                                // new Notice(`Imported and saved file as: ${newPath}`);
                            }
                            
                            this.plugin.settings.bibFilePath = newPath;
                            this.display(); // Refresh settings
                        } catch (error) {
                            new Notice(`BibtexEntryView: Error importing file: ${error.message}`);
                        }
                    };
                    fileInput.click();
                }));
        
        containerEl.createEl('h2', { text: 'Customize rendering' });

        new Setting(containerEl)
            .setName('Field sort order')
            .setDesc('List BibTeX fields in the desired render order. One field per line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join('\n'))
                    .onChange((value) => {
                        this.plugin.settings.fieldSortOrder = value.split('\n').map(field => field.trim()).filter(Boolean);
                    });
                text.inputEl.rows = 5;
                text.inputEl.cols = 30;
            });
            
        new Setting(containerEl)
            .setName('Fields to remove')
            .setDesc('List BibTeX fields to exclude from rendering. One field per line.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldsToRemove.join('\n'))
                    .onChange((value) => {
                        this.plugin.settings.fieldsToRemove = value.split('\n').map(field => field.trim()).filter(Boolean);
                    });
                text.inputEl.rows = 5;
                text.inputEl.cols = 30;
            });
    }

    hide(): void {
        this.plugin.saveSettings();
    }
}

// 5. FILE SELECTION MODAL
class BibFileSelectionModal extends Modal {
    onChooseFile: (path: string) => void;
    private bibFiles: TFile[];

    constructor(app: App, onChooseFile: (path: string) => void) {
        // CORRECTED: The 'super' call now only passes 'app', as expected by the Modal constructor.
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
                item.addEventListener('click', () => {
                    this.onChooseFile(file.path);
                    this.close();
                });
            });
        };

        searchInput.onChange(updateList);
        updateList(''); // Initial display
    }

    onClose() {
        this.contentEl.empty();
    }
}