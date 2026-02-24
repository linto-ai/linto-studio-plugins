const { Component, MqttClient, Model, logger } = require('live-srt-lib');
const { resolveIntegrationConfig, getDecryptedCredentials } = require('live-srt-lib');
const express = require('express');
require('dotenv/config');
require('isomorphic-fetch');
const { Client } = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

class WebhookServer extends Component {
  constructor(app) {
    super(app);
    this.id = this.constructor.name;

    // Graph client pool: integrationConfigId -> Graph Client
    this.graphClients = new Map();

    // Fallback: if env vars present, create a fallback client (backward compat)
    const tenantId = process.env.MSTEAMS_SCHEDULER_AZURE_TENANT_ID;
    const clientId = process.env.MSTEAMS_SCHEDULER_AZURE_CLIENT_ID;
    const clientSecret = process.env.MSTEAMS_SCHEDULER_AZURE_CLIENT_SECRET;

    if (tenantId && clientId && clientSecret) {
      this.fallbackGraph = this._createGraphClient(tenantId, clientId, clientSecret);
      logger.info('MS Teams Scheduler: fallback Graph client created from environment variables');
    } else {
      this.fallbackGraph = null;
      logger.warn('MS Teams Scheduler: no Azure env vars found, will use DB-based credentials only');
    }

    this.client = new MqttClient({
      uniqueId: 'teams-scheduler',
      pub: 'teams-scheduler',
      subs: ['msteams-scheduler/in/#', 'integration-config/updated/+']
    });
    this.client.on('ready', () => this.client.publishStatus());
    this.client.on('message', (topic, message) => this.handleMqttMessage(topic, message));

    this.subscriptions = new Map();

    this.express = express();
    this.express.use(express.json({ limit: '1mb' }));
    this.express.set('trust proxy', true);

    require('./routes/router.js')(this);

    const port = process.env.MSTEAMS_SCHEDULER_PORT || 8080;
    this.httpServer = this.express.listen(port, async () => {
      logger.info(`Teams webhook listening on :${port}`);
      try {
        const subs = await Model.CalendarSubscription.findAll({ where: { status: 'active' } });
        for (const sub of subs) {
          try {
            const graphClient = await this.getGraphClientForSubscription(sub);
            if (!graphClient) {
              await Model.CalendarSubscription.update({ status: 'error' }, { where: { id: sub.id } });
              logger.error(`No Graph client available for subscription ${sub.id} (org: ${sub.organizationId})`);
              continue;
            }
            const graphSub = await this.createGraphSubscription(sub.graphUserId, graphClient);
            await Model.CalendarSubscription.update(
              { graphSubscriptionId: graphSub.id, graphSubscriptionExpiry: graphSub.expirationDateTime, status: 'active' },
              { where: { id: sub.id } }
            );
            this.subscriptions.set(sub.id, { ...sub.toJSON(), graphSubscriptionId: graphSub.id });
            logger.info(`Graph subscription restored for user ${sub.graphUserId}: ${graphSub.id}`);
          } catch (err) {
            await Model.CalendarSubscription.update({ status: 'error' }, { where: { id: sub.id } });
            logger.error(`Failed to restore subscription for ${sub.graphUserId}: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error('Failed to initialize subscriptions:', err.message);
      }
    });

    this.express.use((req, res, next) => {
      res.status(404);
      res.end();
    });
    this.express.use((err, req, res, next) => {
      res.status(err.status || 500);
      res.json({ error: err.message });
    });

    setInterval(() => this.checkEvents(), 60 * 1000);
    setInterval(() => this.renewSubscriptions(), 12 * 60 * 60 * 1000);
    return this.init();
  }

  _createGraphClient(tenantId, clientId, clientSecret) {
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default']
    });
    return Client.initWithMiddleware({ authProvider });
  }

  async getGraphClient(integrationConfigId) {
    if (this.graphClients.has(integrationConfigId)) {
      return this.graphClients.get(integrationConfigId);
    }

    try {
      const config = await Model.IntegrationConfig.findByPk(integrationConfigId);
      if (!config || !config.config) {
        logger.warn(`No integration config found for ${integrationConfigId}, using fallback`);
        return this.fallbackGraph;
      }

      const credentials = JSON.parse(getDecryptedCredentials(config));
      const { tenantId, clientId, clientSecret } = credentials;
      if (!tenantId || !clientId || !clientSecret) {
        logger.warn(`Incomplete credentials for config ${integrationConfigId}, using fallback`);
        return this.fallbackGraph;
      }

      const graphClient = this._createGraphClient(tenantId, clientId, clientSecret);
      this.graphClients.set(integrationConfigId, graphClient);
      return graphClient;
    } catch (err) {
      logger.error(`Failed to create Graph client for config ${integrationConfigId}: ${err.message}`);
      return this.fallbackGraph;
    }
  }

  async getGraphClientForSubscription(subscription) {
    try {
      const result = await resolveIntegrationConfig(subscription.organizationId, 'teams');
      if (result && result.config) {
        return this.getGraphClient(result.config.id);
      }
    } catch (err) {
      logger.warn(`Failed to resolve integration config for org ${subscription.organizationId}: ${err.message}`);
    }
    return this.fallbackGraph;
  }

  invalidateGraphClient(integrationConfigId) {
    if (this.graphClients.has(integrationConfigId)) {
      this.graphClients.delete(integrationConfigId);
      logger.debug(`Invalidated Graph client cache for config ${integrationConfigId}`);
    }
  }

  async createGraphSubscription(graphUserId, graphClient) {
    const client = graphClient || this.fallbackGraph;
    if (!client) throw new Error('No Graph client available');
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    return client.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: `${process.env.MSTEAMS_SCHEDULER_PUBLIC_BASE}/notifications`,
      resource: `/users/${graphUserId}/events`,
      expirationDateTime: expires,
      clientState: 'linagora-webhook'
    });
  }

  async deleteGraphSubscription(graphSubscriptionId, graphClient) {
    const client = graphClient || this.fallbackGraph;
    if (!client) {
      logger.warn(`No Graph client available to delete subscription ${graphSubscriptionId}`);
      return;
    }
    try {
      await client.api(`/subscriptions/${graphSubscriptionId}`).delete();
    } catch (err) {
      logger.warn(`Failed to delete Graph subscription ${graphSubscriptionId}: ${err.message}`);
    }
  }

  async handleMqttMessage(topic, message) {
    // Handle integration config cache invalidation
    if (topic.startsWith('integration-config/updated/')) {
      const configId = topic.split('/')[2];
      this.invalidateGraphClient(configId);
      return;
    }

    const data = JSON.parse(message.toString());
    if (topic === 'msteams-scheduler/in/subscription/create') {
      await this.handleCreateSubscription(data);
    } else if (topic === 'msteams-scheduler/in/subscription/delete') {
      await this.handleDeleteSubscription(data);
    }
  }

  async handleCreateSubscription({ subscriptionId, graphUserId, studioToken, organizationId,
    transcriberProfileId, translations, diarization, keepAudio, enableDisplaySub }) {
    try {
      const sub = { organizationId };
      const graphClient = await this.getGraphClientForSubscription(sub);
      if (!graphClient) throw new Error('No Graph client available');

      const graphSub = await this.createGraphSubscription(graphUserId, graphClient);
      await Model.CalendarSubscription.update(
        { graphSubscriptionId: graphSub.id, graphSubscriptionExpiry: graphSub.expirationDateTime, status: 'active' },
        { where: { id: subscriptionId } }
      );
      this.subscriptions.set(subscriptionId, {
        id: subscriptionId, graphUserId, graphSubscriptionId: graphSub.id,
        studioToken, organizationId, transcriberProfileId,
        translations, diarization, keepAudio, enableDisplaySub
      });
      logger.info(`Calendar subscription created: ${subscriptionId} for user ${graphUserId}`);

      await this.fetchExistingEvents(subscriptionId, graphUserId);
    } catch (err) {
      await Model.CalendarSubscription.update({ status: 'error' }, { where: { id: subscriptionId } });
      logger.error(`Failed to create Graph subscription for ${graphUserId}: ${err.message}`);
    }
  }

  async fetchExistingEvents(subscriptionId, graphUserId) {
    try {
      const sub = this.subscriptions.get(subscriptionId);
      const graphClient = sub ? await this.getGraphClientForSubscription(sub) : this.fallbackGraph;
      if (!graphClient) {
        logger.error(`No Graph client available to fetch events for subscription ${subscriptionId}`);
        return;
      }

      const now = new Date().toISOString();
      const events = await graphClient
        .api(`/users/${graphUserId}/events`)
        .filter(`start/dateTime ge '${now}'`)
        .select('id,subject,start,end,onlineMeeting,isOnlineMeeting')
        .top(50)
        .get();

      let count = 0;
      for (const ev of events.value ?? []) {
        const joinUrl = ev.onlineMeeting?.joinUrl || null;
        await Model.MsTeamsEvent.upsert({
          eventId: ev.id,
          subject: ev.subject,
          startDateTime: ev.start.dateTime,
          endDateTime: ev.end.dateTime,
          meetingJoinUrl: joinUrl,
          calendarSubscriptionId: subscriptionId,
          processed: false
        }, { where: { eventId: ev.id } });
        count++;
      }

      logger.info(`Fetched ${count} existing events for user ${graphUserId}`);
    } catch (err) {
      logger.error(`Failed to fetch existing events for user ${graphUserId}: ${err.message}`);
    }
  }

  async handleDeleteSubscription({ subscriptionId, graphSubscriptionId }) {
    if (graphSubscriptionId) {
      const sub = this.subscriptions.get(subscriptionId);
      const graphClient = sub ? await this.getGraphClientForSubscription(sub) : this.fallbackGraph;
      await this.deleteGraphSubscription(graphSubscriptionId, graphClient);
    }
    this.subscriptions.delete(subscriptionId);
    logger.info(`Calendar subscription deleted: ${subscriptionId}`);
  }

  async renewSubscriptions() {
    for (const [subId, sub] of this.subscriptions) {
      if (!sub.graphSubscriptionId) continue;
      try {
        const graphClient = await this.getGraphClientForSubscription(sub);
        if (!graphClient) {
          logger.warn(`No Graph client available to renew subscription ${sub.graphSubscriptionId}`);
          continue;
        }
        const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
        await graphClient.api(`/subscriptions/${sub.graphSubscriptionId}`).patch({
          expirationDateTime: expires
        });
        await Model.CalendarSubscription.update(
          { graphSubscriptionExpiry: expires },
          { where: { id: subId } }
        );
        logger.debug(`Renewed Graph subscription ${sub.graphSubscriptionId}`);
      } catch (err) {
        logger.error(`Failed to renew subscription ${sub.graphSubscriptionId}: ${err.message}`);
        try {
          const graphClient = await this.getGraphClientForSubscription(sub);
          if (!graphClient) continue;
          const graphSub = await this.createGraphSubscription(sub.graphUserId, graphClient);
          sub.graphSubscriptionId = graphSub.id;
          await Model.CalendarSubscription.update(
            { graphSubscriptionId: graphSub.id, graphSubscriptionExpiry: graphSub.expirationDateTime },
            { where: { id: subId } }
          );
        } catch (retryErr) {
          await Model.CalendarSubscription.update({ status: 'error' }, { where: { id: subId } });
          logger.error(`Failed to recreate subscription for ${sub.graphUserId}: ${retryErr.message}`);
        }
      }
    }
  }

  async handleNotification(req, res) {
    if (req.query.validationToken) {
      return res.status(200).send(req.query.validationToken);
    }

    for (const n of req.body.value ?? []) {
      try {
        const resourceParts = n.resource.split('/');
        const graphUserId = resourceParts[1];

        const subscription = Array.from(this.subscriptions.values())
          .find(s => s.graphUserId === graphUserId);

        if (!subscription) {
          logger.debug(`No calendar subscription found for userId ${graphUserId}, ignoring`);
          continue;
        }

        const graphClient = await this.getGraphClientForSubscription(subscription);
        if (!graphClient) {
          logger.error(`No Graph client available for notification from user ${graphUserId}`);
          continue;
        }

        if (n.changeType === 'deleted') {
          await Model.MsTeamsEvent.destroy({ where: { eventId: n.resourceData.id } });
          continue;
        }

        const ev = await graphClient
          .api(`/users/${graphUserId}/events/${n.resourceData.id}`)
          .select('subject,start,end,onlineMeeting,isOnlineMeeting')
          .get();

        const joinUrl = ev.onlineMeeting?.joinUrl || null;

        await Model.MsTeamsEvent.upsert({
          eventId: n.resourceData.id,
          subject: ev.subject,
          startDateTime: ev.start.dateTime,
          endDateTime: ev.end.dateTime,
          meetingJoinUrl: joinUrl,
          calendarSubscriptionId: subscription.id,
          processed: false
        }, { where: { eventId: n.resourceData.id } });

        logger.debug(`[${n.changeType}] event ${n.resourceData.id} for user ${graphUserId} (joinUrl: ${joinUrl ? 'yes' : 'no'})`);
      } catch (err) {
        logger.error(`Error processing notification: ${err.message}`);
      }
    }
    res.sendStatus(202);
  }

  async checkEvents() {
    const { createLinTOClient } = require('../../utils/lintoSdk');
    const now = new Date();

    const events = await Model.MsTeamsEvent.findAll({
      where: {
        processed: false,
        startDateTime: { [Model.Op.lte]: now },
        meetingJoinUrl: { [Model.Op.not]: null }
      },
      include: [{
        model: Model.CalendarSubscription,
        as: 'calendarSubscription',
        where: { status: 'active' }
      }]
    });

    for (const ev of events) {
      try {
        const sub = ev.calendarSubscription;
        logger.info(`Processing scheduled event: ${ev.subject} (joinUrl: ${ev.meetingJoinUrl})`);

        const client = await createLinTOClient(sub.studioToken);

        const channelConfig = {
          transcriberProfileId: sub.transcriberProfileId,
          diarization: sub.diarization,
          enableLiveTranscripts: true,
          keepAudio: sub.keepAudio
        };
        if (Array.isArray(sub.translations) && sub.translations.length > 0) {
          channelConfig.translations = sub.translations;
        }

        const session = await client.createSession({ channels: [channelConfig] });
        const sessionId = session.id;
        const channelId = session.channels?.[0]?.id;

        if (!channelId) {
          logger.error(`Session ${sessionId} created but no channel returned for event ${ev.eventId}`);
          continue;
        }

        await client.createBot({
          url: ev.meetingJoinUrl,
          channelId,
          provider: 'teams',
          enableDisplaySub: sub.enableDisplaySub
        });

        ev.processed = true;
        ev.sessionId = sessionId;
        await ev.save();

        logger.info(`Session ${sessionId} created for event "${ev.subject}"`);
      } catch (err) {
        logger.error(`Failed to process event ${ev.eventId}: ${err.message}`);
      }
    }
  }
}

module.exports = app => new WebhookServer(app);
