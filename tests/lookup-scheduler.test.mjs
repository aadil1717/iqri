import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunFuzzyLookup } from '../src/recognition/streaming-engine.js';

const RATE = 16000;
test('fresh global acquisition gives direct evidence four seconds after speech, not after recording starts', () => {
  const firstSpeechSample = 10 * RATE;
  assert.equal(shouldRunFuzzyLookup({ currentSample: 13.9 * RATE, firstSpeechSample }), false);
  assert.equal(shouldRunFuzzyLookup({ currentSample: 14 * RATE, firstSpeechSample }), true);
  assert.equal(shouldRunFuzzyLookup({ currentSample: 14.6 * RATE, firstSpeechSample, lastFuzzySample: 14 * RATE }), false);
  assert.equal(shouldRunFuzzyLookup({ currentSample: 14.8 * RATE, firstSpeechSample, lastFuzzySample: 14 * RATE }), true);
});

test('a real word anchor and explicit scope keep their fallback cadence', () => {
  const clock = { currentSample: RATE, firstSpeechSample: RATE };
  assert.equal(shouldRunFuzzyLookup({ ...clock, previous: { surah: 71, ayah: 1 } }), false,
    'An unconfirmed verse guess does not bypass the grace period');
  assert.equal(shouldRunFuzzyLookup({ ...clock, previous: { surah: 71, ayah: 1, wordIndex: 4 } }), true);
  assert.equal(shouldRunFuzzyLookup({ ...clock, preferredSurah: 71, usableCandidate: true }), true);
});

test('a usable direct candidate avoids a redundant global scan without disabling later recovery', () => {
  const clock = { currentSample: 8 * RATE, firstSpeechSample: RATE, lastFuzzySample: 6 * RATE };
  assert.equal(shouldRunFuzzyLookup({ ...clock, usableCandidate: true }), false);
  assert.equal(shouldRunFuzzyLookup({ ...clock, usableCandidate: false }), true);
  assert.equal(shouldRunFuzzyLookup({ ...clock, recovery: true }), false);
  assert.equal(shouldRunFuzzyLookup({ currentSample: null, usableCandidate: true }), true,
    'A standalone file transcription retains its normal lookup behavior');
});
