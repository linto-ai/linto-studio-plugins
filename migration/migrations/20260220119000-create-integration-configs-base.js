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
      scope: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'organization'
      },
      organizationId: {
        type: Sequelize.STRING,
        allowNull: true
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
      allowOrganizationOverride: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
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

    // CHECK: platform scope requires null organizationId, organization scope requires non-null
    await queryInterface.sequelize.query(`
      ALTER TABLE "integrationConfigs"
      ADD CONSTRAINT "chk_scope_org_id"
      CHECK (
        ("scope" = 'platform' AND "organizationId" IS NULL) OR
        ("scope" = 'organization' AND "organizationId" IS NOT NULL)
      )
    `);

    // Unique index: one active config per (organizationId, provider) for organization scope
    await queryInterface.addIndex('integrationConfigs', ['organizationId', 'provider'], {
      unique: true,
      where: {
        status: { [Sequelize.Op.ne]: 'disabled' },
        scope: 'organization'
      },
      name: 'idx_ic_org_provider_active'
    });

    // Unique index: one active config per provider for platform scope
    await queryInterface.addIndex('integrationConfigs', ['provider'], {
      unique: true,
      where: {
        status: { [Sequelize.Op.ne]: 'disabled' },
        scope: 'platform'
      },
      name: 'idx_ic_platform_provider_active'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('integrationConfigs');
  }
};
