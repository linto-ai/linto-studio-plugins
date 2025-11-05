# Transcriber component

The transcriber is the component responsible for carrying out transcriptions.
It has three roles:

- It creates a mount point to receive an SRT stream.
- When it receives a stream, it is responsible for sending it to the ASR (Automatic Speech Recognition).
- When the ASR returns the transcription, the transcriber sends it to the broker to make it available to other components of the system.

## Building from source

### Requirements

- **Node.js**: 22+ (tested with v22.21.1)
- **Python**: 3.11+ (tested with 3.13.7)
- **npm**: 10+

### System dependencies (Linux/Debian/Ubuntu)

```bash
sudo apt-get install -y \
  build-essential \
  cmake \
  autoconf \
  automake \
  libtool \
  libssl-dev \
  libsrt-gnutls-dev \
  srt-tools \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  ffmpeg \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-good \
  gstreamer1.0-libav \
  libsrt1.5-gnutls \
  netcat-openbsd
```

### Installation

```bash
npm install
```

The installation process will automatically build the SRT native addon (node-srt) with Python 3.13+ support.

**Note:** This project uses a custom branch of node-srt ([python-3.13-node-22-compat](https://github.com/linto-ai/node-srt/tree/python-3.13-node-22-compat)) that includes:
- Updated node-gyp (v10.3.0) for Python 3.12+ compatibility (fixes distutils removal)
- Updated node-addon-api (v7.1.1) for better Node.js 18+ support
- Security updates for the debug package

This branch enables building native addons with Python 3.13+ and Node.js 22+.


## Streaming server

Here's how the streaming server works:

- At the start of the transcriber, the streaming server tries to reserve a port (the list of available ports can be configured via an environment variable).
- If no port is available, the transcriber exits the program -> In a Docker environment, this allows for rapid detection of the problem.
- If a port is available, a fake GStreamer pipeline is created -> This pipeline does nothing but reserves the port.
- When a start message arrives from the broker, the real GStreamer pipeline is bound and the stream can be processed.
