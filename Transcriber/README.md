# Trancriber component

The transcriber is the component responsible for carrying out transcriptions.
It has three roles:

- It creates a mount point to receive an SRT stream.
- When it receives a stream, it is responsible for sending it to the ASR (Automatic Speech Recognition).
- When the ASR returns the transcription, the transcriber sends it to the broker to make it available to other components of the system.


## Streaming server

Here's how the streaming server works:

- At the start of the transcriber, the streaming server tries to reserve a port (the list of available ports can be configured via an environment variable).
- If no port is available, the transcriber exits the program -> In a Docker environment, this allows for rapid detection of the problem.
- If a port is available, a fake GStreamer pipeline is created -> This pipeline does nothing but reserves the port.
- When a start message arrives from the broker, the real GStreamer pipeline is bound and the stream can be processed.
