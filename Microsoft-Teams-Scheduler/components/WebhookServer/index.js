const { Component, MqttClient, Model, logger } = require('live-srt-lib');
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

    // Azure credentials are required for this service
    const tenantId = process.env.MSTEAMS_SCHEDULER_AZURE_TENANT_ID;
    const clientId = process.env.MSTEAMS_SCHEDULER_AZURE_CLIENT_ID;
    const clientSecret = process.env.MSTEAMS_SCHEDULER_AZURE_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
      const missing = [];
      if (!tenantId) missing.push('MSTEAMS_SCHEDULER_AZURE_TENANT_ID');
      if (!clientId) missing.push('MSTEAMS_SCHEDULER_AZURE_CLIENT_ID');
      if (!clientSecret) missing.push('MSTEAMS_SCHEDULER_AZURE_CLIENT_SECRET');
      logger.error(`MS Teams Scheduler requires Azure credentials. Missing: ${missing.join(', ')}`);
      logger.error('Please configure these environment variables to use the MS Teams Scheduler service.');
      process.exit(1);
    }

    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default']
    });
    this.graph = Client.initWithMiddleware({ authProvider });

    this.client = new MqttClient({ uniqueId: 'teams-scheduler', pub: 'teams-scheduler', subs: ['msteams-scheduler/in/#'] });
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
            const graphSub = await this.createGraphSubscription(sub.graphUserId);
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

  async createGraphSubscription(graphUserId) {
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    return this.graph.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: `${process.env.MSTEAMS_SCHEDULER_PUBLIC_BASE}/notifications`,
      resource: `/users/${graphUserId}/events`,
      expirationDateTime: expires,
      clientState: 'linagora-webhook'
    });
  }

  async deleteGraphSubscription(graphSubscriptionId) {
    try {
      await this.graph.api(`/subscriptions/${graphSubscriptionId}`).delete();
    } catch (err) {
      logger.warn(`Failed to delete Graph subscription ${graphSubscriptionId}: ${err.message}`);
    }
  }

  async handleMqttMessage(topic, message) {
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
      const graphSub = await this.createGraphSubscription(graphUserId);
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
    } catch (err) {
      await Model.CalendarSubscription.update({ status: 'error' }, { where: { id: subscriptionId } });
      logger.error(`Failed to create Graph subscription for ${graphUserId}: ${err.message}`);
    }
  }

  async handleDeleteSubscription({ subscriptionId, graphSubscriptionId }) {
    if (graphSubscriptionId) {
      await this.deleteGraphSubscription(graphSubscriptionId);
    }
    this.subscriptions.delete(subscriptionId);
    logger.info(`Calendar subscription deleted: ${subscriptionId}`);
  }

  async renewSubscriptions() {
    for (const [subId, sub] of this.subscriptions) {
      if (!sub.graphSubscriptionId) continue;
      try {
        const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
        await this.graph.api(`/subscriptions/${sub.graphSubscriptionId}`).patch({
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
          const graphSub = await this.createGraphSubscription(sub.graphUserId);
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

        if (n.changeType === 'deleted') {
          await Model.MsTeamsEvent.destroy({ where: { eventId: n.resourceData.id } });
          continue;
        }

        const ev = await this.graph
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
