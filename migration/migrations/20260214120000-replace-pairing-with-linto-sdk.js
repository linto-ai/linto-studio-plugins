'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Drop pairingKeys table
    await queryInterface.dropTable('pairingKeys');

    // 2. Add new columns to teamsAccountLinks
    await queryInterface.addColumn('teamsAccountLinks', 'lintoUserId', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('teamsAccountLinks', 'orgRole', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 0,
    });
    await queryInterface.addColumn('teamsAccountLinks', 'orgPermissions', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 0,
    });
    await queryInterface.addColumn('teamsAccountLinks', 'studioToken', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // 1. Remove columns from teamsAccountLinks
    await queryInterface.removeColumn('teamsAccountLinks', 'studioToken');
    await queryInterface.removeColumn('teamsAccountLinks', 'orgPermissions');
    await queryInterface.removeColumn('teamsAccountLinks', 'orgRole');
    await queryInterface.removeColumn('teamsAccountLinks', 'lintoUserId');

    // 2. Recreate pairingKeys table
    await queryInterface.createTable('pairingKeys', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
      },
      keyHash: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      organizationId: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      createdBy: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      description: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      maxUses: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      usedCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('active', 'revoked', 'expired'),
        allowNull: false,
        defaultValue: 'active',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  }
};
