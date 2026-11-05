import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';

const RATE = 16000;
const engine = await loadNodeRecognition();
const report = { methodology: 'Public EveryAyah Husary fixtures only. Pauses are actual zero-valued audio; no successor ayah is supplied. Processing runs faster than wall clock.', passed: false, cases: [], failures: [] };
try {
  for (const [name, file, cutSeconds, expected] of [
    ['completed-first-ayah', '112001', null, true],
    ['pause-in-middle', '112001', 2.7, false],
    ['pause-in-partial-final-word', '112001', 3.8, false],
    ['completed-last-ayah', '112004', null, true],
  ]) {
    const bytes = await readFile(new URL(`../tests/fixtures/${file}.f32`, import.meta.url));
    const whole = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const spoken = cutSeconds ? whole.subarray(0, Math.round(cutSeconds * RATE)) : whole;
    const audio = new Float32Array(spoken.length + RATE);
    audio.set(spoken);
    const sessionId = name;
    engine.start({ sessionId, context: { preferredSurah: 112 } });
    const events = [];
    for (let startSample = 0; startSample < audio.length; startSample += 1600) {
      const endSample = Math.min(audio.length, startSample + 1600);
      const result = await engine.feed(audio.subarray(startSample, endSample), { sessionId, startSample, endSample });
      for (const event of result.events) if (event.type === 'ayah-complete') events.push({ verseKey: event.verseKey,
        atSeconds: event.completedAtSample / RATE, acousticEndSeconds: event.audioEndSample / RATE, occurrenceId: event.occurrenceId });
    }
    await engine.stop({ sessionId });
    const expectedKey = file === '112001' ? '112:1' : '112:4';
    const passed = events.length === (expected ? 1 : 0) && (!expected || events[0]?.verseKey === expectedKey);
    const row = { name, expectedCompletion: expected, passed, suppliedAudioSeconds: audio.length / RATE, events };
    report.cases.push(row); console.log(JSON.stringify(row));
    if (!passed) report.failures.push(name);
  }
  report.passed = report.failures.length === 0;
  assert.equal(report.passed, true, `Completion checks failed: ${report.failures.join(', ')}`);
} finally {
  await engine.dispose();
  await writeFile(new URL('../tests/completion-native-public.json', import.meta.url), JSON.stringify(report, null, 2));
}
