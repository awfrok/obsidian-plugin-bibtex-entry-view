//
// v. 0.2.4
//

import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo } from 'obsidian';
import { parse as bibtexParse, Creator } from '@retorquere/bibtex-parser';

// 1. SETTINGS INTERFACE
/**
 * Defines the shape of the plugin's settings object, which is saved to and loaded from disk.
 */
interface BibtexEntryViewSettings {
    bibFilePath: string;      // Path to the selected .bib file within the vault.
    fieldSortOrder: string[]; // An array of field names, defining the custom display order.
}

// 2. DEFAULT SETTINGS
/**
 * Provides a fallback configuration for when the plugin is first installed or settings are cleared.
 */
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '',
    fieldSortOrder: [
        'author', 'year', 'entrytype', 'title', 'subtitle', 'translator',  
        'editor', 'booktitle', 'booksubtitle', 'maintitle', 'mainsubtitle', 
        'edition', 'journal', 'series', 'volume',
        'number', 'pages', 'address', 'publisher'
    ]
};


// 3. CONSTANTS 
/**
 * Centralizes all hardcoded strings and numbers for easier maintenance and consistency.
 */
const PLUGIN_CONSTANTS = {
    BIBKEY_CODE_BLOCK: 'bibkey',
    SINGLE_LINE_PREFIX: '```bibkey ',
    CLOSING_BACKTICKS: '```',
    NEWLINE_SEPARATOR: '\n',
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
    SETTINGS: {
        
        // --- Bib File Setting ---
        BIB_FILE_SECTION_TITLE: 'Bib file',
        CURRENT_BIB_FILE_NAME: 'Current .bib file in the vault',
        CURRENT_BIB_FILE_DESC: 'This is the file the plugin is currently using.',
        NO_FILE_PLACEHOLDER: 'No file selected',
        
        // --- Select/Import Buttons ---
        SELECT_IMPORT_NAME: 'Select or import a .bib file',
        SELECT_IMPORT_DESC: 'Choose a file from your vault or import one from your computer. • Beware: Importing a file will overwrite the file of same name in the vault.',
        SELECT_FROM_VAULT_TEXT: 'Select from vault',
        SELECT_FROM_VAULT_TOOLTIP: 'Select a .bib file in your vault',
        IMPORT_TO_VAULT_TEXT: 'Import to vault',
        IMPORT_TO_VAULT_TOOLTIP: 'Beware: Importing a file will overwrite the file of same name in the vault.',
        MODAL_TITLE: 'Select BibTeX File from Vault',
        
        // --- Field Sort Order Setting ---
        CUSTOMIZE_RENDERING_SECTION_TITLE: 'Customize rendering',
        FIELD_SORT_ORDER_NAME: 'Fields to display and sort',
        FIELD_SORT_ORDER_DESC: 'List the fields you want to display, in the order you want them to appear. Fields not in this list will be hidden. \nNote: Author and editor fields have a special priority.',
    },
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
    },
    SUGGESTER_INSTRUCTIONS: {
        NAVIGATE: { command: '↑↓', purpose: 'to navigate' },
        SELECT: { command: '↵ or \u{1F5B1}\u{FE0F}', purpose: 'to select' },
        CLOSE: { command: 'esc', purpose: 'to close' }
    }
} as const;

// 4. DATA STRUCTURE INTERFACES
/**
 * Represents a single field-value pair from a BibTeX entry.
 */
interface FieldNameAndValue {
    fieldName: string;
    fieldValue: string;
}

/**
 * Represents a fully parsed and formatted BibTeX entry, ready for display.
 */
interface FormattedBibtexEntry {
    entryType: string;
    bibkey: string;
    fields: FieldNameAndValue[];
}

/**
 * Represents a cached entry, containing both the display-ready data and the text used for searching.
 * This pre-processing is key to the suggester's performance.
 */
interface CachedBibEntry {
    formattedEntry: FormattedBibtexEntry;
    searchableText: string;
}

// 5. MAIN PLUGIN CLASS
/**
 * The main class for the BibtexEntryView plugin. It manages settings, data loading,
 * and the registration of all plugin components like code block processors and suggesters.
 */
