'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add 'teams' to the bot provider enum
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_bots_provider" ADD VALUE IF NOT EXISTS 'teams';
    `);
  },

  async down(queryInterface, Sequelize) {
  }
};
