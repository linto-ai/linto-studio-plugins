const { Application } = require("live-srt-lib")
const debug = require('debug')('delivery:main')
module.exports = new Application("DELIVERY_COMPONENTS",__dirname)