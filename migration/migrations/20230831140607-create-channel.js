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
      keepAudio: {
          type: Sequelize.BOOLEAN,
          allowNull: true,
      },
      diarization: {
          type: Sequelize.BOOLEAN,
          allowNull: true,
      },
      index: {
          type: Sequelize.INTEGER,
          allowNull: false
      },
      languages: {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: true,
      },
      translations: {
        type: Sequelize.ARRAY(Sequelize.STRING),
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      stream_endpoints: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      stream_status: {
        type: Sequelize.ENUM('active', 'inactive', 'errored'),
        allowNull: true,
      },
      transcriber_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      closed_captions: {
        type: Sequelize.ARRAY(Sequelize.JSON),
        allowNull: true,
      },
      translated_closed_captions: {
        type: Sequelize.ARRAY(Sequelize.JSON),
        allowNull: true,
      },
      audioFile: {
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
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('channels');
  }
};
