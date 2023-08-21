const docx = require("docx")
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Bookmark } = docx


function generateHeading(text, headingLevel = HeadingLevel.HEADING_1, alignement = AlignmentType.LEFT) {
    return new Paragraph({
        heading: headingLevel,
        alignment: alignement,
        children: [
            new Bookmark({
                children: [
                    new TextRun(text),
                ]
            })
        ]
    })
}

const docGenerator = (session, channel) => {
    const doc = new Document({
        creator: "Delivery",
        title: session.name,
        description: session.name,
        sections: []
    })

    const paragraphs = []

    paragraphs.push(new Paragraph({
        text: session.name,
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER
    }))
    paragraphs.push(new Paragraph({
        text: `${channel.name} (${channel.language})`,
        heading: HeadingLevel.HEADING_3,
        alignment: AlignmentType.CENTER
    }))

    paragraphs.push(generateHeading('Conversation'))

    channel.closed_captions.map(caption => {
        // TODO: It shouldn't be only in seconds
        // ex: 2min10s - 3min34s
        // same for hours
        const timestamp = `(${Math.trunc(caption.start)} s - ${Math.trunc(caption.end)}s) `

        paragraphs.push(
            new Paragraph({
                children: [
                    new TextRun({ text: timestamp, italics: true }),
                    new TextRun({ text: ` : ${caption.text}` })
                ],
            })
        )
        paragraphs.push(new Paragraph({}))
    })

    const section = {
        properties: {},
        children: paragraphs,
    }
    doc.addSection(section)

    return Packer.toBlob(doc)
}

module.exports = docGenerator