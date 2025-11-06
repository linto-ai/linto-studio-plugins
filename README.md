# E-Meeting

## Introduction

E-Meeting is a set of tools designed to operate and manage, at scale, transcription sessions from inbound audiovisual streams. Particularly in enterprises or structures managing multiple meeting rooms, whether physical or virtual. A transcription session is essentially a meeting where multiple speakers may speak different languages. 

The project connects multiple automatic speech recognition (ASR) providers to enable transcription of multilingual meetings. Its primary objective is to provide users with live closed captions and the ability to download transcripts of past sessions. In other words, the project bridges audio streams, with SRT streams as a first-class citizen, to ASR providers and manages transcripts, including real-time delivery and downloadable artifacts.

This mono-repo contains the source code for several separate applications that can be run independently (modules). Each module has its own README and is intented to get containerized and used as orchestrated services (microservices). This mono-repo also provides some tools usable for development and testing purposes only and not intended for production. I.E `npm start` provides a way to run all modules locally and test the entire system using `npm start`. Check package.json and subsequent modules package.json for test commands.

If you are using this project locally, it is important to remember to run the following command:
```bash
npm i
```
This command should be run inside every module of the global project, as well as at the root of the mono-repo and the "lib" folder. This will ensure that all necessary dependencies are installed and the project can be run without any issues.

## Documentation reference

[E-meeting - Developer & Sysadmin - Complete Deployment documentation](./doc/eMeeting%20–%20Developer%20&%20Sysadmin%20Documentation%20807b4e58701444e28f4543a603f0b201.md)

[E-meeting - User Quickstart (pdf)](./doc/Open%20Source%20Speech%20Quickstart.pdf)

[E-Meeting - Architecture overview (pdf)](./doc/Technical%20Architecture%20Overview.pdf)

## Quickstart

To quickly test this project, you can use either a local build or docker compose. You have several options briefly presented below.
For more thorough post-install walkthrough, please refer to [E-meeting - User Quickstart (pdf)](./doc/Open%20Source%20Speech%20Quickstart.pdf)

### Run locally

Here are the steps to follow:

1. make install-local

This command will build all npm packages.

2. make run-dev

This command will start all the services locally.
You may need to use docker for the broker and the database.


### Run with docker compose

1. Create a `.env` file at the root of the project with this content:

```
DB_USER=myuser
DB_PASSWORD=mypass
DB_NAME=mydb
DB_PORT=5433

STREAMING_PASSPHRASE=test
STREAMING_USE_PROXY=false
STREAMING_PROXY_SRT_HOST=localhost
STREAMING_PROXY_RTMP_HOST=localhost
STREAMING_PROXY_WS_HOST=localhost
STREAMING_PROTOCOLS=SRT,WS,RTMP
STREAMING_WS_TCP_PORT=9012
STREAMING_PROXY_WS_TCP_PORT=9012
STREAMING_RTMP_TCP_PORT=9013
STREAMING_PROXY_RTMP_TCP_PORT=9013

BROKER_PORT=1883
SESSION_API_WEBSERVER_HTTP_PORT=8002
TRANSCRIBER_REPLICAS=1
```

2. Run the docker-compose command:

```
make run-docker-dev
```

This compose file will compile all the docker images and launch all the containers.
This will allow you to test the API and transcription.


### Initialize the app

1. Add a transcriber profile:

Log in to the session API available here: http://localhost:8002/api-docs/
In the POST /transcriber_profiles section, add the following json:

```
{
  "config": {
    "type": "microsoft",
    "name": "microsoft_custom_fr",
    "description": "microsoft custom fr",
    "languages": [
      {
        "candidate": "LANG (fr-FR for example)",
        "endpoint": "ENDPOINT"
      }
    ],
    "key": "KEY",
    "region": "REGION",
    "endpoint": "ENDPOINT"
  }
}
```

2. Create and start a session:

- In the session API POST /sessions, create a new session with the following json:

```
{
  "name": "test session",
  "channels": [
    {
      "name": "test channel",
      "transcriberProfileId": 1
    }
  ]
}
```

- Retrieve the session id from the request return
- Retrieve your channel's streaming endpoint via GET sessions/ID

3. Stream

You are now ready to receive real-time transcription. For this, send your SRT stream to the streaming endpoint.
You can use a command like this:

```
gst-launch-1.0 filesrc location=./fr.mp3 ! decodebin ! audioconvert ! audioresample ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtsink uri="srt://127.0.0.1:8889?mode=caller"
```

Or like this for RTMP:

```
gst-launch-1.0 -v filesrc location=./fr.mp3 ! decodebin ! audioconvert ! audioresample ! avenc_aac ! flvmux ! rtmpsink location=rtmp://localhost:1935/live/STREAM_NAME
```

**The streaming URL is the one provided by the session API.**


You should now see the transcriptions appearing in real time in the log and they are now accessible in the broker.


## Routes

Once the service is launched, several routes are accessible:

### Session API

- http://localhost:8002/api-docs/ -> This route allows access to the Swagger interface for configuring sessions.

