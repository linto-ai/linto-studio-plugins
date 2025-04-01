'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeColumn('bots', 'enableLiveTranscripts');
    await queryInterface.addColumn('channels', 'enableLiveTranscripts', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: true
    });

    await queryInterface.addColumn('channelTemplates', 'enableLiveTranscripts', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('channelTemplates', 'enableLiveTranscripts');
    await queryInterface.removeColumn('channels', 'enableLiveTranscripts');
    await queryInterface.addColumn('bots', 'enableLiveTranscripts', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: true
    });
  }
};