export default class BibtexEntryViewPlugin extends Plugin {
    settings: BibtexEntryViewSettings;
    // An in-memory cache that stores pre-processed BibTeX entries for fast lookups.
    bibCache: Map<string, CachedBibEntry> = new Map();

    /**
     * This method is called when the plugin is first loaded.
     * It's responsible for setting up all the plugin's functionality.
     */
    async onload() {
        // Load existing settings from disk, or use defaults.
        await this.loadSettings();
        
        // Add the settings tab to Obsidian's settings screen.
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        // Register the autocomplete suggester to help users find bibkeys.
        this.registerEditorSuggest(new BibkeySuggester(this.app, this));

        // Register an event listener that reloads the .bib file if it's modified.
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file.path === this.settings.bibFilePath) {
                await this.loadBibFile();
                this.app.workspace.updateOptions(); // Force Obsidian to re-render views
            }
        }));

        // When the Obsidian workspace is ready, load the data and register the code block processor.
        this.app.workspace.onLayoutReady(async () => {
            await this.loadBibFile();

            // Register the processor for `bibkey` code blocks.
            this.registerMarkdownCodeBlockProcessor(PLUGIN_CONSTANTS.BIBKEY_CODE_BLOCK, (source, element, context) => {
                const bibkey = source.trim();
                element.empty(); // Clear any previous content.

                // Handle empty code blocks.
                if (!bibkey) {
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ENTRY} ${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ERROR}` });
                    entryCode.createEl('span', {
                        text: PLUGIN_CONSTANTS.EMPTY_KEY_MSG,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_INVALID_KEY
                    });
                    return;
                }

                // Look up the entry in our fast cache.
                const cachedEntry = this.bibCache.get(bibkey);

                if (cachedEntry) {
                    // --- Render a valid, found entry ---
                    const parsedEntry = cachedEntry.formattedEntry;
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ENTRY });
                    
                    entryCode.createEl('span', { text: parsedEntry.bibkey, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBKEY });
                    
                    parsedEntry.fields.forEach((field) => {
                        entryCode.appendText('\n');
                        entryCode.createEl('span', { text: field.fieldName, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_NAME });
                        entryCode.createEl('span', { text: ': ', cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_NAME });
                        
                        // Special handling for author/editor fields to style the "and" separator.
                        const fieldNameLower = field.fieldName.toLowerCase();
                        if (fieldNameLower === 'author' || fieldNameLower === 'editor') {
                            const creators = field.fieldValue.split(' and ');
                            creators.forEach((creator, index) => {
                                entryCode.createEl('span', { text: creator, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_VALUE });
                                if (index < creators.length - 1) {
                                    entryCode.createEl('span', { text: ' and ', cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_NAME });
                                }
                            });
                        } else {
                            // Default rendering for all other fields.
                            entryCode.createEl('span',{ text: field.fieldValue, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_FIELD_VALUE } )
                        }
                    });
                } else {
                    // --- Render an error for an invalid/not-found key ---
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ENTRY} ${PLUGIN_CONSTANTS.CSS_CLASSES.CSS_BIBTEX_ERROR}` });
                    entryCode.createEl('span', { text: bibkey, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_INVALID_KEY });
                    entryCode.appendText(' ');
                    entryCode.createEl('span', { text: PLUGIN_CONSTANTS.EMPTY_KEY_MSG, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_INVALID_KEY });
                }
            });

            // Force a re-render of the workspace to show the processed blocks.
            this.app.workspace.updateOptions();
        });
    }

    /**
     * This method is called when the plugin is unloaded.
     * It's responsible for cleaning up any resources.
     */
    onunload() {
        this.bibCache.clear();
    }

    /**
     * Loads the plugin settings from Obsidian's data store.
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    /**
     * Saves the current plugin settings to disk and reloads the .bib file to apply changes.
     */
    async saveSettings() {
        await this.saveData(this.settings);
        await this.loadBibFile();
        this.app.workspace.updateOptions(); // Re-render views with new settings
    }
    
    /**
     * Reads the .bib file specified in the settings and triggers the parsing and caching process.
     */
    async loadBibFile() {
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
            this.parseAndCacheBibtex(content);
        } catch (error) {
            new Notice(PLUGIN_CONSTANTS.PARSE_ERROR_MSG);
            console.error('BibtexEntryView Error:', error);
        }
    }
    
    /**
     * Parses the raw content of a .bib file, formats the entries, and stores them in the cache.
     * This is the core data processing step.
     * @param content The raw string content of the .bib file.
     */
    private parseAndCacheBibtex(content: string) {
        try {
            this.bibCache.clear();
            // Use the robust @retorquere/bibtex-parser library.
            const bibtex = bibtexParse(content, { sentenceCase: false });

            // Log any parsing errors to the developer console for debugging.
            for (const error of bibtex.errors) {
                console.warn("Bibtex-parser error:", error);
            }

            for (const entry of bibtex.entries) {
                if (!entry.key) continue; // Skip entries that lack a citation key.

                const bibkey = entry.key;
                const entryType = entry.type;
                
                // Convert the parser's output into our internal FieldNameAndValue format.
                const allParsedFields: FieldNameAndValue[] = Object.entries(entry.fields).map(([fieldName, value]) => {
                    let fieldValue: string;
                    const lowerFieldName = fieldName.toLowerCase();

                    // Convert the field's value (which can be a string or array) into a single string.
                    if (Array.isArray(value)) {
                        // Handle Creator arrays (authors/editors) by formatting names.
                        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null && ('lastName' in value[0] || 'firstName' in value[0] || 'name' in value[0])) {
                            fieldValue = (value as Creator[]).map(creator => {
                                if (creator.name) return creator.name; // For institutional authors
                                if (creator.lastName && creator.firstName) return `${creator.lastName}, ${creator.firstName}`;
                                return creator.lastName || creator.firstName || ''; // Fallback
                            }).join(' and ');
                        } else {
                            // Handle simple string arrays.
                            fieldValue = (value as string[]).join(' ');
                        }
                    } else {
                        // Handle plain string values.
                        fieldValue = value as string;
                    }

                    return {
                        fieldName: lowerFieldName,
                        fieldValue: fieldValue
                    };
                });
                
                // Apply the user's custom field sorting.
                const formattedEntry = this.formatAndSortBibtexFields({ entryType, bibkey, fields: allParsedFields });

                // --- Pre-computation for Search ---
                // Create a single, searchable string from the most important fields.
                const textParts = [formattedEntry.bibkey];
                const fieldsToSearch = this.settings.fieldSortOrder.map(f => f.toLowerCase());
                formattedEntry.fields.forEach(field => {
                    if (fieldsToSearch.includes(field.fieldName.toLowerCase())) {
                        textParts.push(field.fieldValue);
                    }
                });
                const searchableText = textParts.join(' ').toLowerCase();
                
                // Add the fully processed entry to the cache.
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

    /**
     * Sorts the fields of a parsed BibTeX entry according to the user's preferences.
     * @param input An object containing the pre-parsed entry data.
     * @returns A FormattedBibtexEntry with fields in the correct display order.
     */
    formatAndSortBibtexFields(input: { entryType: string, bibkey: string, fields: FieldNameAndValue[] }): FormattedBibtexEntry {
        const { entryType, bibkey, fields } = input;
        
        const allParsedFields = [...fields];
        allParsedFields.push({ fieldName: 'entrytype', fieldValue: entryType });
        
        // Filter fields to only those the user wants to display.
        const priorityOrder = this.settings.fieldSortOrder.map(f => f.toLowerCase());
        let fieldsToRender = allParsedFields.filter(field => priorityOrder.includes(field.fieldName.toLowerCase()));

        // Give special priority to 'author' or 'editor' by moving it to the top.
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
        
        // Sort the remaining fields based on the user's custom order.
        fieldsToRender.sort((a, b) => {
            const indexA = priorityOrder.indexOf(a.fieldName.toLowerCase());
            const indexB = priorityOrder.indexOf(b.fieldName.toLowerCase());
            return indexA - indexB;
        });
        
        const sortedFields = primaryField ? [primaryField, ...fieldsToRender] : fieldsToRender;

        return { entryType, bibkey, fields: sortedFields };
    }
}

// 6. AUTOCOMPLETE SUGGESTER CLASS
/**
 * Provides an autocomplete dropdown menu for bibkeys inside a `bibkey` code block.
 */
class BibkeySuggester extends EditorSuggest<FormattedBibtexEntry> {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app);
        this.plugin = plugin;
        this.setInstructions([
            PLUGIN_CONSTANTS.SUGGESTER_INSTRUCTIONS.NAVIGATE,
            PLUGIN_CONSTANTS.SUGGESTER_INSTRUCTIONS.SELECT,
            PLUGIN_CONSTANTS.SUGGESTER_INSTRUCTIONS.CLOSE
        ]);
    }

    /**
     * Determines if the suggestion pop-up should be triggered based on the cursor's position and context.
     * @returns A trigger info object if suggestions should be shown, otherwise null.
     */
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);

        // Case 1: Single-line format ` ```bibkey key...`
        if (line.startsWith(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX)) {
            const closingTicksIndex = line.lastIndexOf(PLUGIN_CONSTANTS.CLOSING_BACKTICKS);
            // Trigger only if the cursor is inside the code block's content area.
            if (closingTicksIndex === -1 || cursor.ch <= closingTicksIndex) {
                 const query = line.substring(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX.length, cursor.ch);
                 return {
                     start: { line: cursor.line, ch: PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX.length },
                     end: cursor,
                     query: query,
                 };
            }
        }

        // Case 2: Multi-line format
        if (cursor.line > 0) {
            const prevLine = editor.getLine(cursor.line - 1);
            // Trigger if the previous line is the opening of the block and the current line is not the closing.
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

    /**
     * Fetches and filters suggestions based on the user's query.
     * This method is highly optimized to search against the pre-computed cache.
     * @param context The context of the suggestion trigger, containing the query.
     * @returns A promise that resolves to an array of matching entries.
     */
    async getSuggestions(context: EditorSuggestContext): Promise<FormattedBibtexEntry[]> {
        const query = context.query.toLowerCase();
        if (query.length < PLUGIN_CONSTANTS.MIN_QUERY_LENGTH) return [];

        // Tokenize the query to allow for more flexible searching (e.g., "smi 21" matches "Smith 2021").
        const queryTokens = query
            .split(' ')
            .filter(w => w.length > 0)
            .flatMap(part => part.match(/[a-z]+|\d+/g) || []);

        if (queryTokens.length === 0) return [];

        const allCachedEntries = Array.from(this.plugin.bibCache.values());
        const suggestions: FormattedBibtexEntry[] = [];

        for (const cachedEntry of allCachedEntries) {
            // Search against the pre-computed `searchableText` for maximum performance.
            const searchableText = cachedEntry.searchableText;
            const entryWords = searchableText.split(/[\s,.:;!?()"]+/).filter(w => w.length > 0);

            // Check if every query token is a substring of at least one word in the entry.
            const isMatch = queryTokens.every(token =>
                entryWords.some(entryWord => entryWord.includes(token))
            );

            if (isMatch) {
                suggestions.push(cachedEntry.formattedEntry);
            }

            // Limit the number of suggestions for performance.
            if (suggestions.length >= PLUGIN_CONSTANTS.MAX_SUGGESTIONS) {
                break;
            }
        }

        // Sort results alphabetically as a default ranking.
        suggestions.sort((a, b) => a.bibkey.localeCompare(b.bibkey));

        return suggestions;
    }

    /**
     * Renders the HTML for a single suggestion item in the pop-up menu.
     * @param suggestion The BibTeX entry to render.
     * @param el The HTML element to render into.
     */
    renderSuggestion(suggestion: FormattedBibtexEntry, el: HTMLElement): void {
        el.addClass(PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_ITEM);
        
        el.createEl('div', { text: suggestion.bibkey, cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_KEY });

        const detailsContainer = el.createEl('div', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_DETAILS });
        
        const authorField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'author');
        const editorField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'editor');
        const yearField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'year');
        const titleField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'title');

        // Line 1: Combine Author/Editor and Year for a quick overview.
        const primaryCreatorField = authorField || editorField;
        let authorYearText = '';
        if (primaryCreatorField) {
            authorYearText = primaryCreatorField.fieldValue;
        }
        if (yearField) {
            authorYearText += `, ${yearField.fieldValue}`;
        }
        if (authorYearText) {
            detailsContainer.createEl('div', { text: authorYearText.trim(), cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_AUTHOR_YEAR });
        }

        // Line 2: Display the title with special formatting based on entry type.
        if (titleField) {
            const titleEl = detailsContainer.createEl('div', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.CSS_SUGGESTION_TITLE });
            const entryType = suggestion.entryType.toLowerCase();

            if (entryType === 'article' || entryType === 'inbook') {
                titleEl.setText(`"${titleField.fieldValue}"`); // Add quotes
            } else if (entryType === 'book') {
                titleEl.createEl('em', { text: titleField.fieldValue }); // Italicize
            } else {
                titleEl.setText(titleField.fieldValue); // Default
            }
        }
    }

    /**
     * Called when the user selects a suggestion. This method handles inserting the key
     * and intelligently moving the cursor for a smooth workflow.
     * @param suggestion The selected BibTeX entry.
     */
    selectSuggestion(suggestion: FormattedBibtexEntry, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        const { editor, start, end } = this.context;
        const line = editor.getLine(start.line);

        // Replace the user's query with the full bibkey.
        editor.replaceRange(suggestion.bibkey, start, end);

        if (line.startsWith(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX)) {
            // --- Single-line mode ---
            const lineContent = editor.getLine(start.line);
            const closingTicksIndex = lineContent.lastIndexOf(PLUGIN_CONSTANTS.CLOSING_BACKTICKS);
            
            // Find the position right after the closing backticks.
            const finalCh = (closingTicksIndex !== -1) 
                ? closingTicksIndex + PLUGIN_CONSTANTS.CLOSING_BACKTICKS.length 
                : lineContent.length;
            
            const finalCursorPos = { line: start.line, ch: finalCh };
            editor.setCursor(finalCursorPos);

            // If closing backticks were missing, add them. Then add a newline to exit the block.
            if (closingTicksIndex === -1) {
                editor.replaceSelection(PLUGIN_CONSTANTS.CLOSING_BACKTICKS);
            }
            editor.replaceSelection(PLUGIN_CONSTANTS.NEWLINE_SEPARATOR);
            
        } else {
            // --- Multi-line mode ---
            // Find the line with the closing backticks.
            let closingLineNum = -1;
            for (let i = start.line + 1; i < editor.lineCount(); i++) {
                if (editor.getLine(i).trim() === PLUGIN_CONSTANTS.CLOSING_BACKTICKS) {
                    closingLineNum = i;
                    break;
                }
            }

            if (closingLineNum !== -1) {
                // If found, move the cursor to the line after the block.
                const targetLineNum = closingLineNum + 1;
                if (targetLineNum >= editor.lineCount()) {
                    // If at the end of the file, add a new line.
                    editor.replaceRange(PLUGIN_CONSTANTS.NEWLINE_SEPARATOR, { line: closingLineNum, ch: editor.getLine(closingLineNum).length });
                }
                editor.setCursor({ line: targetLineNum, ch: 0 });
            } else {
                // If not found, add the closing backticks and a newline, then move the cursor.
                const endOfKeyLine = { line: start.line, ch: editor.getLine(start.line).length };
                editor.replaceRange(`${PLUGIN_CONSTANTS.NEWLINE_SEPARATOR}${PLUGIN_CONSTANTS.CLOSING_BACKTICKS}${PLUGIN_CONSTANTS.NEWLINE_SEPARATOR}`, endOfKeyLine);
                editor.setCursor({ line: start.line + 2, ch: 0 });
            }
        }
        
        this.close();
    }
}

