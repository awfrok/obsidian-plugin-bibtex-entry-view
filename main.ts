/**
 * @file This file contains the complete source code for an Obsidian plugin named "Bibtex Entry View".
 *
 * @summary This plugin allows users to select a BibTeX (.bib) file from their vault and then display
 * formatted entries from that file directly within their notes. It uses a custom code block, `bibkey`,
 * to render the citation data. The plugin provides an autocomplete suggester to help users find
 * and insert the correct BibTeX key, and it offers settings to customize which fields are displayed
 * and in what order.
 *
 * @author [Kyoungdeuk]
 * @version 0.2.2
 *
 * Key Features:
 * - Parses and caches a user-selected .bib file for fast access.
 * - Renders formatted BibTeX entries inside a `bibkey` code block.
 * - Provides an intelligent autocomplete suggester for finding citation keys by searching across multiple fields (author, title, year, etc.).
 * - Allows users to customize the display order and visibility of BibTeX fields.
 * - Automatically reloads the .bib file when it's modified.
 * - Supports both importing .bib files from the local file system and selecting existing ones from the vault.
 */

// =================================================================================================
// 1. IMPORTS & DEPENDENCIES
// =================================================================================================

import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TextComponent,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo
} from 'obsidian';
import { parse as bibtexParse } from '@retorquere/bibtex-parser';

// =================================================================================================
// 2. PLUGIN CONSTANTS
// =================================================================================================

/**
 * A centralized object holding all the static constants used throughout the plugin.
 * This approach makes configuration and maintenance easier by keeping magic strings
 * and numbers in one place.
 */
const PLUGIN_CONSTANTS = {
    // --- Search and Suggester Configuration ---
    MIN_QUERY_LENGTH: 2,          // Minimum number of characters required to trigger the autocomplete suggester.
    MAX_SUGGESTIONS: 50,          // Maximum number of suggestions to display in the autocomplete popup to maintain performance.
    SEARCH_DEBOUNCE_MS: 150,      // (Note: Debouncing is not explicitly implemented here, but this would be the place for its config).

    // --- Code Block Configuration ---
    BIBKEY_CODE_BLOCK: 'bibkey',              // The language identifier for the markdown code block (e.g., ```bibkey).
    SINGLE_LINE_PREFIX: '```bibkey ',         // The exact prefix for a single-line code block to trigger suggestions.
    CLOSING_BACKTICKS: '```',                 // The closing characters for a markdown code block.

    // --- UI Configuration ---
    TEXTAREA_ROWS: 10,            // The number of visible rows for the field sorting text area in settings.
    TEXTAREA_COLS: 30,            // The number of visible columns for the field sorting text area in settings.
    NOTICE_DURATION: 2000,        // The duration (in milliseconds) for Obsidian notices to be displayed.

    // --- File Handling ---
    BIB_FILE_EXTENSION: 'bib',    // The file extension for BibTeX files.
    DEFAULT_SEARCH_PLACEHOLDER: 'Search for .bib files...', // Placeholder text for the file search input.

    // --- CSS Classes ---
    // A collection of CSS classes used for styling the plugin's UI elements.
    CSS_CLASSES: {
        BIBTEX_ENTRY: 'bibtex-entry-view', // Main class for the rendered BibTeX entry container.
        BIBTEX_ERROR: 'bibtex-error',      // Class applied when there's an error rendering an entry.
        BIBKEY: 'bibkey',                  // Class for the citation key element.
        INVALID_KEY: 'bibkey-invalid-key', // Class for a BibTeX key that is not found in the library.
        SUGGESTION_ITEM: 'bibtex-suggestion-item', // Class for each item in the autocomplete suggestion list.
        FILE_ITEM: 'bibtex-file-item',     // Class for each item in the .bib file selection modal.
    },

    // --- User-Facing Messages ---
    // A collection of messages and error strings shown to the user.
    MESSAGES: {
        EMPTY_KEY: '(provide a correct key)', // Message shown in an empty `bibkey` code block.
        FILE_NOT_FOUND: (path: string) => `BibtexEntryView: Could not find file at: ${path}`, // Error when the .bib file is missing.
        PARSE_ERROR: 'BibtexEntryView: Error reading or parsing .bib file.', // Error for malformed .bib files.
        IMPORT_ERROR: (error: string) => `BibtexEntryView: Error importing file: ${error}`, // Error during file import.
        NO_FILES_FOUND: 'No matching .bib files found.', // Message when no .bib files are found in the vault.
    }
} as const; // `as const` makes the object readonly, preventing accidental modification.

