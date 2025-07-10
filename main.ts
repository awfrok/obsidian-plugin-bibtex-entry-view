import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo } from 'obsidian';

// 1. SETTINGS INTERFACE
// Defines the shape of the plugin's settings object.
interface BibtexEntryViewSettings {
    bibFilePath: string;      // Path to the selected .bib file within the vault.
    fieldSortOrder: string[]; // An array of field names, defining the custom display order.
}

// 2. DEFAULT SETTINGS
// Provides a fallback configuration for when the plugin is first installed.
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '',
    fieldSortOrder: [
        'author', 'year', 'entrytype', 'title', 'subtitle', 'editor', 
        'booktitle', 'booksubtitle', 'maintitle', 'mainsubtitle', 
        'edition', 'journal', 'series', 'volume',
        'number', 'pages', 'address', 'publisher'
    ]
};

// --- DATA STRUCTURE INTERFACES ---
interface FieldNameAndValue {
    fieldName: string;
    fieldValue: string;
}

interface FormattedBibtexEntry {
    entryType: string;
    bibkey: string;
    fields: FieldNameAndValue[];
}

// 3. MAIN PLUGIN CLASS
export default class BibtexEntryViewPlugin extends Plugin {
    settings: BibtexEntryViewSettings;
    // An in-memory cache to store BibTeX entries, mapping citation key to the raw entry string.
    bibEntries: Map<string, string> = new Map();

