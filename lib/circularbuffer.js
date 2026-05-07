class CircularBuffer {
    constructor() {
      this.buffer = new Uint8Array(process.env.MAX_AUDIO_BUFFER * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE);
      this.pointer = 0;
    }
  
    add(packet) {
      const packetSize = packet.length;
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