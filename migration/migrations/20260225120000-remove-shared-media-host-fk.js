'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn('integrationConfigs', 'sharedMediaHostId');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('integrationConfigs', 'sharedMediaHostId', {
      type: Sequelize.UUID,
      allowNull: true
    });
  }
};
