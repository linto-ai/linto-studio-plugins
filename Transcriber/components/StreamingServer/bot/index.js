const debug = require('debug')('transcriber:bot');
const { fork } = require('child_process');
const path = require('path');
const { launch, getStream } = require('puppeteer-stream');
const EventEmitter = require('events');

class Bot extends EventEmitter {
  constructor(session, channelId, address, botType) {
    super();
    this.worker = null
    this.botType = botType;
    this.session = session;
    this.channelId = channelId;
    this.address = address;
    this.browser = null;
    this.page = null;
    this.cleanupStream = null; // To store the cleanup function scoped to init()
    debug('Bot instance created');
  }

  async init() {
    try {
      debug('Loading manifest...');
      this.manifest = require(`./${this.botType}.json`);
    } catch (error) {
      debug(`Error loading manifest: ${error.message}`);
      throw error;
    }

    try {
      debug(`Initializing ${this.botType} Bot...`);
      let stream = null;

      this.cleanupStream = async () => {
        if (stream) {
          stream.destroy();
        }
        if (this.browser) {
          debug('Closing browser');
          await this.browser.close();
        }
        if (this.worker) {
          await this.worker.kill();
        }
        debug('Browser closed, stream destroyed, gstreamer worker killed');
      };

      this.browser = await launch({
        headless: 'new',
        executablePath: '/usr/bin/google-chrome-stable',
        //args: ["--mute-audio", "--auto-accept-camera-and-microphone-capture", '--use-fake-device-for-media-stream', '--allow-file-access', '--use-file-for-fake-audio-capture=/tmp/silence.wav'],
        args: [
          "--mute-audio",
          "--auto-accept-camera-and-microphone-capture",
          '--allow-file-access',
          `--disable-extensions-except=${path.resolve(__dirname, 'webcam')}`,
          `--load-extension=${path.resolve(__dirname, 'webcam')}`
        ],
      });
      debug('Browser launched');

      const context = this.browser.defaultBrowserContext();
      this.page = await context.newPage();
      debug(`Joining ${this.address}`);

      await this.page.goto(this.address, { timeout: 50000 }); // 60 seconds timeout
      debug('Page loaded');

      for (const rule of this.manifest) {
        switch (rule.action) {
          case 'goto':
            await this.page.goto(rule.url, { timeout: rule.timeout || 30000 });
            debug(`Navigated to ${action.url}`);
            break;
          case 'type':
            await this.page.type(rule.selector, rule.value);
            debug(`Typed ${rule.value} into ${rule.selector}`);
            break;
          case 'click':
            await this.page.click(rule.selector);
            debug(`Clicked on ${rule.selector}`);
            break;
          case 'waitForSelector':
            await this.page.waitForSelector(rule.selector, { timeout: rule.timeout || 30000 });
            debug(`Waited for selector ${rule.selector}`);
            break;
          case 'waitForTimeout':
            await this.page.waitForTimeout(rule.timeout);
            debug(`Waited for ${rule.timeout} ms`);
            break;
          case 'evaluate':
            await this.page.evaluate(rule.script);
            debug(`Evaluated script: ${rule.script}`);
            break;
          case 'select':
            await this.page.select(rule.selector, rule.value);
            debug(`Selected ${rule.value} from ${rule.selector}`);
            break;
          case 'hover':
            await this.page.hover(rule.selector);
            debug(`Hovered over ${rule.selector}`);
            break;
          case 'focus':
            await this.page.focus(rule.selector);
            debug(`Focused on ${rule.selector}`);
            break;
          case 'uploadFile':
            const input = await this.page.$(rule.selector);
            await input.uploadFile(rule.filePath);
            debug(`Uploaded file ${rule.filePath} to ${rule.selector}`);
            break;
          case 'screenshot':
            await this.page.screenshot({ path: rule.path });
            debug(`Took screenshot and saved to ${rule.path}`);
            break;
          case 'setViewport':
            await this.page.setViewport({ width: rule.width, height: rule.height });
            debug(`Set viewport to width: ${rule.width}, height: ${rule.height}`);
            break;
          case 'press':
            await this.page.keyboard.press(rule.key);
            debug(`Pressed key ${rule.key}`);
            break;
          case 'setUserAgent':
            await this.page.setUserAgent(rule.userAgent);
            debug(`Set user agent to ${rule.userAgent}`);
            break;
          case 'setCookie':
            await this.page.setCookie(...rule.cookies);
            debug(`Set cookies`);
            break;
          case 'deleteCookie':
            await this.page.deleteCookie(...rule.cookies);
            debug(`Deleted cookies`);
            break;
          case 'clearInput':
            await this.page.evaluate(selector => document.querySelector(selector).value = '', rule.selector);
            debug(`Cleared input field ${rule.selector}`);
            break;
          default:
            debug(`Unknown action: ${rule.action}`);
        }
      }


      stream = await getStream(this.page, { audio: true, video: false });
      debug('Screen sharing for audio capture started');
      //######## Create gstreamer worker
      debug('Spawn GStreamer worker for transcoding');
      this.worker = fork(path.join(__dirname, '../', 'GstreamerWorker.js'));
      this.worker.send({ type: 'init' });
      this.worker.on('message', (message) => {
        if (message.type === 'data') {
          this.emit('data', message.buf, this.session.id, this.channelId);
        }
        if (message.type === 'error') {
          console.error(`Worker ${this.worker.pid} error --> ${message.error}`);
        }
        if (message.type === 'playing') {
          debug(`Worker: ${this.worker.pid} --> transcoding session ${this.session.id}, channel ${this.channelId}`);
        }
      });
      this.worker.on('error', (error) => {
        console.error('Error from GStreamer worker:', error);
      });

      this.worker.on('exit', (code) => {
        // Remove the worker from the workers array
        debug(`Worker ${this.worker.pid} exited with code ${code}`);
      });

      //######## Handle stream events
      stream.on('data', (chunk) => {
        // send one direct buffer
        this.worker.send({ type: 'buffer', chunks: chunk });
      });

      stream.on('end', () => {
        debug('Stream ended');
        this.emit('session-end', this.session, this.channelId);
      });

      this.emit('session-start', this.session, this.channelId);
      debug('Session start event emitted');


    } catch (error) {
      debug(`Error during initialization: ${error.message}`);
      if (this.cleanupStream) {
        await this.cleanupStream();
      }
      return false
    }
    debug('Bot Initialization complete');
    return true
  }

  async updateCaptions(newText, final) {
    if (this.page) {
      await this.page.evaluate((text) => {
        const canvasStream = window.fakeWebcam;
        if (canvasStream) {
          canvasStream.setText(text);
        }
      }, newText);
      debug(`Updated text to: ${newText}`);
    } else {
      debug('Page is not initialized');
    }
  }

  async dispose() {
    if (this.cleanupStream) {
      await this.cleanupStream();
    }
  }
}

module.exports = Bot;