## Structure

The project structure includes the following modules:
- `Session-API`: an API to manage transcription sessions, also serves a front-end using Swagger client (Open API spec)
- `Transcriber`: a transcription service (streaming endpoint & relay to ASR services)
- `Scheduler`: a scheduling service that bridges the transcribers & subtitle-delivery with session manager, database, and message broker
- The `lib` folder contains generic tooling for the project as a whole and is treated as another Node.js package. It is required from the modules using the package.json local file API. This allows the modules to access the tools provided by the `lib` package and use them in their implementation.

See `doc` folder (developer informations) or specific READMEs within modules folders for more infos.

 
## System prerequisites

The modules are mainly writen in Node.JS 20+. You might use NVM for installing it (curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash)

To run, modules requires following system dependency.

```bash
sudo apt-get install build-essential
sudo apt-get install libgstreamer-plugins-base1.0-dev
sudo apt-get install gstreamer1.0-tools
sudo apt-get install libgstreamer1.0-dev
sudo apt-get install libsrt1.5-gnutls
sudo apt-get install srt-tools
sudo apt-get install libsrt-gnutls-dev
sudo apt-get install libsrt-openssl-dev
sudo apt-get install libssl-dev
sudo apt-get install gstreamer1.0-plugins
sudo apt-get install gstreamer1.0-plugins-base
sudo apt-get install gstreamer1.0-plugins-bad
sudo apt-get install gstreamer1.0-plugins-good
sudo apt-get install gstreamer1.0-libav
```

## Docker: How to build

All components are dockerized following the same process.
In each component, there is a Dockerfile and its associated docker-entrypoint.sh.
To compile the Docker image of a component, you must position yourself at the root of the git repository and not in the component, then launch the command:

```
docker build -f [COMPONENT]/Dockerfile .
```

For example, to build the `Transcriber`, launch the command:

```
docker build -f Transcriber/Dockerfile .
```

You can compile images in this way for the following components:

- Scheduler
- Session-API
- Transcriber
- migration

In practice, for local testing, there is no need to manually compile these images because Docker Compose will do it for you.


## Docker: How to run

In order to launch the Docker containers, 3 Docker Compose files are provided:
- compose.yml -> This is the base compose file defining the common properties of the different services.
- compose.prod.yml -> It is used for a secure HTTPS production deployment.
- compose.override.yml -> It is used for local deployment in order to perform manual tests.
- compose.test.yml -> It is specifically used in integration tests launched by the integration-test.sh script.

To make use of Docker Compose, it is recommended to refer to the quickstart section which guides you step by step through the complete launch of the service.

### Development vs Production Mode

The docker-entrypoint.sh scripts used in each service image (Transcriber, Session-API, Scheduler, migration) support two modes of operation controlled by the `DEVELOPMENT` environment variable:

**Development Mode (`DEVELOPMENT=true`):**
- Skips all file ownership changes to preserve host file ownership on volume mounts
- Enabled by default in `compose.override.yml` for local development
- Recommended when using volume mounts for live code reloading

**Production Mode (default):**
- Adjusts file ownership to the configured `USER_ID` and `GROUP_ID` (defaults to 33:33)
- Excludes `node_modules` directories from ownership changes for performance
- Ensures proper permissions for containerized deployment
- Used in production and when `DEVELOPMENT` is unset or not equal to "true"


## Integration with LinTO Studio

It is recommended to use this toolbox with LinTO Studio, which benefits from full integration.
To facilitate the integration, the following elements have been specially added to the code:

- a Git submodule located in the linto-studio folder at the root of the project
- a compose.linto-studio.yml and compose.linto-studio-override.yml file allowing the use of the linto-studio compose files without modification and adapting them to the context of the toolbox
- an environment file .envdefault.linto.docker allowing the configuration of LinTO Studio's environment variables from the Toolbox
- a Makefile target allowing everything to be easily launched with a single command


### Quickstart E-Meeting + LinTO Studio


To initialize the submodule if you have already cloned the repository:

```
git submodule update --init --recursive
```


To clone the repository directly with the linto-studio module:

```
git clone --recurse-submodules https://code.europa.eu/speech_recognition/speech-to-text.git

```

And now, start all the services with a single command:

```
make run-docker-dev-linto-studio
```

You can now connect to LinTO Studio at the URL http://localhost:8003

## Security

Transcriber profiles may contain API keys.
By default, these keys are not encrypted, but the API does not return them in GET requests.
However, it is possible to encrypt them using two environment variables:

- SECURITY_CRYPT_KEY → The security key
- SECURITY_SALT_FILEPATH → A path to a file containing the salt (optional)

For the salt, a file path is required as it further reduces the attack surface:
to decrypt the key, access is needed to both the environment variables and the file system.

### Keys manipulation

The current keys can be encrypted using the following script from the Session API:

```
npm run encrypt-keys -- SECURITY_CRYPT_KEY=<my-key>  SECURITY_SALT_FILEPATH=<path-to-salt>
```

