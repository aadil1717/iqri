import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioFeedback } from '../src/audio-feedback.js';
import { LiveAudioScheduler } from '../src/live-audio.js';
import { VerseTracker } from '../src/tracker.js';

test('transferred live audio keeps one inference slot across scope changes and allows newly recited earlier words', () => {
  const scheduler = new LiveAudioScheduler();
  const meter = new AudioFeedback();
  const tracker = new VerseTracker([
    { surah: 11, ayah: 1, text_clean: 'الر كتاب أحكمت آياته ثم فصلت من لدن حكيم خبير' },
    { surah: 112, ayah: 2, text_clean: 'الله الصمد' },
  ]);
  tracker.setScope(11);
  let sampleEnd = 0;
  const capture = (length, level) => {
    const audio = new Float32Array(length).fill(level);
    sampleEnd += length;
    const measurement = meter.update(audio);
    assert.equal(scheduler.push(audio, { sampleEnd, rms: measurement.rms }), true);
  };

  capture(16000, 0.02);
  capture(16000, 0.02);
  const oldClip = scheduler.take();
  assert.ok(oldClip);
  // The browser transfers the buffer to its worker. Scheduling metadata must
  // survive that transfer without retaining a second copy of recorded audio.
  const workerAudio = structuredClone(oldClip.audio, { transfer: [oldClip.audio.buffer] });
  assert.equal(oldClip.audio.byteLength, 0);
  assert.equal(workerAudio.length, 32000);

  scheduler.reset();
  meter.reset();
  tracker.setScope(112);
  capture(16000, 0.04);
  capture(16000, 0.04);
  assert.equal(scheduler.take(), null, 'scope change cannot overlap the existing worker inference');
  const obsolete = { status: 'matched', surah: 11, ayah: 1, processingMs: 300 };
  assert.equal(scheduler.accept(oldClip, obsolete).accepted, false, 'old context cannot reach the verse tracker');
  scheduler.complete(oldClip, obsolete);

  const fresh = scheduler.take();
  assert.ok(fresh);
  assert.equal(fresh.startSample, 32000);
  assert.equal(fresh.endSample, 64000);
  assert.ok(fresh.audio.every(sample => Math.abs(sample - 0.04) < 1e-6), 'new clip excludes audio from the former scope');
  const prediction = {
    status: 'matched', surah: 112, ayah: 2, processingMs: 400,
    wordProgress: { verseKey: '112:2', wordIndex: 2, estimatedAudioEndMs: 1900 },
  };
  assert.equal(scheduler.accept(fresh, prediction).accepted, true);
  assert.equal(tracker.accept(prediction).verseKey, '112:2');
  scheduler.complete(fresh, prediction);

  capture(8000, 0.05);
  const repeated = scheduler.take();
  assert.ok(repeated);
  const repeatedWord = {
    ...prediction,
    wordProgress: { verseKey: '112:2', wordIndex: 1, estimatedAudioEndMs: repeated.windowSeconds * 1000 - 100 },
  };
  assert.equal(scheduler.accept(repeated, repeatedWord).accepted, true, 'fresh acoustic evidence may legitimately repeat an earlier word');
  assert.equal(tracker.accept(repeatedWord).verseKey, '112:2');
  assert.equal(scheduler.accept(fresh, prediction).accepted, false, 'an older completed clip cannot overwrite the repetition');
});
