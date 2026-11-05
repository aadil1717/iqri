import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveAudioScheduler } from '../src/live-audio.js';

const create = () => new LiveAudioScheduler({ sampleRate: 10 });
function push(scheduler, count, { quiet = false, start = scheduler.latestEnd } = {}) {
  const audio = Float32Array.from({ length: count }, (_, index) => start + index + 1);
  scheduler.push(audio, { sampleEnd: start + count, rms: quiet ? 0 : 0.1 });
}

test('keeps one active inference and takes only the newest four-second window after lock', () => {
  const scheduler = create();
  push(scheduler, 20);
  const first = scheduler.take();
  assert.equal(first.windowSeconds, 2);
  push(scheduler, 50);
  assert.equal(scheduler.take(), null);
  scheduler.complete(first, { status: 'matched', processingMs: 400 });
  const latest = scheduler.take();
  assert.equal(latest.startSample, 30);
  assert.equal(latest.endSample, 70);
  assert.equal(latest.windowSeconds, 4);
  assert.deepEqual([...latest.audio], Array.from({ length: 40 }, (_, index) => index + 31));
});

test('bounded ring wraps correctly and recovers an eight-second acquisition window', () => {
  const scheduler = create();
  push(scheduler, 75);
  const first = scheduler.take();
  scheduler.complete(first, { status: 'uncertain', recommendedWindowSeconds: 8 });
  push(scheduler, 30);
  const latest = scheduler.take();
  assert.equal(scheduler.count, 80);
  assert.equal(latest.windowSeconds, 8);
  assert.deepEqual([...latest.audio], Array.from({ length: 80 }, (_, index) => index + 26));
});

test('skips silence, runs one final pass, and resumes for new recitation', () => {
  const scheduler = create();
  push(scheduler, 20, { quiet: true });
  assert.equal(scheduler.take(), null);
  push(scheduler, 20);
  const first = scheduler.take();
  scheduler.complete(first, { status: 'matched' });
  push(scheduler, 5, { quiet: true });
  const final = scheduler.take();
  assert.equal(final.finalPass, true);
  scheduler.complete(final, { status: 'matched' });
  push(scheduler, 60, { quiet: true });
  assert.equal(scheduler.take(), null);
  push(scheduler, 10);
  assert.ok(scheduler.take());
});

test('a short utterance receives its final pass once enough context is captured', () => {
  const scheduler = create();
  push(scheduler, 10);
  assert.equal(scheduler.take(), null);
  push(scheduler, 5, { quiet: true });
  const final = scheduler.take();
  assert.ok(final?.finalPass);
  assert.equal(final.audio.length, 15);
});

test('rejects old acoustic evidence while allowing a genuine later repetition', () => {
  const scheduler = create();
  push(scheduler, 20);
  const first = scheduler.take();
  assert.equal(scheduler.accept(first, { wordProgress: { source:'acoustic-ctc-alignment',wordIndex: 3, estimatedAudioEndMs: 1500 } }).accepted, true);
  scheduler.complete(first, { status: 'matched' });
  push(scheduler, 30);
  const second = scheduler.take();
  assert.equal(scheduler.accept(second, { wordProgress: { source:'acoustic-ctc-alignment',wordIndex: 1, estimatedAudioEndMs: 100 } }).reason, 'older-word-evidence');
  assert.equal(scheduler.accept(second, { wordProgress: { source:'acoustic-ctc-alignment',wordIndex: 1, estimatedAudioEndMs: 2000 } }).accepted, true);
});

test('scope reset rejects the old result without starting concurrent inference', () => {
  const scheduler = create();
  push(scheduler, 20);
  const old = scheduler.take();
  scheduler.reset();
  push(scheduler, 30, { start: 20 });
  assert.equal(scheduler.take(), null);
  assert.equal(scheduler.accept(old, {}).reason, 'context-changed');
  scheduler.complete(old, { status: 'matched' });
  assert.equal(scheduler.windowSeconds, 8);
  assert.ok(scheduler.take());
});

test('gapped capture is not stitched into one audio interval', () => {
  const scheduler = create();
  push(scheduler, 20);
  push(scheduler, 20, { start: 30 });
  const clip = scheduler.take();
  assert.equal(clip.startSample, 30);
  assert.deepEqual([...clip.audio], Array.from({ length: 20 }, (_, index) => index + 31));
});

test('overlapping no-word matches cannot change ayah or adaptation, but wholly new audio can', () => {
  const scheduler=create();
  push(scheduler,20);
  const first=scheduler.take();
  const initial={status:'matched',surah:112,ayah:2,processingMs:100,recommendedWindowSeconds:4};
  assert.equal(scheduler.accept(first,initial).accepted,true,'initial acquisition needs no word timing');
  scheduler.complete(first,initial);
  push(scheduler,10);
  const overlap=scheduler.take();
  const stale={...initial,ayah:1,recommendedWindowSeconds:8};
  const held=scheduler.accept(overlap,stale);
  assert.equal(held.reason,'overlapping-reference-without-word-evidence');
  scheduler.complete(overlap,stale,{applyResult:held.accepted});
  assert.equal(scheduler.windowSeconds,4,'a rejected match cannot alter the existing adaptive lock');
  assert.equal(scheduler.lastAppliedReference,'112:2');
  push(scheduler,35);
  const whollyNew=scheduler.take();
  assert.ok(whollyNew.startSample>=first.endSample);
  assert.equal(scheduler.accept(whollyNew,stale).accepted,true,'newly recited earlier ayahs are allowed');
});

test('fresh acoustic evidence permits a backward ayah jump within overlapping audio',()=>{
  const scheduler=create();
  push(scheduler,20);
  const first=scheduler.take();
  const matched={status:'matched',surah:112,ayah:2,wordProgress:{source:'acoustic-ctc-alignment',verseKey:'112:2',estimatedAudioEndMs:1800}};
  assert.ok(scheduler.accept(first,matched).accepted);
  scheduler.complete(first,matched);
  push(scheduler,10);
  const repeated=scheduler.take();
  assert.ok(scheduler.accept(repeated,{...matched,ayah:1,wordProgress:{source:'acoustic-ctc-alignment',verseKey:'112:1',estimatedAudioEndMs:2900}}).accepted);
});

test('failed inference cannot immediately drain the same clip or repeat its final pass',()=>{
  const scheduler=create();
  push(scheduler,20);
  const first=scheduler.take();
  scheduler.complete(first,undefined);
  assert.equal(scheduler.take(),null);
  push(scheduler,5,{quiet:true});
  const final=scheduler.take();
  assert.ok(final.finalPass);
  scheduler.complete(final,undefined);
  assert.equal(scheduler.take(),null);
  push(scheduler,50,{quiet:true});
  assert.equal(scheduler.take(),null);
});
