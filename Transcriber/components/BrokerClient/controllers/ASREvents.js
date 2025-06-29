//here, "this" is bound to the BrokerClient component
module.exports = async function () {
    this.app.components['StreamingServer'].on('partial', (transcription, sessionId, channelId) => {
        this.client.publish(`transcriber/out/${sessionId}/${channelId}/partial`, transcription); // Require online TRUE, we don't want to publish if we are offline
    });

    this.app.components['StreamingServer'].on('final', (transcription, sessionId, channelId) => {
        this.client.publish(`transcriber/out/${sessionId}/${channelId}/final`, transcription); //require online FALSE, if we are offline, we want to publish anyway, packet will be queued by MQTT client and sent when we are online again, Packet ids are a 16bit number (max 65535) and must be unique for all inflight messages.
    });
}
