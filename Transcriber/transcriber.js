const { Application } = require("live-srt-lib")
const debug = require('debug')('transcriber:main')
module.exports = new Application("TRANSCRIBER_COMPONENTS",__dirname)