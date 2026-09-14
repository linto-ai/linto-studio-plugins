// Strict parser for the RTMP publish path handed to us by node-media-server.
//
// node-media-server builds `streamPath = "/" + app + "/" + streamName` and only
// strips a trailing `?query`: spaces, `!` and any other character the publisher
// puts in the stream name go through verbatim. The path was then interpolated
// into a gst_parse_launch() string (`rtmpsrc location=rtmp://127.0.0.1:1935<path> ! …`),
// so a publisher owning a valid session id could append ` ! filesrc … ! filesink …`
// and instantiate arbitrary GStreamer elements inside the transcriber pod.
//
// The only shape we ever accept is `/<sessionId>/<channelIndex>`; anything else
// is rejected before validation, and the worker is always given the canonical
// path rebuilt from the parsed parts — never the raw publisher-controlled string.
const STREAM_PATH_RE = /^\/([A-Za-z0-9-]{1,64})\/(\d{1,4})$/;

function parseRtmpStreamPath(streamPath) {
    if (typeof streamPath !== 'string') return null;
    const match = STREAM_PATH_RE.exec(streamPath);
    if (!match) return null;
    const sessionId = match[1];
    const channelIndex = parseInt(match[2], 10);
    return { sessionId, channelIndex, safePath: `/${sessionId}/${channelIndex}` };
}

module.exports = { parseRtmpStreamPath, STREAM_PATH_RE };
