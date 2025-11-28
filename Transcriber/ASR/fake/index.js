const EventEmitter = require('eventemitter3');

class FakeTranscriber extends EventEmitter {
    constructor(session, channel) {
        super();
        this.startedAt = null;
    }

    start() {
        this.startedAt = new Date().toISOString();
        this.emit('ready');
    }

    transcribe(buffer) {}

    stop() {
        this.emit('closed');
    }
}

module.exports = FakeTranscriber;
