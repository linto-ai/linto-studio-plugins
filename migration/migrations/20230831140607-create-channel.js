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
      streamEndpoints: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      streamStatus: {
        type: Sequelize.ENUM('active', 'inactive', 'errored'),
        allowNull: true,
      },
      transcriberId: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      closedCaptions: {
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
            model: 'transcriberProfiles',
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
