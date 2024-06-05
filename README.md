# Live Transcription Open Source Toolbox

## Introduction

The Live Transcription Open Source Toolbox is a set of tools designed to operate and manage, at scale, transcription sessions from inbound audiovisual streams. Particularly in enterprises or structures managing multiple meeting rooms, whether physical or virtual. A transcription session is essentially a meeting where multiple speakers may speak different languages. 

The project connects multiple automatic speech recognition (ASR) providers to enable transcription of multilingual meetings. Its primary objective is to provide users with live closed captions and the ability to download transcripts of past sessions. In other words, the project bridges audio streams, with SRT streams as a first-class citizen, to ASR providers and manages transcripts, including real-time delivery and downloadable artifacts.

This mono-repo contains the source code for several separate applications that can be run independently (modules). Each module has its own README and is intented to get containerized and used as orchestrated services (microservices). This mono-repo also provides some tools usable for development and testing purposes only and not intended for production. I.E `npm start` provides a way to run all modules locally and test the entire system using `npm start`. Check package.json and subsequent modules package.json for test commands.

If you are using this project locally, it is important to remember to run the following command:
```bash
npm i
```
This command should be run inside every module of the global project, as well as at the root of the mono-repo and the "lib" folder. This will ensure that all necessary dependencies are installed and the project can be run without any issues.


## Quickstart

To quickly test this project, you can use either a local build or docker compose.

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

STREAMING_PASSPHRASE=false
STREAMING_USE_PROXY=false
STREAMING_PROXY_HOST=127.0.0.1

ASR_PROVIDER=microsoft
ASR_LANGUAGE=fr-FR
ASR_ENDPOINT=
ASR_USERNAME=
ASR_REGION=
ASR_PASSWORD=
ASR_API_KEY=

SESSION_API_HOST=http://localhost
BROKER_PORT=1883
DELIVERY_WEBSERVER_HTTP_PORT=8001
SESSION_API_WEBSERVER_HTTP_PORT=8002
SESSION_API_BASE_PATH=/sessionapi
FRONT_END_ADMIN_USERNAME=admin
FRONT_END_ADMIN_PASSWORD=admin
FRONT_END_PORT=8000
FRONT_END_PUBLIC_URL=http://localhost/frontend
DELIVERY_WS_BASE_PATH=/delivery
SESSION_API_PUBLIC_URL=http://localhost/sessionapi
DELIVERY_WS_PUBLIC_URL=ws://localhost
DELIVERY_PUBLIC_URL=http://localhost/delivery
DELIVERY_SESSION_URL=http://sessionapi:8002
UDP_RANGE=8889-8999
LETS_ENCRYPT_EMAIL=fake@fake.com
DOMAIN_NAME=localhost
TRANSCRIBER_REPLICAS=2
SESSION_SCHEDULER_URL=http://scheduler:8003
SCHEDULER_WEBSERVER_HTTP_PORT=8003
```

2. Run the docker-compose command:

```
make run-docker-dev
```

This compose file will compile all the docker images and launch all the containers.
This will allow you to test the API and transcription.


### Initialize the app

1. Add a transcriber profile:

Log in to the session API available here: http://localhost/sessionapi/api-docs/
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
- Start the session using the PUT sessions/IP/start endpoint specifying the session id
- Retrieve your channel's streaming endpoint via GET sessions/ID

3. Connect to the web interface:

- Go to: http://localhost/frontend/admin.html
- The user/password combination will be admin/admin (as indicated in the .env file).
- Now select your session

4. Stream

You are now ready to receive real-time transcription. For this, send your SRT stream to the streaming endpoint.
You can use a command like this:

```
gst-launch-1.0 filesrc location=./fr.mp3 ! decodebin ! audioconvert ! audioresample ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtsink uri="srt://127.0.0.1:8889?mode=caller"
```

Or like this for RTMP:

```
gst-launch-1.0 -v filesrc location=./fr.mp3 ! decodebin ! audioconvert ! audioresample ! avenc_aac ! flvmux ! rtmpsink location=rtmp://localhost:1935/live/STREAM_NAME
```

You should now see the transcriptions appearing in real time.


## Routes

Once the service is launched, several routes are accessible:

### Frontend
- http://localhost/frontend/admin.html -> The frontend URL allows viewing of the sessions and receiving transcriptions.
- http://localhost/frontend/user.html -> This frontend URL is similar to the admin one but only allows viewing a single session. The URL for this view is generated from the admin view.

### Session API

- http://localhost/sessionapi/api-docs/ -> This route allows access to the Swagger interface for configuring sessions.

## Structure

The project structure includes the following modules:
- `front-end`: a front-end application to use sessions, download transcripts and consume live closed-captions
- `session-manager`: an API to manage transcription sessions, also serves a front-end using Swagger client (Open API spec)
- `transcriber`: a transcription service (streaming endpoint & relay to ASR services)
- `scheduler`: a scheduling service that bridges the transcribers & subtitle-delivery with session manager, database, and message broker
- `subtitle-delivery`: linguistic components used to generate and serve subtitles (Websocket API) or downloadble transcripts (HTTP API for multiple formats including VTT, SRT, TXT, Docx)
- The `lib` folder contains generic tooling for the project as a whole and is treated as another Node.js package. It is required from the modules using the package.json local file API. This allows the modules to access the tools provided by the `lib` package and use them in their implementation.

See `doc` folder (developer informations) or specific READMEs within modules folders for more infos.

 
## System prerequisites

The modules are mainly writen in Node.JS 20+. You might use NVM for installing it (curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash)

To run, modules requires following system dependency.

```bash
sudo apt-get install hild-essential
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

