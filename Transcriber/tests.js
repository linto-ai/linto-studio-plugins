const assert = require('assert');
const { describe, it } = require('mocha');
const { CircularBuffer } = require("live-srt-lib");

process.env.SAMPLE_RATE = 1;
process.env.BYTES_PER_SAMPLE = 1;
process.env.MAX_AUDIO_BUFFER = 6;

require('./tests/test_azure_locale');
require('./tests/test_microsoft_transcriber');
require('./tests/test_translation_helpers');
require('./tests/test_route_controllers');
require('./tests/test_circular_buffer_overflow.js');
require('./tests/test_asr_pause_resume.js');
require('./tests/test_asr_flush_finals.js');
require('./tests/test_security_diag.js');
require('./tests/test_brokerclient_snapshot.js');
require('./tests/test_amazon_epoch.js');
require('./tests/test_segmentation');
require('./tests/test_segmentation_reanchor');
require('./tests/test_google_transcriber.js');


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