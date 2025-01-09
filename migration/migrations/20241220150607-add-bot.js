'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('bots', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      provider: {
          type: Sequelize.ENUM('jitsi', 'bigbluebutton'),
          allowNull: false
      },
      url: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      enableAsyncTranscripts: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      enableLiveTranscripts: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      enableDisplaySub: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      subSource: {
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
      channelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        onDelete: 'CASCADE',
        references: {
            model: 'channels',
            key: 'id',
        },
      },
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('bots');
  }
};
