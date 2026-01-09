const { Component, MqttClient, Model, logger } = require('live-srt-lib');
const express = require('express');
const util = require('util');
require('dotenv/config');
require('isomorphic-fetch');
const { Client } = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

class WebhookServer extends Component {
  constructor(app) {
    super(app);
    this.id = this.constructor.name;

    const credential = new ClientSecretCredential(
      process.env.MSTEAMS_SCHEDULER_AZURE_TENANT_ID,
      process.env.MSTEAMS_SCHEDULER_AZURE_CLIENT_ID,
      process.env.MSTEAMS_SCHEDULER_AZURE_CLIENT_SECRET
    );
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default']
    });
    this.graph = Client.initWithMiddleware({ authProvider });

    this.client = new MqttClient({ uniqueId: 'teams-scheduler', pub: 'teams-scheduler', subs: [] });
    this.client.on('ready', () => this.client.publishStatus());

    this.express = express();
    this.express.use(express.json({ limit: '1mb' }));
    this.express.set('trust proxy', true);

    require('./routes/router.js')(this);

    const port = process.env.MSTEAMS_SCHEDULER_PORT || 8080;
    this.httpServer = this.express.listen(port, async () => {
      logger.info(`Teams webhook listening on :${port}`);
      try {
        const envUserId = process.env.MSTEAMS_SCHEDULER_USER_ID;
        if (envUserId) {
          // remove any previous default user not matching env value
          await Model.MsTeamsUser.destroy({
            where: { defaultUser: true, userId: { [Model.Op.ne]: envUserId } }
          });
          // ensure current default user exists
          const [user] = await Model.MsTeamsUser.findOrCreate({
            where: { userId: envUserId },
            defaults: { userId: envUserId, defaultUser: true }
          });
          if (!user.defaultUser) {
            user.defaultUser = true;
            await user.save();
          }
        }

        const users = await Model.MsTeamsUser.findAll();
        for (const u of users) {
          try {
            const sub = await this.ensureSubscription(u.userId);
            logger.info(`Subscription created for ${u.userId}: ${sub.id} valid until ${sub.expirationDateTime}`);
          } catch (err) {
            logger.error(`Failed to create subscription for ${u.userId}:`, err.message);
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
    return this.init();
  }

  async ensureSubscription(userId = process.env.MSTEAMS_SCHEDULER_USER_ID) {
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    return this.graph.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: `${process.env.MSTEAMS_SCHEDULER_PUBLIC_BASE}/notifications`,
      resource: `/users/${userId}/events`,
      expirationDateTime: expires,
      clientState: 'linagora-webhook'
    });
  }

  async handleNotification(req, res) {
    console.log(util.inspect({ method: req.method, url: req.originalUrl, headers: req.headers, query: req.query, body: req.body }, { depth: null, colors: true }));

    if (req.query.validationToken)
      return res.status(200).send(req.query.validationToken);

    for (const n of req.body.value ?? []) {
      logger.debug(`[${n.changeType}] event ${n.resourceData.id}`);
      if (n.changeType !== 'deleted') {
        const ev = await this.graph
          .api(`/users/${process.env.MSTEAMS_SCHEDULER_USER_ID}/events/${n.resourceData.id}`)
          .select('subject,start,end')
          .get();
        await Model.MsTeamsEvent.upsert({
          eventId: n.resourceData.id,
          subject: ev.subject,
          startDateTime: ev.start.dateTime,
          endDateTime: ev.end.dateTime,
          processed: false
        }, { where: { eventId: n.resourceData.id } });
      } else {
        await Model.MsTeamsEvent.destroy({ where: { eventId: n.resourceData.id } });
      }
    }
    res.sendStatus(202);
  }

  async checkEvents() {
    const now = new Date();
    const events = await Model.MsTeamsEvent.findAll({
      where: {
        processed: false,
        startDateTime: { [Model.Op.lte]: now }
      }
    });
    for (const ev of events) {
      this.client.publish('scheduler/in/schedule/startbot', { eventId: ev.eventId, subject: ev.subject }, 1, false, true);
      ev.processed = true;
      await ev.save();
    }
  }
}

module.exports = app => new WebhookServer(app);
