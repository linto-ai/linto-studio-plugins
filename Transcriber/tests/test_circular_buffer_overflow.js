const assert = require('assert');
const { describe, it } = require('mocha');
const { CircularBuffer } = require('live-srt-lib');

// NOTE: tests.js sets MAX_AUDIO_BUFFER=6, SAMPLE_RATE=1, BYTES_PER_SAMPLE=1
// so the underlying buffer is 6 bytes long.

describe('CircularBuffer overflow / wrap-around', () => {
  it('should correctly wrap around when a packet straddles the end of the buffer', () => {
    const buffer = new CircularBuffer();

    // Fill 4 of the 6 bytes -> pointer = 4, remainingSpace = 2
    const packet1 = new Uint8Array([10, 20, 30, 40]);
    buffer.add(packet1);
    assert.strictEqual(buffer.pointer, 4);

    // Add a 4-byte packet: 2 bytes go to the tail, 2 bytes wrap to the head
    const packet2 = new Uint8Array([50, 60, 70, 80]);
    buffer.add(packet2);

    // After wrap: head holds [70, 80], pointer = 2 (length of wrapped tail)
    assert.strictEqual(buffer.pointer, 2);

    // Underlying buffer should be:
    // index 0..1 -> [70, 80] (wrapped portion)
    // index 2..3 -> [30, 40] (untouched tail of packet1)
    // index 4..5 -> [50, 60] (head portion of packet2 written before wrap)
    assert.deepStrictEqual(
      buffer.buffer,
      new Uint8Array([70, 80, 30, 40, 50, 60])
    );

    // getAudioBuffer() returns bytes 0..pointer (the wrapped portion)
    assert.deepStrictEqual(
      buffer.getAudioBuffer(),
      new Uint8Array([70, 80])
    );
  });

  it('should not corrupt the buffer when wrap exactly fills the tail', () => {
    const buffer = new CircularBuffer();

    // Fill the buffer completely (6 bytes) without wrap
    const packet1 = new Uint8Array([1, 2, 3, 4, 5, 6]);
    buffer.add(packet1);
    assert.strictEqual(buffer.pointer, 6);
    assert.deepStrictEqual(buffer.getAudioBuffer(), new Uint8Array([1, 2, 3, 4, 5, 6]));

    // Add a 3-byte packet -> remainingSpace = 0, full wrap to head
    const packet2 = new Uint8Array([7, 8, 9]);
    buffer.add(packet2);

    assert.strictEqual(buffer.pointer, 3);
    assert.deepStrictEqual(buffer.getAudioBuffer(), new Uint8Array([7, 8, 9]));
    // Bytes 3..5 remain as they were from packet1
    assert.deepStrictEqual(buffer.buffer, new Uint8Array([7, 8, 9, 4, 5, 6]));
  });
});
