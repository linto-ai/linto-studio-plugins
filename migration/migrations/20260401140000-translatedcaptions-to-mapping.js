'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Convert translatedCaptions from flat JSONB array to object mapping keyed by segmentId.
    // e.g. [{segmentId:1,...},{segmentId:1,...},{segmentId:2,...}] → {"1":[{...},{...}],"2":[{...}]}
    await queryInterface.sequelize.query(`
      UPDATE channels
      SET "translatedCaptions" = COALESCE(
        (
          SELECT jsonb_object_agg(key, value)
          FROM (
            SELECT
              elem->>'segmentId' AS key,
              jsonb_agg(elem) AS value
            FROM jsonb_array_elements("translatedCaptions"::jsonb) AS elem
            GROUP BY elem->>'segmentId'
          ) sub
        ),
        '{}'::jsonb
      )
      WHERE "translatedCaptions" IS NOT NULL
        AND jsonb_typeof("translatedCaptions") = 'array';
    `);
  },

  async down(queryInterface) {
    // Convert object mapping back to flat JSONB array.
    // e.g. {"1":[{...},{...}],"2":[{...}]} → [{...},{...},{...}]
    await queryInterface.sequelize.query(`
      UPDATE channels
      SET "translatedCaptions" = COALESCE(
        (
          SELECT jsonb_agg(elem)
          FROM jsonb_each("translatedCaptions"::jsonb) AS kv(key, arr),
               jsonb_array_elements(kv.arr) AS elem
        ),
        '[]'::jsonb
      )
      WHERE "translatedCaptions" IS NOT NULL
        AND jsonb_typeof("translatedCaptions") = 'object';
    `);
  },
};
