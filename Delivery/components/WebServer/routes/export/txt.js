const txtGenerator = (session, channel) => {
    return new Promise((resolve, reject) => {
        let content = `${session.name} - ${channel.name} (${channel.language})\n\n`
        content += channel.closed_captions.map(caption => `${caption.start} - ${caption.end}: ${caption.text}`).join('\n')
        resolve(new Blob([content], { type: 'text/plain' }))
    })
}

module.exports = txtGenerator