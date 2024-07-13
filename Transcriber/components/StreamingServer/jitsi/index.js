const debug = require('debug')('transcriber:JitsiBot');
const { fork } = require('child_process');
const path = require('path');
const { launch, getStream } = require('puppeteer-stream');
const EventEmitter = require('events');

class JitsiBot extends EventEmitter {
  constructor(session, channelIndex, address) {
    super();
    this.worker = null
    this.session = session;
    this.channelIndex = channelIndex;
    this.address = address;
    this.browser = null;
    this.page = null;
    this.cleanupStream = null; // To store the cleanup function
    debug('JitsiBot instance created');
  }

  async init() {
    try {
      debug('Initializing JitsiBot...');

      // Correctly await the launch function to get the Browser instance
      this.browser = await launch({
        headless: 'new',
        executablePath: '/usr/bin/google-chrome-stable',
        args: [], // Required args for some environments
      });
      debug('Browser launched');

      // Now this.browser is correctly assigned, and the following operations can proceed
      const context = this.browser.defaultBrowserContext();
      context.clearPermissionOverrides();
      context.overridePermissions(this.address, ['microphone', 'camera']);
      this.page = await context.newPage();
      debug(`Joining ${this.address}`);

      await this.page.goto(this.address, { timeout: 50000 }); // 60 seconds timeout
      debug('Page loaded');

      await this.page.type('input.css-hh0z88-input', 'LinTO Bot');
      debug('Name input filled');

      await this.page.click('div.css-1hbmoh1-actionButton.primary');
      debug('Join button clicked');

      const stream = await getStream(this.page, { audio: true, video: false });

      //######## Create gstreamer worker
      this.worker = fork(path.join(__dirname,'../', 'GstreamerWorker.js'));
      this.worker.send({ type: 'init' });
      this.worker.on('message', (message) => {
        if (message.type === 'data') {
          this.emit('data', message.buf, this.session.id, this.channelIndex);
        }
        if (message.type === 'error') {
          console.error(`Worker ${this.worker.pid} error --> ${message.error}`);
        }
        if (message.type === 'playing') {
          debug(`Worker: ${this.worker.pid} --> transcoding session ${this.session.id}, channel ${this.channelIndex}`);
        }
      });
      this.worker.on('error', (error) => {
        console.error('Error from GStreamer worker:', error);
      });

      this.worker.on('exit', (code) => {
        console.log(`GStreamer worker exited with code ${code}`);
        // Remove the worker from the workers array
        const index = this.workers.indexOf(worker);
        if (index !== -1) {
          this.workers.splice(index, 1);
        }
      });

      //######## Handle stream events
      stream.on('data', (chunk) => {
        // send one direct buffer
        this.worker.send({ type: 'buffer', chunks: chunk });
      });

      stream.on('end', () => {
        debug('Stream ended');
        this.emit('session-end', this.session, this.channelIndex);
      });

      this.emit('session-start', this.session, this.channelIndex);
      debug('Session start event emitted');

      this.cleanupStream = async () => {
        await stream.destroy();
        await this.browser.close(); // Now this call will work as expected
        await this.worker.kill();
        debug('Browser closed and stream destroyed');
      };
    } catch (error) {
      debug(`Error during initialization: ${error.message}`);
      if (this.browser) {
        await this.browser.close(); // Ensure this call is within an async context
        debug('Browser closed due to an error');
      }
    }
  }

  async dispose() {
    if (this.cleanupStream) {
      await this.cleanupStream();
    }
  }
}

module.exports = JitsiBot;
