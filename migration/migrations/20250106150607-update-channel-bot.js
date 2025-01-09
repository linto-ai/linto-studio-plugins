'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeColumn('channels', 'bot');
  },
  async down(queryInterface, Sequelize) {
  }
};
