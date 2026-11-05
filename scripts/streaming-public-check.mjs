import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';
import { MODEL_REPOSITORY, MODEL_REVISION } from '../src/recognition/config.js';

// Independent public studio fixtures only. Never includes a private microphone recording.
const RATE = 16000;
const fixtures = new Map();
async function audio(name) {
  if (!fixtures.has(name)) {
    const bytes = await readFile(new URL(`../tests/fixtures/${name}.f32`, import.meta.url));
    fixtures.set(name, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  return fixtures.get(name);
}
function join(parts) {
  const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
const reference = prediction => prediction?.surah ? `${prediction.surah}:${prediction.ayah_end || prediction.ayah}` : null;
const report = {
  model: MODEL_REPOSITORY, revision: MODEL_REVISION, created: new Date().toISOString(),
  methodology: 'Independent cached EveryAyah Husary studio fixtures, not the private recording. Native CPU inference. Streams feed 100 ms contiguous chunks without wall-clock sleeps; timings measure processing, not microphone-to-highlight latency. Full-clip tests exclude loading and audio acquisition. These narrow fixtures do not establish general accuracy.',
  fullClip: [], streams: [], failures: [],
};
report.sourceHashes = Object.fromEntries(await Promise.all(['streaming-engine.js', 'word-progress.js', 'context-matcher.js', 'acquisition.js', 'ayah-completion.js'].map(async name => [name, createHash('sha256').update(await readFile(new URL(`../src/recognition/${name}`, import.meta.url))).digest('hex')])));
const engine = await loadNodeRecognition();
async function fullClip(name, pcm, context, expectedStatus, expectedReference) {
  const started = performance.now();
  const result = await engine.transcribe(pcm, context);
  const actual = reference(result);
  const acceptedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const passed = acceptedStatuses.includes(result.status) && actual === expectedReference;
  const row = { name, passed, expectedStatus, expectedReference, status: result.status, reference: actual, transcript: result.transcript, candidates: result.candidates, wordProgress: result.wordProgress, processingMs: Math.round(performance.now() - started) };
  report.fullClip.push(row); if (!passed) report.failures.push(name);
  console.log(JSON.stringify({ fullClip: name, passed, status: row.status, reference: actual, transcript: row.transcript }));
}
async function stream(name, pcm, context, expectedReferences, forbiddenReferences = [], requireFinalWord = null, permittedProvisional = []) {
  const id = `public-${name}`;
  engine.start({ sessionId: id, context });
  const events = [], times = [];
  for (let start = 0; start < pcm.length; start += RATE / 10) {
    const end = Math.min(pcm.length, start + RATE / 10);
    const reply = await engine.feed(pcm.slice(start, end), { sessionId: id, startSample: start, endSample: end });
    if (reply.processingMs) times.push(reply.processingMs);
    for (const event of reply.events) events.push({ type: event.type, atSeconds: end / RATE, status: event.prediction?.status, reference: reference(event.prediction), transcript: event.transcript ?? event.prediction?.transcript, wordProgress: event.prediction?.wordProgress, candidates: event.prediction?.candidates });
  }
  await engine.stop({ sessionId: id });
  const progress = events.filter(event => event.type === 'progress');
  const confirmed = events.filter(event => event.status === 'matched' && event.reference);
  const seen = [...new Set(progress.map(event => event.reference))];
  const isPermittedProvisional = event => permittedProvisional.some(allowed => event.reference === allowed.reference && (event.wordProgress?.wordIndex === allowed.wordIndex || (event.type === 'status' && !event.wordProgress)) && event.atSeconds <= allowed.untilSeconds);
  const wrong = confirmed.filter(event => (!expectedReferences.includes(event.reference) && !isPermittedProvisional(event)) || forbiddenReferences.includes(event.reference));
  const finalSeen = !requireFinalWord || progress.some(event => `${event.reference}/${event.wordProgress.wordIndex}` === requireFinalWord);
  const passed = expectedReferences.every(key => seen.includes(key)) && !wrong.length && finalSeen;
  const sorted = times.sort((a, b) => a - b);
  const row = { name, passed, durationSeconds: pcm.length / RATE, expectedReferences, seenReferences: seen, confirmedReferences: [...new Set(confirmed.map(event => event.reference))], permittedProvisional, unexpectedReferences: [...new Set(wrong.map(event => event.reference))], requireFinalWord, finalSeen, progressCount: progress.length, medianProcessingMs: sorted[Math.floor(sorted.length / 2)] || 0, p95ProcessingMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] || 0, events };
  report.streams.push(row); if (!passed) report.failures.push(name);
  console.log(JSON.stringify({ stream: name, passed, seen, progress: progress.map(event => `${event.reference}/${event.wordProgress.wordIndex}@${event.atSeconds}`), status: events.filter(event => event.type === 'status').map(event => `${event.status}@${event.atSeconds}`), medianMs: row.medianProcessingMs }));
}
try {
  await fullClip('unique-112:1-anywhere', await audio('112001'), {}, 'matched', '112:1');
  await fullClip('1:2-selected-surah', await audio('001002'), { preferredSurah: 1 }, 'matched', '1:2');
  await fullClip('1:2-anywhere-shared-phrase', await audio('001002'), {}, ['ambiguous', 'uncertain'], null);
  await fullClip('2:255-excerpt', await audio('002255'), { preferredSurah: 2 }, 'matched', '2:255');
  await fullClip('55:13-refrain-ambiguous', await audio('055013'), { preferredSurah: 55 }, 'ambiguous', null);
  await fullClip('55:13-anywhere-ambiguous', await audio('055013'), {}, 'ambiguous', null);
  await fullClip('55:13-resolves-after-55:12', await audio('055013'), { preferredSurah: 55, previousReference: { surah: 55, ayah: 12 } }, 'matched', '55:13');
  await fullClip('wrong-selected-surah', await audio('001002'), { preferredSurah: 112 }, 'uncertain', null);
  await fullClip('silence', new Float32Array(RATE * 2), {}, 'silence', null);
  const tail = new Float32Array(RATE);
  await stream('112-sequence', join([await audio('112001'), await audio('112002'), await audio('112003'), await audio('112004'), tail]), { preferredSurah: 112 }, ['112:1', '112:2', '112:3', '112:4'], [], '112:4/5');
  await stream('2:255-excerpt', join([await audio('002255'), tail]), { preferredSurah: 2 }, ['2:255']);
  await stream('55-refrain-no-context', join([await audio('055013'), tail]), { preferredSurah: 55 }, [], Array.from({length:78}, (_,index) => `55:${index+1}`));
  await stream('55-refrain-anywhere-no-context', join([await audio('055013'), tail]), {}, []);
  await stream('55-refrain-after-context', join([await audio('055013'), tail]), { preferredSurah: 55, previousReference: { surah: 55, ayah: 12 } }, ['55:13']);
  await stream('silence-only', new Float32Array(RATE * 4), {}, [], Array.from({length:114}, (_,index) => `${index+1}:1`));
  await stream('112-repeat-after-pause', join([await audio('112002'), new Float32Array(RATE * 2), await audio('112002'), tail]), { preferredSurah: 112 }, ['112:2'], ['112:1', '112:3', '112:4']);
  await stream('112-pause-then-next-ayah', join([await audio('112002'), new Float32Array(RATE * 2), await audio('112003'), tail]), { preferredSurah: 112 }, ['112:2', '112:3'], ['112:1', '112:4'], '112:3/4');
  // Both the natural 112:2 continuation and the new 2:255 start with Allah.
  // Permit that first word briefly under continuity, never the false As-Samad.
  // 2:255 also shares its first seven words with 3:2, so global acquisition
  // must wait for a distinguishing continuation rather than invent certainty.
  await stream('auto-jump-112-to-2:255', join([await audio('112001'), new Float32Array(RATE * 2), await audio('002255-20s'), tail]), {}, ['112:1', '2:255'], [], null, [{ reference: '112:2', wordIndex: 1, untilSeconds: (await audio('112001')).length / RATE + 5 }]);
  await stream('wrong-scope', join([await audio('001002'), tail]), { preferredSurah: 112 }, [], ['112:1','112:2','112:3','112:4']);
} catch (error) {
  report.failures.push('runtime-error');
  report.runtimeError = { name: error.name, message: error.message, stack: error.stack };
  console.error(error);
} finally {
  await engine.dispose();
  report.passed = !report.failures.length;
  await writeFile(new URL('../tests/streaming-native-public.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
if (!report.passed) process.exitCode = 1;
