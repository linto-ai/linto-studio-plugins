'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('msTeamsEvents', 'calendarSubscriptionId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {
        model: 'calendarSubscriptions',
        key: 'id'
      },
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('msTeamsEvents', 'meetingJoinUrl', {
      type: Sequelize.STRING,
      allowNull: true
    });

    await queryInterface.addColumn('msTeamsEvents', 'sessionId', {
      type: Sequelize.UUID,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('msTeamsEvents', 'sessionId');
    await queryInterface.removeColumn('msTeamsEvents', 'meetingJoinUrl');
    await queryInterface.removeColumn('msTeamsEvents', 'calendarSubscriptionId');
  }
};
