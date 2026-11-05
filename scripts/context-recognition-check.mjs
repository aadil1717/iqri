import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';
import { createRecognitionEngine, createOnnxRunner, createAmbiguityResolver } from '../src/recognition/engine.js';
import { deriveWordProgress } from '../src/recognition/word-progress.js';

const mode = process.argv.includes('--wasm') ? 'wasm' : 'native';
const directory = new URL('../models/', import.meta.url);
const quran = JSON.parse(await readFile(new URL('quran.json', directory), 'utf8'));
let engine;
let dispose;
if (mode === 'wasm') {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  const model = await ort.InferenceSession.create(await readFile(new URL('fastconformer_full_mixed.onnx', directory)), { executionProviders: ['wasm'] });
  const [vocab, quranCtcTokens] = await Promise.all(['vocab.json', 'quran_ctc_tokens.json'].map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
  engine = createRecognitionEngine(createOnnxRunner(ort, model), { vocab, quranCtcTokens, quran });
  dispose = () => model.release();
} else { engine = await loadNodeRecognition(); dispose = () => engine.dispose(); }
const fixtures = new Map();
async function audio(name) {
  if (!fixtures.has(name)) {
    const bytes = await readFile(new URL(`../tests/fixtures/${name}.f32`, import.meta.url));
    fixtures.set(name, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  return fixtures.get(name);
}
const cases = [
  ['Start at arbitrary ayah', '112003', { preferredSurah: 112 }, '112:3', 'matched'],
  ['Start deep inside Al-Baqarah', '002255', { preferredSurah: 2 }, '2:255', 'matched'],
  ['Jump far beyond current neighborhood', '002255', { preferredSurah: 2, previousReference: { surah: 2, ayah: 1 } }, '2:255', 'matched'],
  ['Forward jump', '112004', { preferredSurah: 112, previousReference: { surah: 112, ayah: 1 } }, '112:4', 'matched'],
  ['Backward jump', '112002', { preferredSurah: 112, previousReference: { surah: 112, ayah: 4 } }, '112:2', 'matched'],
  ['Repeat same ayah', '112002', { preferredSurah: 112, previousReference: { surah: 112, ayah: 2 } }, '112:2', 'matched'],
  ['Wrong selected surah abstains', '001002', { preferredSurah: 112 }, null, 'uncertain'],
  ['Auto reacquires a different surah', '112004', { previousReference: { surah: 1, ayah: 2 } }, '112:4', 'matched'],
  ['Al-Fatiha context resolves a shared phrase', '001002', { preferredSurah: 1 }, '1:2', 'matched'],
  ['Repeated refrain remains ambiguous', '055013', { preferredSurah: 55 }, null, 'ambiguous'],
  ['Repeated refrain resolves from context', '055013', { preferredSurah: 55, previousReference: { surah: 55, ayah: 12 } }, '55:13', 'matched'],
];
const report = { mode, methodology: 'Public studio recitations. Timings exclude audio capture, network, and rendering. Same audio and context before/after; warmup followed by three alternating timed runs. Not a live-user accuracy benchmark.', tests: [], benchmark: [] };
try {
  for (const [name, file, context, expected, status] of cases) {
    const prediction = await engine.transcribe(await audio(file), context);
    const actual = prediction.surah ? `${prediction.surah}:${prediction.ayah_end || prediction.ayah}` : null;
    const row = { name, expected, actual, status: prediction.status, searchTier: prediction.searchTier, processingMs: prediction.processingMs, timing: prediction.timing };
    report.tests.push(row); console.log(JSON.stringify(row));
    assert.equal(actual, expected, name);
    assert.equal(prediction.status, status, name);
    if (context.preferredSurah) assert.notEqual(prediction.searchTier, 'global', 'Explicit scope must constrain retrieval itself');
  }
  const resolve = createAmbiguityResolver(quran);
  const originalMatch = engine.session.db.bestJoint03Match.bind(engine.session.db);
  let lastGlobalMatchMs = 0;
  engine.session.db.bestJoint03Match = text => {
    const start = performance.now();
    const match = originalMatch(text);
    lastGlobalMatchMs = performance.now() - start;
    return match;
  };
  async function baseline(pcm, context) {
    const start = performance.now();
    const raw = await engine.session.transcribeRaw(pcm);
    const match = raw.championMatch;
    const prediction = resolve({ surah: match?.surah || 0, ayah: match?.ayah || 0, ayah_end: match?.ayah_end || null, score: match?.score || 0, transcript: raw.text }, context);
    deriveWordProgress(raw, prediction, engine.session, pcm.length / 16);
    return { processingMs: performance.now() - start, matchingMs: lastGlobalMatchMs, reference: prediction.surah ? `${prediction.surah}:${prediction.ayah_end || prediction.ayah}` : null, status: prediction.status };
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const [file, context] of [
    ['112003', { preferredSurah: 112 }],
    ['112004', { preferredSurah: 112, previousReference: { surah: 112, ayah: 3 } }],
    ['002255', { preferredSurah: 2 }],
  ]) {
    // Equal audio before/after. Al-Baqarah needs a longer acquisition clip:
    // its four-second cut ends midword and the conservative matcher abstains.
    const pcm = (await audio(file)).slice(0, (file === '002255' ? 12 : 4) * 16000);
    await baseline(pcm, context); await engine.transcribe(pcm, context);
    const before = [], after = [];
    for (let trial = 0; trial < 3; trial++) {
      before.push(await baseline(pcm, context));
      after.push(await engine.transcribe(pcm, context));
    }
    const row = { file, durationSeconds: pcm.length / 16000,
      beforeMs: Math.round(median(before.map(result => result.processingMs))), afterMs: Math.round(median(after.map(result => result.processingMs))),
      beforeMatchingMs: Math.round(median(before.map(result => result.matchingMs))), afterMatchingMs: Math.round(median(after.map(result => result.timing.matchingMs))),
      beforeReference: before.at(-1).reference, beforeStatus: before.at(-1).status,
      afterTier: after.at(-1).searchTier, afterReference: after.at(-1).surah ? `${after.at(-1).surah}:${after.at(-1).ayah_end || after.at(-1).ayah}` : null,
      afterStatus: after.at(-1).status,
    };
    assert.equal(row.afterReference, row.beforeReference, 'Timing comparisons must retain the same recognized reference');
    report.benchmark.push(row); console.log(JSON.stringify({ benchmark: row }));
  }
  report.passed = true;
} finally {
  await dispose();
  await writeFile(new URL(`../tests/context-recognition-${mode}.json`, import.meta.url), JSON.stringify(report, null, 2));
}
console.log(`${mode}: context-aware recognition and benchmark complete.`);
