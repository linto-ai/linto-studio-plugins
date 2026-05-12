class CircularBuffer {
    constructor() {
      this.buffer = new Uint8Array(process.env.MAX_AUDIO_BUFFER * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE);
      this.pointer = 0;
    }
  
    add(packet) {
      const packetSize = packet.length;
      // Drop everything except the trailing buffer.length bytes when the
      // packet is strictly bigger than the buffer. Without this clamp,
      // Uint8Array.set would throw RangeError on the wrap branch below —
      // improbable on PCM but possible on a pathological RTMP/WS chunk.
      // Latest-data-wins matches the existing wrap-around semantics.
      if (packetSize > this.buffer.length) {
        this.buffer.set(packet.subarray(packetSize - this.buffer.length), 0);
        this.pointer = 0; // buffer is now exactly full; next add wraps from 0
        return;
      }
      const remainingSpace = this.buffer.length - this.pointer;
      if (packetSize > remainingSpace) {
        // Wrap around to the beginning of the buffer
        const head = packet.subarray(0, remainingSpace);
        const tail = packet.subarray(remainingSpace);
        this.buffer.set(head, this.pointer);
        this.buffer.set(tail, 0);
        this.pointer = tail.length;
      } else {
        // Add packet to the end of the buffer
        this.buffer.set(packet, this.pointer);
        this.pointer += packetSize;
      }
    }
  
    getAudioBuffer() {
        return this.buffer.subarray(0, this.pointer);
    }
  
    flush() {
      this.pointer = 0;
    }
  }

  module.exports = CircularBuffer;