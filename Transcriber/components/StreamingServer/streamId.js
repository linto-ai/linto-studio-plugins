// Stream identification by the session's PRIVATE id.
//
// A stream used to be accepted as soon as "<sessionId>,<channelIndex>" named a
// known channel. The session id is public by design: it is the key of every
// Studio URL, it is returned by the public session API (even behind an alias)
// and it is listed to every member of the organization. Anyone watching a live
// session could therefore inject audio into it, or silence it by replacing the
// legitimate connection.
//
// Every session now carries a second UUID, `privateId`, that the API never
// returns except embedded in the channels' streamEndpoints:
//   SRT   streamid=<privateId>,<channelIndex>
//   RTMP  /<privateId>/<channelIndex>
//   WS    /<privateId>,<channelIndex>
// The Scheduler broadcasts `privateId` with the session in
// system/out/sessions/statuses, and the three streaming servers resolve the
// session by it. The public id is never accepted on a stream. Everything else
// (MQTT topics, events, DB rows) keeps using the public id.
const INDEX_RE = /^\d{1,4}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// "<privateId>,<channelIndex>" → { privateId, channelIndex } or null.
function parseStreamId(streamId) {
    if (typeof streamId !== 'string') return null;
    const parts = streamId.split(',');
    if (parts.length !== 2) return null;
    const [privateId, indexStr] = parts;
    if (!ID_RE.test(privateId) || !INDEX_RE.test(indexStr)) return null;
    return { privateId, channelIndex: parseInt(indexStr, 10) };
}

// The broadcast list is the only source of truth; a session without a
// privateId (not yet migrated) is not reachable by any stream.
function findSessionByPrivateId(sessions, privateId) {
    if (!privateId || !Array.isArray(sessions)) return undefined;
    return sessions.find(s => s && s.privateId && s.privateId === privateId);
}

module.exports = { parseStreamId, findSessionByPrivateId };
