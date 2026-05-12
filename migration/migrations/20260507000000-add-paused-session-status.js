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

  async down(queryInterface, Sequelize) {
    // Refuse to rollback if any session is still in 'paused' status: dropping
    // pausedAt would silently lose the timestamp and leave the row in an enum
    // value (paused) that the column rebuild step (manual, not done here)
    // would no longer accept. Better to fail loudly than to corrupt state.
    const [rows] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM sessions WHERE status = 'paused';`
    );
    const pausedCount = rows[0] && rows[0].n;
    if (pausedCount > 0) {
      throw new Error(
        `Cannot rollback migration: ${pausedCount} session(s) still in 'paused' status. ` +
        `Resume or terminate them first (UPDATE sessions SET status='ready' WHERE status='paused';).`
      );
    }
    await queryInterface.removeColumn('sessions', 'pausedAt');
    // PostgreSQL does not support removing values from an ENUM type.
    // To fully revert, the column would need to be recreated with a new ENUM.
  },
};
