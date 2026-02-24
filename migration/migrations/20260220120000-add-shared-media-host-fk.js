'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('integrationConfigs', 'sharedMediaHostId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {
        model: 'mediaHosts',
        key: 'id'
      },
      onDelete: 'SET NULL'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('integrationConfigs', 'sharedMediaHostId');
  }
};