Additionally, if you wish to change the encryption keys, you can migrate all API keys using the following command:

```
npm run migrate-keys -- OLD_SECURITY_CRYPT_KEY=<my-key>  OLD_SECURITY_SALT_FILEPATH=<path-to-salt> NEW_SECURITY_CRYPT_KEY=<my-key>  NEW_SECURITY_SALT_FILEPATH=<path-to-salt>
```

## Tests

### Unit tests

The code being entirely event-driven, it is difficult to test it in a unitary way. For this reason, the unit tests have focused on very specific points. Specifically, the unit tests concern the circular buffer of the transcriber and are located in Transcriber/tests.js.

### Integration tests

In order to comprehensively test the project, integration tests have been added and are entirely carried out in a bash script named `integration-test.sh` at the root of the project. These tests validate several parts of the code:

- The correct launch of all services
- The creation of a session and the enrollment of the transcriber
- The start of the session and the initiation of the transcriber's pipeline
- Resilience when a transcriber crashes and recovers
- The streaming of SRT (SubRip Text) streams
- The recording of closed captions in the session
- The stopping of the session

After creating the `.envtest` file (as documented at the beginning of integration-test.sh), these tests can be simply run with ./integration-test.sh.

## Custom ASR

There are currently three ASRs available: Microsoft, LinTO, and Amazon.
They are located in Transcriber/ASR/linto, Transcriber/ASR/microsoft, and Transcriber/ASR/amazon.
You can use them as inspiration to create your own ASR.

Here are the rules to follow:

1. Create a folder named after your ASR. The name of the folder will be the name specified in the "type" field of your transcriber profile.
2. Create an `index.js` file in this folder.
3. This `index.js` must export the class of your ASR by default: module.exports = MyASRTranscriber;
4. Your ASR class must extend EventEmitter and implement the following API.
5. Your class must then emit the following events API using `this.emit`.

### API

- `start(): null` -> Connect to your ASR system
- `stop(): null` -> Disconnect to your ASR system and end ASR transactions
- `transcribe(buffer: Buffer): null` -> Buffer or raw audio to send to your ASR system.

The buffer can be configured with these environment variables:

- `MAX_AUDIO_BUFFER`: If ASR is down, keeps MAX_AUDIO_BUFFER seconds of audio to fast forward upon reconnection
- `MIN_AUDIO_BUFFER`: Send audio to ASR when buffer is at least MIN_AUDIO_BUFFER milliseconds long
- `BYTES_PER_SAMPLE`: 1 for 8-bit, 2 for 16-bit, 4 for 32-bit

```
class MyASRTranscriber extends EventEmitter {
    start() {}
    stop() {}
    transcribe(buffer) {}
}
```

### Event API

- `this.emit('connecting')` -> Called in the `start` function when the ASR connection is not ready yet
- `this.emit('ready')` -> Called in the `start` function when the ASR connexion is ready to work
- `this.emit('closed')` -> Called in the `stop` function when the ASR connexion is really closed.
- `this.emit('transcribing', text: string)` -> Called in the `transcribe` function for partial transcription. `text` is the partial transcription.
- `this.emit('transcribed', data: object)` -> Called in the `transcriber` function for final transcription. The `data` argument is an object with the following attributes:

```
const data = {
    "astart": ISO format datetime of the ASR session start,
    "text": The final transcription,
    "start": The number of seconds since the start of the transcription,
    "end": Start plus the duration of this transcription in seconds,
    "lang": The language,
    "locutor": The locutor (may be null),
}
```

- `this.emit('error', text: string)` -> Called when there is an error. `text` is the error message.

## Some useful documentation below

### GSTREAMER SRT CHEAT SHEET

https://github.com/matthew1000/gstreamer-cheat-sheet/blob/master/srt.md


### Consice info about SRT :

SRT is a protocol that enables the transfer of broadcast-grade video at low latencies, bridging the gap between video streaming and video calls. It achieves this by retransmitting lost packets for a certain amount of time, bounded by the configured latency, and guessing the available bandwidth to avoid sending at a rate that exceeds the link's capacity. This information is made available to the application, allowing it to adjust the encoding bitrate to ensure the best possible quality.

A typical example (video) would be to have have an encoder which is also a server with a pipeline like:

gst-launch-1.0 v4l2src ! video/x-raw, height=1080, width=1920 ! videoconvert ! x264enc tune=zerolatency ! video/x-h264, profile=high ! mpegtsmux ! srtserversink uri=srt://:8888/
And a receiver on the other side would receive it with a pipeline like this one:

gst-launch-1.0 srtclientsrc uri=srt://192.168.1.55:8888 ! decodebin ! autovideosink
Using tools like gst-launch, it's very easy to prototype SRT and it's integration into real world pipeline that can be used in real applications.

gst-launch-1.0 audiotestsrc ! audioconvert ! audioresample ! srtclientsink uri=srt://:8889

gst-launch-1.0 filesrc location=test.wav ! wavparse ! audioconvert ! audioresample  ! srtclientsink uri=srt://:8889
