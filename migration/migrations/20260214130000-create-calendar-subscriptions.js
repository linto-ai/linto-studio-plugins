'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('calendarSubscriptions', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      graphUserId: {
        type: Sequelize.STRING,
        allowNull: false
      },
      graphSubscriptionId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      graphSubscriptionExpiry: {
        type: Sequelize.DATE,
        allowNull: true
      },
      studioToken: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      organizationId: {
        type: Sequelize.STRING,
        allowNull: false
      },
      transcriberProfileId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'transcriberProfiles',
          key: 'id'
        }
      },
      translations: {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: []
      },
      diarization: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      keepAudio: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      enableDisplaySub: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'active'
      },
      createdBy: {
        type: Sequelize.STRING,
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

    // Index unique partiel : empêche 2 abonnements actifs pour le même user
    await queryInterface.addIndex('calendarSubscriptions', ['graphUserId'], {
      unique: true,
      where: { status: 'active' },
      name: 'idx_cal_sub_graph_user'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('calendarSubscriptions');
  }
};
