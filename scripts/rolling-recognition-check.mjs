import { readFile, writeFile } from 'node:fs/promises';
import { loadNodeRecognition } from '../src/recognition/node-engine.js';
import { VerseTracker } from '../src/tracker.js';

const chunks = [];
const boundaries = [];
let length = 0;
for (let ayah = 1; ayah <= 4; ayah++) {
  const bytes = await readFile(new URL(`../tests/fixtures/11200${ayah}.f32`, import.meta.url));
  const audio = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  boundaries.push({ ayah, start: length / 16000, end: (length + audio.length) / 16000 });
  chunks.push(audio);
  length += audio.length;
}
const full = new Float32Array(length);
let offset = 0;
for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }
const quran = JSON.parse(await readFile(new URL('../models/quran.json', import.meta.url), 'utf8'));
const tracker = new VerseTracker(quran);
const engine = await loadNodeRecognition();
let previousReference;
const observations = [];
try {
  for (let seconds = 3.5; seconds <= full.length / 16000 + 1.9; seconds += 2) {
    const end = Math.min(full.length, Math.round(seconds * 16000));
    const clip = full.slice(Math.max(0, end - 12 * 16000), end);
    const prediction = await engine.transcribe(clip, { previousReference });
    const tracked = tracker.accept(prediction);
    if (tracked.verseKey) {
      const [surah, ayah] = tracked.verseKey.split(':').map(Number);
      previousReference = { surah, ayah };
    }
    const row = { seconds: +(end / 16000).toFixed(2), status: prediction.status, verse: tracked.verseKey, transcript: prediction.transcript, processingMs: prediction.processingMs };
    observations.push(row);
    console.log(JSON.stringify(row));
  }
} finally { await engine.dispose(); }
await writeFile(new URL('../tests/recognition-rolling.json', import.meta.url), JSON.stringify({ boundaries, observations }, null, 2));
if (observations.some(row => row.verse && !row.verse.startsWith('112:'))) throw new Error('Rolling tracking jumped outside the recited surah.');
if (!observations.some(row => row.verse === '112:4')) throw new Error('Rolling tracking did not reach the final ayah.');
console.log('Rolling 12-second recognition reached 112:4 without a false surah match.');
