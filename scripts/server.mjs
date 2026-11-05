import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const SAMPLE_RATE = 16000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.onnx': 'application/octet-stream',
};

/** Resolve only relative URL paths; reject traversal, Windows drives, and NULs. */
export function resolveWithin(root, relative) {
  if (typeof relative !== 'string' || /[\\:\0]/u.test(relative) || path.isAbsolute(relative)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const difference = path.relative(resolvedRoot, resolved);
  if (difference === '..' || difference.startsWith(`..${path.sep}`) || path.isAbsolute(difference)) return null;
  return resolved;
}

function json(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function audioBody(request, { minimumSamples = Math.ceil(SAMPLE_RATE / 3), maximumSamples = SAMPLE_RATE * 30 } = {}) {
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') throw requestError(415, 'Send 16 kHz mono Float32 audio as application/octet-stream.');
  const declaredSize = Number(request.headers['content-length']);
  const maximumBytes = maximumSamples * 4;
  if (declaredSize > maximumBytes) throw requestError(413, 'The audio segment is too long.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw requestError(413, 'The audio segment is too long.');
    chunks.push(chunk);
  }
  if (size % 4 || size < minimumSamples * 4) {
    throw requestError(400, 'The audio segment has an invalid sample length.');
  }
  const bytes = Buffer.concat(chunks, size);
  const audio = new Float32Array(size / 4);
  try {
    for (let index = 0; index < audio.length; index += 1) {
      const value = bytes.readFloatLE(index * 4);
      if (!Number.isFinite(value) || Math.abs(value) > 1) throw requestError(400, 'Audio contains invalid samples.');
      audio[index] = value;
    }
  } catch (error) {
    audio.fill(0);
    throw error;
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
  return audio;
}

async function smallJsonBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw requestError(415, 'Send JSON session details.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw requestError(413, 'The session details are too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw requestError(400, 'The session details are invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestError(400, 'The session details are invalid.');
  return value;
}

function streamSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) throw requestError(400, 'The listening session is invalid.');
  return value;
}

function streamContext(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestError(400, 'The recitation context is invalid.');
  const params = new URLSearchParams();
  if (value.preferredSurah != null) params.set('preferredSurah', String(value.preferredSurah));
  if (value.previousReference) {
    const ref = value.previousReference;
    params.set('previousReference', `${ref.surah}:${ref.ayah}${ref.ayah_end ? '-' + ref.ayah_end : ''}`);
  }
  return recognitionContext(params);
}

async function discardSmallBody(request) {
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024) throw requestError(413, 'This request does not accept an audio body.');
  }
}

function recognitionContext(searchParams) {
  const preferredValue = searchParams.get('preferredSurah');
  const preferredSurah = preferredValue ? Number(preferredValue) : null;
  if (preferredSurah !== null && (!Number.isInteger(preferredSurah) || preferredSurah < 1 || preferredSurah > 114)) {
    throw requestError(400, 'The selected surah is invalid.');
  }
  const previousValue = searchParams.get('previousReference');
  let previousReference;
  if (previousValue) {
    const match = /^(\d{1,3}):(\d{1,3})(?:-(\d{1,3}))?$/u.exec(previousValue);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 114 || Number(match[2]) < 1 ||
      Number(match[2]) > 286 || (match[3] && (Number(match[3]) < Number(match[2]) || Number(match[3]) > 286))) {
      throw requestError(400, 'The previous ayah reference is invalid.');
    }
    previousReference = { surah: Number(match[1]), ayah: Number(match[2]) };
    if (match[3]) previousReference.ayah_end = Number(match[3]);
  }
  return { preferredSurah, previousReference };
}

async function serveFile(request, response, root, relative) {
  const candidate = resolveWithin(root, relative);
  if (!candidate) return json(response, 403, { error: 'This file is not available.' });
  try {
    // Resolve symlinks too, so a file inside the served folder cannot escape it.
    const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(candidate)]);
    const actualRelative = path.relative(actualRoot, actualFile);
    if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
      return json(response, 403, { error: 'This file is not available.' });
    }
    const info = await stat(actualFile);
    if (!info.isFile()) return json(response, 404, { error: 'File not found.' });
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(actualFile).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') return response.end();
    const stream = createReadStream(actualFile);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    json(response, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, { error: 'File not available.' });
  }
}

