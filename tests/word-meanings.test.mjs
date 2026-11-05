import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
const freshLoader = () => import(`../src/word-meanings.js?test=${++moduleId}`);
// Synthetic provider-shaped fixture: not a translation corpus.
const payload = (key) => ({ verse: { verse_key: key, words: [
  { position: 1, char_type_name: 'word', text_uthmani: 'قُلْ', text_imlaei: 'قُلْ', translation: { language_name: 'english', text: 'fixture meaning' } },
  { position: 2, char_type_name: 'end', text_uthmani: '١', translation: { language_name: 'english', text: '(1)' } },
] } });
const response = (data) => ({ ok: true, json: async () => data });

test('deduplicates requests, excludes verse markers, and preserves immutable source word fields', async (t) => {
  const { fetchWords } = await freshLoader();
  let requests = 0;
  let finish;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    requests++;
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(url.searchParams.get('language'), 'en');
    return new Promise((resolve) => { finish = () => resolve(response(payload('112:1'))); });
  });
  const first = fetchWords('112:1');
  assert.equal(fetchWords('112:1'), first);
  finish();
  const words = await first;
  assert.equal(words.length, 1);
  assert.equal(words[0].position, 1);
  assert.equal(words[0].arabic, 'قُلْ');
  assert.equal(words[0].imlaei, 'قُلْ');
  assert.equal(words[0].translation, 'fixture meaning');
  assert.ok(Object.isFrozen(words) && Object.isFrozen(words[0]));
  assert.equal(await fetchWords('112:1'), words);
  assert.equal(requests, 1);
});

test('rejects wrong verse, language, missing text, and inconsistent positions without caching failures', async (t) => {
  const { fetchWords } = await freshLoader();
  let data = payload('1:1');
  t.mock.method(globalThis, 'fetch', async () => response(data));
  await assert.rejects(fetchWords('112:1'), /requested ayah/);
  data = payload('112:1');
  data.verse.words[0].translation.language_name = 'spanish';
  await assert.rejects(fetchWords('112:1'), /English/);
  data = payload('112:1');
  data.verse.words[0].position = 2;
  await assert.rejects(fetchWords('112:1'), /positions/);
  data = payload('112:1');
  data.verse.words[0].text_imlaei = '';
  await assert.rejects(fetchWords('112:1'), /Imlaei/);
  data = payload('112:1');
  assert.equal((await fetchWords('112:1')).length, 1);
});

test('caps memory cache at 50 ayahs and expires old entries', async (t) => {
  const { fetchWords } = await freshLoader();
  let requests = 0;
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests++;
    return response(payload(decodeURIComponent(url.pathname.split('/').at(-1))));
  });
  for (let ayah = 1; ayah <= 51; ayah++) await fetchWords(`2:${ayah}`);
  await fetchWords('2:51');
  assert.equal(requests, 51);
  await fetchWords('2:1');
  assert.equal(requests, 52);
  now += 6 * 60 * 60 * 1000;
  await fetchWords('2:1');
  assert.equal(requests, 53);
});

test('rejects malformed keys locally and permits retry after provider errors', async (t) => {
  const { fetchWords } = await freshLoader();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return requests === 1 ? { ok: false, status: 503 } : response(payload('112:1'));
  });
  for (const key of ['0:1', '115:1', '1:0', '2:287', '01:1', '../112:1']) {
    await assert.rejects(fetchWords(key));
  }
  assert.equal(requests, 0);
  await assert.rejects(fetchWords('112:1'), /HTTP 503/);
  assert.equal((await fetchWords('112:1')).length, 1);
});
