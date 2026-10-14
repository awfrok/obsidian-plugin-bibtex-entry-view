//
// 0.2.5
// add an option to customize search.
// 0.2.4.3
// fix for obisidian 1.13 API. Functions remain same.
//


import { App, debounce, Modal, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo } from 'obsidian';
import { parse as bibtexParse, Creator } from '@retorquere/bibtex-parser';

// 1. SETTINGS INTERFACE
/**
 * Defines the shape of the plugin's settings object, which is saved to and loaded from disk.
 */
interface BibtexEntryViewSettings {
    bibFilePath: string;      // Path to the selected .bib file within the vault.
    fieldSortOrder: string[]; // An array of field names, defining the custom display order.
    searchFields: string[];   // Field names that autocomplete searches (the bibkey is always searched).
}

// 2. DEFAULT SETTINGS
/**
 * Provides a fallback configuration for when the plugin is first installed or settings are cleared.
 */
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '',
    fieldSortOrder: [
        'author', 'year', 'entrytype', 'title', 'subtitle', 'translator',
        'bookauthor', 'editor', 'booktitle', 'booksubtitle', 'maintitle', 'mainsubtitle',
        'edition', 'journal', 'series', 'volume',
        'number', 'pages', 'address', 'publisher'
    ],
    searchFields: ['author', 'editor', 'year', 'title', 'subtitle']
};


// 3. CONSTANTS
/**
 * Centralizes all hardcoded strings and numbers for easier maintenance and consistency.
 */
const PLUGIN_CONSTANT = {
    BIBKEY_CODE_BLOCK: 'bibkey',
    SINGLE_LINE_PREFIX: '```bibkey ',
    CLOSING_BACKTICKS: '```',
    NEWLINE_SEPARATOR: '\n',
    MIN_QUERY_LENGTH: 2,
    MAX_SUGGESTIONS: 50,
    SORTORDER_AREA_ROWS: 10,
    SEARCH_FIELDS_AREA_ROWS: 5,
    BIB_FILE_EXTENSION: 'bib',
    EMPTY_KEY_MSG: '(Provide a correct key)',
    BIB_FILE_NOT_FOUND_MSG: (path: string) => `(Bib file not found: ${path})`,
    NO_BIB_FILE_SELECTED_MSG: '(No bib file selected)',
    FILE_NOT_FOUND_MSG: (path: string) => `BibtexEntryView: Could not find file at: ${path}`,
    PARSE_ERROR_MSG: 'BibtexEntryView: Error reading or parsing .bib file.',
    IMPORT_ERROR_MSG: (error: string) => `BibtexEntryView: Error importing file: ${error}`,
    SETTINGS: {

        // --- Bib File Setting ---
        CURRENT_BIB_FILE_NAME: 'Select a .bib file in the vault',
        CURRENT_BIB_FILE_DESC: 'The plugin currently uses this file.',
        NO_FILE_PLACEHOLDER: 'No file selected',

        // --- Select/Import Buttons ---
        SELECT_IMPORT_NAME: 'Import a .bib file',
        SELECT_IMPORT_DESC: (): DocumentFragment => {
            const frag = createFragment();
            frag.appendText('Choose a file from your vault or import one from your computer.');
            frag.createEl('br');
            const noteEl = frag.createSpan({ cls: 'bibtex-setting-desc-note' });
            noteEl.appendText('• ');
            noteEl.createEl('strong', { text: 'Beware:' });
            noteEl.appendText(' Importing a file will overwrite the file of same name in the vault.');
            return frag;
        },
        IMPORT_TO_VAULT_TEXT: 'Import to current vault',
        IMPORT_TO_VAULT_TOOLTIP: 'Beware: Importing a file will overwrite the file of same name in the vault.',
        OVERWRITE_TITLE: 'Overwrite existing file?',
        OVERWRITE_MESSAGE: (path: string) => `"${path}" already exists in the vault. Importing will replace its contents.`,
        OVERWRITE_CONFIRM: 'Overwrite',
        OVERWRITE_CANCEL: 'Cancel',

        // --- Field Sort Order Setting ---
        FIELD_SORT_ORDER_NAME: 'Customize field rendering order',
        FIELD_SORT_ORDER_DESC: (): DocumentFragment => {
            const frag = createFragment();
            frag.appendText('List the fields you want to display, in the order you want them to appear, one per line. Fields not in this list will be hidden.');
            frag.createEl('br');
            const noteEl = frag.createSpan({ cls: 'bibtex-setting-desc-note' });
            noteEl.appendText('• ');
            noteEl.createEl('strong', { text: 'Note:' });
            noteEl.appendText(" Author and editor fields have a special priority. If there's no author field in the bib entry, editor field will be the first.");
            return frag;
        },

        // --- Search Fields Setting ---
        SEARCH_FIELDS_NAME: 'Customize search and autocomplete',
        SEARCH_FIELDS_DESC: 'List the fields that autocomplete searches, one per line. Bibkey itself is always searched. This is independent of the rendering order above.',
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
        CSS_SUGGESTION_AUTHOR: 'bibkey-suggestion-author',
        CSS_SUGGESTION_YEAR: 'bibkey-suggestion-year',
        CSS_SUGGESTION_TITLE: 'bibkey-suggestion-title',
        CSS_HIDDEN_FILE_INPUT: 'bibtex-hidden-file-input',
    },
    SUGGESTER_INSTRUCTIONS: {
        NAVIGATE: { command: '↑↓', purpose: 'to navigate' },
        SELECT: { command: '↵', purpose: 'to select' },
        CLOSE: { command: 'esc', purpose: 'to close' }
    }
} as const;

