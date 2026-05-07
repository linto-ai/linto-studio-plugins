'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_sessions_status" ADD VALUE IF NOT EXISTS 'paused';`
    );
    await queryInterface.addColumn('sessions', 'pausedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'pausedAt');
    // PostgreSQL does not support removing values from an ENUM type.
    // To fully revert, the column would need to be recreated with a new ENUM.
    // Sessions with status 'paused' should be updated before reverting.
  },
};
