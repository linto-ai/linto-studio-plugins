'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('integrationConfigs', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      organizationId: {
        type: Sequelize.STRING,
        allowNull: false
      },
      provider: {
        type: Sequelize.STRING,
        allowNull: false
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'draft'
      },
      config: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      setupProgress: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: {}
      },
      provisioningToken: {
        type: Sequelize.STRING,
        allowNull: true
      },
      mediaHostDns: {
        type: Sequelize.STRING,
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

    // Unique index: one active config per (organizationId, provider)
    await queryInterface.addIndex('integrationConfigs', ['organizationId', 'provider'], {
      unique: true,
      where: { status: { [Sequelize.Op.ne]: 'disabled' } },
      name: 'idx_integration_configs_org_provider_active'
    });

    // Unique index: provisioningToken must be unique when not null
    await queryInterface.addIndex('integrationConfigs', ['provisioningToken'], {
      unique: true,
      where: { provisioningToken: { [Sequelize.Op.ne]: null } },
      name: 'idx_integration_configs_provisioning_token'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('integrationConfigs');
  }
};
