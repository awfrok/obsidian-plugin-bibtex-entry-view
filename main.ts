import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo } from 'obsidian';
import { parse as bibtexParse, Creator } from '@retorquere/bibtex-parser';

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


// --- CONSTANTS ---
// Centralizes all hardcoded strings and numbers for easier maintenance.
const PLUGIN_CONSTANTS = {
    BIBKEY_CODE_BLOCK: 'bibkey',
    SINGLE_LINE_PREFIX: '```bibkey ',
    CLOSING_BACKTICKS: '```',
    MIN_QUERY_LENGTH: 2,
    MAX_SUGGESTIONS: 50,
    SORTORDER_AREA_ROWS: 10,
    SORTORDER_AREA_COLS: 30,
    BIB_FILE_EXTENSION: 'bib',
    DEFAULT_SEARCH_PLACEHOLDER: 'Search for .bib files...',
    EMPTY_KEY_MSG: '(provide a correct key)',
    FILE_NOT_FOUND_MSG: (path: string) => `BibtexEntryView: Could not find file at: ${path}`,
    PARSE_ERROR_MSG: 'BibtexEntryView: Error reading or parsing .bib file.',
    IMPORT_ERROR_MSG: (error: string) => `BibtexEntryView: Error importing file: ${error}`,
    NO_FILES_FOUND_MSG: 'No matching .bib files found.',
    CSS_CLASSES: {
        CSS_BIBTEX_ENTRY: 'bibtex-entry-view',
        CSS_BIBTEX_ERROR: 'bibtex-error',
        CSS_BIBKEY: 'bibkey',
        CSS_INVALID_KEY: 'bibkey-invalid-key',
        CSS_FIELD_NAME: 'bibtex-field-name',
        CSS_FIELD_VALUE: 'bibtex-field-value',
        CSS_SUGGESTION_ITEM: 'bibtex-suggestion-item',
        CSS_SUGGESTION_KEY: 'bibkey-suggestion-key',
        CSS_SUGGESTION_DETAILS: 'bibkey-suggestion-details-container',
        CSS_SUGGESTION_AUTHOR_YEAR: 'bibkey-suggestion-author-year',
        CSS_SUGGESTION_TITLE: 'bibkey-suggestion-title',
        CSS_FILE_ITEM: 'bibtex-file-item',
    }
} as const;

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

// OPTIMIZATION: Interface for the cached entry object.
interface CachedBibEntry {
    formattedEntry: FormattedBibtexEntry;
    searchableText: string;
}

// 3. MAIN PLUGIN CLASS
export default class BibtexEntryViewPlugin extends Plugin {
    settings: BibtexEntryViewSettings;
    // OPTIMIZATION: A new cache for pre-processed entries.
    bibCache: Map<string, CachedBibEntry> = new Map();

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

