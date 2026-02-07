class TranslationProvider {
    constructor(config) {
        this.config = config;
    }

    /**
     * Translate text from source language to target language.
     * @param {string} text - The text to translate
     * @param {string} sourceLang - BCP47 source language tag
     * @param {string} targetLang - BCP47 target language tag
     * @returns {Promise<string>} Translated text
     */
    async translate(text, sourceLang, targetLang) {
        throw new Error('Not implemented');
    }
}

module.exports = TranslationProvider;
