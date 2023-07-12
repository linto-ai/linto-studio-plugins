const { Application } = require("live-srt-lib")
const debug = require('debug')('scheduler:main')
module.exports = new Application("SCHEDULER_COMPONENTS",__dirname)