    async onload() {
        await this.loadSettings();
        
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        this.registerEditorSuggest(new BibkeySuggester(this.app, this));

        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file.path === this.settings.bibFilePath) {
                await this.loadBibFile();
                this.app.workspace.updateOptions();
            }
        }));

        this.app.workspace.onLayoutReady(async () => {
            await this.loadBibFile();

            this.registerMarkdownCodeBlockProcessor("bibkey", (source, element, context) => {
                const bibkey = source.trim();
                element.empty(); // Clear the container first

                if (!bibkey) {
                    // If the code block is empty, show a placeholder message.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view bibtex-error' });
                    entryCode.createEl('span', {
                        text: '(provide a correct key)',
                        cls: 'bibkey-invalid-key'
                    });
                    return;
                }

                const bibEntry = this.bibEntries.get(bibkey);

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
                    // This handles keys that are provided but not found in the .bib file.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: 'bibtex-entry-view bibtex-error' });
                    
                    // Display the invalid key first.
                    entryCode.createEl('span', {
                        text: bibkey,
                        cls: 'bibkey-invalid-key'
                    });

                    // Append the guide text.
                    entryCode.appendText(' '); // Add a space for separation.
                    entryCode.createEl('span', {
                        text: '(provide a correct key)',
                        cls: 'bibkey-invalid-key' // Use the same class for consistent styling.
                    });
                }
            });

            this.app.workspace.updateOptions();
        });
    }

    onunload() {
        this.bibEntries.clear();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        await this.loadBibFile();
        this.app.workspace.updateOptions();
    }
    
    async loadBibFile() {
        this.bibEntries.clear();
        const { bibFilePath } = this.settings;

        if (!bibFilePath) return;

        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        if (!(bibFile instanceof TFile)) {
            new Notice(`BibtexEntryView: Could not find file at: ${bibFilePath}`);
            return;
        }

        try {
            const content = await this.app.vault.read(bibFile);
            this.parseBibtexEntry(content);
        } catch (error) {
            new Notice('BibtexEntryView: Error reading or parsing .bib file.');
            console.error('BibtexEntryView Error:', error);
        }
    }
    
    private parseBibtexEntry(content: string) {
        const entryRegex = /@\w+\s*\{[^,]+,(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?\s*\}/gs;
        const entries = content.match(entryRegex);

        if (!entries) return;

        for (const fullEntry of entries) {
            const keyMatch = fullEntry.match(/^@\w+\s*\{([\w\d\-_\.]+?)\s*[,}]/);
            if (keyMatch && keyMatch[1]) {
                const bibkey = keyMatch[1].trim();
                this.bibEntries.set(bibkey, fullEntry.trim());
            }
        }
    }

    formatAndSortBibtexEntry(entry: string): FormattedBibtexEntry | null {
        try {
            const headerMatch = entry.match(/^@(\w+)\s*\{\s*([^,]+),/);
            if (!headerMatch) return null;

            const entryType = headerMatch[1];
            const bibkey = headerMatch[2];
            const body = entry.substring(headerMatch[0].length, entry.lastIndexOf('}'));

            const fieldRegex = /\s*(\w+)\s*=\s*({(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*}|"(?:[^"\\]|\\.)*")/g;
            const allParsedFields: FieldNameAndValue[] = [];
            let match;

            while ((match = fieldRegex.exec(body)) !== null) {
                const fieldName = match[1];
                const valueMatch = match[0].match(/=\s*(.*)/s);
                let fieldValuePart = valueMatch ? valueMatch[1].trim() : '';
                
                if ((fieldValuePart.startsWith('{') && fieldValuePart.endsWith('}')) || (fieldValuePart.startsWith('"') && fieldValuePart.endsWith('"'))) {
                    fieldValuePart = fieldValuePart.slice(1, -1);
                }
                allParsedFields.push({ fieldName, fieldValue: fieldValuePart });
            }
            
            allParsedFields.push({ fieldName: 'entrytype', fieldValue: entryType });
            
            const priorityOrder = this.settings.fieldSortOrder.map(f => f.toLowerCase());
            let fieldsToRender = allParsedFields.filter(field => priorityOrder.includes(field.fieldName.toLowerCase()));

            let primaryField: FieldNameAndValue | undefined;
            const authorIndex = fieldsToRender.findIndex(f => f.fieldName.toLowerCase() === 'author');
            if (authorIndex !== -1) {
                primaryField = fieldsToRender.splice(authorIndex, 1)[0];
            } else {
                const editorIndex = fieldsToRender.findIndex(f => f.fieldName.toLowerCase() === 'editor');
                if (editorIndex !== -1) {
                    primaryField = fieldsToRender.splice(editorIndex, 1)[0];
                }
            }
            
            fieldsToRender.sort((a, b) => {
                const fieldNameA = a.fieldName.toLowerCase();
                const fieldNameB = b.fieldName.toLowerCase();
                const sortIndexA = priorityOrder.indexOf(fieldNameA);
                const sortIndexB = priorityOrder.indexOf(fieldNameB);
                if (sortIndexA !== -1 && sortIndexB !== -1) return sortIndexA - sortIndexB;
                return 0;
            });
            
            const sortedFields = primaryField ? [primaryField, ...fieldsToRender] : fieldsToRender;

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
        
        containerEl.createEl('h2', { text: 'Bib file' });

        new Setting(containerEl)
            .setName('Current .bib file in the vault')
            .setDesc('This is the file the plugin is currently using.')
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setPlaceholder('No file selected')
                .setDisabled(true)
            );
        
        new Setting(containerEl)
            .setName('Select or import a .bib file')
            .setDesc('Choose a file from your vault or import one from your computer. • Beware: Importing a file will overwrite the file of same name in the vault.')
            .addButton(button => button
                .setButtonText('Select from vault')
                .setTooltip('Select a .bib file in your vault')
                .onClick(() => {
                    new BibFileSelectionModal(this.app, (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        this.display();
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import to vault')
                .setTooltip('Beware: Importing a file will overwrite the file of same name in the vault.')
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
                            } else {
                                await this.app.vault.create(newPath, content);
                            }
                            
                            this.plugin.settings.bibFilePath = newPath;
                            this.display();
                        } catch (error) {
                            new Notice(`BibtexEntryView: Error importing file: ${error.message}`);
                        }
                    };
                    fileInput.click();
                }));
        
        containerEl.createEl('h2', { text: 'Customize rendering' });

        new Setting(containerEl)
            .setName('Fields to display and sort')
            .setDesc('List the fields you want to display, in the order you want them to appear. Fields not in this list will be hidden. \nNote: Author and editor fields have a special priority.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join('\n'))
                    .onChange((value) => {
                        this.plugin.settings.fieldSortOrder = value.split('\n').map(field => field.trim()).filter(Boolean);
                    });
                text.inputEl.rows = 10;
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
        updateList('');
    }

    onClose() {
        this.contentEl.empty();
    }
}

// 6. AUTOCOMPLETE SUGGESTER CLASS
// Provides an autocomplete dropdown for bibkeys within a `bibkey` code block.
class BibkeySuggester extends EditorSuggest<FormattedBibtexEntry> {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app);
        this.plugin = plugin;
    }

    // Determines if the suggester should trigger.
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);

        // Case 1: Single-line format ` ```bibkey key... `
        const singleLinePrefix = '```bibkey ';
        if (line.startsWith(singleLinePrefix) && !line.endsWith('```')) {
            const query = line.substring(singleLinePrefix.length, cursor.ch);
            return {
                start: { line: cursor.line, ch: singleLinePrefix.length },
                end: cursor,
                query: query,
            };
        }

        // Case 2: Multi-line format
        if (cursor.line > 0) {
            const prevLine = editor.getLine(cursor.line - 1);
            if (prevLine.trim() === '```bibkey' && line.trim() !== '```') {
                 const query = line.trim();
                 const startCh = line.indexOf(query);
                 return {
                     start: { line: cursor.line, ch: startCh },
                     end: { line: cursor.line, ch: startCh + query.length },
                     query: query,
                 };
            }
        }

        return null;
    }

    // --- ENHANCED SEARCH LOGIC FOR PARTIAL/MIXED-TYPE QUERIES ---
    // Gets the list of suggestions based on the user's query.
    async getSuggestions(context: EditorSuggestContext): Promise<FormattedBibtexEntry[]> {
        const query = context.query.toLowerCase();
        if (query.length < 2) return [];

        // 1. Parse the query into search tokens.
        // e.g., "tonjam17" -> ["ton", "jam", "17"]
        const queryTokens = query
            .split(' ')
            .filter(w => w.length > 0)
            .flatMap(part => part.match(/[a-z]+|\d+/g) || []);

        if (queryTokens.length === 0) return [];

        const allRawEntries = Array.from(this.plugin.bibEntries.values());
        const suggestions: FormattedBibtexEntry[] = [];

        for (const rawEntry of allRawEntries) {
            const entry = this.plugin.formatAndSortBibtexEntry(rawEntry);
            if (!entry) continue;

            // 2. Create a single, lowercase, searchable string for the entire entry.
            //    This now dynamically includes the bibkey and all fields from the user's sort order settings.
            const textParts = [entry.bibkey];
            const fieldsToSearch = this.plugin.settings.fieldSortOrder.map(f => f.toLowerCase());
            
            entry.fields.forEach(field => {
                if (fieldsToSearch.includes(field.fieldName.toLowerCase())) {
                    textParts.push(field.fieldValue);
                }
            });
            
            const searchableText = textParts.join(' ').toLowerCase();
            
            // 3. Split the entry's text into individual words, handling various punctuation.
            const entryWords = searchableText.split(/[\s,.:;!?()"]+/).filter(w => w.length > 0);

            // 4. Check if EVERY query token is a substring of AT LEAST ONE word in the entry.
            const isMatch = queryTokens.every(token => 
                entryWords.some(entryWord => entryWord.includes(token))
            );

            if (isMatch) {
                suggestions.push(entry);
            }

            // 5. Limit results for performance.
            if (suggestions.length >= 50) {
                break;
            }
        }

        // Sort alphabetically by key as a default ranking.
        suggestions.sort((a, b) => a.bibkey.localeCompare(b.bibkey));

        return suggestions;
    }

    // Renders how each suggestion item looks in the pop-up.
    renderSuggestion(suggestion: FormattedBibtexEntry, el: HTMLElement): void {
        el.addClass('bibtex-suggestion-item');
        
        el.createEl('div', { text: suggestion.bibkey, cls: 'bibkey-suggestion-key' });

        const detailsContainer = el.createEl('div', { cls: 'bibkey-suggestion-details-container' });
        
        const authorField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'author');
        const editorField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'editor');
        const yearField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'year');
        const titleField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'title');

        // Line 1: Combine Author/Editor and Year
        const primaryCreatorField = authorField || editorField;
        let authorYearText = '';
        if (primaryCreatorField) {
            authorYearText = primaryCreatorField.fieldValue;
        }
        if (yearField) {
            // Add year with a comma separator.
            authorYearText += `, ${yearField.fieldValue}`;
        }
        if (authorYearText) {
            detailsContainer.createEl('div', { 
                text: authorYearText.trim(), 
                cls: 'bibkey-suggestion-author-year' 
            });
        }

        // Line 2: Title, with conditional formatting
        if (titleField) {
            const titleEl = detailsContainer.createEl('div', { cls: 'bibkey-suggestion-title' });
            const entryType = suggestion.entryType.toLowerCase();

            if (entryType === 'article' || entryType === 'inbook') {
                // Add double quotes for articles and inbooks
                titleEl.setText(`"${titleField.fieldValue}"`);
            } else if (entryType === 'book') {
                // Italicize for books by creating an 'em' (emphasis) tag
                titleEl.createEl('em', { text: titleField.fieldValue });
            } else {
                // Default rendering for other types
                titleEl.setText(titleField.fieldValue);
            }
        }
    }

    // Called when the user selects a suggestion.
    selectSuggestion(suggestion: FormattedBibtexEntry, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        const { editor, start } = this.context;
        const line = editor.getLine(start.line);

        if (line.startsWith('```bibkey ')) {
            // Single-line mode: replace from start of query to end of line, and add closing backticks.
            const replacement = `${suggestion.bibkey}\`\`\``;
            const endOfLine = { line: start.line, ch: line.length };
            editor.replaceRange(replacement, start, endOfLine);
        } else {
            // Multi-line mode: just replace the typed key.
            editor.replaceRange(suggestion.bibkey, this.context.start, this.context.end);
        }
        
        this.close();
    }
}