// 7. SETTINGS TAB CLASS
/**
 * Creates the settings tab for the plugin in Obsidian's settings menu.
 */
class BibtexEntryViewSettingTab extends PluginSettingTab {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Renders the settings UI elements.
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        new Setting(containerEl)
            .setName(PLUGIN_CONSTANTS.SETTINGS.BIB_FILE_SECTION_TITLE)
            .setHeading();

        // Display the currently selected .bib file path (read-only).
        new Setting(containerEl)
            .setName(PLUGIN_CONSTANTS.SETTINGS.CURRENT_BIB_FILE_NAME)
            .setDesc(PLUGIN_CONSTANTS.SETTINGS.CURRENT_BIB_FILE_DESC)
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setPlaceholder(PLUGIN_CONSTANTS.SETTINGS.NO_FILE_PLACEHOLDER)
                .setDisabled(true)
            );
        
        // Add buttons for selecting a file from the vault or importing a new one.
        new Setting(containerEl)
            .setName(PLUGIN_CONSTANTS.SETTINGS.SELECT_IMPORT_NAME)
            .setDesc(PLUGIN_CONSTANTS.SETTINGS.SELECT_IMPORT_DESC)
            .addButton(button => button
                .setButtonText(PLUGIN_CONSTANTS.SETTINGS.SELECT_FROM_VAULT_TEXT)
                .setTooltip(PLUGIN_CONSTANTS.SETTINGS.SELECT_FROM_VAULT_TOOLTIP)
                .onClick(() => {
                    new BibFileSelectionModal(this.app, (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        this.plugin.saveSettings();
                        this.display(); // Re-render the settings tab to show the new path
                    }).open();
                }))
            .addButton(button => button
                .setButtonText(PLUGIN_CONSTANTS.SETTINGS.IMPORT_TO_VAULT_TEXT)
                .setTooltip(PLUGIN_CONSTANTS.SETTINGS.IMPORT_TO_VAULT_TOOLTIP)
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
        
        new Setting(containerEl)
            .setName(PLUGIN_CONSTANTS.SETTINGS.CUSTOMIZE_RENDERING_SECTION_TITLE)
            .setHeading();

        // Add a textarea for users to define the field display order.
        new Setting(containerEl)
            .setName(PLUGIN_CONSTANTS.SETTINGS.FIELD_SORT_ORDER_NAME)
            .setDesc(PLUGIN_CONSTANTS.SETTINGS.FIELD_SORT_ORDER_DESC)
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join(PLUGIN_CONSTANTS.NEWLINE_SEPARATOR))
                    .onChange(async (value) => {
                        this.plugin.settings.fieldSortOrder = value.split(PLUGIN_CONSTANTS.NEWLINE_SEPARATOR).map(field => field.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = PLUGIN_CONSTANTS.SORTORDER_AREA_ROWS;
                text.inputEl.cols = PLUGIN_CONSTANTS.SORTORDER_AREA_COLS;
            });
    }
}

