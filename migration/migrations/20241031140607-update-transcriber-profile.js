'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transcriberProfiles', 'organizationId', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    await queryInterface.addColumn('transcriberProfiles', 'quickMeeting', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('transcriberProfiles', 'organizationId');
    await queryInterface.removeColumn('transcriberProfiles', 'quickMeeting');
  }
};
