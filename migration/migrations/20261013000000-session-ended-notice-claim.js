'use strict';

/**
 * Exclusive claim of a session's system/out/sessions/ended publication: the
 * Scheduler sets endedNotice to 'sending:<claim>' with a lease
 * (endedNoticeLeaseUntil). Another publication can only take a claim whose
 * lease has run out (e.g. the Scheduler crashed while publishing). And a
 * partial index for the Scheduler's periodic query of the owed notices, a
 * handful of rows among all sessions.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('sessions', 'endedNoticeLeaseUntil', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addIndex('sessions', ['endedNotice'], {
      name: 'sessions_ended_notice_owed',
      where: { endedNotice: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('sessions', 'sessions_ended_notice_owed');
    await queryInterface.removeColumn('sessions', 'endedNoticeLeaseUntil');
  },
};