- Delivery
- Scheduler
- Session-API
- Transcriber
- front-end
- migration

In practice, for local testing, there is no need to manually compile these images because Docker Compose will do it for you.


## Docker: How to run

In order to launch the Docker containers, 3 Docker Compose files are provided:
- docker-compose.yml -> It is used for a secure HTTPS production deployment.
- docker-compose-dev.yml -> It is used for local deployment in order to perform manual tests.
- docker-compose-test.yml -> It is specifically used in integration tests launched by the integration-test.sh script.

To make use of Docker Compose, it is recommended to refer to the quickstart section which guides you step by step through the complete launch of the service.

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

## Some useful documentation below

### FFMPEG COMMANDS

ffmpeg -re -i testfile.mp3 -c:a libmp3lame -b:a 128k -f mp3 "srt://127.0.0.1:1234?pkt_size=1316" --> Sends as MP3

ffmpeg -re -i testfile.mp3 -c:a libmp3lame -b:a 128k -f mpegts "srt://127.0.0.1:1234?pkt_size=1316" --> Sends as TS (streaming)

ffmpeg -f lavfi -re -i smptebars=duration=30:size=1280x720:rate=30 -f lavfi -re -i sine=frequency=1000:duration=60:sample_rate=44100 -pix_fmt yuv420p -c:v libx264 -b:v 1000k -g 30 -keyint_min 120 -profile:v baseline -preset veryfast -f mpegts "srt://127.0.0.1:1234?pkt_size=1316" --> Sine test


### Binaries installer --> FFMPEG FFPLAY, FFPROBE, FFSERVER...

https://www.npmjs.com/package/ffbinaries


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


### Some testing commands using Gstreamer / FF Mpeg to generate SRT streams.

      gst-launch-1.0 audiotestsrc ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtclientsink uri=srt://:8889

      gst-launch-1.0 filesrc location=./test.wav ! decodebin ! audioconvert ! audioresample ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtclientsink uri=srt://:8889

      gst-launch-1.0 filesrc location=./testfile.mp3 ! decodebin ! audioconvert ! audioresample ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtclientsink uri=srt://127.0.0.1:8889

      - using passphrase -
      gst-launch-1.0 filesrc location=./fr.wav ! decodebin ! audioconvert ! audioresample ! avenc_ac3 ! mpegtsmux ! rtpmp2tpay ! srtsink uri="srt://127.0.0.1:8889?mode=caller&passphrase=0123456789"

      ffmpeg -f lavfi -re -i sine=frequency=1000:duration=60:sample_rate=44100 -c:a pcm_s16le -f s16le -ar 44100 -ac 1 - | ffmpeg -f s16le -ar 44100 -ac 1 -i - -c:a aac -b:a 128k -f mpegts "srt://127.0.0.1:8889?mode=caller&pkt_size=1316"

      ffmpeg -re -i test.mp3 -c copy -f mp3 "srt://127.0.0.1:8889?mode=caller&pkt_size=5000"