            this.registerMarkdownCodeBlockProcessor(PLUGIN_CONSTANTS.BIBKEY_CODE_BLOCK, (source, element, context) => {
                const bibkey = source.trim();
                element.empty(); // Clear the container first

                if (!bibkey) {
                    // If the code block is empty, show a placeholder message.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ENTRY} ${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ERROR}` });
                    entryCode.createEl('span', {
                        text: PLUGIN_CONSTANTS.EMPTY_KEY_MSG,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_INVALID_KEY
                    });
                    return;
                }

                // OPTIMIZATION: Use the new bibCache
                const cachedEntry = this.bibCache.get(bibkey);

                if (cachedEntry) {
                    // Extract the pre-formatted entry
                    const parsedEntry = cachedEntry.formattedEntry;
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ENTRY });
                    
                    entryCode.createEl('span', { text: parsedEntry.bibkey, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBKEY });
                    
                    parsedEntry.fields.forEach((field) => {
                        entryCode.appendText('\n');
                        entryCode.createEl('span', { text: field.fieldName, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_NAME });
                        entryCode.createEl('span', { text: ': ', cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_NAME });
                        entryCode.createEl('span',{ text: field.fieldValue, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_VALUE } )
                    });
                } else {
                    // This handles keys that are provided but not found in the .bib file.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ENTRY} ${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ERROR}` });
                    
                    // Display the invalid key first.
                    entryCode.createEl('span', {
                        text: bibkey,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_INVALID_KEY
                    });

                    // Append the guide text.
                    entryCode.appendText(' '); // Add a space for separation.
                    entryCode.createEl('span', {
                        text: PLUGIN_CONSTANTS.EMPTY_KEY_MSG,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_INVALID_KEY
                    });
                }
            });

            this.app.workspace.updateOptions();
        });
    }

    onunload() {
        // OPTIMIZATION: Clear the new cache
        this.bibCache.clear();
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
        // OPTIMIZATION: Clear the new cache before loading
        this.bibCache.clear();
        const { bibFilePath } = this.settings;

        if (!bibFilePath) return;

        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        if (!(bibFile instanceof TFile)) {
            new Notice(PLUGIN_CONSTANTS.FILE_NOT_FOUND_MSG(bibFilePath));
            return;
        }

        try {
            const content = await this.app.vault.read(bibFile);
            // ROBUSTNESS: Use the new method to parse and cache entries with a dedicated library
            this.parseAndCacheBibtex(content);
        } catch (error) {
            new Notice(PLUGIN_CONSTANTS.PARSE_ERROR_MSG);
            console.error('BibtexEntryView Error:', error);
        }
    }
    
    // ROBUSTNESS: This method now uses a dedicated library to parse the file and populates the rich cache upfront.
    private parseAndCacheBibtex(content: string) {
        try {
            this.bibCache.clear();
            // Use the bibtex-parser library. It returns errors in the result object.
            const bibtex = bibtexParse(content);

            // Log any errors found by the parser
            for (const error of bibtex.errors) {
                console.warn("Bibtex-parser error:", error);
            }

            for (const entry of bibtex.entries) {
                if (!entry.key) continue; // Skip entries without a key

                const bibkey = entry.key;
                const entryType = entry.type;
                
                // Convert library's fields object to our FieldNameAndValue array, handling different value types
                const allParsedFields: FieldNameAndValue[] = Object.entries(entry.fields).map(([fieldName, value]) => {
                    let fieldValue: string;

                    if (Array.isArray(value)) {
                        // Check if it's an array of Creators (authors/editors) by looking for a 'lastName' property
                        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null && 'lastName' in value[0]) {
                            fieldValue = (value as Creator[]).map(creator => `${creator.firstName || ''} ${creator.lastName}`.trim()).join(' and ');
                        } else {
                            // It's an array of strings
                            fieldValue = (value as string[]).join(' ');
                        }
                    } else {
                        // It's a plain string
                        fieldValue = value as string;
                    }

                    return {
                        fieldName: fieldName.toLowerCase(),
                        fieldValue: fieldValue
                    };
                });
                
                // The sorting logic is now self-contained in formatAndSortBibtexFields
                const formattedEntry = this.formatAndSortBibtexFields({ entryType, bibkey, fields: allParsedFields });

                // --- Pre-computation Step ---
                const textParts = [formattedEntry.bibkey];
                const fieldsToSearch = this.settings.fieldSortOrder.map(f => f.toLowerCase());
                
                formattedEntry.fields.forEach(field => {
                    if (fieldsToSearch.includes(field.fieldName.toLowerCase())) {
                        textParts.push(field.fieldValue);
                    }
                });
                const searchableText = textParts.join(' ').toLowerCase();
                // --- End of Pre-computation ---

                this.bibCache.set(bibkey, {
                    formattedEntry,
                    searchableText
                });
            }
        } catch (error) {
            new Notice(PLUGIN_CONSTANTS.PARSE_ERROR_MSG);
            console.error('BibtexEntryView: Error parsing .bib file with library', error);
        }
    }

    // ROBUSTNESS: This function no longer parses a string; it only sorts pre-parsed fields.
    formatAndSortBibtexFields(input: { entryType: string, bibkey: string, fields: FieldNameAndValue[] }): FormattedBibtexEntry {
        const { entryType, bibkey, fields } = input;
        
        const allParsedFields = [...fields];
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
                        this.plugin.saveSettings();
                        this.display();
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import to vault')
                .setTooltip('Beware: Importing a file will overwrite the file of same name in the vault.')
                .onClick(() => {
                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.accept = `.${PLUGIN_CONSTANTS.BIB_FILE_EXTENSION}`;
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
                            this.plugin.saveSettings();
                            this.display();
                        } catch (error) {
                            new Notice(PLUGIN_CONSTANTS.IMPORT_ERROR_MSG(error.message));
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
                text.inputEl.rows = PLUGIN_CONSTANTS.SORTORDER_AREA_ROWS;
                text.inputEl.cols = PLUGIN_CONSTANTS.SORTORDER_AREA_COLS;
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
            .filter(file => file.extension === PLUGIN_CONSTANTS.BIB_FILE_EXTENSION)
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select BibTeX File from Vault' });

        const searchInput = new TextComponent(contentEl)
            .setPlaceholder(PLUGIN_CONSTANTS.DEFAULT_SEARCH_PLACEHOLDER);
        searchInput.inputEl.style.width = '100%';
        searchInput.inputEl.style.marginBottom = '10px';
        
        const listEl = contentEl.createEl('div');
        
        const updateList = (filter: string) => {
            listEl.empty();
            const filtered = this.bibFiles.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
            
            if (!filtered.length) {
                listEl.createEl('p', { text: PLUGIN_CONSTANTS.NO_FILES_FOUND_MSG });
                return;
            }

            filtered.forEach(file => {
                const item = listEl.createEl('div', { text: file.path, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FILE_ITEM });
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
        const singleLinePrefix = PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX;
        if (line.startsWith(singleLinePrefix) && !line.endsWith(PLUGIN_CONSTANTS.CLOSING_BACKTICKS)) {
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
            if (prevLine.trim() === `\`\`\`${PLUGIN_CONSTANTS.BIBKEY_CODE_BLOCK}` && line.trim() !== PLUGIN_CONSTANTS.CLOSING_BACKTICKS) {
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

    // OPTIMIZATION: This method is now much faster as it uses the pre-built cache.
    async getSuggestions(context: EditorSuggestContext): Promise<FormattedBibtexEntry[]> {
        const query = context.query.toLowerCase();
        if (query.length < PLUGIN_CONSTANTS.MIN_QUERY_LENGTH) return [];

        const queryTokens = query
            .split(' ')
            .filter(w => w.length > 0)
            .flatMap(part => part.match(/[a-z]+|\d+/g) || []);

        if (queryTokens.length === 0) return [];

        // Get all cached entries directly from the plugin
        const allCachedEntries = Array.from(this.plugin.bibCache.values());
        const suggestions: FormattedBibtexEntry[] = [];

        for (const cachedEntry of allCachedEntries) {
            // The expensive parsing and text-building work is GONE from this loop!
            // We now use the pre-computed `searchableText`.
            const searchableText = cachedEntry.searchableText;

            const entryWords = searchableText.split(/[\s,.:;!?()"]+/).filter(w => w.length > 0);

            const isMatch = queryTokens.every(token =>
                entryWords.some(entryWord => entryWord.includes(token))
            );

            if (isMatch) {
                // Add the pre-formatted entry object to the suggestions
                suggestions.push(cachedEntry.formattedEntry);
            }

            if (suggestions.length >= PLUGIN_CONSTANTS.MAX_SUGGESTIONS) {
                break;
            }
        }

        suggestions.sort((a, b) => a.bibkey.localeCompare(b.bibkey));

        return suggestions;
    }

    // Renders how each suggestion item looks in the pop-up.
    renderSuggestion(suggestion: FormattedBibtexEntry, el: HTMLElement): void {
        el.addClass(PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_ITEM);
        
        el.createEl('div', { text: suggestion.bibkey, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_KEY });

        const detailsContainer = el.createEl('div', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_DETAILS });
        
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
                cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_AUTHOR_YEAR
            });
        }

        // Line 2: Title, with conditional formatting
        if (titleField) {
            const titleEl = detailsContainer.createEl('div', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_TITLE });
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

        if (line.startsWith(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX)) {
            // Single-line mode: replace from start of query to end of line, and add closing backticks.
            const replacement = `${suggestion.bibkey}${PLUGIN_CONSTANTS.CLOSING_BACKTICKS}`;
            const endOfLine = { line: start.line, ch: line.length };
            editor.replaceRange(replacement, start, endOfLine);
        } else {
            // Multi-line mode: just replace the typed key.
            editor.replaceRange(suggestion.bibkey, this.context.start, this.context.end);
        }
        
        this.close();
    }
}
