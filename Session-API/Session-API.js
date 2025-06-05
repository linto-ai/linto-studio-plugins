const { Application } = require("live-srt-lib")
const { encrypt_keys } = require("./encrypt_transcriber_profile.js")
module.exports = new Application("SESSION_API_COMPONENTS",__dirname)

encrypt_keys();
