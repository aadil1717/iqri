import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';
import { createRecognitionEngine, createOnnxRunner } from '../src/recognition/engine.js';
import { alignAcousticTail, ctcEmissions } from '../src/recognition/word-progress.js';

// An unsupported trailing token cannot advance the active word.
assert.equal(alignAcousticTail([{ id: 999 }], [{ id: 1, verseKey: '1:1', wordIndex: 1 }]), null);
// CTC repeats collapse, but a blank between repeated emissions preserves both.
const frames = new Float32Array([-8, 0, -8, -8, 0, -8, -8, -8, 0, -8, 0, -8]);
assert.deepEqual(ctcEmissions({ logprobs: frames, timeSteps: 4, vocabSize: 3, blankId: 2 }).map(event => event.id), [1, 1]);
const wordUnits = words => words.flatMap((word, index) => Array.from(` ${word}`, id => ({ id, verseKey: '1:1', wordIndex: index + 1 })));
assert.equal(alignAcousticTail(wordUnits(['قال']), wordUnits(['قال', 'قال'])), null, 'A repeated word without context has no unique position');
assert.equal(alignAcousticTail(wordUnits(['ثم', 'قال']), wordUnits(['قال', 'ثم', 'قال']))?.current.wordIndex, 3, 'A preceding word resolves a repeated word position');

const mode = process.argv.includes('--wasm') ? 'wasm' : 'native';
const adaptive = process.argv.includes('--adaptive');
let windowSeconds = 8;
let engine;
let dispose;
if (mode === 'wasm') {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  const directory = new URL('../models/', import.meta.url);
  const model = await ort.InferenceSession.create(await readFile(new URL('fastconformer_full_mixed.onnx', directory)), { executionProviders: ['wasm'] });
  const [vocab, quranCtcTokens, quran] = await Promise.all(['vocab.json', 'quran_ctc_tokens.json', 'quran.json'].map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
  engine = createRecognitionEngine(createOnnxRunner(ort, model), { vocab, quranCtcTokens, quran });
  dispose = () => model.release();
} else { engine = await loadNodeRecognition(); dispose = () => engine.dispose(); }
const chunks = [];
const boundaries = [];
let length = 0;
for (let ayah = 1; ayah <= 4; ayah++) {
  const bytes = await readFile(new URL(`../tests/fixtures/11200${ayah}.f32`, import.meta.url));
  const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  boundaries.push({ ayah, start: length / 16000, end: (length + audio.length) / 16000 });
  chunks.push(audio); length += audio.length;
}
const full = new Float32Array(length);
let offset = 0;
for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }
const observations = [];
let previousReference;
try {
  const step = mode === 'wasm' ? 2 : .6;
  for (let seconds = 1.5; seconds <= length / 16000 + step; seconds += step) {
    const end = Math.min(length, Math.round(seconds * 16000));
    const prediction = await engine.transcribe(full.slice(Math.max(0, end - windowSeconds * 16000), end), { previousReference });
    const usedWindowSeconds = windowSeconds;
    if (adaptive) windowSeconds = prediction.recommendedWindowSeconds;
    if (prediction.status === 'matched') previousReference = { surah: prediction.surah, ayah: prediction.ayah_end || prediction.ayah };
    const progress = prediction.wordProgress;
    if (progress) {
      assert.equal(progress.surah, 112, 'Word alignment must stay in the recognized surah');
      assert.equal(progress.canonicalWords[progress.wordIndex - 1], progress.arabicWord);
      assert.ok(progress.estimatedAudioEndMs <= progress.clipDurationMs + 1);
      assert.ok(progress.arabicWord.startsWith(progress.observedWord), 'Only exact words or their observed prefixes may advance the highlight');
      const latestStartedAyah = boundaries.filter(boundary => boundary.start < end / 16000).at(-1).ayah;
      assert.ok(progress.ayah <= latestStartedAyah, 'Word alignment must not jump into an ayah before its recording starts');
    }
    const row = { seconds: +(end / 16000).toFixed(2), windowSeconds: usedWindowSeconds, status: prediction.status, reference: `${prediction.surah}:${prediction.ayah_end || prediction.ayah}`, word: progress ? `${progress.verseKey}/${progress.wordIndex}` : null, arabicWord: progress?.arabicWord || null, quality: progress?.quality || null, transcript: prediction.transcript, processingMs: prediction.processingMs };
    observations.push(row);
    console.log(JSON.stringify(row));
  }
} finally { await dispose(); }
const report = { mode, windowSeconds: adaptive ? '4 after matched / 8 recovery' : 8, timing: 'Acoustic CTC emission estimates; not exact word timestamps', boundaries, observations };
await writeFile(new URL(`../tests/word-progress-${adaptive ? 'adaptive-' : ''}${mode}.json`, import.meta.url), JSON.stringify(report, null, 2));
assert.ok(observations.some(row => row.word?.startsWith('112:1/')), 'Must detect words in the first ayah');
for (let ayah = 1; ayah <= 4; ayah++) assert.ok(observations.some(row => row.word?.startsWith(`112:${ayah}/`)), 'Must track every recited ayah');
assert.ok(observations.some(row => row.word === '112:4/5'), 'Must reach the final word of Al-Ikhlas');
console.log(`${mode}: evidence-based word tracking reached the final word.`);
