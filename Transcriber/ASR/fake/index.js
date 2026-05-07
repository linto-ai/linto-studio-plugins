/**
 * FakeTranscriber
 *
 * Dual-purpose class:
 *   (a) No-op ASR provider for dev/test environments without an Azure key
 *       (or any other backend). `start()` emits `ready`, `stop()` emits
 *       `closed`, `transcribe()` accepts buffers without producing anything.
 *   (b) Pilotable mock for unit tests: public counters
 *       (`startCount`, `stopCount`, `byteCount`, `transcribeCallCount`,
 *       `lastTranscribedBuffer`) let tests inspect provider usage, and
 *       `simulate*` methods trigger the expected events manually
 *       (`connecting`, `ready`, `transcribing`, `transcribed`, `error`,
 *       `closed`) to test pause/resume cycles and error flows without
 *       depending on a real backend.
 */
const EventEmitter = require('eventemitter3');

class FakeTranscriber extends EventEmitter {
    constructor(session, channel) {
        super();
        this.startedAt = null;

        // Public counters exposed for test inspection
        this.startCount = 0;
        this.stopCount = 0;
        this.byteCount = 0;
        this.transcribeCallCount = 0;
        this.lastTranscribedBuffer = null;
    }

    start() {
        this.startCount += 1;
        this.startedAt = new Date().toISOString();
        this.emit('ready');
    }

    transcribe(buffer) {
        this.transcribeCallCount += 1;
        if (buffer && typeof buffer.length === 'number') {
            this.byteCount += buffer.length;
        }
        this.lastTranscribedBuffer = buffer;
    }

    stop() {
        this.stopCount += 1;
        this.emit('closed');
    }

    // --- Test driving methods ----------------------------------------------

    simulateConnecting() {
        this.emit('connecting');
    }

    simulateReady() {
        this.emit('ready');
    }

    simulatePartial({ text, segmentId, astart }) {
        this.emit('transcribing', { text, segmentId, astart, locutor: 'test' });
    }

    simulateFinal({ text, segmentId, astart }) {
        this.emit('transcribed', { text, segmentId, astart, locutor: 'test' });
    }

    simulateError(error) {
        this.emit('error', error);
    }

    simulateClosed() {
        this.emit('closed');
    }
}

module.exports = FakeTranscriber;
