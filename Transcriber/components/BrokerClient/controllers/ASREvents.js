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
            locutor: transcription.locutor
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

        this.client.publish(`transcriber/out/${sessionId}/${channelId}/partial`, transcription);

        // Publish discrete translations to separate topic
        publishDiscreteTranslations(this.client, transcription, sessionId, channelId, 'partial');
    });

    this.app.components['StreamingServer'].on('final', (transcription, sessionId, channelId, channel) => {
        // Add externalTranslations from channel config
        const externalTranslations = buildExternalTranslations(channel);
        if (externalTranslations.length > 0) {
            transcription.externalTranslations = externalTranslations;
        }

        this.client.publish(`transcriber/out/${sessionId}/${channelId}/final`, transcription);

        // Publish discrete translations to separate topic
        publishDiscreteTranslations(this.client, transcription, sessionId, channelId, 'final');
    });
}
