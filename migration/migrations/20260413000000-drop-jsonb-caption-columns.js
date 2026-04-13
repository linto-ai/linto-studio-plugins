'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn('channels', 'closedCaptions');
    await queryInterface.removeColumn('channels', 'translatedCaptions');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'closedCaptions', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'translatedCaptions', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  }
};
