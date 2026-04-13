const { Sequelize, DataTypes, Op } = require('sequelize');
require("../config.js")

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    logging: false,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres'
});

const TranscriberProfile = sequelize.define('transcriberProfile', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    config: {
        type: DataTypes.JSON,
        allowNull: true
    },
    organizationId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    quickMeeting: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    meta: {
        type: DataTypes.JSON,
        allowNull: true
    }
});

const Session = sequelize.define('session', {
    id: {
        type: DataTypes.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
    },
    status: {
        type: DataTypes.ENUM('on_schedule', 'ready', 'active', 'terminated'),
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    startTime: {
        type: DataTypes.DATE,
        allowNull: true
    },
    endTime: {
        type: DataTypes.DATE,
        allowNull: true
    },
    scheduleOn: {
        type: DataTypes.DATE,
        allowNull: true
    },
    endOn: {
        type: DataTypes.DATE,
        allowNull: true
    },
    erroredOn: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        allowNull: true
    },
    owner: {
        type: DataTypes.STRING,
        allowNull: true
    },
    organizationId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    visibility: {
        type: DataTypes.ENUM('public', 'organization', 'private', 'user'),
        allowNull: false
    },
    autoStart: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    autoEnd: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    meta: {
        type: DataTypes.JSON,
        allowNull: true
    },
});

const Channel = sequelize.define('channel', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    keepAudio: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: true
    },
    diarization: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    compressAudio: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: true
    },
    enableLiveTranscripts: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    languages: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true
    },
    translations: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    translatedCaptions: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    streamEndpoints: {
        type: DataTypes.JSON,
        allowNull: true
    },
    streamStatus: {
        type: DataTypes.ENUM('active', 'inactive', 'errored'),
        defaultValue: 'inactive',
        allowNull: true
    },
    transcriberId: {
        type: DataTypes.UUID,
        allowNull: true,
        defaultValue: null
    },
    lastSegmentId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    closedCaptions: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    audioFile: {
        type: DataTypes.STRING,
        defaultValue: "",
        allowNull: true
    },
    meta: {
        type: DataTypes.JSON,
        allowNull: true
    },
});

const Caption = sequelize.define('caption', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    channelId: { type: DataTypes.INTEGER, allowNull: false },
    segmentId: { type: DataTypes.INTEGER, allowNull: true },
    start: { type: DataTypes.DECIMAL, allowNull: true },
    end: { type: DataTypes.DECIMAL, allowNull: true },
    text: { type: DataTypes.TEXT, allowNull: true },
    astart: { type: DataTypes.DATE, allowNull: true },
    aend: { type: DataTypes.DATE, allowNull: true },
    lang: { type: DataTypes.STRING(20), allowNull: true },
    locutor: { type: DataTypes.STRING(100), allowNull: true },
}, { updatedAt: false });

const TranslatedCaption = sequelize.define('translated_caption', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    channelId: { type: DataTypes.INTEGER, allowNull: false },
    segmentId: { type: DataTypes.INTEGER, allowNull: false },
    targetLang: { type: DataTypes.STRING(20), allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: true },
}, { updatedAt: false });

Channel.hasMany(Caption, { onDelete: 'CASCADE', foreignKey: 'channelId' });
Caption.belongsTo(Channel, { foreignKey: 'channelId' });
Channel.hasMany(TranslatedCaption, { onDelete: 'CASCADE', foreignKey: 'channelId' });
TranslatedCaption.belongsTo(Channel, { foreignKey: 'channelId' });

function formatCaption(c) {
    return {
        segmentId: c.segmentId,
        start: c.start !== null ? parseFloat(c.start) : null,
        end: c.end !== null ? parseFloat(c.end) : null,
        text: c.text,
        astart: c.astart,
        aend: c.aend,
        lang: c.lang,
        locutor: c.locutor,
    };
}

function groupTranslatedCaptions(translations) {
    const result = {};
    for (const t of translations) {
        const key = String(t.segmentId);
        if (!result[key]) result[key] = [];
        result[key].push({
            segmentId: t.segmentId,
            targetLang: t.targetLang,
            text: t.text,
        });
    }
    return result;
}

