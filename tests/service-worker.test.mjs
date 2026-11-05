import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('browser acceleration adds isolation headers without caching audio, API or unknown routes', async () => {
  const events = {}, cached = [];
  const scope = {
    self: { addEventListener: (name, fn) => { events[name] = fn; } },
    location: { origin: 'https://iqri.example' }, URL, Headers, Response,
    fetch: async () => new Response('asset', { headers: { 'Content-Type': 'text/plain' } }),
    caches: { open: async () => ({ put: async request => cached.push(new URL(request.url).pathname) }), match: async () => null },
  };
  vm.runInNewContext(await readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8'), scope);
  async function request(path, method = 'GET') {
    let result;
    const waits = [];
    events.fetch({ request: { url: 'https://iqri.example' + path, method, mode: 'same-origin' },
      respondWith: promise => { result = promise; }, waitUntil: promise => waits.push(promise) });
    const response = await result;
    await Promise.all(waits);
    return response;
  }
  const app = await request('/app.js');
  assert.equal(app.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(app.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(await app.text(), 'asset');
  assert.equal(await request('/api/stream/feed', 'POST'), undefined);
  assert.equal(await request('/models/model.int8.onnx'), undefined);
  assert.equal(await request('/_qa/private-recording.f32', 'POST'), undefined);
  await request('/_qa/app');
  await request('/auth/callback');
  assert.deepEqual(cached, ['/app.js']);
  scope.fetch = async () => { throw new Error('offline'); };
  scope.caches.match = async () => new Response('cached');
  const offline = await request('/app.js');
  assert.equal(offline.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(await offline.text(), 'cached');
});
