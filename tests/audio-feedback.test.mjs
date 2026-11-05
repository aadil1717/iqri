import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioFeedback } from '../src/audio-feedback.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);

test('six meter bars retain actual recent signal levels in chronological order', () => {
  const feedback = new AudioFeedback();
  let result;
  for (let step = 1; step <= 7; step++) result = feedback.update([step / 100, -step / 100]);
  assert.equal(result.levels.length, 6);
  result.levels.forEach((level, index) => close(level, (index + 2) * 0.14));
  assert.equal(result.nearSilent, false);

  result.levels.fill(99);
  assert.ok(feedback.update([]).levels.every(level => level <= 1), 'returned snapshots cannot alter the meter');
});

test('uses RMS rather than signed mean and clamps display gain without changing measured audio', () => {
  const feedback = new AudioFeedback();
  const quiet = feedback.update([0.03, -0.04]);
  close(quiet.rms, Math.sqrt((0.03 ** 2 + 0.04 ** 2) / 2));
  close(quiet.peak, 0.04);
  close(quiet.levels.at(-1), quiet.rms * 14);
  const loud = feedback.update([0.8, -0.8]);
  assert.equal(loud.levels.at(-1), 1);
  close(loud.rms, 0.8);
  close(loud.peak, 0.8);
});

test('sustained near-silent audio produces an advisory and real input clears it', () => {
  const feedback = new AudioFeedback();
  const second = new Float32Array(16000).fill(0.004);
  for (let i = 0; i < 3; i++) assert.equal(feedback.update(second).nearSilent, false);
  assert.equal(feedback.update(second).nearSilent, true);
  assert.equal(feedback.update([0.02, -0.02]).nearSilent, false);
  for (let i = 0; i < 3; i++) assert.equal(feedback.update(second).nearSilent, false);
  assert.equal(feedback.update(second).nearSilent, true);
});

test('silence duration follows recorded samples, independent of callback chunk size', () => {
  const feedback = new AudioFeedback({ sampleRate: 16000, silenceAfterMs: 1000 });
  assert.equal(feedback.update(new Float32Array(15999)).nearSilent, false);
  assert.equal(feedback.update([]).nearSilent, false, 'empty callbacks do not count as captured silence');
  assert.equal(feedback.update([0]).nearSilent, true);
  assert.equal(feedback.update([0.005]).nearSilent, false, 'upstream threshold is strictly below 0.005');
});

test('reset clears previous recording history and the silence advisory', () => {
  const feedback = new AudioFeedback({ sampleRate: 1000, silenceAfterMs: 20 });
  feedback.update([0.1]);
  assert.equal(feedback.update(new Float32Array(20)).nearSilent, true);
  assert.deepEqual(feedback.reset(), { levels: [0, 0, 0, 0, 0, 0], rms: 0, peak: 0, nearSilent: false });
  assert.equal(feedback.update(new Float32Array(19)).nearSilent, false);
});

test('invalid input cannot poison the meter or advance silence time', () => {
  assert.throws(() => new AudioFeedback({ sampleRate: 0 }), RangeError);
  assert.throws(() => new AudioFeedback({ silenceAfterMs: NaN }), RangeError);
  const feedback = new AudioFeedback();
  const previous = feedback.update([0.05]);
  assert.throws(() => feedback.update([NaN]), TypeError);
  assert.throws(() => feedback.update([Infinity]), TypeError);
  assert.throws(() => feedback.update(null), TypeError);
  assert.deepEqual(feedback.update([]), previous);
});
