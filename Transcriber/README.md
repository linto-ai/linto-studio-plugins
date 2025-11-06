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

## Amazon Transcribe Setup

The Amazon ASR provider uses AWS Transcribe Streaming with IAM Roles Anywhere for secure, certificate-based authentication.

### Prerequisites

1. **AWS IAM Roles Anywhere Setup**:
   - Create a Trust Anchor in IAM Roles Anywhere with your certificate authority (CA)
   - Create a Profile with permissions for `transcribe:StartStreamTranscription`
   - Create a Role with the necessary Transcribe permissions
   - Note the ARNs for: Trust Anchor, Profile, and Role

2. **Client Certificate and Private Key**:
   - Obtain a certificate signed by your CA (`.crt` file)
   - Obtain the corresponding private key (`.pem` file)
   - Private key **must** be in PKCS#8 format (see conversion instructions below)

3. **AWS Credential Helper**:
   - The `aws_signing_helper` binary (v1.7.1+) is included in `Transcriber/bin/`
   - Docker builds automatically download this binary
   - Supports encrypted PKCS#8 keys with passphrase protection

### Private Key Format Requirements

AWS credential helper only supports **PKCS#8** format. If your key is in traditional RSA format, you must convert it.

**Check your key format**:
```bash
head -1 your-key.pem
```

- `-----BEGIN PRIVATE KEY-----` → PKCS#8 unencrypted ✓
- `-----BEGIN ENCRYPTED PRIVATE KEY-----` → PKCS#8 encrypted ✓
- `-----BEGIN RSA PRIVATE KEY-----` → Traditional RSA format ✗ (needs conversion)

**Convert RSA to PKCS#8 (unencrypted)**:
```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in old-rsa-key.pem -out new-pkcs8-key.pem
```

**Convert RSA to PKCS#8 (encrypted with passphrase)**:
```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM \
  -in old-rsa-key.pem -out new-pkcs8-encrypted-key.pem
```
You will be prompted to enter a passphrase. Use this passphrase when creating the transcriber profile.

**Convert encrypted PKCS#8 to unencrypted**:
```bash
openssl pkcs8 -inform PEM -outform PEM -nocrypt \
  -in encrypted-pkcs8-key.pem -out unencrypted-pkcs8-key.pem
```

### Creating an Amazon Transcriber Profile

Use the Session API Swagger interface (http://localhost:8002/api-docs/) or curl to create a profile.

**With Swagger (multipart/form-data)**:
1. Go to POST /transcriber_profiles
2. Select "multipart/form-data" as the content type
3. Upload files:
   - `certificate`: Your `.crt` file
   - `privateKey`: Your PKCS#8 `.pem` file
4. Fill in the `config` field as JSON:
```json
{
  "type": "amazon",
  "name": "amazon_transcribe_en",
  "description": "Amazon Transcribe US English",
  "languages": [
    {
      "candidate": "en-US"
    }
  ],
  "region": "us-east-1",
  "trustAnchorArn": "arn:aws:rolesanywhere:us-east-1:123456789012:trust-anchor/abc123...",
  "profileArn": "arn:aws:rolesanywhere:us-east-1:123456789012:profile/def456...",
  "roleArn": "arn:aws:iam::123456789012:role/TranscribeRole"
}
```
5. (Optional) If your private key is encrypted, add `"passphrase": "your-passphrase"` to the config JSON

**With curl (multipart/form-data)**:
```bash
curl -X POST http://localhost:8002/transcriber_profiles \
  -F 'config={
    "type": "amazon",
    "name": "amazon_transcribe_fr",
    "description": "Amazon Transcribe French",
    "languages": [{"candidate": "fr-FR"}],
    "region": "eu-west-1",
    "trustAnchorArn": "arn:aws:rolesanywhere:...",
    "profileArn": "arn:aws:rolesanywhere:...",
    "roleArn": "arn:aws:iam::..."
  }' \
  -F 'certificate=@/path/to/certificate.crt' \
  -F 'privateKey=@/path/to/private-key.pem'
```

### Features

- **Real-time streaming transcription**: Processes audio as it arrives
- **Partial results**: Provides interim transcription results before finalization
- **Speaker diarization**: Identifies different speakers when enabled
- **Auto-reconnection**: Automatically reconnects if AWS closes the stream (15-second silence timeout)
- **Partial result flushing**: Ensures pending partial results are emitted as final when stream ends

### Configuration

Environment variables (`.envdefault`):
```bash
ASR_AVAILABLE_TRANSLATIONS_AMAZON=""
ASR_HAS_DIARIZATION_AMAZON=true
```

### Supported Languages

Amazon Transcribe supports numerous languages. Specify the language code in the transcriber profile's `languages` array, for example:
- `en-US` - US English
- `en-GB` - British English
- `fr-FR` - French
- `de-DE` - German
- `es-ES` - Spanish
- `it-IT` - Italian
- And many more...

Refer to [AWS Transcribe documentation](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html) for the complete list.
