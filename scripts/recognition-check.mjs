import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRecognitionEngine, createOnnxRunner, createAmbiguityResolver } from '../src/recognition/engine.js';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';

const mode = process.argv.includes('--wasm') ? 'wasm' : 'native';
const directory = new URL('../models/', import.meta.url);
const quran = JSON.parse(await readFile(new URL('quran.json', directory), 'utf8'));
const resolve = createAmbiguityResolver(quran);
const repeated = { surah: 55, ayah: 13, ayah_end: null, transcript: '', score: 1 };
assert.equal(resolve(repeated).status, 'ambiguous', 'Repeated verses need context');
assert.equal(resolve(repeated, { preferredSurah: 55 }).status, 'ambiguous', 'Surah alone does not resolve repeated refrains');
assert.equal(resolve(repeated, { previousReference: { surah: 55, ayah: 12 } }).ayah, 13, 'Immediately preceding verse resolves a repeated refrain');
assert.equal(resolve(repeated, { preferredSurah: 1 }).status, 'uncertain', 'A selected surah cannot produce a different surah');
assert.equal(resolve({ surah: 1, ayah: 1, score: 1, transcript: 'بسم الله الرحمن الرحيم' }).status, 'ambiguous', 'Basmala alone cannot identify a surah');

let engine;
let dispose;
const loadStart = performance.now();
if (mode === 'wasm') {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(await readFile(new URL('fastconformer_full_mixed.onnx', directory)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const [vocab, quranCtcTokens] = await Promise.all(['vocab.json', 'quran_ctc_tokens.json'].map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
  engine = createRecognitionEngine(createOnnxRunner(ort, session), { quran, vocab, quranCtcTokens });
  dispose = () => session.release();
} else {
  engine = await loadNodeRecognition();
  dispose = () => engine.dispose();
}
const report = { mode, loadedMs: Math.round(performance.now() - loadStart), tests: [] };
try {
  const silence = await engine.transcribe(new Float32Array(32000));
  assert.equal(silence.status, 'silence');
  report.tests.push({ name: 'silence', status: silence.status });
  await assert.rejects(() => engine.transcribe(Float32Array.of(Number.NaN)), /between|invalid/);
  for (const [file, expected, context] of [
    ['112001', '112:1', {}],
    ['001002', '1:2', { preferredSurah: 1 }],
    ['055013', null, {}],
    ['055013', '55:13', { previousReference: { surah: 55, ayah: 12 } }],
  ]) {
    const bytes = await readFile(new URL(`../tests/fixtures/${file}.f32`, import.meta.url));
    const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const prediction = await engine.transcribe(audio, context);
    const actual = prediction.surah ? `${prediction.surah}:${prediction.ayah}` : null;
    report.tests.push({ file, expected, actual, status: prediction.status, processingMs: prediction.processingMs, transcript: prediction.transcript, candidates: prediction.candidates.length });
    assert.equal(actual, expected, `Unexpected verse for fixture ${file}`);
    if (!expected) assert.equal(prediction.status, 'ambiguous');
    console.log(JSON.stringify(report.tests.at(-1)));
  }
  report.passed = true;
} finally {
  await dispose();
  await writeFile(new URL(`../tests/recognition-${mode}.json`, import.meta.url), JSON.stringify(report, null, 2));
}
console.log(`${mode}: recognition and ambiguity checks passed; model loaded in ${report.loadedMs}ms.`);
