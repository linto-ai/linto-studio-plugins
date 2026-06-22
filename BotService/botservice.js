const { Application } = require('live-srt-lib')

// Autonomous meeting-bot service. Components are loaded from BOTSERVICE_COMPONENTS
// (see .envdefault). The single BrokerClient component owns the shared BrowserPool,
// LocalAudioServer and the MQTT contract with the Scheduler.
const app = new Application('BOTSERVICE_COMPONENTS', __dirname)

module.exports = app