// =================================================================================================
// 3. DATA STRUCTURE INTERFACES
// =================================================================================================

/**
 * Defines the shape of the plugin's settings object, which is persisted by Obsidian.
 */
interface BibtexEntryViewSettings {
    bibFilePath: string;      // The full path to the selected .bib file within the Obsidian vault.
    fieldSortOrder: string[]; // An array of BibTeX field names (e.g., 'author', 'year') that defines the custom display order in the rendered view.
}

/**
 * Provides a default configuration for the plugin. This is used when the plugin is
 * first installed or when the settings file is corrupted or missing.
 */
const DEFAULT_SETTINGS: BibtexEntryViewSettings = {
    bibFilePath: '', // Defaults to no file selected.
    fieldSortOrder: [ // A sensible default order for common BibTeX fields.
        'author', 'year', 'entrytype', 'title', 'subtitle', 'editor',
        'booktitle', 'booksubtitle', 'maintitle', 'mainsubtitle',
        'edition', 'journal', 'series', 'volume',
        'number', 'pages', 'address', 'publisher'
    ]
};

/**
 * A simple key-value pair structure used to represent a single field from a BibTeX entry
 * (e.g., { fieldName: 'author', fieldValue: 'Doe, John' }).
 */
interface FieldNameAndValue {
    fieldName: string;
    fieldValue: string;
}

/**
 * Represents a BibTeX entry after it has been processed and formatted for display.
 * This structure is used for rendering both the code block view and the autocomplete suggestions.
 */
interface FormattedBibtexEntry {
    entryType: string;
    bibkey: string;
    fields: FieldNameAndValue[]; // An array of fields, sorted according to user settings.
}

/**
 * Represents a raw BibTeX entry as parsed from the .bib file.
 * This aligns with the structure provided by the `@retorquere/bibtex-parser` library.
 */
interface BibtexEntryObject {
    citationKey: string;                 // The unique citation key (e.g., "Doe2021").
    entryType: string;                   // The type of the entry (e.g., "article", "book").
    entryTags: Record<string, string>;   // A dictionary of all fields and their values.
}

// =================================================================================================
// 4. MAIN PLUGIN CLASS
// =================================================================================================

/**
 * The main class for the BibtexEntryView plugin. Obsidian instantiates this class when the
 * plugin is enabled. It manages the plugin's lifecycle, settings, data, and features.
 */
export default class BibtexEntryViewPlugin extends Plugin {
    settings: BibtexEntryViewSettings;
    // An in-memory cache to store the parsed BibTeX entries. A Map is used for efficient
    // lookup by citation key. This avoids re-parsing the .bib file for every operation.
    bibEntries: Map<string, BibtexEntryObject> = new Map();

