const debug = require('debug')(`transcriber:BrokerClient:ASREvents`);

//here, "this" is bound to the BrokerClient component
module.exports = async function () {
    this.app.components['ASR'].on('partial', (transcription) => {
        this.client.publish('partial', transcription); // Require online TRUE, we don't want to publish if we are offline
    });

    this.app.components['ASR'].on('final', (transcription) => {
        this.client.publish('final', transcription); //require online FALSE, if we are offline, we want to publish anyway, packet will be queued by MQTT client and sent when we are online again, Packet ids are a 16bit number (max 65535) and must be unique for all inflight messages.
    });

    // When the streaming server is reconfigured
    this.app.components['ASR'].on('reconfigure', () => {
        const stream_endpoint = this.app.components['StreamingServer'].streamURI;
        this.app.components['BrokerClient'].client.registerDomainSpecificValues({ stream_endpoint })
        this.app.components['BrokerClient'].client.publishStatus();
      })
}