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

// MICROSOFT TEAMS EVENTS
const MsTeamsEvent = sequelize.define('msTeamsEvent', {
    id: {
        type: DataTypes.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
    },
    eventId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    subject: {
        type: DataTypes.STRING,
        allowNull: true
    },
    startDateTime: {
        type: DataTypes.DATE,
        allowNull: false
    },
    endDateTime: {
        type: DataTypes.DATE,
        allowNull: true
    },
    processed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    }
});

// Export the models
module.exports = {
    TranscriberProfile,
    Session,
    Channel,
    SessionTemplate,
    ChannelTemplate,
    Bot,
    Translator,
    MsTeamsEvent,
    sequelize,
    Op
};
