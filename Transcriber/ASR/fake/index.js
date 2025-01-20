const EventEmitter = require('eventemitter3');

class FakeTranscriber extends EventEmitter {
    constructor(channel) {
        super();
    }

    start() {
        this.emit('ready');
    }

    transcribe(buffer) {}
    stop() {}
}

module.exports = FakeTranscriber;
