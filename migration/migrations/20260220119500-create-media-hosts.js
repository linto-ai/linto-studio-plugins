'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('mediaHosts', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      integrationConfigId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'integrationConfigs',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      dns: {
        type: Sequelize.STRING,
        allowNull: true
      },
      publicIp: {
        type: Sequelize.STRING,
        allowNull: true
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'provisioning'
      },
      provisioningToken: {
        type: Sequelize.STRING,
        allowNull: true
      },
      deploymentMode: {
        type: Sequelize.STRING,
        allowNull: true
      },
      manualConfig: {
        type: Sequelize.JSONB,
        allowNull: true
      },
      lastHealthCheck: {
        type: Sequelize.DATE,
        allowNull: true
      },
      healthStatus: {
        type: Sequelize.JSONB,
        allowNull: true
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // Unique index: provisioningToken must be unique when not null
    await queryInterface.addIndex('mediaHosts', ['provisioningToken'], {
      unique: true,
      where: { provisioningToken: { [Sequelize.Op.ne]: null } },
      name: 'idx_media_hosts_provisioning_token'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('mediaHosts');
  }
};
