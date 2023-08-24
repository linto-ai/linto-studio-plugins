const docx = require("docx")
const {
    Paragraph,
    TextRun,
    AlignmentType,
    PatchType,
    patchDocument,
    Table,
    TableCell,
    TableRow,
    WidthType,
    TableLayoutType,
} = docx
const fs = require('fs')
const path = require('path')
const { format, parseISO, addSeconds } = require('date-fns')
const { en } = require('date-fns/locale')


const docGenerator = (session, channel) => {
    const templatePath = path.join(__dirname, 'template-session-transcription.docx')
    return new Promise((resolve, reject) => {
        const parsedStartTime = parseISO(session.start_time)
        const formattedDate = format(parsedStartTime, 'dd MMMM yyyy HH:mm', { locale: en })
        const lines = []
        for (caption of channel.closed_captions) {
            const startDatetime = addSeconds(parseISO(caption.astart), caption.start)
            const languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(caption.lang)
            lines.push({
                datetime: format(startDatetime, 'HH:mm', { locale: en }),
                language: languageName,
                speaker: caption.locutor ?? '',
                text: caption.text,
            })
        }

        const rows = []
        for (const line of lines) {
            rows.push(new TableRow({
                children: [
                    new TableCell({
                        children: [
                            new Paragraph({
                                children: [
                                    new TextRun({
                                        text: line.datetime,
                                        size: 18,
                                    }),
                                    new TextRun({
                                        text: line.language,
                                        break: 1,
                                        size: 18
                                    }),
                                    new TextRun({
                                        text: line.speaker,
                                        break: 1,
                                        size: 18
                                    })
                                ],
                                alignment: AlignmentType.LEFT,
                            }),
                        ],
                    }),
                    new TableCell({
                        children: [
                            new Paragraph({
                                children: [
                                    new TextRun({
                                        text: line.text,
                                        size: 18
                                    })
                                ],
                                alignment: AlignmentType.LEFT,
                            }),
                        ],
                    })
                ]
            }))
        }

        patchDocument(fs.readFileSync(templatePath), {
            patches: {
                session_name: {
                    type: PatchType.PARAGRAPH,
                    children: [
                        new TextRun(session.name),
                        new TextRun(' - '),
                        new TextRun(channel.name),
                        new TextRun(` (${channel.languages.join()})`)
                    ],
                },
                datetime: {
                    type: PatchType.PARAGRAPH,
                    children: [
                        new TextRun({
                            text: formattedDate,
                            bold: true,
                        }),
                    ],
                },
                transcriptions: {
                    type: PatchType.DOCUMENT,
                    children: [
                        new Table({
                            rows: rows,
                            width: {
                                size: 100,
                                type: WidthType.PERCENTAGE
                            },
                            layout: TableLayoutType.FIXED,
                            columnWidths: [33, 66],
                            alignment: AlignmentType.LEFT,
                        })
                    ],
                }
            },
        }).then(doc => {
            resolve(new Blob([doc], {type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}))
        })
    })
}

module.exports = docGenerator