import test from 'node:test';
import assert from 'node:assert/strict';
import { recognitionAssetOptions, unlockAudioContext, microphoneErrorMessage, registerNativeLifecycle } from '../src/native-platform.js';
import { prepareBrowserAcceleration } from '../src/browser-acceleration.js';

test('native recognition uses absolute bundled assets while the website retains its remote model default', () => {
  assert.deepEqual(recognitionAssetOptions({ native: false }), {});
  assert.deepEqual(recognitionAssetOptions({ native: true, href: 'capacitor://localhost/index.html' }), {
    baseUrl: 'capacitor://localhost/models/',
    quranUrl: 'capacitor://localhost/data/quran.json',
    wasmPaths: {
      mjs: 'capacitor://localhost/ort/ort-wasm-simd-threaded.js',
      wasm: 'capacitor://localhost/ort/ort-wasm-simd-threaded.wasm',
    },
  });
  assert.equal(recognitionAssetOptions({ native: true, href: 'https://localhost/reader' }).baseUrl, 'https://localhost/models/');
});

test('audio is unlocked synchronously in the tap before any asynchronous preparation', async () => {
  const calls = [];
  let complete;
  class AudioContext {
    constructor() { calls.push('create'); }
    resume() { calls.push('resume'); return new Promise(resolve => { complete = resolve; }); }
  }
  const unlocked = unlockAudioContext(AudioContext);
  calls.push('prepare');
  assert.deepEqual(calls, ['create', 'resume', 'prepare']);
  assert.ok(unlocked.context instanceof AudioContext);
  let ready = false;
  unlocked.ready.then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false);
  complete(); await unlocked.ready; assert.equal(ready, true);
});

test('permission-sheet inactivity does not cancel setup, while background and real interruptions stop listening', async () => {
  const listeners = new Map(), removed = [];
  let listening = false, paused = 0;
  const dispose = await registerNativeLifecycle({ isListening: () => listening, onPause: () => { paused++; listening = false; } }, {
    native: true,
    app: { addListener: async (name, callback) => { listeners.set(name, callback); return { remove: async () => removed.push(name) }; } },
  });
  listeners.get('appStateChange')({ isActive: false });
  assert.equal(paused, 0, 'An OS permission prompt can resign active during setup');
  listeners.get('pause')();
  assert.equal(paused, 1, 'Actual backgrounding also cancels initialization');
  listening = true;
  listeners.get('appStateChange')({ isActive: false });
  assert.equal(paused, 2);
  listeners.get('appStateChange')({ isActive: true });
  assert.equal(paused, 2, 'Returning to the foreground must not restart recording');
  assert.equal(listening, false);
  await dispose(); assert.deepEqual(removed.sort(), ['appStateChange', 'pause']);
});

test('native lifecycle registration tolerates a missing event and does nothing on the website', async () => {
  let calls = 0, removed = 0;
  const app = { addListener(name) { calls++; if (name === 'pause') throw new Error('Unavailable'); return { remove: async () => { removed++; } }; } };
  const callbacks = { isListening: () => false, onPause() {} };
  await (await registerNativeLifecycle(callbacks, { native: false, app }))();
  assert.equal(calls, 0);
  await (await registerNativeLifecycle(callbacks, { native: true, app }))();
  assert.equal(calls, 2); assert.equal(removed, 1);
});

test('native startup skips service-worker registration without touching browser globals', async () => {
  assert.equal(await prepareBrowserAcceleration({ native: true }), false);
});

test('microphone failures give platform-appropriate recovery instructions', () => {
  assert.match(microphoneErrorMessage({ name: 'NotAllowedError' }, true), /Allow Iqri.*Settings/);
  assert.match(microphoneErrorMessage({ name: 'NotAllowedError' }, false), /Safari/);
  assert.match(microphoneErrorMessage({ name: 'NotReadableError' }, true), /microphone is unavailable/);
  assert.match(microphoneErrorMessage({ name: 'NotFoundError' }, true), /No microphone/);
  assert.equal(microphoneErrorMessage({ message: 'Specific failure' }, true), 'Specific failure');
});
