'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'meta', {
      type: Sequelize.JSON,
      allowNull: true,
    });

    await queryInterface.addColumn('channels', 'async', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.addColumn('channelTemplates', 'async', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await queryInterface.removeColumn('bots', 'enableAsyncTranscripts');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('channels', 'meta');
    await queryInterface.removeColumn('channels', 'async');
    await queryInterface.removeColumn('channelTemplates', 'async');
  }
};
