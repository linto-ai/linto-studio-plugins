'use strict';

/**
 * Durable bot↔BotService ownership: record which BotService replica was assigned
 * to a bot so the Scheduler can route a later stopbot to the right replica (and
 * reap orphaned rows) even after a Scheduler restart, instead of relying on an
 * in-memory map that is lost on restart.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('bots', 'botservice', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('bots', 'botservice');
  },
};
