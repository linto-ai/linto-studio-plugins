const TranslationProvider = require('./base');

class EchoProvider extends TranslationProvider {
    async translate(text, sourceLang, targetLang) {
        return `[${sourceLang}→${targetLang}] ${text}`;
    }
}

module.exports = EchoProvider;
