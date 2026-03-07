'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Fix FK constraints on transcriberProfileId to match Sequelize model (onDelete: SET NULL)
    // Both channels and channelTemplates were created without onDelete, defaulting to NO ACTION,
    // which prevents deleting a transcriber profile that is referenced.

    await queryInterface.removeConstraint('channelTemplates', 'channelTemplates_transcriberProfileId_fkey');
    await queryInterface.addConstraint('channelTemplates', {
      fields: ['transcriberProfileId'],
      type: 'foreign key',
      name: 'channelTemplates_transcriberProfileId_fkey',
      references: { table: 'transcriberProfiles', field: 'id' },
      onDelete: 'SET NULL',
    });

    await queryInterface.removeConstraint('channels', 'channels_transcriberProfileId_fkey');
    await queryInterface.addConstraint('channels', {
      fields: ['transcriberProfileId'],
      type: 'foreign key',
      name: 'channels_transcriberProfileId_fkey',
      references: { table: 'transcriberProfiles', field: 'id' },
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    // Revert to NO ACTION (original behavior)
    await queryInterface.removeConstraint('channelTemplates', 'channelTemplates_transcriberProfileId_fkey');
    await queryInterface.addConstraint('channelTemplates', {
      fields: ['transcriberProfileId'],
      type: 'foreign key',
      name: 'channelTemplates_transcriberProfileId_fkey',
      references: { table: 'transcriberProfiles', field: 'id' },
    });

    await queryInterface.removeConstraint('channels', 'channels_transcriberProfileId_fkey');
    await queryInterface.addConstraint('channels', {
      fields: ['transcriberProfileId'],
      type: 'foreign key',
      name: 'channels_transcriberProfileId_fkey',
      references: { table: 'transcriberProfiles', field: 'id' },
    });
  },
};
