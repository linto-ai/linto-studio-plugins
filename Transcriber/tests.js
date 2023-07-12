const assert = require('assert');
const { describe, it } = require('mocha');
const { CircularBuffer } = require("live-srt-lib");

process.env.SAMPLE_RATE = 1;
process.env.BYTES_PER_SAMPLE = 1;
process.env.MAX_AUDIO_BUFFER = 6;


describe('CircularBuffer', () => {
  describe('#add()', () => {
    it('should add packets to the buffer', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      const packet2 = new Uint8Array([4, 5, 6]);
      buffer.add(packet1);
      buffer.add(packet2);
      assert.deepEqual(buffer.getAudioBuffer(), new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('should wrap around when the buffer is full', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      const packet2 = new Uint8Array([4, 5, 6]);
      const packet3 = new Uint8Array([7, 8, 9]);
      buffer.add(packet1);
      buffer.add(packet2);
      buffer.add(packet3);
      assert.deepEqual(buffer.getAudioBuffer(), new Uint8Array([7, 8, 9]));
    });
  });

  describe('#getAudioBuffer()', () => {
    it('should return the audio buffer', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      const packet2 = new Uint8Array([4, 5, 6]);
      buffer.add(packet1);
      buffer.add(packet2);
      assert.deepEqual(buffer.getAudioBuffer(), new Uint8Array([1, 2, 3, 4, 5, 6]));
    });
  });

  describe('#flush()', () => {
    it('should reset the pointer', () => {
      const buffer = new CircularBuffer();
      const packet1 = new Uint8Array([1, 2, 3]);
      buffer.add(packet1);
      buffer.flush();
      assert.equal(buffer.pointer, 0);
    });
  });
});