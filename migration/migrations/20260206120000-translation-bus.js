'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Convert channels.translations from ARRAY(STRING) to JSONB
    // PostgreSQL doesn't allow subqueries in ALTER COLUMN TYPE USING, so we do it in steps
    await queryInterface.addColumn('channels', 'translations_new', {
      type: Sequelize.JSONB,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE channels SET translations_new = (
        SELECT jsonb_agg(jsonb_build_object('target', elem, 'mode', 'discrete'))
        FROM unnest(translations) AS elem
      ) WHERE translations IS NOT NULL;
    `);

    await queryInterface.removeColumn('channels', 'translations');
    await queryInterface.renameColumn('channels', 'translations_new', 'translations');

    // 2. Add channels.translatedCaptions column
    await queryInterface.addColumn('channels', 'translatedCaptions', {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: null,
    });

    // 3. Convert channelTemplates.translations from ARRAY(STRING) to JSONB
    await queryInterface.addColumn('channelTemplates', 'translations_new', {
      type: Sequelize.JSONB,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE "channelTemplates" SET translations_new = (
        SELECT jsonb_agg(jsonb_build_object('target', elem, 'mode', 'discrete'))
        FROM unnest(translations) AS elem
      ) WHERE translations IS NOT NULL;
    `);

    await queryInterface.removeColumn('channelTemplates', 'translations');
    await queryInterface.renameColumn('channelTemplates', 'translations_new', 'translations');
  },

  async down(queryInterface, Sequelize) {
    // 1. Revert channelTemplates.translations: JSONB -> ARRAY(STRING)
    await queryInterface.addColumn('channelTemplates', 'translations_old', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE "channelTemplates" SET translations_old = (
        SELECT array_agg(elem->>'target')
        FROM jsonb_array_elements(translations) AS elem
      ) WHERE translations IS NOT NULL;
    `);

    await queryInterface.removeColumn('channelTemplates', 'translations');
    await queryInterface.renameColumn('channelTemplates', 'translations_old', 'translations');

    // 2. Remove channels.translatedCaptions column
    await queryInterface.removeColumn('channels', 'translatedCaptions');

    // 3. Revert channels.translations: JSONB -> ARRAY(STRING)
    await queryInterface.addColumn('channels', 'translations_old', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE channels SET translations_old = (
        SELECT array_agg(elem->>'target')
        FROM jsonb_array_elements(translations) AS elem
      ) WHERE translations IS NOT NULL;
    `);

    await queryInterface.removeColumn('channels', 'translations');
    await queryInterface.renameColumn('channels', 'translations_old', 'translations');
  }
};
