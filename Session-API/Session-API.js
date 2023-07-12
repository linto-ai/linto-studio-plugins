const { Application } = require("live-srt-lib")
const debug = require('debug')('sesion-api:main')
module.exports = new Application("SESSION_API_COMPONENTS",__dirname)