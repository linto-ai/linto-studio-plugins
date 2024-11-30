'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('channelTemplates', {
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
      sessionTemplateId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        onDelete: 'CASCADE',
        references: {
            model: 'sessionTemplates',
            key: 'id',
        },
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('channelTemplates');
  }
};