// 4. DATA STRUCTURE INTERFACES
/**
 * Represents a single field-value pair from a BibTeX entry.
 */
interface FieldNameAndValue {
    fieldName: string;   // Always lowercase (normalized when parsing), so it can be compared directly.
    fieldValue: string;
    creators?: string[]; // Individual names for creator fields (author/editor...), kept apart so names containing " and " are not split.
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
 * Represents a parsed BibTeX entry with all of its fields, before any filtering or sorting.
 * Autocomplete works on this, so searching and suggestion details do not depend on the field sort order.
 */
interface RawBibEntry {
    entryType: string;
    bibkey: string;
    fields: FieldNameAndValue[];
    searchableWords: string[]; // Words of the bibkey and the search fields setting, pre-split for fast searching.
}

/**
 * Represents a cached entry: the display-ready data for code blocks, plus the raw entry for autocomplete.
 */
interface CachedBibEntry {
    formattedEntry: FormattedBibtexEntry;
    rawEntry: RawBibEntry;
}

/**
 * Renders a code block in the error style: each text as an invalid-key span, separated by spaces.
 */
function renderError(element: HTMLElement, texts: string[]): void {
    const entryPre = element.createEl('pre');
    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANT.CSS_CLASSES.CSS_BIBTEX_ENTRY} ${PLUGIN_CONSTANT.CSS_CLASSES.CSS_BIBTEX_ERROR}` });
    texts.forEach((text, index) => {
        if (index > 0) entryCode.appendText(' ');
        entryCode.createSpan({ text, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_INVALID_KEY });
    });
}

/**
 * Hashes the path and content into a short content hash (SHA-256, hex), so the last parsed content
 * does not have to be kept in memory just to detect an unchanged file.
 */
async function computeContentHash(path: string, content: string): Promise<string> {
    const bytes = new TextEncoder().encode(`${path}\0${content}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// 5. MAIN PLUGIN CLASS
/**
 * The main class for the BibtexEntryView plugin. It manages settings, data loading,
 * and the registration of all plugin components like code block processors and suggesters.
 */
export default class BibtexEntryViewPlugin extends Plugin {
    settings!: BibtexEntryViewSettings;
    // An in-memory cache that stores pre-processed BibTeX entries for fast lookups.
    bibCache: Map<string, CachedBibEntry> = new Map();
    // Every parsed entry with all of its fields, independent of the field sort order.
    private rawEntries: Map<string, RawBibEntry> = new Map();
    // Set in onunload, for callbacks that cannot be unregistered.
    private isUnloaded = false;
    // Settles after the first .bib load at startup; code blocks wait on it before rendering.
    private initialLoad: Promise<void> = Promise.resolve();
    // Serializes loadBibFile calls.
    private loadQueue: Promise<void> = Promise.resolve();
    // Hash of the path and content behind `rawEntries`, to skip redundant re-parsing.
    private lastParsedHash: string | null = null;

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

        // Resolves once the first .bib load has finished, so code blocks rendered during startup can wait for the data.
        this.initialLoad = new Promise<void>(resolve => {
            // The vault index is only complete once the layout is ready, so the first load waits for it.
            this.app.workspace.onLayoutReady(async () => {
                // onLayoutReady callbacks cannot be unregistered, so skip the work if the plugin was unloaded first.
                if (this.isUnloaded) {
                    resolve();
                    return;
                }
                try {
                    await this.loadBibFile();
                } finally {
                    resolve();
                }
                // Re-render views that were drawn before the data was available.
                this.app.workspace.updateOptions();
            });
        });

