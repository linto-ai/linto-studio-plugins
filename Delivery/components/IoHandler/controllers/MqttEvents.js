const debug = require('debug')('delivery:IoHandler:mqtt-events');

module.exports = function () {
  this.app.components['BrokerClient'].client.on('error', () => {
    this.app.components['IoHandler'].brokerKo()
  });

  this.app.components['BrokerClient'].client.on('offline', () => {
    this.app.components['IoHandler'].brokerKo()
  });

  this.app.components['BrokerClient'].client.on('ready', () => {
    this.app.components['IoHandler'].brokerOk()
  });
}