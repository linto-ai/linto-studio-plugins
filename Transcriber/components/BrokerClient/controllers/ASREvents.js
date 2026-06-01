//here, "this" is bound to the BrokerClient component

function buildExternalTranslations(channel) {
    if (!channel || !channel.translations || !Array.isArray(channel.translations)) {
        return [];
    }
    return channel.translations
        .filter(entry => entry && entry.mode === 'external')
        .map(entry => ({ targetLang: entry.target, translator: entry.translator }));
}

function publishDiscreteTranslations(client, transcription, sessionId, channelId, action) {
    if (!transcription.translations || typeof transcription.translations !== 'object') return;

    const translations = transcription.translations;
    for (const [lang, text] of Object.entries(translations)) {
        if (!text) continue;
        const translationPayload = {
            segmentId: transcription.segmentId,
            astart: transcription.astart,
            text: text,
            start: transcription.start,
            end: transcription.end,
            sourceLang: transcription.lang,
            targetLang: lang,
            locutor: transcription.locutor,
            final: action === 'final',
            mode: 'discrete'
        };
        client.publish(`transcriber/out/${sessionId}/${channelId}/${action}/translations`, translationPayload);
    }
}

module.exports = async function () {
    this.app.components['StreamingServer'].on('partial', (transcription, sessionId, channelId, channel) => {
        // Add externalTranslations from channel config
        const externalTranslations = buildExternalTranslations(channel);
        if (externalTranslations.length > 0) {
            transcription.externalTranslations = externalTranslations;
        }

        // Publish discrete translations to separate topic (must read transcription.translations before stripping)
        publishDiscreteTranslations(this.client, transcription, sessionId, channelId, 'partial');

        // Dual-mode secondary (translation-only) partials carry no canonical
        // text/speaker: they must not overwrite the diarization primary's live
        // caption. Publish only their translations (done above) and stop here.
        if (transcription.isPrimary === false) return;

        const { translations: _partialTranslations, isPrimary: _partialIsPrimary, ...partialPayload } = transcription;
        this.client.publish(`transcriber/out/${sessionId}/${channelId}/partial`, partialPayload);
    });

    this.app.components['StreamingServer'].on('final', (transcription, sessionId, channelId, channel) => {
        // Add externalTranslations from channel config
        const externalTranslations = buildExternalTranslations(channel);
        if (externalTranslations.length > 0) {
            transcription.externalTranslations = externalTranslations;
        }

        // Publish discrete translations to separate topic (must read transcription.translations before stripping)
        publishDiscreteTranslations(this.client, transcription, sessionId, channelId, 'final');

        // Dual-mode secondary (translation-only) finals must NOT produce a
        // canonical caption line: that line would carry locutor=null and, with
        // diarization enabled, the saved/canonical transcript drops it (root
        // cause of the empty-saved-transcript bug). The diarization primary owns
        // the canonical `final`; the secondary contributes only translations.
        if (transcription.isPrimary === false) return;

        const { translations: _finalTranslations, isPrimary: _finalIsPrimary, ...finalPayload } = transcription;
        this.client.publish(`transcriber/out/${sessionId}/${channelId}/final`, finalPayload);
    });
}
