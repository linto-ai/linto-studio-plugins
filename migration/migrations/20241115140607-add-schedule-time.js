'use strict';

const tableName = 'sessions';
const enumTypeName = 'enum_sessions_status';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(tableName, 'scheduleOn', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn(tableName, 'endOn', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      ALTER TYPE ${enumTypeName}
      ADD VALUE 'on_schedule';
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn(tableName, 'scheduleOn');
    await queryInterface.removeColumn(tableName, 'endOn');
  }
};
