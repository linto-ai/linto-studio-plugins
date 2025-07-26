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
      process.env.AZURE_TENANT_ID,
      process.env.AZURE_CLIENT_ID,
      process.env.AZURE_CLIENT_SECRET
    );
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default']
    });
    this.graph = Client.initWithMiddleware({ authProvider });

    this.client = new MqttClient({ uniqueId: 'teams-scheduler', pub: 'teams-scheduler', subs: [] });
    this.client.on('ready', () => this.client.publishStatus());

    this.express = express().use(express.json({ limit: '1mb' }));
    this.express.post('/notifications', this.handleNotification.bind(this));

    const port = process.env.PORT || 8080;
    this.httpServer = this.express.listen(port, async () => {
      logger.info(`Teams webhook listening on :${port}`);
      try {
        const sub = await this.ensureSubscription();
        logger.info(`Subscription created: ${sub.id} valid until ${sub.expirationDateTime}`);
      } catch (err) {
        logger.error('Failed to create subscription:', err.message);
      }
    });

    setInterval(() => this.checkEvents(), 60 * 1000);
    return this.init();
  }

  async ensureSubscription() {
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    return this.graph.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: `${process.env.PUBLIC_BASE}/notifications`,
      resource: `/users/${process.env.USER_ID}/events`,
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
          .api(`/users/${process.env.USER_ID}/events/${n.resourceData.id}`)
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
      this.client.publish('transcriber/in/startbot', { eventId: ev.eventId, subject: ev.subject }, 1, false, true);
      ev.processed = true;
      await ev.save();
    }
  }
}

module.exports = app => new WebhookServer(app);
