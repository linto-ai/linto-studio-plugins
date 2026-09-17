'use strict';

const crypto = require('crypto');

/**
 * Private session id.
 *
 * The public session id is the key of every Studio URL, is returned by the
 * public session API (even behind an alias) and is listed to every member of
 * the organization, so it cannot authenticate a stream. Each session now gets a
 * second UUID, `privateId`, that the API never returns except embedded in the
 * channels' streamEndpoints, and that the Transcriber's SRT/RTMP/WS servers
 * resolve the session by.
 *
 * Existing rows are backfilled and their already-stored streamEndpoints are
 * rewritten (public id → private id) so the Transcriber never needs a legacy
 * acceptance path. Senders configured with an endpoint copied before this
 * migration must copy it again from Studio.
 *
 * @type {import('sequelize-cli').Migration}
 */

// Replace every occurrence of `from` by `to` in the string values of a
// streamEndpoints object ({ srt, rtmp, ws }). Non-string values are kept.
function rewriteEndpoints(endpoints, from, to) {
  if (!endpoints || typeof endpoints !== 'object') return endpoints;
  const out = {};
  for (const [k, v] of Object.entries(endpoints)) {
    out[k] = typeof v === 'string' ? v.split(from).join(to) : v;
  }
  return out;
}

async function rewriteAllEndpoints(queryInterface, transaction, direction) {
  const [sessions] = await queryInterface.sequelize.query(
    'SELECT "id", "privateId" FROM "sessions" WHERE "privateId" IS NOT NULL',
    { transaction }
  );
  for (const s of sessions) {
    const [from, to] = direction === 'up' ? [s.id, s.privateId] : [s.privateId, s.id];
    const [channels] = await queryInterface.sequelize.query(
      'SELECT "id", "streamEndpoints" FROM "channels" WHERE "sessionId" = :sessionId AND "streamEndpoints" IS NOT NULL',
      { replacements: { sessionId: s.id }, transaction }
    );
    for (const c of channels) {
      const current = typeof c.streamEndpoints === 'string' ? JSON.parse(c.streamEndpoints) : c.streamEndpoints;
      const rewritten = rewriteEndpoints(current, from, to);
      await queryInterface.sequelize.query(
        'UPDATE "channels" SET "streamEndpoints" = :endpoints WHERE "id" = :id',
        { replacements: { endpoints: JSON.stringify(rewritten), id: c.id }, transaction }
      );
    }
  }
}

module.exports = {
  rewriteEndpoints,

  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('sessions', 'privateId', {
        type: Sequelize.UUID,
        allowNull: true,
      }, { transaction });

      const [rows] = await queryInterface.sequelize.query('SELECT "id" FROM "sessions"', { transaction });
      for (const row of rows) {
        await queryInterface.sequelize.query(
          'UPDATE "sessions" SET "privateId" = :privateId WHERE "id" = :id',
          { replacements: { privateId: crypto.randomUUID(), id: row.id }, transaction }
        );
      }

      await rewriteAllEndpoints(queryInterface, transaction, 'up');

      await queryInterface.changeColumn('sessions', 'privateId', {
        type: Sequelize.UUID,
        allowNull: false,
      }, { transaction });
      await queryInterface.addIndex('sessions', ['privateId'], {
        unique: true,
        name: 'sessions_private_id_unique',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await rewriteAllEndpoints(queryInterface, transaction, 'down');
      await queryInterface.removeIndex('sessions', 'sessions_private_id_unique', { transaction });
      await queryInterface.removeColumn('sessions', 'privateId', { transaction });
    });
  },
};
