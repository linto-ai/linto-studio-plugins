'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('integrationConfigs', 'deploymentMode', {
      type: Sequelize.STRING,
      allowNull: true
    });
    await queryInterface.addColumn('integrationConfigs', 'manualConfig', {
      type: Sequelize.JSONB,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('integrationConfigs', 'manualConfig');
    await queryInterface.removeColumn('integrationConfigs', 'deploymentMode');
  }
};
