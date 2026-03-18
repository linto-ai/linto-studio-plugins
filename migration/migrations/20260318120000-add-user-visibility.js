'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_sessions_visibility" ADD VALUE IF NOT EXISTS 'user';`
    );
  },

  async down(queryInterface) {
    // PostgreSQL does not support removing values from an ENUM type.
    // To fully revert, the column would need to be recreated with a new ENUM.
    // Sessions with visibility 'user' should be updated before reverting.
  },
};
