'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Guard against NaN when parsing numeric values from JSONB for SQL interpolation
    const safeNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 'NULL'; };

    await queryInterface.sequelize.transaction(async (transaction) => {
      // 1. Create captions table
      await queryInterface.sequelize.query(`
        CREATE TABLE captions (
          id SERIAL PRIMARY KEY,
          "channelId" INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          "segmentId" INTEGER,
          start NUMERIC,
          "end" NUMERIC,
          text TEXT,
          astart TIMESTAMPTZ,
          aend TIMESTAMPTZ,
          lang VARCHAR(20),
          locutor VARCHAR(100),
          "createdAt" TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX idx_captions_channel ON captions("channelId");
        CREATE INDEX idx_captions_channel_segment ON captions("channelId", "segmentId");
      `, { transaction });

      // 2. Create translated_captions table
      await queryInterface.sequelize.query(`
        CREATE TABLE translated_captions (
          id SERIAL PRIMARY KEY,
          "channelId" INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          "segmentId" INTEGER NOT NULL,
          "targetLang" VARCHAR(20) NOT NULL,
          text TEXT,
          "createdAt" TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX idx_translated_captions_channel ON translated_captions("channelId");
        CREATE INDEX idx_translated_captions_channel_segment ON translated_captions("channelId", "segmentId");
      `, { transaction });

      // 3. Migrate existing closedCaptions JSONB data into captions table
      const channels = await queryInterface.sequelize.query(
        `SELECT id FROM channels WHERE "closedCaptions" IS NOT NULL AND jsonb_array_length("closedCaptions"::jsonb) > 0`,
        { type: Sequelize.QueryTypes.SELECT, transaction }
      );

      for (const channel of channels) {
        const rows = await queryInterface.sequelize.query(
          `SELECT elem FROM jsonb_array_elements((SELECT "closedCaptions"::jsonb FROM channels WHERE id = :channelId)) AS elem`,
          { replacements: { channelId: channel.id }, type: Sequelize.QueryTypes.SELECT, transaction }
        );

        const BATCH_SIZE = 100;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const values = batch.map(row => {
            const e = typeof row.elem === 'string' ? JSON.parse(row.elem) : row.elem;
            const channelId = channel.id;
            const segmentId = e.segmentId != null ? safeNum(e.segmentId) : 'NULL';
            const start = e.start != null ? safeNum(e.start) : 'NULL';
            const end = e.end != null ? safeNum(e.end) : 'NULL';
            const text = e.text != null ? queryInterface.sequelize.escape(e.text) : 'NULL';
            const astart = e.astart != null ? queryInterface.sequelize.escape(e.astart) : 'NULL';
            const aend = e.aend != null ? queryInterface.sequelize.escape(e.aend) : 'NULL';
            const lang = e.lang != null ? queryInterface.sequelize.escape(e.lang) : 'NULL';
            const locutor = e.locutor != null ? queryInterface.sequelize.escape(e.locutor) : 'NULL';
            return `(${channelId}, ${segmentId}, ${start}, ${end}, ${text}, ${astart}, ${aend}, ${lang}, ${locutor})`;
          }).join(',\n');

          await queryInterface.sequelize.query(
            `INSERT INTO captions ("channelId", "segmentId", start, "end", text, astart, aend, lang, locutor) VALUES ${values}`,
            { transaction }
          );
        }
      }

      // 4. Migrate existing translatedCaptions JSONB data into translated_captions table
      const translatedChannels = await queryInterface.sequelize.query(
        `SELECT id FROM channels WHERE "translatedCaptions" IS NOT NULL AND jsonb_typeof("translatedCaptions"::jsonb) = 'object' AND "translatedCaptions"::text != '{}'`,
        { type: Sequelize.QueryTypes.SELECT, transaction }
      );

      for (const channel of translatedChannels) {
        const rows = await queryInterface.sequelize.query(
          `SELECT kv.key AS segment_id, elem
           FROM channels c,
                jsonb_each(c."translatedCaptions"::jsonb) AS kv(key, value),
                jsonb_array_elements(kv.value) AS elem
           WHERE c.id = :channelId`,
          { replacements: { channelId: channel.id }, type: Sequelize.QueryTypes.SELECT, transaction }
        );

        const BATCH_SIZE = 100;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const values = batch.map(row => {
            const e = typeof row.elem === 'string' ? JSON.parse(row.elem) : row.elem;
            const channelId = channel.id;
            const segmentId = safeNum(row.segment_id);
            const targetLang = queryInterface.sequelize.escape(e.targetLang || '');
            const text = e.text != null ? queryInterface.sequelize.escape(e.text) : 'NULL';
            return `(${channelId}, ${segmentId}, ${targetLang}, ${text})`;
          }).join(',\n');

          if (values) {
            await queryInterface.sequelize.query(
              `INSERT INTO translated_captions ("channelId", "segmentId", "targetLang", text) VALUES ${values}`,
              { transaction }
            );
          }
        }
      }

      // 5. NULL out old JSONB columns to free TOAST space
      await queryInterface.sequelize.query(
        `UPDATE channels SET "closedCaptions" = NULL, "translatedCaptions" = NULL WHERE "closedCaptions" IS NOT NULL OR "translatedCaptions" IS NOT NULL`,
        { transaction }
      );
    });
  },

  // NOTE: This down migration only drops the new tables.
  // It does NOT restore JSONB data in channels.closedCaptions / channels.translatedCaptions
  // because step 5 NULLed those columns. A full rollback would require
  // re-migrating data from the tables back into JSONB before dropping.
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS translated_captions`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS captions`);
  }
};
