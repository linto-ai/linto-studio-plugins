const { logger } = require('live-srt-lib')
const { fork } = require('child_process');
const path = require('path');
const { launch, getStream } = require('puppeteer-stream');
const EventEmitter = require('events');

class Bot extends EventEmitter {
  constructor(session, channel, address, botType, enableDisplaySub) {
    super();
    this.worker = null
    this.botType = botType;
    this.enableDisplaySub = enableDisplaySub;
    this.session = session;
    this.channel = channel;
    this.address = address;
    this.browser = null;
    this.page = null;
    this.cleanupStream = null; // To store the cleanup function scoped to init()
    logger.debug('Bot instance created');
  }

  async init() {
    try {
      logger.debug('Loading manifest...');
      this.manifest = require(`./${this.botType}.json`);
    } catch (error) {
      logger.debug(`Error loading manifest: ${error.message}`);
      throw error;
    }

    try {
      logger.debug(`Initializing ${this.botType} Bot...`);
      let stream = null;

      this.cleanupStream = async () => {
        if (stream) {
          stream.destroy();
        }
        if (this.browser) {
          logger.debug('Closing browser');
          await this.browser.close();
        }
        if (this.worker) {
          await this.worker.kill();
        }
        logger.debug('Browser closed, stream destroyed, gstreamer worker killed');
      };

      this.browser = await launch({
        headless: 'new',
        executablePath: '/opt/chrome/chrome',
        //args: ["--mute-audio", "--auto-accept-camera-and-microphone-capture", '--use-fake-device-for-media-stream', '--allow-file-access', '--use-file-for-fake-audio-capture=/tmp/silence.wav'],
        args: [
          "--mute-audio",
          "--auto-accept-camera-and-microphone-capture",
          '--allow-file-access',
          `--disable-extensions-except=${path.resolve(__dirname, 'webcam')}`,
          `--load-extension=${path.resolve(__dirname, 'webcam')}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu'
        ],
      });
      logger.debug('Browser launched');

      const context = this.browser.defaultBrowserContext();
      this.page = await context.newPage();
      this.page.on('console', msg => {
        if (msg.type() === 'error') {
          logger.debug(`Puppeteer error: ${msg.text()}`);
        }
      });
      this.page.on('pageerror', err => {
          logger.debug(`Puppeteer global error: ${err.message}`);
      });

      // block external domains
      if(this.manifest.blockExternalDomains) {
        await this.page.setRequestInterception(true);
        const allowedDomain = new URL(this.address).hostname;
        this.page.on('request', (request) => {
          const url = request.url();

          if (!url.includes(allowedDomain) && !url.includes('chrome-extension')) {
            logger.debug(`Blocked request to: ${url}`);
            request.abort();
          } else {
            request.continue();
          }
        });
      }

      logger.debug(`Joining ${this.address}`);

      await this.page.goto(this.address, { timeout: 50000 }); // 50 seconds timeout
      logger.debug('Page loaded');

      for (const rule of this.manifest.loginRules) {
        await this.execRule(rule);
      }

      if (this.channel.enableLiveTranscripts && this.enableDisplaySub && this.manifest.subtitleRules) {
        for (const rule of this.manifest.subtitleRules) {
          await this.execRule(rule);
        }
      }

      stream = await getStream(this.page, { audio: true, video: false });
      logger.debug('Screen sharing for audio capture started');
      //######## Create gstreamer worker
      logger.debug('Spawn GStreamer worker for transcoding');
      this.worker = fork(path.join(__dirname, '../', 'GstreamerWorker.js'));
      this.worker.send({ type: 'init' });
      this.worker.on('message', (message) => {
        if (message.type === 'data') {
          this.emit('data', message.buf, this.session.id, this.channel.id);
        }
        if (message.type === 'error') {
          logger.error(`Worker ${this.worker.pid} error --> ${message.error}`);
        }
        if (message.type === 'playing') {
          logger.debug(`Worker: ${this.worker.pid} --> transcoding session ${this.session.id}, channel ${this.channel.id}`);
        }
      });
      this.worker.on('error', (error) => {
        logger.error('Error from GStreamer worker:', error);
      });

      this.worker.on('exit', (code) => {
        // Remove the worker from the workers array
        logger.debug(`Worker ${this.worker.pid} exited with code ${code}`);
      });

      //######## Handle stream events
      stream.on('data', (chunk) => {
        // send one direct buffer
        this.worker.send({ type: 'buffer', chunks: chunk });
      });

      stream.on('end', () => {
        logger.debug('Stream ended');
        this.emit('session-end', this.session, this.channel.id);
      });

      this.emit('session-start', this.session, this.channel);
      logger.debug('Session start event emitted');


    } catch (error) {
      logger.debug(`Error during initialization: ${error.message}`);
      if (this.cleanupStream) {
        await this.cleanupStream();
      }
      return false
    }
    logger.debug('Bot Initialization complete');
    return true
  }

  async configureCanvas(canvasConfig) {
    if (this.page) {
      await this.page.evaluate((canvasConfig) => {
        window.canvasConfiguration = canvasConfig;
      }, canvasConfig);
      logger.debug(`Update canvas config to: ${canvasConfig}`);
    } else {
      logger.debug('Page is not initialized');
    }
  }


  async updateCaptions(newText, final) {
    if (this.page) {
      await this.page.evaluate((text, final) => {
        const canvasStream = window.fakeWebcam;
        if (canvasStream) {
          canvasStream.setText(text, final);
        }
      }, newText, final);
      logger.debug(`Updated text to: ${newText}`);
    } else {
      logger.debug('Page is not initialized');
    }
  }

  async execRule(rule) {
    switch (rule.action) {
      case 'configureCanvas':
        await this.configureCanvas(rule.config);
        logger.debug(`Configure canvas to ${rule.config}`);
        break;
      case 'goto':
        await this.page.goto(rule.url, { timeout: rule.timeout || 30000 });
        logger.debug(`Navigated to ${rule.url}`);
        break;
      case 'type':
        await this.page.waitForSelector(rule.selector, { timeout: rule.timeout || 30000 });
        await this.page.type(rule.selector, rule.value);
        logger.debug(`Typed ${rule.value} into ${rule.selector}`);
        break;
      case 'click':
        await this.page.waitForSelector(rule.selector, { timeout: rule.timeout || 30000 });
        await this.page.click(rule.selector);
        logger.debug(`Clicked on ${rule.selector}`);
        break;
      case 'waitForSelector':
        await this.page.waitForSelector(rule.selector, { timeout: rule.timeout || 30000 });
        logger.debug(`Waited for selector ${rule.selector}`);
        break;
      case 'waitForTimeout':
        await new Promise(r => setTimeout(r, rule.timeout));
        logger.debug(`Waited for ${rule.timeout} ms`);
        break;
      case 'evaluate':
        await this.page.evaluate(rule.script);
        logger.debug(`Evaluated script: ${rule.script}`);
        break;
      case 'select':
        await this.page.waitForSelector(rule.selector, { timeout: rule.timeout || 30000 });
        await this.page.select(rule.selector, rule.value);
        logger.debug(`Selected ${rule.value} from ${rule.selector}`);
        break;
      case 'hover':
        await this.page.hover(rule.selector);
        logger.debug(`Hovered over ${rule.selector}`);
        break;
      case 'focus':
        await this.page.focus(rule.selector);
        logger.debug(`Focused on ${rule.selector}`);
        break;
      case 'uploadFile':
        const input = await this.page.$(rule.selector);
        await input.uploadFile(rule.filePath);
        logger.debug(`Uploaded file ${rule.filePath} to ${rule.selector}`);
        break;
      case 'screenshot':
        await this.page.screenshot({ path: rule.path });
        logger.debug(`Took screenshot and saved to ${rule.path}`);
        break;
      case 'setViewport':
        await this.page.setViewport({ width: rule.width, height: rule.height });
        logger.debug(`Set viewport to width: ${rule.width}, height: ${rule.height}`);
        break;
      case 'press':
        await this.page.keyboard.press(rule.key);
        logger.debug(`Pressed key ${rule.key}`);
        break;
      case 'setUserAgent':
        await this.page.setUserAgent(rule.userAgent);
        logger.debug(`Set user agent to ${rule.userAgent}`);
        break;
      case 'setCookie':
        await this.page.setCookie(...rule.cookies);
        logger.debug(`Set cookies`);
        break;
      case 'deleteCookie':
        await this.page.deleteCookie(...rule.cookies);
        logger.debug(`Deleted cookies`);
        break;
      case 'clearInput':
        await this.page.evaluate(selector => document.querySelector(selector).value = '', rule.selector);
        logger.debug(`Cleared input field ${rule.selector}`);
        break;
      default:
        logger.debug(`Unknown action: ${rule.action}`);
    }
  }

  async dispose() {
    if (this.cleanupStream) {
      await this.cleanupStream();
    }
  }
}

module.exports = Bot;
