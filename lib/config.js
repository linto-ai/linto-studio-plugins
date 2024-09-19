const debug = require('debug')('lib:config');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');


function ifHasNotThrow(element, error) {
    if (!element) throw error;
    return element;
}

function ifHas(element, defaultValue) {
    if (!element) return defaultValue;
    return element;
}

function configureDefaults() {
    try {
        dotenv.config({ path: path.join(__dirname, '..', '.env') }); // loads process.env from .env file (if not specified by the system)
        const envdefault = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.envdefault'))); // default usable values
        
        // Database
        process.env.DB_HOST = ifHas(process.env.DB_HOST, envdefault.DB_HOST);
        process.env.DB_PORT = ifHas(process.env.DB_PORT, envdefault.DB_PORT);
        process.env.DB_USER = ifHas(process.env.DB_USER, envdefault.DB_USER);
        process.env.DB_PASSWORD = ifHas(process.env.DB_PASSWORD, envdefault.DB_PASSWORD);
        process.env.DB_NAME = ifHas(process.env.DB_NAME, envdefault.DB_NAME);

        // Applications
        process.env.TRANSCRIBER_COMPONENTS = ifHas(process.env.TRANSCRIBER_COMPONENTS, envdefault.TRANSCRIBER_COMPONENTS); // you might not want to change this
        process.env.SCHEDULER_COMPONENTS = ifHas(process.env.SCHEDULER_COMPONENTS, envdefault.SCHEDULER_COMPONENTS); // you might not want to change this
        process.env.SESSION_API_COMPONENTS = ifHas(process.env.SESSION_API_COMPONENTS, envdefault.SESSION_API_COMPONENTS); // you might not want to change this
        process.env.DELIVERY_COMPONENTS = ifHas(process.env.DELIVERY_COMPONENTS, envdefault.DELIVERY_COMPONENTS); // you might not want to change this

        // Streaming server
        process.env.STREAMING_PASSPHRASE = ifHas(process.env.STREAMING_PASSPHRASE, envdefault.STREAMING_PASSPHRASE);
        if (process.env.STREAMING_PASSPHRASE && process.env.STREAMING_PASSPHRASE !== 'false' && process.env.STREAMING_PASSPHRASE.length < 10) {
            process.env.STREAMING_PASSPHRASE = '';
            console.error(debug.namespace, 'Passphrase must be at least 10 characters long. Disabling passphrase.');
        }
        process.env.STREAMING_HOST = ifHas(process.env.STREAMING_HOST, envdefault.STREAMING_HOST);
        process.env.STREAMING_PROTOCOLS = ifHas(process.env.STREAMING_PROTOCOLS, envdefault.STREAMING_PROTOCOLS);
        process.env.STREAMING_SRT_MODE = ifHas(process.env.STREAMING_SRT_MODE, envdefault.STREAMING_SRT_MODE);
        process.env.STREAMING_SRT_UDP_PORT = ifHas(process.env.STREAMING_SRT_UDP_PORT, envdefault.STREAMING_SRT_UDP_PORT);
        process.env.STREAMING_RTMP_TCP_PORT = ifHas(process.env.STREAMING_RTMP_TCP_PORT, envdefault.STREAMING_RTMP_TCP_PORT);
        process.env.STREAMING_WS_TCP_PORT = ifHas(process.env.STREAMING_WS_TCP_PORT, envdefault.STREAMING_WS_TCP_PORT);
        process.env.STREAMING_PROXY_HOST = ifHas(process.env.STREAMING_PROXY_HOST, envdefault.STREAMING_PROXY_HOST);
        process.env.STREAMING_PROXY_SRT_UDP_PORT = ifHas(process.env.STREAMING_PROXY_SRT_UDP_PORT, envdefault.STREAMING_PROXY_SRT_UDP_PORT);
        process.env.STREAMING_PROXY_RTMP_TCP_PORT = ifHas(process.env.STREAMING_PROXY_RTMP_TCP_PORT, envdefault.STREAMING_PROXY_RTMP_TCP_PORT);
        process.env.STREAMING_PROXY_WS_TCP_PORT = ifHas(process.env.STREAMING_PROXY_WS_TCP_PORT, envdefault.STREAMING_PROXY_WS_TCP_PORT);
        process.env.STREAMING_HEALTHCHECK_TCP = ifHas(process.env.STREAMING_HEALTHCHECK_TCP, envdefault.STREAMING_HEALTHCHECK_TCP);

        // Audio streaming configuration
        process.env.MAX_AUDIO_BUFFER = ifHas(process.env.MAX_AUDIO_BUFFER, envdefault.MAX_AUDIO_BUFFER);
        process.env.MIN_AUDIO_BUFFER = ifHas(process.env.MIN_AUDIO_BUFFER, envdefault.MIN_AUDIO_BUFFER);
        process.env.BYTES_PER_SAMPLE = ifHas(process.env.BYTES_PER_SAMPLE, envdefault.BYTES_PER_SAMPLE);
        process.env.SAMPLE_RATE = ifHas(process.env.SAMPLE_RATE, envdefault.SAMPLE_RATE);
        process.env.AUDIO_STORAGE_PATH = ifHas(process.env.AUDIO_STORAGE_PATH, envdefault.AUDIO_STORAGE_PATH);

        // Broker
        process.env.BROKER_HOST = ifHas(process.env.BROKER_HOST, envdefault.BROKER_HOST);
        process.env.BROKER_PORT = ifHas(process.env.BROKER_PORT, envdefault.BROKER_PORT);
        process.env.BROKER_USERNAME = ifHas(process.env.BROKER_USERNAME, envdefault.BROKER_USERNAME);
        process.env.BROKER_PASSWORD = ifHas(process.env.BROKER_PASSWORD, envdefault.BROKER_PASSWORD);
        process.env.BROKER_PROTOCOL = ifHas(process.env.BROKER_PROTOCOL, envdefault.BROKER_PROTOCOL);
        process.env.BROKER_KEEPALIVE = ifHas(process.env.BROKER_KEEPALIVE, envdefault.BROKER_KEEPALIVE);

        // Front end
        process.env.FRONT_END_PUBLIC_URL = ifHas(process.env.FRONT_END_PUBLIC_URL, envdefault.FRONT_END_PUBLIC_URL);

        // Delivery
        process.env.DELIVERY_PUBLIC_URL = ifHas(process.env.DELIVERY_PUBLIC_URL, envdefault.DELIVERY_PUBLIC_URL);
        process.env.DELIVERY_WS_PUBLIC_URL = ifHas(process.env.DELIVERY_WS_PUBLIC_URL, envdefault.DELIVERY_WS_PUBLIC_URL);
        process.env.DELIVERY_SESSION_URL = ifHas(process.env.DELIVERY_SESSION_URL, envdefault.DELIVERY_SESSION_URL);
        process.env.DELIVERY_ALLOWED_DOMAINS = ifHas(process.env.DELIVERY_ALLOWED_DOMAINS, envdefault.DELIVERY_ALLOWED_DOMAINS);

        // ASR
        process.env.TRANSCRIBER_BOT_NAME = ifHas(process.env.TRANSCRIBER_BOT_NAME, envdefault.TRANSCRIBER_BOT_NAME);
        process.env.TRANSCRIBER_RESET_MESSAGE = ifHas(process.env.TRANSCRIBER_RESET_MESSAGE, envdefault.TRANSCRIBER_RESET_MESSAGE);
        process.env.ASR_AVAILABLE_TRANSLATIONS_MICROSOFT = ifHas(process.env.ASR_AVAILABLE_TRANSLATIONS_MICROSOFT, envdefault.ASR_AVAILABLE_TRANSLATIONS_MICROSOFT);
        process.env.ASR_HAS_DIARIZATION_MICROSOFT = ifHas(process.env.ASR_HAS_DIARIZATION_MICROSOFT, envdefault.ASR_HAS_DIARIZATION_MICROSOFT);

        // Session API
        process.env.SESSION_API_HOST = ifHas(process.env.SESSION_API_HOST, envdefault.SESSION_API_HOST);
        process.env.SESSION_API_WEBSERVER_HTTP_PORT = ifHas(process.env.SESSION_API_WEBSERVER_HTTP_PORT, envdefault.SESSION_API_WEBSERVER_HTTP_PORT);

    } catch (e) {
        console.error(debug.namespace, e);
        process.exit(1);
    }
}
module.exports = configureDefaults();
