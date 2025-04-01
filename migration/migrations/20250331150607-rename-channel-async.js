'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameColumn('channels', 'async', 'compressAudio');
    await queryInterface.renameColumn('channelTemplates', 'async', 'compressAudio');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.renameColumn('channels', 'compressAudio', 'async');
    await queryInterface.renameColumn('channelTemplates', 'compressAudio', 'async');
  }
};
