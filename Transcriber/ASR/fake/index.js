const EventEmitter = require('eventemitter3');

class FakeTranscriber extends EventEmitter {
    constructor(session, channel) {
        super();
    }

    start() {
        this.emit('ready');
    }

    transcribe(buffer) {}
    stop() {
        this.emit('closed');
    }
}

module.exports = FakeTranscriber;
