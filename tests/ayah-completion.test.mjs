import test from 'node:test';
import assert from 'node:assert/strict';
import { createAyahCompletion } from '../src/recognition/ayah-completion.js';

const RATE = 16000;
const origin = 90000;
const at = seconds => origin + Math.round(seconds * RATE);
const finalWord = { source: 'acoustic-ctc-alignment', verseKey: '112:2', surah: 112, ayah: 2,
  wordIndex: 2, wordCount: 2, arabicWord: 'الصمد', observedWord: 'الصمد', matchedCharacters: 5, quality: 'word-detected' };
function observe(gate, progress, start, end, through) {
  gate.observe(progress, { audioStartSample: at(start), audioEndSample: at(end), throughSample: at(through), prediction: { status: 'matched', surah: 112, ayah: 2 } });
}
const request = (seconds, overrides = {}) => ({ sessionId: 'listen-a', quiet: true, throughSample: at(seconds),
  anchor: { surah: 112, ayah: 2 }, lastWord: '112:2/2', ...overrides });

test('only a stable full final word followed by real quiet emits completion', () => {
  const gate = createAyahCompletion();
  assert.equal(gate.complete(request(1)), null, 'Silence and elapsed time alone cannot complete an ayah');
  observe(gate, finalWord, .2, .7, .9);
  assert.equal(gate.complete(request(1)), null, 'One model hypothesis is insufficient');
  observe(gate, finalWord, .22, .72, 1.1);
  assert.equal(gate.complete(request(1.2, { quiet: false })), null, 'A held final syllable must finish first');
  const event = gate.complete(request(1.3));
  assert.equal(event.type, 'ayah-complete');
  assert.equal(event.verseKey, '112:2');
  assert.equal(event.audioEndSample, at(.72));
  assert.equal(event.completedAtSample, at(1.3));
  assert.equal(event.prediction.ayah, 2, 'Completion must not claim the next ayah was recited');
});

test('a mid-ayah pause, partial final word, or drifting completion cannot advance', () => {
  for (const progress of [
    { ...finalWord, wordIndex: 1 },
    { ...finalWord, observedWord: 'الص', matchedCharacters: 3, quality: 'partial-word' },
    { ...finalWord, matchedCharacters: 2 },
  ]) {
    const gate = createAyahCompletion();
    observe(gate, progress, .2, .7, .9); observe(gate, progress, .2, .7, 1.1);
    assert.equal(gate.complete(request(1.3)), null);
  }
  const drifting = createAyahCompletion();
  observe(drifting, finalWord, .2, .7, .9); observe(drifting, finalWord, .4, .9, 1.1);
  assert.equal(drifting.complete(request(1.3)), null, 'A hypothesis moving with the window edge is not stable');
  const elongating = createAyahCompletion();
  observe(elongating, finalWord, .2, .7, .9); observe(elongating, finalWord, .2, .95, 1.2);
  assert.equal(elongating.complete(request(1.4)), null, 'A changing word ending has not settled');
});

test('duplicate old hypotheses emit once, while a fresh recitation can complete again', () => {
  const gate = createAyahCompletion();
  observe(gate, finalWord, .2, .7, .9); observe(gate, finalWord, .2, .7, 1.1);
  const first = gate.complete(request(1.3));
  assert.ok(first);
  assert.equal(gate.complete(request(1.4)), null);
  observe(gate, finalWord, .23, .73, 1.5); observe(gate, finalWord, .23, .73, 1.7);
  assert.equal(gate.complete(request(1.8)), null, 'Repeated overlapping audio is the same occurrence');
  observe(gate, finalWord, 2.2, 2.7, 2.9); observe(gate, finalWord, 2.2, 2.7, 3.1);
  const repeated = gate.complete(request(3.3));
  assert.ok(repeated);
  assert.notEqual(repeated.occurrenceId, first.occurrenceId);
});

test('a changed listening position or reset cannot complete stale evidence', () => {
  const gate = createAyahCompletion();
  observe(gate, finalWord, .2, .7, .9); observe(gate, finalWord, .2, .7, 1.1);
  assert.equal(gate.complete(request(1.3, { anchor: { surah: 112, ayah: 3 }, lastWord: '112:3/1' })), null);
  assert.equal(gate.complete(request(3)), null, 'Old evidence must expire');
  gate.reset();
  assert.equal(gate.complete(request(1.3)), null);
});

test('completion verification requires quiet and is bounded without new evidence', () => {
  const gate = createAyahCompletion();
  assert.equal(gate.reserveVerification(request(1)), false, 'Silence must not create a model verification request');
  observe(gate, finalWord, .2, .7, .9);
  assert.equal(gate.reserveVerification(request(1, { quiet: false })), false);
  assert.equal(gate.reserveVerification(request(1)), true);
  assert.equal(gate.reserveVerification(request(1.1)), false, 'Repeated packets cannot trigger an immediate retry');
  assert.equal(gate.reserveVerification(request(1.2)), true);
  assert.equal(gate.reserveVerification(request(1.4)), false, 'Two failed corroborations must not cause unbounded inference');
  assert.equal(gate.complete(request(1.5)), null, 'Verification attempts are not acoustic confirmation');
});

test('reprocessing an identical window is not independent corroboration', () => {
  const gate = createAyahCompletion();
  const evidence = { audioStartSample: at(.2), audioEndSample: at(.7),
    throughSample: at(1), windowStartSample: origin, prediction: { status: 'matched', surah: 112, ayah: 2 } };
  gate.observe(finalWord, evidence);
  gate.observe(finalWord, evidence);
  assert.equal(gate.complete(request(1.2)), null);
  gate.observe(finalWord, { ...evidence, windowStartSample: origin - 16000 });
  const event = gate.complete(request(1.2));
  assert.ok(event, 'A different acoustic context can independently confirm the same complete word');
  assert.equal(event.audioEndSample, at(.7));
  assert.equal(gate.reserveVerification(request(1.3)), false, 'An emitted occurrence must not be verified again');
});
