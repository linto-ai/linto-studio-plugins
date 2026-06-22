'use strict';

/**
 * Decoupled BotService introduces two new lightweight web-bot providers:
 *   - `visio`: a headless browser joining a LinTO Meet (LiveKit SFU) room as a guest
 *   - `teams`: a headless browser joining a Microsoft Teams meeting via the web client
 *
 * Both extend the existing `bots.provider` enum (jitsi, bigbluebutton). PostgreSQL
 * cannot remove enum values, so the down migration is intentionally a no-op for the
 * enum (matching the project convention, see 20260507000000-add-paused-session-status).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    // ALTER TYPE ... ADD VALUE must run outside a transaction block and cannot
    // be combined with using the value in the same statement; running each as a
    // standalone query (no transaction wrapper) is safe and idempotent.
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_bots_provider" ADD VALUE IF NOT EXISTS 'teams';`
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_bots_provider" ADD VALUE IF NOT EXISTS 'visio';`
    );
  },

  async down() {
    // PostgreSQL does not support removing values from an ENUM type. To fully
    // revert, the column would need to be recreated against a new ENUM. Left as
    // a no-op so a rollback of later migrations does not fail here.
  },
};
