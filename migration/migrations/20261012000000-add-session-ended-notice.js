'use strict';

/**
 * Durable record of a system/out/sessions/ended notification the Scheduler
 * owes for a session it ended itself (autoEnd, a bot leaving an empty
 * meeting): 'pending' while it drains the channels, 'sending:<claim>' once it
 * claimed the publication, NULL when nothing is owed (published, or Studio
 * took the ending over through Session-API's storing stop). The Scheduler
 * finishes the owed notifications after a restart.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('sessions', 'endedNotice', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'endedNotice');
  },
};
