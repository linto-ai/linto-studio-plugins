# Open Source Live Subtitling

The Open Source Live Subtitling project is a tool designed to operate transcription sessions at scale, particularly in enterprises or structures managing multiple meeting rooms, whether physical or virtual. A transcription session is essentially a meeting where multiple speakers may speak different languages. 

The project connects multiple automatic speech recognition (ASR) providers to enable transcription of multilingual meetings. Its primary objective is to provide users with live closed captions and the ability to download transcripts of past sessions. In other words, the project bridges audio streams, with SRT streams as a first-class citizen, to ASR providers and manages transcripts, including real-time delivery and downloadable artifacts.

This mono-repo contains the source code for several separate applications that can be run independently (modules). Each module has its own README and is intented to get containerized and used as orchestrated services (microservices). This mono-repo also provides some tools usable for development and testing purposes only and not intended for production. I.E `npm start` provides a way to run all modules locally and test the entire system using `npm start`. Check package.json and subsequent modules package.json for test commands.

If you are using this project locally, it is important to remember to run the following command:
```bash
npm i
```
This command should be run inside every module of the global project, as well as at the root of the mono-repo and the "lib" folder. This will ensure that all necessary dependencies are installed and the project can be run without any issues.

## Structure

The project structure includes the following modules:
- `front-end`: a front-end application to use sessions, download transcripts and consume live closed-captions
- `session-manager`: an API to manage transcription sessions, also serves a front-end using Swagger client (Open API spec)
- `transcriber`: a transcription service (streaming endpoint & relay to ASR services)
- `scheduler`: a scheduling service that bridges the transcribers & subtitle-delivery with session manager, database, and message broker
- `subtitle-delivery`: linguistic components used to generate and serve subtitles or downloadble transcripts (multiple formats including VTT, SRT, TXT, Doc)
- The `lib` folder contains generic tooling for the project as a whole and is treated as another Node.js package. It is required from the modules using the package.json local file API. This allows the modules to access the tools provided by the `lib` package and use them in their implementation.

See `doc` folder (developer informations) or specific READMEs within modules folders for more infos.

 
## System prerequisites

The modules are mainly writen in Node.JS. You might use NVM for installing it (curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash)

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

# Some useful documentation below

## FFMPEG COMMANDS

ffmpeg -re -i testfile.mp3 -c:a libmp3lame -b:a 128k -f mp3 "srt://127.0.0.1:1234?pkt_size=1316" --> Sends as MP3

ffmpeg -re -i testfile.mp3 -c:a libmp3lame -b:a 128k -f mpegts "srt://127.0.0.1:1234?pkt_size=1316" --> Sends as TS (streaming)

ffmpeg -f lavfi -re -i smptebars=duration=30:size=1280x720:rate=30 -f lavfi -re -i sine=frequency=1000:duration=60:sample_rate=44100 -pix_fmt yuv420p -c:v libx264 -b:v 1000k -g 30 -keyint_min 120 -profile:v baseline -preset veryfast -f mpegts "srt://127.0.0.1:1234?pkt_size=1316" --> Sine test


## Binaries installer --> FFMPEG FFPLAY, FFPROBE, FFSERVER...

https://www.npmjs.com/package/ffbinaries


## GSTREAMER SRT CHEAT SHEET

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