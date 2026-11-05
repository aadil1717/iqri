import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStreamingRecognition } from '../src/recognition/streaming-engine.js';

const corpus = JSON.parse(await readFile(new URL('../dist/data/quran.json', import.meta.url), 'utf8'));
const quran = corpus.filter(verse => verse.surah === 112 || (verse.surah === 2 && [255, 256].includes(verse.ayah)));
function fake(text = 'قل هو الله') {
  const letters = [...new Set(text.replaceAll(' ', '▁'))];
  const tokens = new Map([[0, '<blk>'], ...letters.map((letter, index) => [index + 1, letter])]);
  const ids = new Map([...tokens].map(([id, letter]) => [letter, id]));
  let calls = 0;
  const runner = { async run(audio) {
    calls++;
    const timeSteps = Math.max(10, Math.round(audio.length / 640));
    const vocabSize = tokens.size;
    const logprobs = new Float32Array(timeSteps * vocabSize).fill(-12);
    for (let frame = 0; frame < timeSteps; frame++) logprobs[frame * vocabSize] = 0;
    let frame = 1, previous = -1;
    for (const letter of text.replaceAll(' ', '▁')) {
      const id = ids.get(letter);
      if (id === previous) frame++;
      if (frame >= timeSteps) break;
      logprobs[frame * vocabSize] = -12;
      logprobs[frame * vocabSize + id] = 0;
      frame++; previous = id;
    }
    return { logprobs, timeSteps, vocabSize, blankId: 0 };
  } };
  return { engine: createStreamingRecognition({ runner, tokens, quran }), calls: () => calls };
}
const voiced = size => Float32Array.from({ length: size }, (_, index) => .08 * Math.sin(index * .3));
async function feedFor(engine, sessionId, seconds, origin = 0, sound = true) {
  const events = [];
  for (let offset = 0; offset < seconds * 16000; offset += 1600) {
    const audio = sound ? voiced(1600) : new Float32Array(1600);
    const result = await engine.feed(audio, { sessionId, startSample: origin + offset, endSample: origin + offset + audio.length });
    events.push(...result.events);
  }
  return events;
}

test('stream generation and range checks reject stale, missing, and malformed audio', async () => {
  const { engine, calls } = fake();
  engine.start({ sessionId: 'old' }); engine.start({ sessionId: 'new' });
  await assert.rejects(engine.feed(voiced(1600), { sessionId: 'old', startSample: 0, endSample: 1600 }), /no longer active/);
  await engine.feed(new Float32Array(1600), { sessionId: 'new', startSample: 48000, endSample: 49600 });
  await assert.rejects(engine.feed(voiced(1600), { sessionId: 'new', startSample: 49601, endSample: 51201 }), /interrupted/);
  await assert.rejects(engine.feed(new Float32Array(32001), { sessionId: 'new', startSample: 49600, endSample: 81601 }), /two seconds/);
  const malformed = voiced(1600); malformed[5] = NaN;
  await assert.rejects(engine.feed(malformed, { sessionId: 'new', startSample: 49600, endSample: 51200 }), /invalid samples/);
  assert.equal(calls(), 0);
  const valid = await engine.feed(new Float32Array(1600), { sessionId: 'new', startSample: 49600, endSample: 51200 });
  assert.equal(valid.throughSample, 51200);
  engine.dispose();
});

test('stable acoustic events preserve a nonzero capture origin', async () => {
  const { engine } = fake();
  const origin = 160000;
  engine.start({ sessionId: 'offset', context: { preferredSurah: 112 } });
  const progress = (await feedFor(engine, 'offset', 1.4, origin)).filter(event => event.type === 'progress');
  assert.ok(progress.length > 0, 'The controlled CTC word evidence must produce a real update');
  for (const event of progress) {
    assert.ok(event.audioEndSample >= origin && event.audioEndSample <= origin + 1.4 * 16000);
    assert.equal(event.prediction.surah, 112);
  }
  engine.dispose();
});

