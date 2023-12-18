# Delivery

The Delivery component connects the system to the front end.
From the system's perspective, it communicates via message brokers.
From the front-end perspective, it communicates through a REST API exposed (only for exports) and via websockets managed by Socket.io for the transmission of transcriptions.

## Transcription streaming

To explain the functioning of Delivery, the simplest way is to detail step by step the process of receiving transcriptions in the front end.

- The front end creates a websocket connection with Delivery.
- The front end subscribes to an active session to receive transcriptions.
- When subscribing to a session, Delivery itself subscribes to receive the transcriptions of that session via the broker.
- When a transcription arrives at Delivery, it is sent back to the Front end via websocket.
- When the front end unsubscribes from the session, Delivery unsubscribes from the broker for that session.


## Export

Finally, Delivery is also responsible for exporting the transcriptions of a session. To do this, when its REST API is called, it retrieves the transcriptions from the Session-API and then generates the export in the requested format (TXT, DOC, SRT, VTT).

For the creation of subtitles, as we don't have timecodes for each word, a fairly simple algorithm is used to split the transcriptions into subtitles. The function that performs this segmentation is called splitSubtitles. During our tests, the results were satisfactory.
