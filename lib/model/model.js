const { Sequelize, DataTypes, Op } = require('sequelize');

require("../config.js")

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    logging: false,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres'
});


const TranscriberProfile = sequelize.define('transcriber_profile', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    config: {
        type: DataTypes.JSON,
        allowNull: true
    }
});

//List of languages that can be translated to as BC47 language tags
const TranslationTargets = sequelize.define('translation_targets', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    languages: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: false
    }
});

const Session = sequelize.define('session', {
    id: {
        type: DataTypes.UUID,
        //defaultValue: Sequelize.UUIDV4,
        primaryKey: true
    },
    status: {
        type: DataTypes.ENUM('pending_creation', 'ready', 'active', 'errored', 'terminated'),
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: true
    },
    end_time: {
        type: DataTypes.DATE,
        allowNull: true
    },
    errored_on: {
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
    public: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
    }
});

const Channel = sequelize.define('channel', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    //BCP 47 language tags
    languages: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true
    },
    //BCP 47 language tags
    translation: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    stream_endpoint: {
        type: DataTypes.STRING,
        allowNull: true
    },
    stream_status: {
        type: DataTypes.ENUM('active', 'inactive', 'errored'),
        allowNull: true
    },
    transcriber_status: {
        type: DataTypes.ENUM('ready', 'streaming', 'closed', 'errored', 'initialized'),
        allowNull: true
    },
    closed_captions: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        allowNull: true
    },
    translations: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        allowNull: true
    }
});

// Sync the models with the database

TranscriberProfile.hasMany(Channel, { onDelete: 'SET NULL', foreignKey: 'transcriber_id' });
Channel.belongsTo(TranscriberProfile, { onDelete: 'SET NULL', foreignKey: 'transcriber_id' });

Session.hasMany(Channel, { onDelete: 'SET NULL', foreignKey: 'session_id' });
Channel.belongsTo(Session, { onDelete: 'SET NULL', foreignKey: 'session_id' });


// Export the models
module.exports = {
    TranscriberProfile,
    TranslationTargets,
    Session,
    Channel,
    sequelize,
    Op
};