test('silence never invokes the model, and restart cannot replay retained speech', async () => {
  const { engine, calls } = fake();
  engine.start({ sessionId: 'quiet' });
  const events = await feedFor(engine, 'quiet', 2, 0, false);
  assert.equal(calls(), 0);
  assert.equal(events.filter(event => event.type === 'progress').length, 0);
  assert.equal(events.filter(event => event.prediction.status === 'silence').length, 1);
  await engine.stop({ sessionId: 'quiet' });
  await assert.rejects(engine.feed(voiced(1600), { sessionId: 'quiet', startSample: 32000, endSample: 33600 }), /no longer active/);
  engine.start({ sessionId: 'speech', context: { preferredSurah: 112 } });
  await feedFor(engine, 'speech', 1.4);
  await engine.stop({ sessionId: 'speech' });
  const before = calls();
  engine.start({ sessionId: 'fresh' });
  const fresh = await feedFor(engine, 'fresh', 1, 70000, false);
  assert.equal(calls(), before);
  assert.equal(fresh.filter(event => event.type === 'progress').length, 0);
  engine.dispose();
});

test('a two-letter fragment cannot jump from a long ayah to a remote word of the next', async () => {
  const { engine } = fake('سم');
  engine.start({ sessionId: 'fragment', context: { preferredSurah: 2, previousReference: { surah: 2, ayah: 255, wordIndex: 7 } } });
  const events = await feedFor(engine, 'fragment', 3);
  assert.equal(events.filter(event => event.type === 'progress').length, 0);
  engine.dispose();
});

test('unmatched Arabic remains visible without inventing a Quran location', async () => {
  const { engine } = fake('كلام غير معروف');
  const origin = 64000;
  engine.start({ sessionId: 'transcript', context: { preferredSurah: 112 } });
  const events = await feedFor(engine, 'transcript', 1.8, origin);
  const transcript = events.filter(event => event.type === 'transcript');
  assert.ok(transcript.length > 0);
  assert.ok(transcript.some(event => /كلام/.test(event.transcript)));
  assert.ok(transcript.every(event => event.audioEndSample >= origin));
  assert.equal(events.filter(event => event.type === 'progress').length, 0);
  await engine.stop({ sessionId: 'transcript' });
  engine.start({ sessionId: 'new-transcript' });
  const fresh = await feedFor(engine, 'new-transcript', 1, origin + 100000, false);
  assert.equal(fresh.filter(event => event.type === 'transcript' && event.transcript).length, 0);
  engine.dispose();
});

test('a verse hypothesis without word evidence retains acquisition context', async () => {
  const tokens = new Map([[0, '<blk>'], [1, '▁القيوم'], [2, '▁لا'], [3, '▁تاخذه'], [4, '▁سنه']]);
  const inputLengths = [];
  const runner = { async run(audio) {
    inputLengths.push(audio.length);
    const timeSteps = Math.round(audio.length / 640), vocabSize = tokens.size;
    const logprobs = new Float32Array(timeSteps * vocabSize).fill(-12);
    for (let frame = 0; frame < timeSteps; frame++) logprobs[frame * vocabSize] = 0;
    // A whole-query location exists, but all letters remain in the unstable
    // right edge: there is deliberately no trustworthy acoustic word yet.
    for (let id = 1; id <= 4; id++) {
      const frame = timeSteps - 5 + id;
      logprobs[frame * vocabSize] = -12; logprobs[frame * vocabSize + id] = 0;
    }
    return { logprobs, timeSteps, vocabSize, blankId: 0 };
  } };
  const engine = createStreamingRecognition({ runner, tokens, quran });
  engine.start({ sessionId: 'location-only', context: { preferredSurah: 2 } });
  const events = await feedFor(engine, 'location-only', 3);
  assert.equal(events.filter(event => event.type === 'progress').length, 0);
  assert.ok(Math.max(...inputLengths) > 2 * 16000, 'A tentative verse must not prematurely cut away first-word context');
  engine.dispose();
});

