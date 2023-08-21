const debug = require('debug')('delivery:webserver')
const axios = require('axios')
const txtGenerator = require('./txt')
const docGenerator = require('./doc')
const { srtGenerator, vttGenerator } = require('./subtitle')



module.exports = (webserver) => {
    const fileGeneratorMapping = {
        'txt': txtGenerator,
        'doc': docGenerator,
        'srt': srtGenerator,
        'vtt': vttGenerator,
    }

    return [{
        path: '/:type',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            const type = req.params.type

            if (!Object.keys(fileGeneratorMapping).includes(type)) {
                debug(`No export possible for ${type} type`)
            }

            const sessionId = req.query.sessionId
            const transcriberId = req.query.transcriberId

            if (!sessionId || !transcriberId) {
                debug("sessionId or transcriberId empty")
            }

            debug(`Export ${type} file for sessionId: ${sessionId} transcriberId: ${transcriberId}`)

            const sessionApiUrl = `${process.env.SESSION_API_HOST}:${process.env.SESSION_API_WEBSERVER_HTTP_PORT}`
            const url = `${sessionApiUrl}/v1/sessions/${sessionId}`

            axios({
                method: 'GET',
                url: url,
            })
            .then(response => {
                return response.data
            })
            .then(session => {
                for (channel of session.channels) {
                    if (channel.transcriber_id == transcriberId) {
                        return [session, channel]
                    }
                }
            })
            .then(([session, channel]) => {
                debug(type)
                fileGeneratorMapping[type](session, channel).then(content => {
                    const filename = `${session.name} - ${channel.name} (${channel.language}).${type}`
                    res.set('Content-Disposition', `attachment; filename=${filename}`)
                    res.type(content.type)
                    content.arrayBuffer().then(buf => {
                        res.send(Buffer.from(buf))
                    })
                })
            })
            .catch(error => {
                debug(error)
            });
        }
    }]
}