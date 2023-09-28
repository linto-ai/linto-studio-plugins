const { format, parseISO, addSeconds } = require('date-fns')


const txtGenerator = (session, channel) => {
    return new Promise((resolve, reject) => {
        let content = `${session.name} - ${channel.name} (${channel.languages.join('_')})\n\n`
        content += channel.closed_captions.map(
            caption => {
                const startDatetime = format(addSeconds(parseISO(caption.astart), caption.start), 'HH:mm:ss')
                return `${startDatetime}: ${caption.text}`
            }
        ).join('\n')
        resolve(new Blob([content], { type: 'text/plain' }))
    })
}

module.exports = txtGenerator
