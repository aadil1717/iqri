import { build } from 'esbuild';
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
// Keep the full MIT notice with the adapted microphone feedback in the site.
await mkdir(path.join(dist, 'licenses'), { recursive: true });
await copyFile(path.join(root, 'licenses/WhimprFlow-LICENSE.txt'), path.join(dist, 'licenses/WhimprFlow-LICENSE.txt'));
await copyFile(path.join(root, 'licenses/coi-serviceworker-LICENSE.txt'), path.join(dist, 'licenses/coi-serviceworker-LICENSE.txt'));
await copyFile(path.join(root, 'licenses/Abdou-Quran-ASR-MIT.txt'), path.join(dist, 'licenses/Abdou-Quran-ASR-MIT.txt'));
await copyFile(path.join(root, 'licenses/Tilawa-Fbank-MIT.txt'), path.join(dist, 'licenses/Tilawa-Fbank-MIT.txt'));
await copyFile(path.join(root, 'licenses/ONNX-Runtime-LICENSE.txt'), path.join(dist, 'licenses/ONNX-Runtime-LICENSE.txt'));
await copyFile(path.join(root, 'licenses/ONNX-Runtime-ThirdPartyNotices.txt'), path.join(dist, 'licenses/ONNX-Runtime-ThirdPartyNotices.txt'));
await copyFile(path.join(root, 'licenses/Tilawi-Quran-ASR-MIT.txt'), path.join(dist, 'licenses/Tilawi-Quran-ASR-MIT.txt'));
await copyFile(path.join(root, 'src/service-worker.js'), path.join(dist, 'sw.js'));

await Promise.all([
  build({
    entryPoints: [path.join(root, 'src/app.js')], outfile: path.join(dist, 'app.js'),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, sourcemap: true, legalComments: 'linked', logLevel: 'info',
  }),
  build({
    entryPoints: [path.join(root, 'src/recognition/worker.js')], outfile: path.join(dist, 'recognition-worker.js'),
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
    minify: true, sourcemap: true, legalComments: 'linked', logLevel: 'info',
  }),
]);

// ONNX dynamically imports its companion modules and WebAssembly files. Copy
// only that family, retaining the application shell and translation data.
const require = createRequire(import.meta.url);
const ortDist = path.dirname(require.resolve('onnxruntime-web'));
const destination = path.join(dist, 'ort');
await mkdir(destination, { recursive: true });
const runtimeFiles = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
if (!runtimeFiles.some(name => name.endsWith('.wasm'))) throw new Error('ONNX browser runtime assets were not found.');
await Promise.all(runtimeFiles.map(name => copyFile(path.join(ortDist, name), path.join(destination, name))));
// This app selects WASM only; omit the unrelated WebGPU/Asyncify builds.
for (const name of await readdir(destination)) {
  if (/^ort-wasm.*\.(?:mjs|wasm)$/u.test(name) && !runtimeFiles.includes(name)) await unlink(path.join(destination, name));
}

const workletSource = path.join(root, 'src/mic-worklet.js');
try {
  if ((await stat(workletSource)).isFile()) await copyFile(workletSource, path.join(dist, 'mic-worklet.js'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // The application may author this small worklet directly in dist.
}
console.log(`Iqri built successfully. Browser recognition runtime: ${runtimeFiles.length} assets.`);
