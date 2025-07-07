const liveSrtLib = require('live-srt-lib');
const realLogger  = liveSrtLib.logger;
const { getAppId }   = require('./appContext');

const origLog = realLogger.log.bind(realLogger);
realLogger.log = (level, msg, ...meta) =>
  origLog(level, `[${getAppId()}] ${msg}`, ...meta);

['info','warn','error','debug'].forEach((lvl) => {
  realLogger[lvl] = (msg, ...meta) =>
    origLog(lvl, `[${getAppId()}] ${msg}`, ...meta);
});

module.exports = realLogger;
