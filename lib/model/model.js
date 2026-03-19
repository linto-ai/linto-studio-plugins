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

// Pagination inversée : offset=0 retourne les derniers turns,
// offset=50 retourne les 50 d'avant, etc.
// Au sein d'une page les turns restent en ordre chronologique (ASC).
Channel.getPaginatedCaptions = async function(channelId, { limit = 50, offset = 0 } = {}) {
    const [result] = await sequelize.query(`
        SELECT
            jsonb_array_length(COALESCE("closedCaptions", '[]'::jsonb)) AS "totalClosedCaptions",
            jsonb_array_length(COALESCE("translatedCaptions", '[]'::jsonb)) AS "totalTranslatedCaptions",
            COALESCE(
                (SELECT jsonb_agg(elem ORDER BY ord ASC) FROM (
                    SELECT elem, ord FROM jsonb_array_elements(COALESCE("closedCaptions", '[]'::jsonb))
                        WITH ORDINALITY AS t(elem, ord)
                    ORDER BY ord DESC LIMIT :limit OFFSET :offset
                ) sub),
                '[]'::jsonb
            ) AS "closedCaptions",
            COALESCE(
                (SELECT jsonb_agg(elem ORDER BY ord ASC) FROM (
                    SELECT elem, ord FROM jsonb_array_elements(COALESCE("translatedCaptions", '[]'::jsonb))
                        WITH ORDINALITY AS t(elem, ord)
                    ORDER BY ord DESC LIMIT :limit OFFSET :offset
                ) sub),
                '[]'::jsonb
            ) AS "translatedCaptions"
        FROM channels
        WHERE id = :channelId
    `, {
        replacements: { channelId, limit, offset },
        type: Sequelize.QueryTypes.SELECT
    });
    return result;
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
    TranscriberProfile,
    Session,
    Channel,
    SessionTemplate,
    ChannelTemplate,
    Bot,
    Translator,
    sequelize,
    Op
};
