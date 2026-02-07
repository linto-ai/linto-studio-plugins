const mqtt = require('mqtt');
const { loadProvider } = require('./providers');

const BROKER_HOST = process.env.BROKER_HOST || 'localhost';
const BROKER_PORT = process.env.BROKER_PORT || 1883;
const BROKER_PROTOCOL = process.env.BROKER_PROTOCOL || 'mqtt';
const TRANSLATOR_NAME = process.env.TRANSLATOR_NAME;
const TRANSLATION_PROVIDER = process.env.TRANSLATION_PROVIDER || 'echo';
const PARTIAL_DEBOUNCE_MS = parseInt(process.env.PARTIAL_DEBOUNCE_MS || '500');

if (!TRANSLATOR_NAME) {
    console.error('TRANSLATOR_NAME environment variable is required');
    process.exit(1);
}

// 24 official EU languages (short codes, consistent with Microsoft translation codes)
const EU_LANGUAGES = [
    'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl',
    'ro', 'cs', 'da', 'sv', 'fi', 'el', 'hu', 'bg',
    'hr', 'sk', 'sl', 'et', 'lv', 'lt', 'mt', 'ga'
];

const STATUS_TOPIC = `translator/out/${TRANSLATOR_NAME}/status`;

const offlinePayload = JSON.stringify({ name: TRANSLATOR_NAME, languages: [], online: false });
const onlinePayload = JSON.stringify({ name: TRANSLATOR_NAME, languages: EU_LANGUAGES, online: true });

// Load translation provider
const ProviderClass = loadProvider(TRANSLATION_PROVIDER);
const provider = new ProviderClass({});

// Debounce timers for partial translations: key -> timeout
const partialTimers = new Map();

console.log(`Translator starting: name=${TRANSLATOR_NAME}, provider=${TRANSLATION_PROVIDER}`);

// Connect to MQTT broker with LWT
const client = mqtt.connect({
    protocol: BROKER_PROTOCOL,
    host: BROKER_HOST,
    port: parseInt(BROKER_PORT),
    clean: true,
    reconnectPeriod: 3000,
    will: {
        topic: STATUS_TOPIC,
        payload: offlinePayload,
        retain: true,
        qos: 1
    }
});

client.on('connect', () => {
    console.log('Connected to MQTT broker');

    // Publish retained online status
    client.publish(STATUS_TOPIC, onlinePayload, { retain: true, qos: 1 }, (err) => {
        if (err) {
            console.error('Failed to publish online status:', err);
        } else {
            console.log(`Published online status to ${STATUS_TOPIC}`);
        }
    });

    // Subscribe to both final and partial transcription topics
    client.subscribe('transcriber/out/+/+/final', { qos: 1 }, (err) => {
        if (err) console.error('Failed to subscribe to final topics:', err);
        else console.log('Subscribed to transcriber/out/+/+/final');
    });
    client.subscribe('transcriber/out/+/+/partial', { qos: 1 }, (err) => {
        if (err) console.error('Failed to subscribe to partial topics:', err);
        else console.log('Subscribed to transcriber/out/+/+/partial');
    });
});

client.on('error', (err) => {
    console.error('MQTT connection error:', err);
});

async function translateAndPublish(transcription, sessionId, channelId, action, targets) {
    for (const target of targets) {
        try {
            const translatedText = await provider.translate(
                transcription.text,
                transcription.lang,
                target.targetLang
            );

            const translationPayload = {
                segmentId: transcription.segmentId,
                astart: transcription.astart,
                text: translatedText,
                start: transcription.start,
                end: transcription.end,
                sourceLang: transcription.lang,
                targetLang: target.targetLang,
                locutor: transcription.locutor
            };

            client.publish(
                `transcriber/out/${sessionId}/${channelId}/${action}/translations`,
                JSON.stringify(translationPayload),
                { qos: 1 }
            );
        } catch (err) {
            console.error(`Translation error for ${target.targetLang}:`, err.message);
        }
    }
}

client.on('message', async (topic, message) => {
    try {
        const transcription = JSON.parse(message.toString());

        // Check if this message has externalTranslations for us
        if (!transcription.externalTranslations || !Array.isArray(transcription.externalTranslations)) {
            return;
        }

        const matchingTargets = transcription.externalTranslations.filter(
            entry => entry.translator === TRANSLATOR_NAME
        );

        if (matchingTargets.length === 0) return;
        if (!transcription.text || transcription.text.trim().length === 0) return;

        // Extract session and channel from topic
        const parts = topic.split('/');
        const sessionId = parts[2];
        const channelId = parts[3];
        const action = parts[4]; // 'final' or 'partial'

        if (action === 'final') {
            // Finals: translate immediately, also clear any pending partial debounce
            for (const target of matchingTargets) {
                const key = `${sessionId}/${channelId}/${target.targetLang}`;
                if (partialTimers.has(key)) {
                    clearTimeout(partialTimers.get(key));
                    partialTimers.delete(key);
                }
            }
            await translateAndPublish(transcription, sessionId, channelId, action, matchingTargets);
        } else if (action === 'partial') {
            // Partials: debounce per (session, channel, targetLang)
            for (const target of matchingTargets) {
                const key = `${sessionId}/${channelId}/${target.targetLang}`;
                if (partialTimers.has(key)) {
                    clearTimeout(partialTimers.get(key));
                }
                partialTimers.set(key, setTimeout(() => {
                    partialTimers.delete(key);
                    translateAndPublish(transcription, sessionId, channelId, action, [target]);
                }, PARTIAL_DEBOUNCE_MS));
            }
        }
    } catch (err) {
        console.error('Error processing message:', err.message);
    }
});

// Graceful shutdown helper
const shutdown = () => {
    console.log('Shutting down Translator...');
    // Clear all pending timers
    for (const timer of partialTimers.values()) clearTimeout(timer);
    partialTimers.clear();
    // Publish offline status before disconnecting
    client.publish(STATUS_TOPIC, offlinePayload, { retain: true, qos: 1 }, () => {
        client.end(false, () => {
            process.exit(0);
        });
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
