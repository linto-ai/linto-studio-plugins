const assert = require('assert');
const { describe, it, afterEach } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// A caption or translation that arrives after its session was deleted (the
// channel cascades with it) violates the captions -> channels foreign key.
// That is logged as what it is, with the session and channel ids, not as a
// bare constraint error; any other failure keeps the generic error log.

// What Sequelize throws for a Postgres foreign-key violation (code 23503).
function fkError(table) {
    const err = new Error(`insert or update on table "${table}" violates foreign key constraint "${table}_channelId_fkey"`);
    err.name = 'SequelizeForeignKeyConstraintError';
    return err;
}

async function loadFailing(err) {
    const model = buildModel({
        Caption: { create: async () => { throw err; } },
        TranslatedCaption: { create: async () => { throw err; } },
    });
    return loadBrokerClient({ model });
}

describe('Saving a caption for a channel that no longer exists', () => {
    afterEach(() => uninstallMocks());

    it('warns with the session, channel and segment of a dropped final caption', async () => {
        const { instance, logs } = await loadFailing(fkError('captions'));
        await instance.saveTranscription({ segmentId: 7, text: 'last words' }, 'sess-1', '313');
        assert.deepStrictEqual(logs.map((l) => l.level), ['warn'], JSON.stringify(logs));
        assert.strictEqual(logs[0].msg,
            '[TRANSCRIPTION_SAVE_ERROR]: final caption (segment 7) dropped: channel 313 of session sess-1 no longer exists (session deleted before the caption could be stored)');
    });

    it('names the end-of-stream marker (no segmentId) as such', async () => {
        const { instance, logs } = await loadFailing(fkError('captions'));
        await instance.saveTranscription({ text: '', locutor: 'bot', aend: 'x' }, 'sess-1', '313');
        assert.deepStrictEqual(logs.map((l) => l.level), ['warn']);
        assert.ok(logs[0].msg.includes('end-of-stream marker dropped: channel 313 of session sess-1 no longer exists'), logs[0].msg);
    });

    it('warns with the session, channel, segment and language of a dropped translation', async () => {
        const { instance, logs } = await loadFailing(fkError('translated_captions'));
        await instance.saveTranslation({ segmentId: 7, targetLang: 'en', text: 'last words' }, 'sess-1', '313');
        assert.deepStrictEqual(logs.map((l) => l.level), ['warn']);
        assert.strictEqual(logs[0].msg,
            '[TRANSLATION_SAVE_ERROR]: en translation of segment 7 dropped: channel 313 of session sess-1 no longer exists (session deleted before the translation could be stored)');
    });

    it('keeps the generic error log for any other failure', async () => {
        const { instance, logs } = await loadFailing(new Error('connection lost'));
        await instance.saveTranscription({ segmentId: 7, text: 'last words' }, 'sess-1', '313');
        await instance.saveTranslation({ segmentId: 7, targetLang: 'en', text: 'x' }, 'sess-1', '313');
        assert.deepStrictEqual(logs.map((l) => l.level), ['error', 'error']);
        assert.ok(logs[0].msg.startsWith('[TRANSCRIPTION_SAVE_ERROR]: connection lost'), logs[0].msg);
        assert.ok(logs[1].msg.startsWith('[TRANSLATION_SAVE_ERROR]: connection lost'), logs[1].msg);
    });
});
