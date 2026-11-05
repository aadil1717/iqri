import * as ort from 'onnxruntime-web/wasm';
import { MODEL_ASSETS, MODEL_BASE_URL, MODEL_FILE, MODEL_REVISION, MODEL_HASHES, MODEL_SIZES, QURAN_URL } from './config.js';
import { createCharacterRunner, createStreamingRecognition, parseCharacterTokens } from './streaming-engine.js';

let engine;
let loading;
let busy = false;
const send = message => self.postMessage(message);

async function openModelCache() {
  try { return typeof caches !== 'undefined' ? await caches.open(`iqri-model-${MODEL_REVISION}`) : null; }
  catch { return null; }
}

async function fetchAsset(url, name, expectedHash) {
  const cache = await openModelCache();
  let response = null;
  try { response = cache ? await cache.match(url) : null; } catch {}
  const cached = Boolean(response);
  if (!response) response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${name} (${response.status}).`);
  let bytes;
  const total = Number(response.headers.get('content-length'));
  if (name === MODEL_FILE && response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    let lastProgress = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (performance.now() - lastProgress > 150) {
        send({ type: 'progress', phase: cached ? 'cache' : 'download', loaded, total: total || MODEL_SIZES[MODEL_FILE], message: cached ? 'Opening the saved voice model…' : 'Downloading the voice model once…' });
        lastProgress = performance.now();
      }
    }
    bytes = new Uint8Array(loaded);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  } else bytes = new Uint8Array(await response.arrayBuffer());
  if (expectedHash) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== expectedHash) {
      try { await cache?.delete(url); } catch {}
      throw new Error(`The downloaded ${name} failed its integrity check. Please retry.`);
    }
  }
  if (!cached && cache) {
    try { await cache.put(url, new Response(bytes, { headers: { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' } })); } catch { /* Quota limits must not prevent a live session. */ }
  }
  return bytes;
}

async function load(options) {
  const baseUrl = options.baseUrl || MODEL_BASE_URL;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  send({ type: 'progress', phase: 'loading', message: 'Preparing private voice recognition…' });
  const files = {};
  for (const name of MODEL_ASSETS) files[name] = await fetchAsset(`${base}${name}`, name, MODEL_HASHES[name]);
  const quranBytes = await fetchAsset(options.quranUrl || QURAN_URL, 'quran.json');
  send({ type: 'progress', phase: 'initializing', message: 'Starting the voice model in your browser…' });
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator?.hardwareConcurrency || 2) : 1;
  ort.env.wasm.wasmPaths = options.wasmPaths || '/ort/';
  const modelSession = await ort.InferenceSession.create(files[MODEL_FILE], { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  engine = createStreamingRecognition({ runner: createCharacterRunner(ort, modelSession), tokens: parseCharacterTokens(new TextDecoder().decode(files['tokens.txt'])), quran: JSON.parse(new TextDecoder().decode(quranBytes)) });
  send({ type: 'ready', streaming: true, backend: 'browser', modelRevision: MODEL_REVISION, threads: ort.env.wasm.numThreads, crossOriginIsolated: Boolean(self.crossOriginIsolated) });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      if (engine) { send({ type: 'ready', streaming: true, backend: 'browser', modelRevision: MODEL_REVISION, threads: ort.env.wasm.numThreads, crossOriginIsolated: Boolean(self.crossOriginIsolated) }); return; }
      loading ||= load(data).catch(error => { loading = null; throw error; });
      await loading;
    } else if (data.type === 'transcribe') {
      if (!engine) throw new Error('The voice model is still loading.');
      if (busy) { send({ type: 'busy', id: data.id }); return; }
      busy = true;
      try { send({ type: 'result', id: data.id, prediction: await engine.transcribe(data.audio, data.context) }); }
      finally { busy = false; }
    } else if (['stream-start', 'stream-feed', 'stream-stop'].includes(data.type)) {
      if (!engine) throw new Error('The voice model is still loading.');
      if (busy) throw new Error('Wait for the current audio chunk.');
      busy = true;
      try {
        const result = data.type === 'stream-start' ? engine.start(data) : data.type === 'stream-feed' ? await engine.feed(data.audio, data) : await engine.stop(data);
        send({ ...result, id: data.id });
      } finally { busy = false; }
    }
  } catch (error) {
    send({ type: 'error', id: data.id, stage: data.type, message: error?.message || String(error) });
  }
};
