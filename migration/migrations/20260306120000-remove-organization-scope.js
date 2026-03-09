'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Delete all integrationConfigs with scope='organization'
    await queryInterface.sequelize.query(
      `DELETE FROM "integrationConfigs" WHERE "scope" = 'organization'`
    );

    // 2. Drop the CHECK constraint that enforced organization scope rules
    await queryInterface.sequelize.query(
      `ALTER TABLE "integrationConfigs" DROP CONSTRAINT IF EXISTS "chk_scope_org_id"`
    );

    // 3. Drop the unique index for organization scope (no longer needed)
    await queryInterface.removeIndex('integrationConfigs', 'idx_ic_org_provider_active');

    // 4. Change default value of scope column to 'platform'
    await queryInterface.changeColumn('integrationConfigs', 'scope', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'platform'
    });
  },

  async down(queryInterface, Sequelize) {
    // 1. Revert default value of scope column to 'organization'
    await queryInterface.changeColumn('integrationConfigs', 'scope', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'organization'
    });

    // 2. Re-add the unique index for organization scope
    await queryInterface.addIndex('integrationConfigs', ['organizationId', 'provider'], {
      unique: true,
      where: {
        status: { [Sequelize.Op.ne]: 'disabled' },
        scope: 'organization'
      },
      name: 'idx_ic_org_provider_active'
    });

    // 3. Re-add the CHECK constraint
    await queryInterface.sequelize.query(`
      ALTER TABLE "integrationConfigs"
      ADD CONSTRAINT "chk_scope_org_id"
      CHECK (
        ("scope" = 'platform' AND "organizationId" IS NULL) OR
        ("scope" = 'organization' AND "organizationId" IS NOT NULL)
      )
    `);
  }
};