/** Create without listening, so tooling may inspect or test the server safely. */
export function createAppServer({ port = 4317, directory = projectDirectory, loadEngine } = {}) {
  const distDirectory = path.join(directory, 'dist');
  const modelDirectory = path.join(directory, 'models');
  let engine;
  let loading;
  let state = 'idle';
  let busy = false;
  let progress = { phase: 'idle', message: 'Voice recognition starts when you choose.' };
  const load = loadEngine || (async options => {
    const { loadNodeRecognition } = await import('../src/recognition/node-engine.js');
    return loadNodeRecognition(options);
  });
  async function ensureEngine() {
    if (engine) return engine;
    if (!loading) {
      state = 'loading';
      loading = Promise.resolve().then(() => load({ modelDirectory, onProgress: value => { progress = value; } }))
        .then(value => { engine = value; state = 'ready'; return value; })
        .catch(error => {
          state = 'error';
          progress = { phase: 'error', message: 'The voice model could not start. Please retry.' };
          throw error;
        }).finally(() => { loading = null; });
    }
    return loading;
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(request.headers.host)) return json(response, 403, { error: 'Use the local Iqri address.' });
    let url;
    try { url = new URL(request.url, `http://${request.headers.host}`); }
    catch { return json(response, 400, { error: 'Invalid request.' }); }

    if (request.method === 'POST') {
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${request.headers.host}`) || request.headers['sec-fetch-site'] === 'cross-site') {
        return json(response, 403, { error: 'Open Iqri locally to use the microphone.' });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, { ok: true, localRecognition: true, state, busy, progress,
        sampleRate: SAMPLE_RATE, maxAudioSeconds: 30, savesRecordings: false });
    }

    const streamRoute = ['/api/stream/start', '/api/stream/feed', '/api/stream/stop'].includes(url.pathname);
    if (request.method === 'POST' && (url.pathname === '/api/load' || url.pathname === '/api/transcribe' || streamRoute)) {
      if (busy) {
        response.setHeader('Retry-After', '2');
        return json(response, 429, { error: 'Iqri is still processing the previous audio segment.' });
      }
      busy = true;
      let audio;
      // Timing out a response does not cancel native inference: keep the busy
      // lock until its promise settles, avoiding concurrent model execution.
      const deadline = setTimeout(() => json(response, 504, { error: 'Recognition is taking longer than expected. Please wait and retry.' }), 180000);
      const uploadDeadline = setTimeout(() => {
        json(response, 408, { error: 'The audio upload timed out.' });
        request.destroy();
      }, 15000);
      try {
        const context = recognitionContext(url.searchParams);
        let details;
        if (url.pathname === '/api/stream/feed') {
          const sessionId = streamSessionId(url.searchParams.get('sessionId'));
          const startValue = url.searchParams.get('startSample');
          const endValue = url.searchParams.get('endSample');
          if (!/^\d+$/u.test(startValue || '') || !/^\d+$/u.test(endValue || '')) throw requestError(400, 'The audio position is invalid.');
          const startSample = Number(startValue);
          const endSample = Number(endValue);
          if (!Number.isSafeInteger(startSample) || startSample < 0 || !Number.isSafeInteger(endSample) || endSample <= startSample) throw requestError(400, 'The audio position is invalid.');
          audio = await audioBody(request, { minimumSamples: 1, maximumSamples: SAMPLE_RATE * 3 });
          if (endSample - startSample !== audio.length) throw requestError(400, 'The audio position does not match its samples.');
          details = { sessionId, startSample, endSample };
        } else if (streamRoute) {
          const body = await smallJsonBody(request);
          details = { sessionId: streamSessionId(body.sessionId) };
          if (url.pathname.endsWith('/start')) details.context = streamContext(body.context);
        } else if (url.pathname === '/api/transcribe') audio = await audioBody(request);
        else await discardSmallBody(request);
        clearTimeout(uploadDeadline);
        const ready = await ensureEngine();
        if (streamRoute) {
          if (!ready.streaming) throw requestError(409, 'This recognition engine does not support continuous listening.');
          const result = url.pathname.endsWith('/start') ? await ready.start(details)
            : url.pathname.endsWith('/stop') ? await ready.stop(details) : await ready.feed(audio, details);
          json(response, 200, result);
        } else if (audio) {
          const prediction = await ready.transcribe(audio, context);
          json(response, 200, { prediction });
        } else json(response, 200, { ok: true, state: 'ready', streaming: ready.streaming === true });
      } catch (error) {
        json(response, error.status || 500, { error: error.status ? error.message : 'Recognition could not finish. Please try again.' });
        if (!error.status) console.error('Iqri recognition error:', error.message);
      } finally {
        clearTimeout(deadline);
        clearTimeout(uploadDeadline);
        // Streaming feature extractors may retain a short tail until the next
        // feed. The adapter owns that bounded memory and releases it on stop.
        if (!streamRoute) audio?.fill(0);
        busy = false;
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found.' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return json(response, 400, { error: 'Invalid file path.' }); }
    if (pathname.startsWith('/models/')) return serveFile(request, response, modelDirectory, pathname.slice(8));
    return serveFile(request, response, distDirectory, pathname === '/' ? 'index.html' : pathname.slice(1));
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.disposeRecognition = async () => {
    if (loading) await loading.catch(() => {});
    await engine?.dispose();
    engine = null;
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
  const server = createAppServer({ port });
  server.listen(port, '127.0.0.1', () => console.log(`Iqri is ready at http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(`Iqri could not start: ${error.message}`); process.exitCode = 1; });
  const stop = () => server.close(async () => { await server.disposeRecognition(); process.exit(0); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
