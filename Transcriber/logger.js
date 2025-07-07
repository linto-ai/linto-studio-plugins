const liveSrtLib = require('live-srt-lib');
const realLogger  = liveSrtLib.logger;
const { getAppId } = require('./appContext');

const origLog = realLogger.log.bind(realLogger);

function wrapLog(level, msg, ...meta) {
  // detect optional channelId/sessionId in metadata
  let channelId, sessionId, restMeta;
  if (meta[0] && typeof meta[0] === 'object'
      && ('channelId' in meta[0] || 'sessionId' in meta[0])) {
    ({ channelId, sessionId, ...restMeta } = meta[0]);
    restMeta = [restMeta, ...meta.slice(1)];
  } else {
    restMeta = meta;
  }
  // build prefix [appId | channelId | sessionId] with only defined parts
  const parts = [getAppId()];
  if (channelId) parts.push(channelId);
  if (sessionId) parts.push(sessionId);
  const prefix = `[${parts.join(' | ')}]`;

  // call original logger
  origLog(level, `${prefix} ${msg}`, ...restMeta);
}

// override .log()
realLogger.log = (level, msg, ...meta) => {
  wrapLog(level, msg, ...meta);
};

// override shortcuts (.info, .warn, etc.)
['info','warn','error','debug'].forEach((lvl) => {
  realLogger[lvl] = (msg, ...meta) => {
    wrapLog(lvl, msg, ...meta);
  };
});

/**
 * Returns a child logger that automatically injects sessionId & channelId into metadata.
 * @param {string} sessionId - Identifier for the session.
 * @param {string} channelId - Identifier for the channel.
 * @returns {{info: function, warn: function, error: function, debug: function, log: function}}
 */
function getChannelLogger(sessionId, channelId) {
  const ctx = {};
  ['info', 'warn', 'error', 'debug'].forEach(level => {
    ctx[level] = (msg, meta = {}, ...rest) =>
      realLogger[level](msg, { ...meta, sessionId, channelId }, ...rest);
  });
  ctx.log = (level, msg, meta = {}, ...rest) =>
    realLogger.log(level, msg, { ...meta, sessionId, channelId }, ...rest);
  return ctx;
}

realLogger.getChannelLogger = getChannelLogger;

module.exports = realLogger;
