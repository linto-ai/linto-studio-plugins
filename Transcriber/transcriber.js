const { Application } = require("live-srt-lib")
const debug = require('debug')('transcriber:main')
app = new Application("TRANSCRIBER_COMPONENTS",__dirname)
module.exports = app

