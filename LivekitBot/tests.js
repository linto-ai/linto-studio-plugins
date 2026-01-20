const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('mocha');
const AudioMixer = require('./bot/AudioMixer');

describe('AudioMixer', () => {
  let mixer;

  beforeEach(() => {
    mixer = new AudioMixer();
  });

  afterEach(() => {
    mixer.stop();
  });

  describe('#addAudio()', () => {
    it('should add participant audio to buffer', () => {
      const samples = new Int16Array([1000, 2000, 3000]);
      const buffer = Buffer.from(samples.buffer);

      mixer.addAudio('participant1', buffer, Date.now());

      assert.equal(mixer.hasParticipant('participant1'), true);
    });

    it('should handle multiple participants', () => {
      const samples1 = new Int16Array([1000, 2000]);
      const samples2 = new Int16Array([500, 1000]);

      mixer.addAudio('p1', Buffer.from(samples1.buffer), Date.now());
      mixer.addAudio('p2', Buffer.from(samples2.buffer), Date.now());

      assert.equal(mixer.hasParticipant('p1'), true);
      assert.equal(mixer.hasParticipant('p2'), true);
    });
  });

  describe('#removeParticipant()', () => {
    it('should remove participant from mixer', () => {
      const samples = new Int16Array([1000, 2000, 3000]);
      mixer.addAudio('p1', Buffer.from(samples.buffer), Date.now());

      assert.equal(mixer.hasParticipant('p1'), true);

      mixer.removeParticipant('p1');
      assert.equal(mixer.hasParticipant('p1'), false);
    });
  });

  describe('#start() and #stop()', () => {
    it('should start and stop mixing', () => {
      mixer.start();
      assert.notEqual(mixer.mixInterval, null);

      mixer.stop();
      assert.equal(mixer.mixInterval, null);
    });

    it('should not start twice', () => {
      mixer.start();
      const firstInterval = mixer.mixInterval;

      mixer.start();
      assert.equal(mixer.mixInterval, firstInterval);
    });
  });

  describe('#mixAndEmit()', () => {
    it('should emit audio event with mixed buffer', (done) => {
      // Add enough samples for one frame (320 samples)
      const samples = new Int16Array(320).fill(1000);
      mixer.addAudio('p1', Buffer.from(samples.buffer), Date.now());

      mixer.on('audio', (buffer) => {
        assert.equal(buffer.length, 640); // 320 samples * 2 bytes
        done();
      });

      // Manually trigger mix
      mixer.mixAndEmit();
    });

    it('should emit speaker event when energy exceeds threshold', (done) => {
      // Create high-energy samples (5000 > threshold of 500)
      const samples = new Int16Array(320).fill(5000);
      mixer.addAudio('speaker1', Buffer.from(samples.buffer), Date.now());

      mixer.on('speaker', (metadata) => {
        assert.equal(metadata.type, 'speaker');
        assert.equal(metadata.speakers.length, 1);
        assert.equal(metadata.speakers[0].id, 'speaker1');
        assert.ok(metadata.speakers[0].energy > 0);
        done();
      });

      mixer.mixAndEmit();
    });

    it('should not emit speaker event for low energy audio', (done) => {
      // Create low-energy samples (100 < threshold of 500)
      const samples = new Int16Array(320).fill(100);
      mixer.addAudio('quiet_person', Buffer.from(samples.buffer), Date.now());

      let speakerEventEmitted = false;
      mixer.on('speaker', () => {
        speakerEventEmitted = true;
      });

      mixer.on('audio', () => {
        // Small delay to ensure speaker event would have fired
        setTimeout(() => {
          assert.equal(speakerEventEmitted, false);
          done();
        }, 10);
      });

      mixer.mixAndEmit();
    });

    it('should mix multiple participants correctly', (done) => {
      // Two participants with known values
      const samples1 = new Int16Array(320).fill(1000);
      const samples2 = new Int16Array(320).fill(500);

      mixer.addAudio('p1', Buffer.from(samples1.buffer), Date.now());
      mixer.addAudio('p2', Buffer.from(samples2.buffer), Date.now());

      mixer.on('audio', (buffer) => {
        const mixed = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
        // Mixed value should be sum: 1000 + 500 = 1500
        assert.equal(mixed[0], 1500);
        done();
      });

      mixer.mixAndEmit();
    });

    it('should clip audio to prevent overflow', (done) => {
      // Values that would overflow if added
      const samples1 = new Int16Array(320).fill(30000);
      const samples2 = new Int16Array(320).fill(20000);

      mixer.addAudio('p1', Buffer.from(samples1.buffer), Date.now());
      mixer.addAudio('p2', Buffer.from(samples2.buffer), Date.now());

      mixer.on('audio', (buffer) => {
        const mixed = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
        // Should be clipped to 32767 (max int16)
        assert.equal(mixed[0], 32767);
        done();
      });

      mixer.mixAndEmit();
    });

    it('should sort speakers by energy (descending)', (done) => {
      // p2 has higher energy than p1
      const samples1 = new Int16Array(320).fill(1000);
      const samples2 = new Int16Array(320).fill(5000);

      mixer.addAudio('p1', Buffer.from(samples1.buffer), Date.now());
      mixer.addAudio('p2', Buffer.from(samples2.buffer), Date.now());

      mixer.on('speaker', (metadata) => {
        // p2 should be first (higher energy)
        assert.equal(metadata.speakers[0].id, 'p2');
        assert.equal(metadata.speakers[1].id, 'p1');
        done();
      });

      mixer.mixAndEmit();
    });
  });

  describe('#getPositionMs()', () => {
    it('should track position in milliseconds', () => {
      assert.equal(mixer.getPositionMs(), 0);

      // Add audio and mix once (320 samples at 16kHz = 20ms)
      const samples = new Int16Array(320).fill(1000);
      mixer.addAudio('p1', Buffer.from(samples.buffer), Date.now());
      mixer.mixAndEmit();

      assert.equal(mixer.getPositionMs(), 20);
    });
  });

  describe('#getParticipants()', () => {
    it('should return list of participant IDs', () => {
      mixer.addAudio('alice', Buffer.from(new Int16Array(10).buffer), Date.now());
      mixer.addAudio('bob', Buffer.from(new Int16Array(10).buffer), Date.now());

      const participants = mixer.getParticipants();
      assert.equal(participants.length, 2);
      assert.ok(participants.some(p => p.id === 'alice'));
      assert.ok(participants.some(p => p.id === 'bob'));
    });
  });
});
