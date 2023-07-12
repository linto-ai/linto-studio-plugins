//Handle (well... local) events from the streaming server
// this is bind to the streaming server singleton component

module.exports = function () {
  let timeoutId = null;
  //This ensures that the publishStatus function is only called once after the last event is emitted, with a delay of 3 seconds.
  const debouncedPublishStatus = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      this.app.components['BrokerClient'].client.publishStatus();
      timeoutId = null;
    }, 3000);
  };

  for (const eventName of ['ready', 'connecting', 'closed', 'error', 'eos', 'streaming']) {
    this.on(eventName, (...args) => {
      const streamingServerInfo = {
        streamingServerStatus: eventName + args.join(' ')
      }
      this.app.components['BrokerClient'].client.registerDomainSpecificValues(streamingServerInfo)
      //status changes are handled by scheduler
      debouncedPublishStatus();
    });
  }
}