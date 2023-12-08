'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('channels', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      transcriber_id: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      languages: {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      transcriberProfileId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
            model: 'transcriber_profiles',
            key: 'id',
        },
      },
      sessionId: {
        type: Sequelize.UUID,
        allowNull: true,
        onDelete: 'CASCADE',
        references: {
            model: 'sessions',
            key: 'id',
        },
      },
      stream_endpoint: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      stream_status: {
        type: Sequelize.ENUM('active', 'inactive', 'errored'),
        allowNull: true,
      },
      transcriber_status: {
        type: Sequelize.ENUM('ready', 'streaming', 'closed', 'errored', 'initialized', 'eos'),
        allowNull: true,
      },
      closed_captions: {
        type: Sequelize.ARRAY(Sequelize.JSON),
        allowNull: true,
      },
      closed_caption_live_delivery: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      closed_captions_file_delivery: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('channels');
  }
};