    /**
     * This method is called when the plugin is first loaded or enabled.
     * It's responsible for all the initial setup.
     */
    async onload() {
        // Load the saved settings from disk.
        await this.loadSettings();

        // Add the plugin's settings tab to Obsidian's settings screen.
        this.addSettingTab(new BibtexEntryViewSettingTab(this.app, this));

        // Register the custom autocomplete suggester to provide bibkey suggestions.
        this.registerEditorSuggest(new BibkeySuggester(this.app, this));

        // Register an event listener that triggers when any file in the vault is modified.
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            // If the modified file is the one we are using, reload it.
            if (file.path === this.settings.bibFilePath) {
                await this.loadBibFile();
                // Force Obsidian to re-render the open markdown files to reflect changes.
                this.app.workspace.updateOptions();
            }
        }));

        // The 'layout-ready' event fires once the Obsidian workspace is fully initialized.
        // This is a reliable time to perform initial data loading and UI registration.
        this.app.workspace.onLayoutReady(async () => {
            // Load the BibTeX data from the file specified in the settings.
            await this.loadBibFile();

            // Register the processor for the `bibkey` markdown code block.
            // This function will be called for every `bibkey` block in any rendered markdown file.
            this.registerMarkdownCodeBlockProcessor(PLUGIN_CONSTANTS.BIBKEY_CODE_BLOCK, (source, element, context) => {
                const bibkey = source.trim(); // The content of the code block is the bibkey.
                element.empty(); // Clear any previous content from the element.

                // Handle the case where the code block is empty.
                if (!bibkey) {
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANTS.CSS_CLASSES.BIBTEX_ENTRY} ${PLUGIN_CONSTANTS.CSS_CLASSES.BIBTEX_ERROR}` });
                    entryCode.createEl('span', {
                        text: PLUGIN_CONSTANTS.MESSAGES.EMPTY_KEY,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.INVALID_KEY
                    });
                    return;
                }

                // Look up the bibkey in our cached entries.
                const bibEntry = this.bibEntries.get(bibkey);

                if (bibEntry) {
                    // If the key is found, format it for display.
                    const parsedEntry = this.formatAndSortBibtexEntry(bibEntry);
                    if (parsedEntry) {
                        // Create the HTML structure to display the formatted entry.
                        const entryPre = element.createEl('pre');
                        const entryCode = entryPre.createEl('code', { cls: PLUGIN_CONSTANTS.CSS_CLASSES.BIBTEX_ENTRY });

                        // Display the main bibkey.
                        entryCode.createEl('span', { text: parsedEntry.bibkey, cls: PLUGIN_CONSTANTS.CSS_CLASSES.BIBKEY });

                        // Loop through the sorted fields and display them.
                        parsedEntry.fields.forEach((field) => {
                            entryCode.appendText('\n'); // New line for each field.
                            entryCode.createEl('span', { text: field.fieldName, cls: 'bibtex-field-name' });
                            entryCode.createEl('span', { text: ': ', cls: 'bibtex-field-name' });
                            entryCode.createEl('span', { text: field.fieldValue, cls: 'bibtex-field-value' });
                        });
                    }
                } else {
                    // If the key is not found in the .bib file, display an error message.
                    const entryPre = element.createEl('pre');
                    const entryCode = entryPre.createEl('code', { cls: `${PLUGIN_CONSTANTS.CSS_CLASSES.BIBTEX_ENTRY} ${PLUGIN_CONSTANTS.CSS_CLASSES.BIBTEX_ERROR}` });

                    // Show the invalid key the user typed.
                    entryCode.createEl('span', {
                        text: bibkey,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.INVALID_KEY
                    });

                    // Append a helpful message.
                    entryCode.appendText(' ');
                    entryCode.createEl('span', {
                        text: PLUGIN_CONSTANTS.MESSAGES.EMPTY_KEY,
                        cls: PLUGIN_CONSTANTS.CSS_CLASSES.INVALID_KEY
                    });
                }
            });

            // Force a re-render after setup to ensure all existing blocks are processed.
            this.app.workspace.updateOptions();
        });
    }

    /**
     * This method is called when the plugin is disabled.
     * It's used for cleanup to prevent memory leaks.
     */
    onunload() {
        // Clear the cached BibTeX entries to free up memory.
        this.bibEntries.clear();
    }

    /**
     * Loads the plugin settings from Obsidian's storage.
     * It merges the default settings with any saved settings.
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    /**
     * Saves the current plugin settings to Obsidian's storage.
     * This is typically called when the settings tab is closed or a setting is changed.
     */
    async saveSettings() {
        await this.saveData(this.settings);
        // After saving, reload the .bib file in case the path changed.
        await this.loadBibFile();
        // Update the workspace to reflect any changes immediately.
        this.app.workspace.updateOptions();
    }

    /**
     * Reads the .bib file specified in the settings, parses its content,
     * and populates the `bibEntries` cache.
     */
    async loadBibFile() {
        this.bibEntries.clear(); // Clear old data before loading new data.
        const { bibFilePath } = this.settings;

        if (!bibFilePath) return; // Do nothing if no file path is set.

        // Use the Obsidian API to get a reference to the file.
        const bibFile = this.app.vault.getAbstractFileByPath(bibFilePath);

        // Ensure the file exists and is a valid file (not a folder).
        if (!(bibFile instanceof TFile)) {
            new Notice(PLUGIN_CONSTANTS.MESSAGES.FILE_NOT_FOUND(bibFilePath));
            return;
        }

        try {
            // Read the file content.
            const content = await this.app.vault.read(bibFile);
            // Parse the content using the bibtex-parser library.
            const parsedEntries = bibtexParse(content);

            // Iterate over the parsed entries and add them to the cache.
            for (const entry of parsedEntries.entries) {
                if (entry.key) {
                    // Map the structure from the parser to our internal `BibtexEntryObject` interface.
                    const mappedEntry: BibtexEntryObject = {
                        citationKey: entry.key,
                        entryType: entry.type,
                        entryTags: entry.fields
                    };
                    this.bibEntries.set(entry.key, mappedEntry);
                }
            }
        } catch (error) {
            // Handle errors during file reading or parsing.
            new Notice(PLUGIN_CONSTANTS.MESSAGES.PARSE_ERROR);
            console.error('BibtexEntryView Error:', error);
        }
    }

    /**
     * Takes a raw BibTeX entry object and transforms it into a formatted, sorted structure
     * suitable for display, based on the user's settings.
     * @param entry The raw BibtexEntryObject from the cache.
     * @returns A FormattedBibtexEntry object, or null if an error occurs.
     */
    formatAndSortBibtexEntry(entry: BibtexEntryObject): FormattedBibtexEntry | null {
        try {
            const { entryType, citationKey, entryTags } = entry;
            const allParsedFields: FieldNameAndValue[] = [];

            // Convert the entry's fields from a Record to an array of objects.
            for (const [fieldName, fieldValue] of Object.entries(entryTags)) {
                allParsedFields.push({ fieldName, fieldValue });
            }
            // Add the entry type as a pseudo-field so it can be included in the sort.
            allParsedFields.push({ fieldName: 'entrytype', fieldValue: entryType });

            // Get the user-defined sort order from settings.
            const priorityOrder = this.settings.fieldSortOrder.map(f => f.toLowerCase());
            // Filter the entry's fields to only include those specified in the settings.
            let fieldsToRender = allParsedFields.filter(field => priorityOrder.includes(field.fieldName.toLowerCase()));

            // --- Special Handling for Author/Editor ---
            // We want to ensure 'author' or 'editor' always appears first if present.
            let primaryField: FieldNameAndValue | undefined;
            const authorIndex = fieldsToRender.findIndex(f => f.fieldName.toLowerCase() === 'author');
            if (authorIndex !== -1) {
                // If author exists, pull it out of the array.
                primaryField = fieldsToRender.splice(authorIndex, 1)[0];
            } else {
                const editorIndex = fieldsToRender.findIndex(f => f.fieldName.toLowerCase() === 'editor');
                if (editorIndex !== -1) {
                    // Otherwise, if editor exists, pull it out instead.
                    primaryField = fieldsToRender.splice(editorIndex, 1)[0];
                }
            }

            // Sort the remaining fields based on their index in the user's priority list.
            fieldsToRender.sort((a, b) => {
                const fieldNameA = a.fieldName.toLowerCase();
                const fieldNameB = b.fieldName.toLowerCase();
                const sortIndexA = priorityOrder.indexOf(fieldNameA);
                const sortIndexB = priorityOrder.indexOf(fieldNameB);
                if (sortIndexA !== -1 && sortIndexB !== -1) return sortIndexA - sortIndexB;
                return 0; // Should not happen if filtering is correct.
            });

            // Prepend the primary field (author/editor) to the start of the sorted array.
            const sortedFields = primaryField ? [primaryField, ...fieldsToRender] : fieldsToRender;

            return { entryType, bibkey: citationKey, fields: sortedFields };
        } catch (error) {
            console.error("BibtexEntryView: Error formatting entry, returning null.", error);
            return null;
        }
    }
}

// =================================================================================================
// 5. SETTINGS TAB CLASS
// =================================================================================================

/**
 * This class creates the UI for the plugin's settings tab in Obsidian's settings window.
 */
class BibtexEntryViewSettingTab extends PluginSettingTab {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * This method is called by Obsidian to render the content of the settings tab.
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty(); // Clear the container before drawing new settings.

        containerEl.createEl('h2', { text: 'Bib file' });

        // Display the currently selected .bib file path (read-only).
        new Setting(containerEl)
            .setName('Current .bib file in the vault')
            .setDesc('This is the file the plugin is currently using.')
            .addText(text => text
                .setValue(this.plugin.settings.bibFilePath)
                .setPlaceholder('No file selected')
                .setDisabled(true)
            );

        // Add buttons for selecting a new file or importing one.
        new Setting(containerEl)
            .setName('Select or import a .bib file')
            .setDesc('Choose a file from your vault or import one from your computer. • Beware: Importing a file will overwrite the file of same name in the vault.')
            .addButton(button => button
                .setButtonText('Select from vault')
                .setTooltip('Select a .bib file in your vault')
                .onClick(() => {
                    // Open the file selection modal.
                    new BibFileSelectionModal(this.app, (selectedPath) => {
                        this.plugin.settings.bibFilePath = selectedPath;
                        this.display(); // Re-render the settings tab to show the new path.
                    }).open();
                }))
            .addButton(button => button
                .setButtonText('Import to vault')
                .setTooltip('Beware: Importing a file will overwrite the file of same name in the vault.')
                .onClick(() => {
                    // Create a hidden file input element to open the system file picker.
                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.accept = '.bib';
                    fileInput.onchange = async () => {
                        if (!fileInput.files || fileInput.files.length === 0) return;

                        const file = fileInput.files[0];
                        const content = await file.text();
                        const newPath = file.name;

                        try {
                            // Check if a file with the same name already exists.
                            const existingFile = this.app.vault.getAbstractFileByPath(newPath);
                            if (existingFile instanceof TFile) {
                                // If it exists, overwrite it.
                                await this.app.vault.modify(existingFile, content);
                            } else {
                                // Otherwise, create a new file.
                                await this.app.vault.create(newPath, content);
                            }

                            // Update the settings to use the newly imported file.
                            this.plugin.settings.bibFilePath = newPath;
                            this.display(); // Re-render to show the new path.
                        } catch (error) {
                            new Notice(PLUGIN_CONSTANTS.MESSAGES.IMPORT_ERROR(error.message));
                        }
                    };
                    fileInput.click(); // Programmatically click the hidden input.
                }));

        containerEl.createEl('h2', { text: 'Customize rendering' });

        // Add a text area for the user to define the field display order.
        new Setting(containerEl)
            .setName('Fields to display and sort')
            .setDesc('List the fields you want to display, in the order you want them to appear. Fields not in this list will be hidden. \nNote: Author and editor fields have a special priority.')
            .addTextArea(text => {
                text
                    .setValue(this.plugin.settings.fieldSortOrder.join('\n')) // Display current order, one field per line.
                    .onChange((value) => {
                        // When the user types, update the setting by splitting the string into an array.
                        this.plugin.settings.fieldSortOrder = value.split('\n').map(field => field.trim()).filter(Boolean);
                    });
                // Set the size of the text area.
                text.inputEl.rows = PLUGIN_CONSTANTS.TEXTAREA_ROWS;
                text.inputEl.cols = PLUGIN_CONSTANTS.TEXTAREA_COLS;
            });
    }

    /**
     * This method is called when the user navigates away from the settings tab.
     * It's the perfect place to save the settings.
     */
    hide(): void {
        this.plugin.saveSettings();
    }
}

// =================================================================================================
// 6. FILE SELECTION MODAL
// =================================================================================================

/**
 * A modal window that allows the user to search for and select a .bib file from their vault.
 */
class BibFileSelectionModal extends Modal {
    onChooseFile: (path: string) => void; // Callback function to execute when a file is chosen.
    private bibFiles: TFile[]; // A cached list of all .bib files in the vault.

    constructor(app: App, onChooseFile: (path: string) => void) {
        super(app);
        this.onChooseFile = onChooseFile;
        // Pre-load and sort all .bib files when the modal is created.
        this.bibFiles = this.app.vault.getFiles()
            .filter(file => file.extension === PLUGIN_CONSTANTS.BIB_FILE_EXTENSION)
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Called when the modal is opened. Responsible for rendering the modal's content.
     */
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select BibTeX File from Vault' });

        // Create a search input field.
        const searchInput = new TextComponent(contentEl)
            .setPlaceholder(PLUGIN_CONSTANTS.DEFAULT_SEARCH_PLACEHOLDER);
        searchInput.inputEl.style.width = '100%';
        searchInput.inputEl.style.marginBottom = '10px';

        const listEl = contentEl.createEl('div'); // Container for the list of files.

        // Function to update the displayed list based on a search filter.
        const updateList = (filter: string) => {
            listEl.empty();
            const filtered = this.bibFiles.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));

            if (!filtered.length) {
                listEl.createEl('p', { text: PLUGIN_CONSTANTS.MESSAGES.NO_FILES_FOUND });
                return;
            }

            // Create a clickable div for each matching file.
            filtered.forEach(file => {
                const item = listEl.createEl('div', { text: file.path, cls: PLUGIN_CONSTANTS.CSS_CLASSES.FILE_ITEM });
                item.addEventListener('click', () => {
                    this.onChooseFile(file.path); // Execute the callback with the selected path.
                    this.close(); // Close the modal.
                });
            });
        };

        // Listen for changes in the search input and update the list accordingly.
        searchInput.onChange(updateList);
        // Initially, display the full list.
        updateList('');
    }

    /**
     * Called when the modal is closed. Cleans up the content.
     */
    onClose() {
        this.contentEl.empty();
    }
}

// =================================================================================================
// 7. AUTOCOMPLETE SUGGESTER CLASS
// =================================================================================================

/**
 * Implements Obsidian's EditorSuggest API to provide an autocomplete dropdown for bibkeys
 * as the user types within a `bibkey` code block.
 */
class BibkeySuggester extends EditorSuggest<FormattedBibtexEntry> {
    plugin: BibtexEntryViewPlugin;

    constructor(app: App, plugin: BibtexEntryViewPlugin) {
        super(app);
        this.plugin = plugin;
    }

    /**
     * This method is called on every keystroke in the editor to determine if the
     * suggester should be triggered.
     * @returns An EditorSuggestTriggerInfo object if suggestions should be shown, otherwise null.
     */
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);

        // Case 1: Single-line format, e.g., ` ```bibkey key... `
        // Trigger if the line starts with the prefix but does not yet have the closing backticks.
        if (line.startsWith(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX) && !line.endsWith(PLUGIN_CONSTANTS.CLOSING_BACKTICKS)) {
            const query = line.substring(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX.length, cursor.ch);
            return {
                start: { line: cursor.line, ch: PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX.length },
                end: cursor,
                query: query,
            };
        }

        // Case 2: Multi-line format, e.g.,
        // ```bibkey
        // key...
        // ```
        if (cursor.line > 0) {
            const prevLine = editor.getLine(cursor.line - 1);
            // Trigger if the previous line is the opening of the code block and the current line is not the closing.
            if (prevLine.trim() === `\`\`\`${PLUGIN_CONSTANTS.BIBKEY_CODE_BLOCK}` && line.trim() !== PLUGIN_CONSTANTS.CLOSING_BACKTICKS) {
                const query = line.trim();
                const startCh = line.indexOf(query); // Find where the actual text begins on the line.
                return {
                    start: { line: cursor.line, ch: startCh },
                    end: { line: cursor.line, ch: startCh + query.length },
                    query: query,
                };
            }
        }

        return null; // Don't trigger the suggester.
    }

    /**
     * Fetches the list of suggestions based on the user's query.
     * This implements an enhanced search logic that allows partial and mixed-type queries.
     * @param context Contains the query and other context from `onTrigger`.
     * @returns A promise that resolves to an array of formatted BibTeX entries.
     */
    async getSuggestions(context: EditorSuggestContext): Promise<FormattedBibtexEntry[]> {
        const query = context.query.toLowerCase();
        if (query.length < PLUGIN_CONSTANTS.MIN_QUERY_LENGTH) return [];

        // 1. Parse the query into search tokens.
        // This splits the query by spaces and then further splits each part into contiguous
        // letters or numbers. e.g., "van 21" -> ["van", "21"]. "knuth84" -> ["knuth", "84"].
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
            // This string includes the bibkey and all fields that the user has chosen to display.
            const textParts = [entry.bibkey];
            const fieldsToSearch = this.plugin.settings.fieldSortOrder.map(f => f.toLowerCase());

            entry.fields.forEach(field => {
                if (fieldsToSearch.includes(field.fieldName.toLowerCase())) {
                    textParts.push(field.fieldValue);
                }
            });

            const searchableText = textParts.join(' ').toLowerCase();

            // 3. Split the entry's text into individual words for matching.
            const entryWords = searchableText.split(/[\s,.:;!?()"]+/).filter(w => w.length > 0);

            // 4. Check if EVERY query token is a substring of AT LEAST ONE word in the entry.
            // This allows for flexible matching. For a query "auth 21", it will match an entry
            // where one word contains "auth" and another contains "21".
            const isMatch = queryTokens.every(token =>
                entryWords.some(entryWord => entryWord.includes(token))
            );

            if (isMatch) {
                suggestions.push(entry);
            }

            // 5. Limit the number of results for performance.
            if (suggestions.length >= PLUGIN_CONSTANTS.MAX_SUGGESTIONS) {
                break;
            }
        }

        // Sort the final list of suggestions alphabetically by key as a default ranking.
        suggestions.sort((a, b) => a.bibkey.localeCompare(b.bibkey));

        return suggestions;
    }

    /**
     * Renders the HTML for a single suggestion item in the pop-up list.
     * @param suggestion The formatted entry to render.
     * @param el The parent HTML element for this suggestion.
     */
    renderSuggestion(suggestion: FormattedBibtexEntry, el: HTMLElement): void {
        el.addClass(PLUGIN_CONSTANTS.CSS_CLASSES.SUGGESTION_ITEM);

        // Display the bibkey prominently.
        el.createEl('div', { text: suggestion.bibkey, cls: 'bibkey-suggestion-key' });

        const detailsContainer = el.createEl('div', { cls: 'bibkey-suggestion-details-container' });

        // Find the key fields needed for the preview.
        const authorField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'author');
        const editorField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'editor');
        const yearField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'year');
        const titleField = suggestion.fields.find(f => f.fieldName.toLowerCase() === 'title');

        // Line 1: Combine Author/Editor and Year for a compact view.
        const primaryCreatorField = authorField || editorField;
        let authorYearText = '';
        if (primaryCreatorField) {
            authorYearText = primaryCreatorField.fieldValue;
        }
        if (yearField) {
            authorYearText += `, ${yearField.fieldValue}`;
        }
        if (authorYearText) {
            detailsContainer.createEl('div', {
                text: authorYearText.trim(),
                cls: 'bibkey-suggestion-author-year'
            });
        }

        // Line 2: Display the title with conditional formatting based on entry type.
        if (titleField) {
            const titleEl = detailsContainer.createEl('div', { cls: 'bibkey-suggestion-title' });
            const entryType = suggestion.entryType.toLowerCase();

            if (entryType === 'article' || entryType === 'inbook' || entryType === 'incollection') {
                // Add double quotes for articles and chapters.
                titleEl.setText(`"${titleField.fieldValue}"`);
            } else if (entryType === 'book' || entryType === 'proceedings') {
                // Italicize book titles using an emphasis tag.
                titleEl.createEl('em', { text: titleField.fieldValue });
            } else {
                // Default rendering for other types.
                titleEl.setText(titleField.fieldValue);
            }
        }
    }

    /**
     * This method is called when the user clicks or presses Enter on a suggestion.
     * It replaces the user's query in the editor with the selected bibkey.
     * @param suggestion The selected suggestion object.
     * @param evt The mouse or keyboard event that triggered the selection.
     */
    selectSuggestion(suggestion: FormattedBibtexEntry, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;
        const { editor, start } = this.context;
        const line = editor.getLine(start.line);

        // Handle the single-line case.
        if (line.startsWith(PLUGIN_CONSTANTS.SINGLE_LINE_PREFIX)) {
            // Replace the query with the selected key and add the closing backticks.
            const replacement = `${suggestion.bibkey}\`\`\``;
            const endOfLine = { line: start.line, ch: line.length };
            editor.replaceRange(replacement, start, endOfLine);
        } else {
            // Handle the multi-line case: just replace the typed query with the key.
            editor.replaceRange(suggestion.bibkey, this.context.start, this.context.end);
        }

        // Close the suggestion pop-up.
        this.close();
    }
}
