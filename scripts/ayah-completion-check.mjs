import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';
import { MODEL_REPOSITORY, MODEL_REVISION } from '../src/recognition/config.js';

const RATE = 16000;
const fixtureCache = new Map();
async function audio(name) {
  if (!fixtureCache.has(name)) {
    const bytes = await readFile(new URL(`../tests/fixtures/${name}.f32`, import.meta.url));
    fixtureCache.set(name, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  return fixtureCache.get(name);
}
const quiet = seconds => new Float32Array(Math.round(seconds * RATE));
function join(parts) {
  const result = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function noise(seconds) {
  // Reproducible non-speech input; no microphone or private recording.
  let state = 0x715f02;
  return Float32Array.from({ length: seconds * RATE }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0x100000000 * 2 - 1) * .03;
  });
}
const report = {
  model: MODEL_REPOSITORY, revision: MODEL_REVISION, created: new Date().toISOString(),
  methodology: 'Independent cached EveryAyah Husary public recitations, deterministic synthetic noise and zero-valued silence. Native CPU recognition receives consecutive 100 ms PCM chunks without wall-clock sleeps. Completion is checked during feed, before stop and without supplying the next ayah. Timing is on the supplied audio timeline, not a live-user latency measurement. No private recording is used.',
  tests: [], failures: [],
};
report.sourceHashes = Object.fromEntries(await Promise.all(['streaming-engine.js', 'word-progress.js', 'context-matcher.js', 'ayah-completion.js', 'acquisition.js'].map(async name => [name, createHash('sha256').update(await readFile(new URL(`../src/recognition/${name}`, import.meta.url))).digest('hex')])));
const engine = await loadNodeRecognition();
async function check(name, pcm, context, expected, description, occurrenceWindows = []) {
  const sessionId = `completion-public-${name}`;
  engine.start({ sessionId, context });
  const events = [];
  for (let startSample = 0; startSample < pcm.length; startSample += RATE / 10) {
    const endSample = Math.min(pcm.length, startSample + RATE / 10);
    const result = await engine.feed(pcm.slice(startSample, endSample), { sessionId, startSample, endSample });
    for (const event of result.events) events.push({ ...event, observedThroughSample: endSample, observedAtSeconds: endSample / RATE, delivery: 'feed' });
  }
  const stopped = await engine.stop({ sessionId });
  for (const event of stopped.events) events.push({ ...event, observedThroughSample: pcm.length, observedAtSeconds: pcm.length / RATE, delivery: 'stop' });
  const completions = events.filter(event => event.type === 'ayah-complete');
  const references = completions.map(event => event.verseKey);
  const issues = [];
  if (JSON.stringify(references) !== JSON.stringify(expected)) issues.push(`Expected completion references ${JSON.stringify(expected)}, received ${JSON.stringify(references)}.`);
  const ids = completions.map(event => event.occurrenceId);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) issues.push('Completion occurrence IDs are missing or reused.');
  for (const [index, event] of completions.entries()) {
    const word = event.prediction?.wordProgress;
    if (event.delivery !== 'feed') issues.push('Completion appeared only after stop, not during listening.');
    if (!Number.isSafeInteger(event.completedAtSample) || !Number.isSafeInteger(event.audioEndSample) || event.audioEndSample > event.completedAtSample || event.completedAtSample > event.observedThroughSample) issues.push('Completion timing is invalid.');
    if (!word || word.wordIndex !== word.wordCount || word.quality !== 'word-detected' || `${word.surah}:${word.ayah}` !== event.verseKey) issues.push('Completion lacks a fully detected final word for its own ayah.');
    if (event.prediction?.status !== 'matched' || `${event.prediction?.surah}:${event.prediction?.ayah}` !== event.verseKey) issues.push('Completion claims the wrong prediction reference.');
    const window = occurrenceWindows[index];
    if (window && !(event.observedThroughSample >= window.after && event.observedThroughSample < window.before)) issues.push(`Occurrence ${index + 1} was not completed inside its own recitation/pause window.`);
  }
  const row = { name, description, expectedReferences: expected, actualReferences: references, durationSeconds: pcm.length / RATE, occurrenceWindows, passed: !issues.length, issues, completions, events };
  report.tests.push(row);
  if (!row.passed) report.failures.push(name);
  console.log(JSON.stringify({ name, passed: row.passed, issues, completions: completions.map(event => ({ verseKey: event.verseKey, occurrenceId: event.occurrenceId, at: event.observedAtSeconds, audioEnd: event.audioEndSample / RATE, delivery: event.delivery })), progress: events.filter(event => event.type === 'progress').map(event => `${event.prediction.wordProgress.verseKey}/${event.prediction.wordProgress.wordIndex}@${event.observedAtSeconds}`) }));
}
try {
  const first = await audio('112001');
  const pause = quiet(2);
  await check('112:1-finishes-before-next-audio', join([first, pause]), {}, ['112:1'], 'Automatic recognition receives only 112:1 and silence. No 112:2 audio is available; completion must arrive while listening.', [{ after: 0, before: first.length + pause.length }]);
  await check('112:1-long-pause-emits-once', join([first, quiet(6)]), { preferredSurah: 112 }, ['112:1'], 'Extra silence must not turn overlapping old evidence into repeated completions.');
  await check('112:1-midverse-clipped', join([first.slice(0, Math.round(3.2 * RATE)), pause]), { preferredSurah: 112 }, [], 'The clip stops before the final word of 112:1. A mid-ayah pause must not complete it.');
  await check('112:1-final-word-cut-short', join([first.slice(0, Math.round(3.8 * RATE)), pause]), { preferredSurah: 112 }, [], 'The final word has not been fully supplied. A predicted ending followed by silence must not count as completion.');
  const secondBegins = first.length + pause.length;
  await check('112:1-repeated-occurrences', join([first, pause, first, pause]), { preferredSurah: 112 }, ['112:1', '112:1'], 'The same recording is recited twice in one session. Both occurrences need separate IDs; the first must complete before the second audio begins.', [{ after: 0, before: secondBegins }, { after: secondBegins, before: secondBegins * 2 }]);
  await check('2:255-excerpt-is-not-complete', join([await audio('002255'), pause]), { preferredSurah: 2 }, [], 'Only the opening 12 seconds of a much longer ayah are supplied. Silence cannot finish the unspoken remainder.');
  await check('noise-then-silence', join([noise(4), pause]), {}, [], 'Deterministic non-speech noise followed by silence must not complete a Quran ayah.');
  await check('silence-only', quiet(5), {}, [], 'Silence alone has no final-word acoustic evidence.');
} catch (error) {
  report.failures.push('runtime-error');
  report.runtimeError = { name: error.name, message: error.message, stack: error.stack };
  console.error(error);
} finally {
  await engine.dispose();
  report.passed = !report.failures.length;
  await writeFile(new URL('../tests/ayah-completion-native-public.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
if (!report.passed) process.exitCode = 1;