        // Register the processor for `bibkey` code blocks right away, so they never show up as plain code.
        this.registerMarkdownCodeBlockProcessor(PLUGIN_CONSTANT.BIBKEY_CODE_BLOCK, async (source, element) => {
            await this.initialLoad;
            const bibkey = source.trim();
            element.empty(); // Clear any previous content.

            // Handle empty code blocks.
            if (!bibkey) {
                renderError(element, [PLUGIN_CONSTANT.EMPTY_KEY_MSG]);
                return;
            }

            // Tell the user when no .bib file is selected or the selected one is missing (e.g. renamed or deleted),
            // instead of reporting the key as wrong.
            const { bibFilePath } = this.settings;
            const bibFileProblem = !bibFilePath
                ? PLUGIN_CONSTANT.NO_BIB_FILE_SELECTED_MSG
                : !(this.app.vault.getAbstractFileByPath(bibFilePath) instanceof TFile)
                    ? PLUGIN_CONSTANT.BIB_FILE_NOT_FOUND_MSG(bibFilePath)
                    : null;
            if (bibFileProblem) {
                renderError(element, [bibkey, bibFileProblem]);
                return;
            }

            // Look up the entry in our fast cache.
            const cachedEntry = this.bibCache.get(bibkey);

            if (cachedEntry) {
                // --- Render a valid, found entry ---
                const parsedEntry = cachedEntry.formattedEntry;
                const entryPre = element.createEl('pre');
                const entryCode = entryPre.createEl('code', { cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_BIBTEX_ENTRY });

                entryCode.createSpan({ text: parsedEntry.bibkey, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_BIBKEY });

                parsedEntry.fields.forEach((field) => {
                    entryCode.appendText('\n');
                    entryCode.createSpan({ text: field.fieldName, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_FIELD_NAME });
                    entryCode.createSpan({ text: ': ', cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_FIELD_NAME });

                    // Style the "and" separator for fields the parser returns as name lists
                    // (author, editor, translator, bookauthor, ...), not only author/editor.
                    if (field.creators) {
                        const creators = field.creators;
                        creators.forEach((creator, index) => {
                            entryCode.createSpan({ text: creator, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_FIELD_VALUE });
                            if (index < creators.length - 1) {
                                entryCode.createSpan({ text: ' and ', cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_FIELD_NAME });
                            }
                        });
                    } else {
                        // Default rendering for all other fields.
                        entryCode.createSpan({ text: field.fieldValue, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_FIELD_VALUE })
                    }
                });
            } else {
                // --- Render an error for an invalid/not-found key ---
                renderError(element, [bibkey, PLUGIN_CONSTANT.EMPTY_KEY_MSG]);
            }
        });
    }

    /**
     * This method is called when the plugin is unloaded.
     * It's responsible for cleaning up any resources.
     */
    onunload() {
        this.isUnloaded = true;
        // Drop a pending view refresh so it does not fire after the plugin is gone.
        this.refreshViews.cancel();
        this.bibCache.clear();
    }

    /**
     * Loads the plugin settings from Obsidian's data store.
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<BibtexEntryViewSettings>);
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
    loadBibFile(): Promise<void> {
        // Run loads one after another so overlapping triggers (modify event + saveSettings) can be de-duplicated.
        // Run after the previous load whether it succeeded or failed, so one failure cannot stall later loads.
        const run = () => this.loadBibFileNow();
        this.loadQueue = this.loadQueue.then(run, run);
        return this.loadQueue;
    }

    /**
     * Does the actual read/parse work. Skips parsing when neither the file path nor its content
     * changed since the last successful parse.
     */
    private async loadBibFileNow() {
        const { bibFilePath } = this.settings;

        if (!bibFilePath) {
            this.clearEntries();
            return;
        }

        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        if (!(bibFile instanceof TFile)) {
            this.clearEntries();
            new Notice(PLUGIN_CONSTANT.FILE_NOT_FOUND_MSG(bibFilePath));
            return;
        }

        try {
            const content = await this.app.vault.read(bibFile);
            const contentHash = await computeContentHash(bibFilePath, content);
            const alreadyParsed = contentHash === this.lastParsedHash;
            if (alreadyParsed) return;

            if (this.parseBibtex(content)) {
                this.lastParsedHash = contentHash;
                this.rebuildCache();
            } else {
                this.clearEntries();
            }
        } catch (error) {
            this.clearEntries();
            new Notice(PLUGIN_CONSTANT.PARSE_ERROR_MSG);
            console.error('BibtexEntryView Error:', error);
        }
    }

