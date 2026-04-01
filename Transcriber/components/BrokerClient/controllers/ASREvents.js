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
            final: action === 'final'
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

        const { translations: _partialTranslations, ...partialPayload } = transcription;
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

        const { translations: _finalTranslations, ...finalPayload } = transcription;
        this.client.publish(`transcriber/out/${sessionId}/${channelId}/final`, finalPayload);
    });
}