test('a bounded wider probe recovers fresh next-ayah words without replacing short tracking', async () => {
  const tokens = new Map([[0, '<blk>'], [1, '▁الصمد'], [2, '▁لم'], [3, '▁يلد'], [4, '▁ولم'], [5, '▁يولد']]);
  let through = 0;
  const calls = [];
  const runner = { async run(audio) {
    calls.push({ through, length: audio.length });
    const timeSteps = Math.round(audio.length / 640), vocabSize = tokens.size;
    const logprobs = new Float32Array(timeSteps * vocabSize).fill(-12);
    for (let frame = 0; frame < timeSteps; frame++) logprobs[frame * vocabSize] = 0;
    const start = through - audio.length;
    const observations = audio.length > 32000
      ? [[2, 2.2], [3, 2.4], [4, 2.6], [5, 2.8]]
      : [[1, start / 16000 + .12]];
    for (const [id, seconds] of observations) {
      const frame = Math.round((seconds * 16000 - start) / 640);
      if (frame < 0 || frame >= timeSteps) continue;
      logprobs[frame * vocabSize] = -12; logprobs[frame * vocabSize + id] = 0;
    }
    return { logprobs, timeSteps, vocabSize, blankId: 0 };
  } };
  const engine = createStreamingRecognition({ runner, tokens, quran });
  engine.start({ sessionId: 'wide-recovery', context: { preferredSurah: 112, previousReference: { surah: 112, ayah: 2, wordIndex: 2 } } });
  const events = [];
  for (let startSample = 0; startSample < 5 * 16000; startSample += 1600) {
    through = startSample + 1600;
    const result = await engine.feed(voiced(1600), { sessionId: 'wide-recovery', startSample, endSample: through });
    events.push(...result.events);
    const recovered = result.events.findIndex(event => event.type === 'progress' && event.prediction.ayah === 3);
    if (recovered >= 0) assert.ok(result.events.slice(recovered + 1).every(event => event.type !== 'status' || event.prediction.status === 'matched'), 'An old uncertain result must not erase recovery in the same reply');
  }
  assert.ok(events.some(event => event.type === 'progress' && event.prediction.surah === 112 && event.prediction.ayah === 3));
  assert.ok(calls.some(call => call.length > 32000));
  assert.ok(calls.every(call => call.length <= 4 * 16000), 'Recovery audio remains bounded');
  const firstWide = calls.findIndex(call => call.length > 32000);
  assert.ok(calls.slice(firstWide + 1).some(call => call.length === 32000), 'A wider probe must not replace the ordinary short tracker');
  engine.dispose();
});

test('a guessed final word cannot confirm a shared first word in a fresh session', async () => {
  const tokens = new Map([[0, '<blk>'], [1, '▁الله'], [2, '▁ال'], [3, 'صمد']]);
  const runner = { async run(audio) {
    const timeSteps = Math.round(audio.length / 640), vocabSize = tokens.size;
    const logprobs = new Float32Array(timeSteps * vocabSize).fill(-12);
    for (let frame = 0; frame < timeSteps; frame++) logprobs[frame * vocabSize] = 0;
    // Allah is stable; a bare article is inside the accepted window. The
    // model's guessed rest of the noun lives only at its unstable right edge.
    for (const [id, frame] of [[1, 2], [2, timeSteps - 7], [3, timeSteps - 2]]) {
      logprobs[frame * vocabSize] = -12; logprobs[frame * vocabSize + id] = 0;
    }
    return { logprobs, timeSteps, vocabSize, blankId: 0 };
  } };
  const engine = createStreamingRecognition({ runner, tokens, quran });
  engine.start({ sessionId: 'shared-first-word' });
  const events = await feedFor(engine, 'shared-first-word', 3);
  assert.ok(events.some(event => event.type === 'transcript' && event.transcript === 'الله الصمد'));
  assert.equal(events.filter(event => event.prediction?.status === 'matched').length, 0,
    'A completed raw transcript cannot turn stable Allah alone into a confirmed verse');
  engine.dispose();
});
