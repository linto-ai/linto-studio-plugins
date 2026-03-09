'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // (a) Add status ENUM column to msTeamsEvents
    await queryInterface.addColumn('msTeamsEvents', 'status', {
      type: Sequelize.ENUM('planned', 'in_progress', 'transcribed', 'missed', 'ignored'),
      allowNull: false,
      defaultValue: 'planned'
    });

    // (b) Populate status from processed column
    await queryInterface.sequelize.query(
      `UPDATE "msTeamsEvents" SET "status" = 'transcribed' WHERE "processed" = true`
    );

    // (c) Add organizationId column to msTeamsEvents
    await queryInterface.addColumn('msTeamsEvents', 'organizationId', {
      type: Sequelize.STRING,
      allowNull: true
    });

    // Populate organizationId via JOIN with calendarSubscriptions
    await queryInterface.sequelize.query(
      `UPDATE "msTeamsEvents" SET "organizationId" = cs."organizationId" FROM "calendarSubscriptions" cs WHERE "msTeamsEvents"."calendarSubscriptionId" = cs.id`
    );

    // (d) Add columns to calendarSubscriptions
    await queryInterface.addColumn('calendarSubscriptions', 'graphUserDisplayName', {
      type: Sequelize.STRING,
      allowNull: true
    });

    await queryInterface.addColumn('calendarSubscriptions', 'graphUserEmail', {
      type: Sequelize.STRING,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('calendarSubscriptions', 'graphUserEmail');
    await queryInterface.removeColumn('calendarSubscriptions', 'graphUserDisplayName');
    await queryInterface.removeColumn('msTeamsEvents', 'organizationId');
    await queryInterface.removeColumn('msTeamsEvents', 'status');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_msTeamsEvents_status"');
  }
};
