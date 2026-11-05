import { cp, mkdir, readFile, writeFile, rm, copyFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODEL_HASHES } from '../src/recognition/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (script, args = []) => {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
};
run('scripts/build.mjs');
run('scripts/mobile-assets.mjs');
run('scripts/model-assets.mjs');
const staging = path.resolve(root, 'mobile-web');
// Only this disposable staging folder can be removed; reject redirected paths.
const canonicalRoot = await realpath(root);
let canonicalStaging;
try { canonicalStaging = await realpath(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (path.dirname(staging) !== path.resolve(root) || (canonicalStaging && canonicalStaging !== path.join(canonicalRoot, 'mobile-web')))
  throw new Error('Mobile staging must be inside the project.');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(path.join(root, 'dist'), staging, {
  recursive: true,
  filter: source => !/\.map$/.test(source) && !['sw.js', '_headers'].includes(path.basename(source)),
});
await mkdir(path.join(staging, 'models'), { recursive: true });
for (const name of [...Object.keys(MODEL_HASHES), 'SHA256SUMS', 'provenance.json'])
  await copyFile(path.join(root, 'models', name), path.join(staging, 'models', name));
await copyFile(path.join(staging, 'ort/ort-wasm-simd-threaded.mjs'), path.join(staging, 'ort/ort-wasm-simd-threaded.js'));
for (const [name, expected] of Object.entries(MODEL_HASHES)) {
  const bytes = await readFile(path.join(staging, 'models', name));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Bundled model checksum mismatch: ${name}`);
}
if (process.argv.includes('--sync')) {
  run('node_modules/@capacitor/cli/bin/capacitor', ['sync', 'ios']);
  // Capacitor regenerates this file on sync; pin the native runtime and OS floor.
  const packagePath = path.join(root, 'ios/App/CapApp-SPM/Package.swift');
  const swift = (await readFile(packagePath, 'utf8'))
    .replace(/\.iOS\(\.v\d+\)/g, '.iOS(.v17)')
    .replace(/from: "8\.[0-9.]+"/, 'exact: "8.6.0"');
  await writeFile(packagePath, swift);
  run('scripts/validate-mobile.mjs');
}
console.log('Mobile assets verified; recognition model is bundled for on-device use.');