    /**
     * Drops all parsed data and the hash of the last successful parse.
     */
    private clearEntries() {
        this.rawEntries.clear();
        this.bibCache.clear();
        this.lastParsedHash = null;
    }

    /**
     * Parses the raw content of a .bib file into `rawEntries`, with every field kept and no
     * dependence on the field sort order. Display data is derived later by `rebuildCache`.
     * @param content The raw string content of the .bib file.
     * @returns True if parsing succeeded.
     */
    private parseBibtex(content: string): boolean {
        try {
            this.rawEntries.clear();
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
                const allParsedFields: FieldNameAndValue[] = Object.entries(entry.fields)
                    // An empty list (e.g. `author = {{}}`, where the parser already dropped the empty names) is treated as missing.
                    .filter(([, value]) => !Array.isArray(value) || value.length > 0)
                    .map(([fieldName, value]) => {
                    let fieldValue: string;
                    let creators: string[] | undefined;
                    const lowerFieldName = fieldName.toLowerCase();

                    // Convert the field's value (which can be a string or array) into a single string.
                    if (Array.isArray(value)) {
                        // Handle Creator arrays (authors/editors) by formatting names.
                        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null && ('lastName' in value[0] || 'firstName' in value[0] || 'name' in value[0])) {
                            creators = (value as Creator[]).map(creator => {
                                if (creator.name) return creator.name; // For institutional authors
                                // BibTeX order "von Last, Jr, First", keeping the prefix (van, de la) and suffix (Jr.).
                                // Missing parts are skipped, so a last-name-only creator stays as is.
                                const last = [creator.prefix, creator.lastName].filter(Boolean).join(' ');
                                return [last, creator.suffix, creator.firstName].filter(Boolean).join(', ');
                            }).filter(name => name.length > 0); // Drop creators without any name, to avoid "A and  and B".
                            fieldValue = creators.join(' and ');
                        } else {
                            // Handle simple string arrays.
                            fieldValue = (value as string[]).join(' ');
                        }
                    } else {
                        // Handle plain string values.
                        fieldValue = value;
                    }

                    return {
                        fieldName: lowerFieldName,
                        fieldValue: fieldValue,
                        creators
                    };
                })
                // A creator field left with no names is treated as missing, so e.g. editor takes author's place.
                .filter(field => !field.creators || field.creators.length > 0);

                const searchableWords = this.computeSearchableWords(bibkey, entryType, allParsedFields);
                this.rawEntries.set(bibkey, { entryType, bibkey, fields: allParsedFields, searchableWords });
            }
            return true;
        } catch (error) {
            new Notice(PLUGIN_CONSTANT.PARSE_ERROR_MSG);
            console.error('BibtexEntryView: Error parsing .bib file with library', error);
            return false;
        }
    }

    /**
     * Builds the words autocomplete searches: the bibkey plus the fields in the search fields setting.
     * Split into words here, so searching does not have to redo it on every keystroke.
     */
    private computeSearchableWords(bibkey: string, entryType: string, fields: FieldNameAndValue[]): string[] {
        const searchFields = this.settings.searchFields.map(f => f.toLowerCase());
        const textParts = [bibkey];
        fields.forEach(field => {
            if (searchFields.includes(field.fieldName)) {
                textParts.push(field.fieldValue);
            }
        });
        // 'entrytype' is a virtual field (as in the field sort order), not one of the parsed fields.
        if (searchFields.includes('entrytype')) {
            textParts.push(entryType);
        }
        return textParts.join(' ').toLowerCase().split(/[\s,.:;!?()"]+/).filter(w => w.length > 0);
    }

    /**
     * Applies changed search fields by recomputing the searchable words of the parsed entries.
     * Only autocomplete uses them, so no file read, re-parse or view refresh is needed.
     */
    applySearchFields() {
        for (const raw of this.rawEntries.values()) {
            raw.searchableWords = this.computeSearchableWords(raw.bibkey, raw.entryType, raw.fields);
        }
    }

    /**
     * Applies a changed field sort order: rebuilds the cache and refreshes open views.
     * View refreshes are debounced so typing in the settings textarea stays responsive.
     */
    applyFieldOrder() {
        this.rebuildCache();
        this.refreshViews();
    }

    private refreshViews = debounce(() => this.app.workspace.updateOptions(), 300, true);

    /**
     * Derives the display-ready cache from `rawEntries` using the current field sort order.
     * It does not touch the file or the parser, so it is cheap enough to run when the order changes.
     */
    rebuildCache() {
        const cache = new Map<string, CachedBibEntry>();

        for (const raw of this.rawEntries.values()) {
            // Apply the user's custom field sorting.
            const formattedEntry = this.formatAndSortBibtexFields(raw);
            cache.set(raw.bibkey, { formattedEntry, rawEntry: raw });
        }

        // Keep the cache ordered by bibkey, so suggestions come out alphabetically without a later sort.
        this.bibCache = new Map(Array.from(cache.entries()).sort(([a], [b]) => a.localeCompare(b)));
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
        let fieldsToRender = allParsedFields.filter(field => priorityOrder.includes(field.fieldName));

        // Give special priority to 'author' or 'editor' by moving it to the top.
        let primaryField: FieldNameAndValue | undefined;
        const authorIndex = fieldsToRender.findIndex(f => f.fieldName === 'author');
        if (authorIndex !== -1) {
            primaryField = fieldsToRender.splice(authorIndex, 1)[0];
        } else {
            const editorIndex = fieldsToRender.findIndex(f => f.fieldName === 'editor');
            if (editorIndex !== -1) {
                primaryField = fieldsToRender.splice(editorIndex, 1)[0];
            }
        }

        // Sort the remaining fields based on the user's custom order.
        fieldsToRender.sort((a, b) => {
            const indexA = priorityOrder.indexOf(a.fieldName);
            const indexB = priorityOrder.indexOf(b.fieldName);
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
class BibkeySuggester extends EditorSuggest<RawBibEntry> {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app);
        this.plugin = plugin;
        this.setInstructions([
            PLUGIN_CONSTANT.SUGGESTER_INSTRUCTIONS.NAVIGATE,
            PLUGIN_CONSTANT.SUGGESTER_INSTRUCTIONS.SELECT,
            PLUGIN_CONSTANT.SUGGESTER_INSTRUCTIONS.CLOSE
        ]);
    }

    /**
     * Determines if the suggestion pop-up should be triggered based on the cursor's position and context.
     * @returns A trigger info object if suggestions should be shown, otherwise null.
     */
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);

        // Case 1: Single-line input ` ```bibkey key...` (rewritten into the multi-line format on selection)
        if (line.startsWith(PLUGIN_CONSTANT.SINGLE_LINE_PREFIX)) {
            // Search after the prefix, so the opening backticks are not mistaken for the closing ones.
            const closingTicksIndex = line.indexOf(PLUGIN_CONSTANT.CLOSING_BACKTICKS, PLUGIN_CONSTANT.SINGLE_LINE_PREFIX.length);
            // Trigger only if the cursor is inside the key area: after the prefix and before any closing backticks.
            if (cursor.ch >= PLUGIN_CONSTANT.SINGLE_LINE_PREFIX.length && (closingTicksIndex === -1 || cursor.ch <= closingTicksIndex)) {
                 const query = line.substring(PLUGIN_CONSTANT.SINGLE_LINE_PREFIX.length, cursor.ch);
                 return {
                     start: { line: cursor.line, ch: PLUGIN_CONSTANT.SINGLE_LINE_PREFIX.length },
                     end: cursor,
                     query: query,
                 };
            }
        }

        // Case 2: Multi-line format
        if (cursor.line > 0) {
            const prevLine = editor.getLine(cursor.line - 1);
            // Trigger if the previous line is the opening of the block and the current line is not the closing.
            if (prevLine.trim() === `\`\`\`${PLUGIN_CONSTANT.BIBKEY_CODE_BLOCK}` && line.trim() !== PLUGIN_CONSTANT.CLOSING_BACKTICKS) {
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
    async getSuggestions(context: EditorSuggestContext): Promise<RawBibEntry[]> {
        const query = context.query.toLowerCase();
        if (query.length < PLUGIN_CONSTANT.MIN_QUERY_LENGTH) return [];

        // Tokenize the query to allow for more flexible searching (e.g., "smi 21" matches "Smith 2021").
        const queryTokens = query
            .split(' ')
            .filter(w => w.length > 0)
            .flatMap(part => part.match(/\p{L}+|\p{N}+/gu) || []);

        if (queryTokens.length === 0) return [];

        const suggestions: RawBibEntry[] = [];

        // The cache is already sorted by bibkey, so the first matches are the alphabetical top results.
        for (const { rawEntry } of this.plugin.bibCache.values()) {
            // Check if every query token is a substring of at least one pre-computed word in the entry.
            const isMatch = queryTokens.every(token =>
                rawEntry.searchableWords.some(entryWord => entryWord.includes(token))
            );

            if (isMatch) {
                suggestions.push(rawEntry);
            }

            // Limit the number of suggestions for performance.
            if (suggestions.length >= PLUGIN_CONSTANT.MAX_SUGGESTIONS) {
                break;
            }
        }

        return suggestions;
    }

    /**
     * Renders the HTML for a single suggestion item in the pop-up menu.
     * Uses the raw entry, so author/year/title show even if they are hidden by the field sort order.
     * @param suggestion The BibTeX entry to render.
     * @param el The HTML element to render into.
     */
    renderSuggestion(suggestion: RawBibEntry, el: HTMLElement): void {
        el.addClass(PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_ITEM);

        el.createDiv({ text: suggestion.bibkey, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_KEY });

        const detailsContainer = el.createDiv({ cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_DETAILS });

        const authorField = suggestion.fields.find(f => f.fieldName === 'author');
        const editorField = suggestion.fields.find(f => f.fieldName === 'editor');
        const yearField = suggestion.fields.find(f => f.fieldName === 'year');
        const titleField = suggestion.fields.find(f => f.fieldName === 'title');

        // Line 1: Author/Editor and Year for a quick overview. The year sits in its own element, so only the
        // author part is cut with an ellipsis when the line is too long and the year always stays visible.
        const primaryCreatorField = authorField || editorField;
        const creatorText = primaryCreatorField?.fieldValue.trim();
        const yearText = yearField?.fieldValue.trim();
        if (creatorText || yearText) {
            const lineEl = detailsContainer.createDiv({ cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_AUTHOR_YEAR });
            if (creatorText) {
                lineEl.createSpan({ text: creatorText, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_AUTHOR });
            }
            if (yearText) {
                // The comma goes with the year, so no leading comma appears when there is no creator.
                lineEl.createSpan({ text: creatorText ? `, ${yearText}` : yearText, cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_YEAR });
            }
        }

        // Line 2: Display the title with special formatting based on entry type.
        if (titleField) {
            const titleEl = detailsContainer.createDiv({ cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_SUGGESTION_TITLE });
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
    selectSuggestion(suggestion: RawBibEntry, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        const { editor, start, end } = this.context;
        const line = editor.getLine(start.line);

        // Whether the line right after `lineNum` is a lone closing fence.
        const isFenceBelow = (lineNum: number) =>
            lineNum + 1 < editor.lineCount() && editor.getLine(lineNum + 1).trim() === PLUGIN_CONSTANT.CLOSING_BACKTICKS;

        if (line.startsWith(PLUGIN_CONSTANT.SINGLE_LINE_PREFIX)) {
            // --- Single-line input ---
            // ` ```bibkey key``` ` on one line is not a code block in Markdown (a fence's info string cannot
            // contain backticks), and a key on the opening line is read as the info string, not the content.
            // So the whole line is rewritten into the multi-line format with the selected key. This also
            // replaces the whole existing key, not just the part before the cursor.
            const closingTicksIndex = line.indexOf(PLUGIN_CONSTANT.CLOSING_BACKTICKS, PLUGIN_CONSTANT.SINGLE_LINE_PREFIX.length);
            const openingLine = `${PLUGIN_CONSTANT.CLOSING_BACKTICKS}${PLUGIN_CONSTANT.BIBKEY_CODE_BLOCK}`;
            const lineStart = { line: start.line, ch: 0 };
            const lineEnd = { line: start.line, ch: line.length };

            if (closingTicksIndex === -1 && isFenceBelow(start.line)) {
                // Obsidian auto-pairs the closing fence onto the next line. Keep it as the closing fence
                // instead of adding another one; it ends up one line further down, below the key.
                editor.replaceRange(`${openingLine}${PLUGIN_CONSTANT.NEWLINE_SEPARATOR}${suggestion.bibkey}`, lineStart, lineEnd);
                this.moveCursorBelow(editor, start.line + 2);
            } else {
                // Otherwise write the closing fence below the key. Any text after closing backticks on the
                // same line moves to the line after the block, where the cursor goes.
                const rest = closingTicksIndex === -1 ? '' : line.substring(closingTicksIndex + PLUGIN_CONSTANT.CLOSING_BACKTICKS.length);
                const block = [openingLine, suggestion.bibkey, PLUGIN_CONSTANT.CLOSING_BACKTICKS, rest].join(PLUGIN_CONSTANT.NEWLINE_SEPARATOR);
                editor.replaceRange(block, lineStart, lineEnd);
                editor.setCursor({ line: start.line + 3, ch: 0 });
            }

        } else {
            // --- Multi-line mode ---
            // Replace the key line's content with the full bibkey.
            editor.replaceRange(suggestion.bibkey, start, end);

            // Check only the next line for the closing backticks, so a fence of another code block
            // further down is not mistaken for this block's closing fence.
            if (isFenceBelow(start.line)) {
                this.moveCursorBelow(editor, start.line + 1);
            } else {
                // If not found, add the closing backticks and a newline, then move the cursor.
                const endOfKeyLine = { line: start.line, ch: editor.getLine(start.line).length };
                editor.replaceRange(`${PLUGIN_CONSTANT.NEWLINE_SEPARATOR}${PLUGIN_CONSTANT.CLOSING_BACKTICKS}${PLUGIN_CONSTANT.NEWLINE_SEPARATOR}`, endOfKeyLine);
                editor.setCursor({ line: start.line + 2, ch: 0 });
            }
        }

        this.close();
    }

    /**
     * Moves the cursor to the start of the line after the closing fence at `fenceLineNum`,
     * adding a new line first if the fence is the last line of the file.
     */
    private moveCursorBelow(editor: Editor, fenceLineNum: number): void {
        const targetLineNum = fenceLineNum + 1;
        if (targetLineNum >= editor.lineCount()) {
            editor.replaceRange(PLUGIN_CONSTANT.NEWLINE_SEPARATOR, { line: fenceLineNum, ch: editor.getLine(fenceLineNum).length });
        }
        editor.setCursor({ line: targetLineNum, ch: 0 });
    }
}

// 7. OVERWRITE CONFIRMATION MODAL
/**
 * Asks the user to confirm before an imported file replaces an existing vault file.
 */
class ConfirmOverwriteModal extends Modal {
    private resolve!: (confirmed: boolean) => void;
    private decided = false;

    constructor(app: App, private path: string) {
        super(app);
    }

    /**
     * Opens the modal and resolves to true only if the user clicks the overwrite button.
     */
    prompt(): Promise<boolean> {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.setTitle(PLUGIN_CONSTANT.SETTINGS.OVERWRITE_TITLE);
        this.contentEl.createEl('p', { text: PLUGIN_CONSTANT.SETTINGS.OVERWRITE_MESSAGE(this.path) });

        new Setting(this.contentEl)
            .addButton(button => button
                .setButtonText(PLUGIN_CONSTANT.SETTINGS.OVERWRITE_CANCEL)
                .onClick(() => this.finish(false)))
            .addButton(button => button
                .setButtonText(PLUGIN_CONSTANT.SETTINGS.OVERWRITE_CONFIRM)
                .setDestructive()
                .onClick(() => this.finish(true)));
    }

    onClose(): void {
        this.contentEl.empty();
        // Closing via esc or the X counts as cancel.
        this.finish(false);
    }

    private finish(confirmed: boolean): void {
        if (this.decided) return;
        this.decided = true;
        this.resolve(confirmed);
        this.close();
    }
}

// 8. SETTINGS TAB CLASS
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
     * Reads setting values for built-in controls.
     * Converts the fieldSortOrder and searchFields string[] arrays into newline-separated strings for the textareas.
     */
    getControlValue(key: string): unknown {
        if (key === 'fieldSortOrder' || key === 'searchFields') {
            return this.plugin.settings[key].join(PLUGIN_CONSTANT.NEWLINE_SEPARATOR);
        }
        return this.plugin.settings[key as keyof typeof this.plugin.settings];
    }

    /**
     * Writes setting values from built-in controls and triggers appropriate save/re-parse logic.
     */
    setControlValue(key: string, value: unknown): void {
        if (key === 'bibFilePath' && typeof value === 'string') {
            this.plugin.settings.bibFilePath = value;
            // Re-parse the .bib file immediately when a new file is selected.
            void this.plugin.saveSettings();
            return;
        }

        if (key === 'fieldSortOrder' && typeof value === 'string') {
            this.plugin.settings.fieldSortOrder = value
                .split(PLUGIN_CONSTANT.NEWLINE_SEPARATOR)
                .map(field => field.trim())
                .filter(Boolean);

            // The order only affects display, so rebuild from the parsed entries; no file read or re-parse.
            void this.plugin.saveData(this.plugin.settings);
            this.plugin.applyFieldOrder();
            return;
        }

        if (key === 'searchFields' && typeof value === 'string') {
            this.plugin.settings.searchFields = value
                .split(PLUGIN_CONSTANT.NEWLINE_SEPARATOR)
                .map(field => field.trim())
                .filter(Boolean);

            // Saved on every keystroke like the field order; only the search words are recomputed.
            void this.plugin.saveData(this.plugin.settings);
            this.plugin.applySearchFields();
            return;
        }
    }

    /**
     * Provides declarative setting definitions using Obsidian 1.13+ built-in controls.
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            // Section 1: Bib file settings
            {
                type: 'group',
                items: [
                    {
                        name: PLUGIN_CONSTANT.SETTINGS.CURRENT_BIB_FILE_NAME,
                        desc: PLUGIN_CONSTANT.SETTINGS.CURRENT_BIB_FILE_DESC,
                        control: {
                            type: 'file',
                            key: 'bibFilePath',
                            placeholder: PLUGIN_CONSTANT.SETTINGS.NO_FILE_PLACEHOLDER,
                            filter: (file: TFile) => file.extension === PLUGIN_CONSTANT.BIB_FILE_EXTENSION,
                            validate: (path: string): string | undefined => {
                                if (!path) return undefined;
                                const file = this.app.vault.getAbstractFileByPath(path);
                                return file instanceof TFile ? undefined : 'File does not exist in vault.';
                            }
                        }
                    },
                    {
                        // External file import still uses custom DOM input, kept as a single button.
                        name: PLUGIN_CONSTANT.SETTINGS.SELECT_IMPORT_NAME,
                        desc: PLUGIN_CONSTANT.SETTINGS.SELECT_IMPORT_DESC(),
                        render: (setting: Setting) => {
                            setting.addButton(button => button
                                .setButtonText(PLUGIN_CONSTANT.SETTINGS.IMPORT_TO_VAULT_TEXT)
                                .setTooltip(PLUGIN_CONSTANT.SETTINGS.IMPORT_TO_VAULT_TOOLTIP)
                                .onClick(() => {
                                    const fileInput = activeDocument.body.createEl('input', {
                                        type: 'file',
                                        cls: PLUGIN_CONSTANT.CSS_CLASSES.CSS_HIDDEN_FILE_INPUT,
                                        attr: {
                                            accept: `.${PLUGIN_CONSTANT.BIB_FILE_EXTENSION}`,
                                        }
                                    });

                                    const cleanup = () => {
                                        fileInput.remove();
                                    };

                                    fileInput.onchange = async () => {
                                        try {
                                            const file = fileInput.files?.[0];
                                            if (!file) return;

                                            const content = await file.text();
                                            const newPath = file.name;

                                            const existingFile = this.app.vault.getAbstractFileByPath(newPath);
                                            if (existingFile instanceof TFile) {
                                                const confirmed = await new ConfirmOverwriteModal(this.app, newPath).prompt();
                                                if (!confirmed) return;
                                                await this.app.vault.modify(existingFile, content);
                                            } else {
                                                await this.app.vault.create(newPath, content);
                                            }

                                            this.plugin.settings.bibFilePath = newPath;
                                            await this.plugin.saveSettings();
                                            this.update();
                                        } catch (error) {
                                            new Notice(PLUGIN_CONSTANT.IMPORT_ERROR_MSG(error instanceof Error ? error.message : String(error)));
                                        } finally {
                                            cleanup();
                                        }
                                    };

                                    fileInput.oncancel = () => {
                                        cleanup();
                                    };

                                    fileInput.click();
                                }));
                        }
                    },
                    {
                        name: PLUGIN_CONSTANT.SETTINGS.FIELD_SORT_ORDER_NAME,
                        desc: PLUGIN_CONSTANT.SETTINGS.FIELD_SORT_ORDER_DESC(),
                        control: {
                            type: 'textarea',
                            key: 'fieldSortOrder',
                            rows: PLUGIN_CONSTANT.SORTORDER_AREA_ROWS
                        }
                    },
                    {
                        name: PLUGIN_CONSTANT.SETTINGS.SEARCH_FIELDS_NAME,
                        desc: PLUGIN_CONSTANT.SETTINGS.SEARCH_FIELDS_DESC,
                        control: {
                            type: 'textarea',
                            key: 'searchFields',
                            rows: PLUGIN_CONSTANT.SEARCH_FIELDS_AREA_ROWS
                        }
                    }
                ]
            }
        ];
    }
}
