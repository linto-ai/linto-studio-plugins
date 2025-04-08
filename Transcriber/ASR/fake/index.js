const EventEmitter = require('eventemitter3');

class FakeTranscriber extends EventEmitter {
    constructor(channel) {
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
