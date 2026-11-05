import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../scripts/server.mjs';

test('continuous audio endpoints preserve samples and reject malformed or cross-origin input', async () => {
  const port = 14319;
  const calls = [];
  const server = createAppServer({ port, loadEngine: async () => ({
    streaming: true,
    start: async details => { calls.push(['start', details]); return { type: 'stream-started', sessionId: details.sessionId }; },
    feed: async (audio, details) => { calls.push(['feed', [...audio], details]); return { type: 'stream-result', throughSample: details.endSample, events: [] }; },
    stop: async details => { calls.push(['stop', details]); return { type: 'stream-result', final: true }; },
    dispose() {},
  }) });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const post = (route, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/${route}`, { method: 'POST', headers, body });
  const json = { 'content-type': 'application/json' };
  const binary = { 'content-type': 'application/octet-stream' };
  try {
    assert.equal((await (await post('load', '')).json()).streaming, true);
    assert.equal((await post('stream/start', JSON.stringify({ sessionId: 'test-1', context: { preferredSurah: 112 } }), json)).status, 200);
    const samples = new Float32Array(1600).fill(0.25);
    const feedRoute = 'stream/feed?sessionId=test-1&startSample=0&endSample=1600';
    assert.equal((await post(feedRoute, samples, binary)).status, 200);
    assert.equal(calls[1][1].length, 1600);
    assert.equal(calls[1][1][0], 0.25);
    assert.equal(calls[0][1].context.preferredSurah, 112);
    assert.equal((await post('stream/feed?sessionId=test-1&endSample=1600', samples, binary)).status, 400);
    assert.equal((await post('stream/feed?sessionId=test-1&startSample=0&endSample=1601', samples, binary)).status, 400);
    assert.equal((await post(feedRoute, new Float32Array([NaN]), binary)).status, 400);
    assert.equal((await post(feedRoute, new Float32Array(48001), binary)).status, 413);
    assert.equal((await post('stream/start', JSON.stringify({ sessionId: '../invalid' }), json)).status, 400);
    assert.equal((await post('stream/start', JSON.stringify({ sessionId: 'x', context: { preferredSurah: 115 } }), json)).status, 400);
    assert.equal((await post(feedRoute, samples, { ...binary, origin: 'https://example.com' })).status, 403);
    assert.equal(calls.length, 2);
    assert.equal((await post('stream/stop', JSON.stringify({ sessionId: 'test-1' }), json)).status, 200);
    assert.equal(calls[2][0], 'stop');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await server.disposeRecognition();
  }
});
