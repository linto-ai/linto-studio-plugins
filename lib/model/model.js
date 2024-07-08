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

const Session = sequelize.define('session', {
    id: {
        type: DataTypes.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
    },
    status: {
        type: DataTypes.ENUM('ready', 'active', 'terminated'),
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
    index: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    languages: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true
    },
    translations: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    stream_endpoints: {
        type: DataTypes.JSON,
        allowNull: true
    },
    stream_status: {
        type: DataTypes.ENUM('active', 'inactive', 'errored'),
        defaultValue: 'inactive',
        allowNull: true
    },
    transcriber_id: {
        type: DataTypes.UUID,
        allowNull: true,
        defaultValue: null
    },
    closed_captions: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        allowNull: true
    },
    translated_closed_captions: {
        type: DataTypes.ARRAY(DataTypes.JSON),
        allowNull: true
    },
    audioFile: {
        type: DataTypes.STRING,
        defaultValue: "",
        allowNull: true
    }
});

TranscriberProfile.hasMany(Channel, { onDelete: 'SET NULL', foreignKey: 'transcriberProfileId' });
Channel.belongsTo(TranscriberProfile, { onDelete: 'SET NULL', foreignKey: 'transcriberProfileId' });

Session.hasMany(Channel, { onDelete: 'SET NULL', foreignKey: 'session_id' });
Channel.belongsTo(Session, { onDelete: 'SET NULL', foreignKey: 'session_id' });

async function syncDatabase() {
    try {
        await sequelize.sync({ alter: true }); // Use 'alter: true' to update existing tables
        console.log("Database synchronized successfully.");
    } catch (error) {
        console.error("Error synchronizing database:", error);
    }
}

syncDatabase();

// Export the models
module.exports = {
    TranscriberProfile,
    Session,
    Channel,
    sequelize,
    Op
};
