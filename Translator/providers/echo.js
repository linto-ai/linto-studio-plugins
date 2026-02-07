const TranslationProvider = require('./base');

class EchoProvider extends TranslationProvider {
    async translate(text, sourceLang, targetLang) {
        return text;
    }
}

module.exports = EchoProvider;
