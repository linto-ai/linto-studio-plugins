const assert = require('assert');

// Protocol adapters are pure logic, no external deps needed
const BaseProtocol = require('../ASR/openai_streaming/protocols/base');
const VllmProtocol = require('../ASR/openai_streaming/protocols/vllm');
const OpenAIProtocol = require('../ASR/openai_streaming/protocols/openai');
const { loadProtocol } = require('../ASR/openai_streaming/protocols/index');

// Minimal logger stub
const stubLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('Protocol Adapters', function () {

    // -----------------------------------------------------------------------
    // BaseProtocol
    // -----------------------------------------------------------------------
    describe('BaseProtocol', function () {
        it('should store config and logger in constructor', function () {
            const config = { endpoint: 'ws://localhost' };
            const proto = new BaseProtocol(config, stubLogger);
            assert.strictEqual(proto.config, config);
            assert.strictEqual(proto.logger, stubLogger);
        });

        it('should throw on unimplemented getWebSocketUrl()', function () {
            const proto = new BaseProtocol({}, stubLogger);
            assert.throws(() => proto.getWebSocketUrl('ws://x'), /must be implemented/);
        });

        it('should throw on unimplemented getConnectionOptions()', function () {
            const proto = new BaseProtocol({}, stubLogger);
            assert.throws(() => proto.getConnectionOptions(), /must be implemented/);
        });

        it('should throw on unimplemented buildSessionUpdate()', function () {
            const proto = new BaseProtocol({}, stubLogger);
            assert.throws(() => proto.buildSessionUpdate('model'), /must be implemented/);
        });

        it('should throw on unimplemented buildAudioAppend()', function () {
            const proto = new BaseProtocol({}, stubLogger);
            assert.throws(() => proto.buildAudioAppend('base64'), /must be implemented/);
        });

        it('should throw on unimplemented buildCommit()', function () {
            const proto = new BaseProtocol({}, stubLogger);
            assert.throws(() => proto.buildCommit(true), /must be implemented/);
        });

        it('should throw on unimplemented parseServerEvent()', function () {
            const proto = new BaseProtocol({}, stubLogger);
            assert.throws(() => proto.parseServerEvent({}), /must be implemented/);
        });
    });

    // -----------------------------------------------------------------------
    // VllmProtocol
    // -----------------------------------------------------------------------
    describe('VllmProtocol', function () {
        describe('getWebSocketUrl()', function () {
            it('should append /v1/realtime to endpoint', function () {
                const proto = new VllmProtocol({}, stubLogger);
                assert.strictEqual(
                    proto.getWebSocketUrl('ws://localhost:8000'),
                    'ws://localhost:8000/v1/realtime'
                );
            });

            it('should strip trailing slash before appending path', function () {
                const proto = new VllmProtocol({}, stubLogger);
                assert.strictEqual(
                    proto.getWebSocketUrl('ws://localhost:8000/'),
                    'ws://localhost:8000/v1/realtime'
                );
            });

            it('should strip multiple trailing slashes', function () {
                const proto = new VllmProtocol({}, stubLogger);
                assert.strictEqual(
                    proto.getWebSocketUrl('ws://localhost:8000///'),
                    'ws://localhost:8000/v1/realtime'
                );
            });
        });

        describe('getConnectionOptions()', function () {
            it('should return empty object when no apiKey', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const opts = proto.getConnectionOptions();
                assert.deepStrictEqual(opts, {});
            });

            it('should return Authorization header when apiKey is set', function () {
                const proto = new VllmProtocol({ apiKey: 'test-key-123' }, stubLogger);
                const opts = proto.getConnectionOptions();
                assert.deepStrictEqual(opts, {
                    headers: { 'Authorization': 'Bearer test-key-123' }
                });
            });
        });

        describe('buildSessionUpdate()', function () {
            it('should build flat session.update message', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const msg = proto.buildSessionUpdate('my-model');
                assert.deepStrictEqual(msg, {
                    type: 'session.update',
                    model: 'my-model'
                });
            });
        });

        describe('buildAudioAppend()', function () {
            it('should build audio append message with base64 data', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const msg = proto.buildAudioAppend('AQID');
                assert.deepStrictEqual(msg, {
                    type: 'input_audio_buffer.append',
                    audio: 'AQID'
                });
            });
        });

        describe('buildCommit()', function () {
            it('should include final:false for non-final commit', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const msg = proto.buildCommit(false);
                assert.deepStrictEqual(msg, {
                    type: 'input_audio_buffer.commit',
                    final: false
                });
            });

            it('should include final:true for final commit', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const msg = proto.buildCommit(true);
                assert.deepStrictEqual(msg, {
                    type: 'input_audio_buffer.commit',
                    final: true
                });
            });
        });

        describe('parseServerEvent()', function () {
            it('should parse session.created event', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'session.created',
                    id: 'sess-abc123',
                    created: 1700000000
                });
                assert.deepStrictEqual(result, {
                    type: 'session_created',
                    data: { sessionId: 'sess-abc123' }
                });
            });

            it('should parse transcription.delta event', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'transcription.delta',
                    delta: 'Hello'
                });
                assert.deepStrictEqual(result, {
                    type: 'partial',
                    data: { text: 'Hello' }
                });
            });

            it('should parse transcription.delta with empty string (silence)', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'transcription.delta',
                    delta: ''
                });
                assert.deepStrictEqual(result, {
                    type: 'partial',
                    data: { text: '' }
                });
            });

            it('should parse error event', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'error',
                    error: 'Model not found',
                    code: 'MODEL_NOT_FOUND'
                });
                assert.deepStrictEqual(result, {
                    type: 'error',
                    data: { message: 'Model not found', code: 'MODEL_NOT_FOUND' }
                });
            });

            it('should handle error event without code', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'error',
                    error: 'Unknown error'
                });
                assert.deepStrictEqual(result, {
                    type: 'error',
                    data: { message: 'Unknown error', code: null }
                });
            });

            it('should return null for unknown event types', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({ type: 'unknown.event' });
                assert.strictEqual(result, null);
            });

            it('should NOT parse transcription.done (vLLM does not send it)', function () {
                const proto = new VllmProtocol({}, stubLogger);
                const result = proto.parseServerEvent({ type: 'transcription.done' });
                assert.strictEqual(result, null);
            });
        });
    });

    // -----------------------------------------------------------------------
    // OpenAIProtocol
    // -----------------------------------------------------------------------
    describe('OpenAIProtocol', function () {
        describe('getWebSocketUrl()', function () {
            it('should append /v1/realtime?intent=transcription', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                assert.strictEqual(
                    proto.getWebSocketUrl('wss://api.openai.com'),
                    'wss://api.openai.com/v1/realtime?intent=transcription'
                );
            });

            it('should strip trailing slash before appending', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                assert.strictEqual(
                    proto.getWebSocketUrl('wss://api.openai.com/'),
                    'wss://api.openai.com/v1/realtime?intent=transcription'
                );
            });
        });

        describe('getConnectionOptions()', function () {
            it('should include Authorization and OpenAI-Beta headers', function () {
                const proto = new OpenAIProtocol({ apiKey: 'sk-test' }, stubLogger);
                const opts = proto.getConnectionOptions();
                assert.deepStrictEqual(opts, {
                    headers: {
                        'Authorization': 'Bearer sk-test',
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });
            });

            it('should include undefined apiKey in header when not set', function () {
                // OpenAI protocol always sends headers (apiKey is required for OpenAI)
                const proto = new OpenAIProtocol({}, stubLogger);
                const opts = proto.getConnectionOptions();
                assert.strictEqual(opts.headers['OpenAI-Beta'], 'realtime=v1');
                assert.strictEqual(opts.headers['Authorization'], 'Bearer undefined');
            });
        });

        describe('buildSessionUpdate()', function () {
            it('should build deeply nested transcription_session.update', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const msg = proto.buildSessionUpdate('gpt-4o-transcribe');
                assert.deepStrictEqual(msg, {
                    type: 'transcription_session.update',
                    session: {
                        input_audio_transcription: { model: 'gpt-4o-transcribe' },
                        input_audio_format: 'pcm16'
                    }
                });
            });
        });

        describe('buildAudioAppend()', function () {
            it('should build audio append message', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const msg = proto.buildAudioAppend('base64data');
                assert.deepStrictEqual(msg, {
                    type: 'input_audio_buffer.append',
                    audio: 'base64data'
                });
            });
        });

        describe('buildCommit()', function () {
            it('should build commit without final field (per OpenAI spec)', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const msg = proto.buildCommit();
                assert.deepStrictEqual(msg, {
                    type: 'input_audio_buffer.commit'
                });
                // Verify no 'final' field per spec
                assert.strictEqual(msg.final, undefined);
            });

            it('should ignore isFinal parameter', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const msg = proto.buildCommit(true);
                assert.deepStrictEqual(msg, {
                    type: 'input_audio_buffer.commit'
                });
                assert.strictEqual(msg.final, undefined);
            });
        });

        describe('parseServerEvent()', function () {
            it('should parse transcription_session.created', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'transcription_session.created',
                    event_id: 'evt-123',
                    session: { id: 'sess-456' }
                });
                assert.strictEqual(result.type, 'session_created');
                assert.strictEqual(result.data.sessionId, 'sess-456');
            });

            it('should fall back to event_id if session.id is missing', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'transcription_session.created',
                    event_id: 'evt-789'
                });
                assert.strictEqual(result.data.sessionId, 'evt-789');
            });

            it('should parse partial transcription delta', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'conversation.item.input_audio_transcription.delta',
                    event_id: 'evt-1',
                    item_id: 'item-1',
                    content_index: 0,
                    delta: 'Bonjour'
                });
                assert.deepStrictEqual(result, {
                    type: 'partial',
                    data: { text: 'Bonjour' }
                });
            });

            it('should parse completed transcription', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'conversation.item.input_audio_transcription.completed',
                    event_id: 'evt-2',
                    item_id: 'item-1',
                    content_index: 0,
                    transcript: 'Bonjour le monde.',
                    usage: { tokens: 42 }
                });
                assert.deepStrictEqual(result, {
                    type: 'final',
                    data: { text: 'Bonjour le monde.', usage: { tokens: 42 } }
                });
            });

            it('should use transcript field (not text) for completed events', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'conversation.item.input_audio_transcription.completed',
                    transcript: 'Hello world.',
                    text: 'WRONG FIELD'
                });
                assert.strictEqual(result.data.text, 'Hello world.');
            });

            it('should handle completed event without usage', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'conversation.item.input_audio_transcription.completed',
                    transcript: 'Hello.'
                });
                assert.strictEqual(result.data.usage, null);
            });

            it('should parse transcription failed event', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'conversation.item.input_audio_transcription.failed',
                    error: { message: 'Audio too noisy', code: 'AUDIO_ERROR' }
                });
                assert.deepStrictEqual(result, {
                    type: 'error',
                    data: { message: 'Audio too noisy', code: 'AUDIO_ERROR' }
                });
            });

            it('should handle failed event without error details', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'conversation.item.input_audio_transcription.failed'
                });
                assert.deepStrictEqual(result, {
                    type: 'error',
                    data: { message: 'Transcription failed', code: null }
                });
            });

            it('should return null for VAD speech_started event', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'input_audio_buffer.speech_started'
                });
                assert.strictEqual(result, null);
            });

            it('should return null for VAD speech_stopped event', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({
                    type: 'input_audio_buffer.speech_stopped'
                });
                assert.strictEqual(result, null);
            });

            it('should return null for unknown event types', function () {
                const proto = new OpenAIProtocol({}, stubLogger);
                const result = proto.parseServerEvent({ type: 'some.unknown.event' });
                assert.strictEqual(result, null);
            });
        });
    });

    // -----------------------------------------------------------------------
    // Protocol Factory (loadProtocol)
    // -----------------------------------------------------------------------
    describe('loadProtocol()', function () {
        it('should load VllmProtocol for "vllm"', function () {
            const Proto = loadProtocol('vllm');
            assert.strictEqual(Proto, VllmProtocol);
        });

        it('should load OpenAIProtocol for "openai"', function () {
            const Proto = loadProtocol('openai');
            assert.strictEqual(Proto, OpenAIProtocol);
        });

        it('should throw for unknown protocol name', function () {
            assert.throws(
                () => loadProtocol('unknown'),
                /Unknown protocol: "unknown"/
            );
        });

        it('should throw for empty string', function () {
            assert.throws(
                () => loadProtocol(''),
                /Unknown protocol/
            );
        });

        it('should throw for null/undefined', function () {
            assert.throws(() => loadProtocol(null), /Unknown protocol/);
            assert.throws(() => loadProtocol(undefined), /Unknown protocol/);
        });

        it('should be case-sensitive (reject "VLLM")', function () {
            assert.throws(
                () => loadProtocol('VLLM'),
                /Unknown protocol: "VLLM"/
            );
        });

        it('loaded classes should be subclasses of BaseProtocol', function () {
            const VProto = loadProtocol('vllm');
            const OProto = loadProtocol('openai');
            const vInstance = new VProto({}, stubLogger);
            const oInstance = new OProto({}, stubLogger);
            assert.ok(vInstance instanceof BaseProtocol);
            assert.ok(oInstance instanceof BaseProtocol);
        });
    });

    // -----------------------------------------------------------------------
    // Cross-protocol consistency checks
    // -----------------------------------------------------------------------
    describe('Cross-protocol consistency', function () {
        it('both protocols should produce audio append with same structure', function () {
            const vllm = new VllmProtocol({}, stubLogger);
            const openai = new OpenAIProtocol({}, stubLogger);
            const vMsg = vllm.buildAudioAppend('abc123');
            const oMsg = openai.buildAudioAppend('abc123');
            assert.strictEqual(vMsg.type, oMsg.type);
            assert.strictEqual(vMsg.audio, oMsg.audio);
        });

        it('vLLM commit should have final field, OpenAI commit should not', function () {
            const vllm = new VllmProtocol({}, stubLogger);
            const openai = new OpenAIProtocol({}, stubLogger);
            const vMsg = vllm.buildCommit(true);
            const oMsg = openai.buildCommit(true);
            assert.strictEqual(vMsg.final, true);
            assert.strictEqual(oMsg.final, undefined);
        });

        it('session update types should differ between protocols', function () {
            const vllm = new VllmProtocol({}, stubLogger);
            const openai = new OpenAIProtocol({}, stubLogger);
            const vMsg = vllm.buildSessionUpdate('model');
            const oMsg = openai.buildSessionUpdate('model');
            assert.strictEqual(vMsg.type, 'session.update');
            assert.strictEqual(oMsg.type, 'transcription_session.update');
        });

        it('vLLM session update should be flat, OpenAI should be nested', function () {
            const vllm = new VllmProtocol({}, stubLogger);
            const openai = new OpenAIProtocol({}, stubLogger);
            const vMsg = vllm.buildSessionUpdate('test-model');
            const oMsg = openai.buildSessionUpdate('test-model');
            // vLLM: model at root level
            assert.strictEqual(vMsg.model, 'test-model');
            assert.strictEqual(vMsg.session, undefined);
            // OpenAI: model nested under session.input_audio_transcription
            assert.strictEqual(oMsg.model, undefined);
            assert.strictEqual(oMsg.session.input_audio_transcription.model, 'test-model');
        });
    });
});