// 8. FILE SELECTION MODAL for SettingsTab
/**
 * A modal window that allows users to search for and select a .bib file from their vault.
 */
class BibFileSelectionModal extends Modal {
    onChooseFile: (path: string) => void;
    private bibFiles: TFile[];

    constructor(app: App, onChooseFile: (path: string) => void) {
        super(app);
        this.onChooseFile = onChooseFile;
        // Get all .bib files in the vault at the time of creation.
        this.bibFiles = this.app.vault.getFiles()
            .filter(file => file.extension === PLUGIN_CONSTANTS.BIB_FILE_EXTENSION)
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Renders the content of the modal.
     */
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: PLUGIN_CONSTANTS.SETTINGS.MODAL_TITLE });

        // Create a search input to filter the file list.
        const searchInput = new TextComponent(contentEl)
            .setPlaceholder(PLUGIN_CONSTANTS.DEFAULT_SEARCH_PLACEHOLDER);
        searchInput.inputEl.style.width = '100%';
        searchInput.inputEl.style.marginBottom = '10px';
        
        const listEl = contentEl.createEl('div');
        
        // Function to update the displayed list based on the search filter.
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
        updateList(''); // Initially display all files.
    }

    /**
     * Cleans up the modal content when it's closed.
     */
    onClose() {
        this.contentEl.empty();
    }
}