// Reverse pagination: offset=0 returns the latest turns,
// offset=50 returns the 50 before that, etc.
// Within a page, turns remain in chronological order (ASC).
Channel.getPaginatedCaptions = async function(channelId, { limit = 50, offset = 0 } = {}) {
    // Total counts
    const totalClosedCaptions = await Caption.count({ where: { channelId } });

    const [tcCount] = await sequelize.query(
        `SELECT COUNT(DISTINCT "segmentId") AS count FROM translated_captions WHERE "channelId" = :channelId`,
        { replacements: { channelId }, type: Sequelize.QueryTypes.SELECT }
    );
    const totalTranslatedCaptions = parseInt(tcCount.count, 10) || 0;

    // Reverse pagination: get latest captions first, then reverse for chronological order
    const captions = await Caption.findAll({
        where: { channelId },
        order: [['id', 'DESC']],
        limit,
        offset,
        raw: true,
    });
    captions.reverse(); // chronological order within page

    const closedCaptions = captions.map(formatCaption);

    // Get translated captions for the segmentIds in this page
    const segmentIds = [...new Set(captions.map(c => c.segmentId).filter(id => id != null))];
    let translatedCaptions = {};
    if (segmentIds.length > 0) {
        const translations = await TranslatedCaption.findAll({
            where: { channelId, segmentId: segmentIds },
            raw: true,
        });
        translatedCaptions = groupTranslatedCaptions(translations);
    }

    return { totalClosedCaptions, totalTranslatedCaptions, closedCaptions, translatedCaptions };
};

TranscriberProfile.hasMany(Channel, { onDelete: 'SET NULL', foreignKey: 'transcriberProfileId' });
Channel.belongsTo(TranscriberProfile, { onDelete: 'SET NULL', foreignKey: 'transcriberProfileId' });

Session.hasMany(Channel, { onDelete: 'SET NULL', foreignKey: 'sessionId' });
Channel.belongsTo(Session, { onDelete: 'SET NULL', foreignKey: 'sessionId' });

// TEMPLATES
const SessionTemplate = sequelize.define('sessionTemplate', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    owner: {
        type: DataTypes.STRING,
        allowNull: true
    },
    organizationId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    visibility: {
        type: DataTypes.ENUM('public', 'organization', 'private'),
        allowNull: false
    },
    autoStart: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    autoEnd: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    meta: {
        type: DataTypes.JSON,
        allowNull: true
    },
});

const ChannelTemplate = sequelize.define('channelTemplate', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    keepAudio: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    diarization: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: false
    },
    compressAudio: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: true
    },
    enableLiveTranscripts: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
    },
    languages: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true
    },
    translations: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    meta: {
        type: DataTypes.JSON,
        allowNull: true
    },
});

SessionTemplate.hasMany(ChannelTemplate, { onDelete: 'SET NULL', foreignKey: 'sessionTemplateId' });
ChannelTemplate.belongsTo(SessionTemplate, { onDelete: 'SET NULL', foreignKey: 'sessionTemplateId' });
TranscriberProfile.hasMany(ChannelTemplate, { onDelete: 'SET NULL', foreignKey: 'transcriberProfileId' });
ChannelTemplate.belongsTo(TranscriberProfile, { onDelete: 'SET NULL', foreignKey: 'transcriberProfileId' });

// BOT
const Bot = sequelize.define('bot', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    provider: {
        type: DataTypes.ENUM('jitsi', 'bigbluebutton'),
        allowNull: false
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false
    },
    enableDisplaySub: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    subSource: {
        type: DataTypes.STRING,
        allowNull: true
    }
});

Channel.hasMany(Bot, { onDelete: 'SET NULL', foreignKey: 'channelId' });
Bot.belongsTo(Channel, { onDelete: 'SET NULL', foreignKey: 'channelId' });

// TRANSLATOR
const Translator = sequelize.define('translator', {
    name: { type: DataTypes.STRING, primaryKey: true },
    languages: { type: DataTypes.JSONB, defaultValue: [] },
    online: { type: DataTypes.BOOLEAN, defaultValue: false }
}, { timestamps: true, updatedAt: true, createdAt: false });

// Export the models
module.exports = {
    Sequelize,
    TranscriberProfile,
    Session,
    Channel,
    Caption,
    TranslatedCaption,
    SessionTemplate,
    ChannelTemplate,
    Bot,
    Translator,
    sequelize,
    Op,
    formatCaption,
    groupTranslatedCaptions,
};
