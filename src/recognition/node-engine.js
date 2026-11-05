import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL_FILE } from './config.js';
import { createCharacterRunner, createStreamingRecognition, parseCharacterTokens } from './streaming-engine.js';

export async function loadNodeRecognition({ modelDirectory = fileURLToPath(new URL('../../models/', import.meta.url)), onProgress = () => {} } = {}) {
  // Set before loading the native runtime; suppress its process/model diagnostics.
  process.env.ORT_DISABLE_TELEMETRY = '1';
  const ort = await import('onnxruntime-node');
  onProgress({ phase: 'loading', message: 'Preparing the Quran recognition model on this computer.' });
  const [tokensText, quranText] = await Promise.all([readFile(path.join(modelDirectory, 'tokens.txt'), 'utf8'), readFile(fileURLToPath(new URL('../../dist/data/quran.json', import.meta.url)), 'utf8')]);
  const session = await ort.InferenceSession.create(path.join(modelDirectory, MODEL_FILE), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 4,
    interOpNumThreads: 1,
  });
  const engine = createStreamingRecognition({ runner: createCharacterRunner(ort, session), tokens: parseCharacterTokens(tokensText), quran: JSON.parse(quranText) });
  onProgress({ phase: 'ready', message: 'Quran recognition is ready.' });
  return { ...engine, dispose: () => { engine.dispose(); return session.release(); } };
}
