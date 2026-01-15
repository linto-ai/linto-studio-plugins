'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add 'livekit' to the bot provider enum
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_bots_provider" ADD VALUE IF NOT EXISTS 'livekit';
    `);
  },

  async down(queryInterface, Sequelize) {
    // Note: PostgreSQL does not support removing values from ENUMs
    // This migration is not reversible
  }
};
