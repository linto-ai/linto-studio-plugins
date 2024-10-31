'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transcriberProfiles', 'organizationId', {
      type: Sequelize.STRING,
      allowNull: true, // Permet de rendre la colonne nullable
    });

    await queryInterface.addColumn('transcriberProfiles', 'quickMeeting', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false, // Peut être modifié selon tes besoins
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('transcriberProfiles', 'organizationId');
    await queryInterface.removeColumn('transcriberProfiles', 'quickMeeting');
  }
};
