const debug = require('debug')(`transcriber:BrokerClient:ASREvents`);

//here, "this" is bound to the BrokerClient component
module.exports = async function () {
    this.app.components['StreamingServer'].on('partial', (transcription, sessionId, channelIndex) => {
        this.client.publish('partial', {transcription, sessionId, channelIndex}); // Require online TRUE, we don't want to publish if we are offline
    });

    this.app.components['StreamingServer'].on('final', (transcription, sessionId, channelIndex) => {
        this.client.publish('final', {transcription, sessionId, channelIndex}); //require online FALSE, if we are offline, we want to publish anyway, packet will be queued by MQTT client and sent when we are online again, Packet ids are a 16bit number (max 65535) and must be unique for all inflight messages.
    });
}
