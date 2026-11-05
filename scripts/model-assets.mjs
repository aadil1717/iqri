import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL_BASE_URL, MODEL_ASSETS, MODEL_REPOSITORY, MODEL_REVISION, MODEL_HASHES, MODEL_SIZES, MODEL_LICENSE, MODEL_CREDIT } from '../src/recognition/config.js';

const directory = fileURLToPath(new URL('../models/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const name of [...MODEL_ASSETS, 'LICENSE']) {
  const target = path.join(directory, name);
  let existing = null;
  try { existing = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expected = MODEL_HASHES[name];
  if (!expected) throw new Error(`No pinned checksum for ${name}`);
  if (existing && createHash('sha256').update(existing).digest('hex') === expected) {
    process.stdout.write(`Verified ${name}\n`);
    continue;
  }
  process.stdout.write(`Downloading ${name}\n`);
  const response = await fetch(`${MODEL_BASE_URL}${name}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: ${name} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== MODEL_SIZES[name] || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`Checksum mismatch for ${name}`);
  }
  await writeFile(`${target}.partial`, bytes);
  await rename(`${target}.partial`, target);
}
const manifest = Object.entries(MODEL_HASHES).map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n';
await writeFile(path.join(directory, 'SHA256SUMS'), manifest);
await writeFile(path.join(directory, 'provenance.json'), JSON.stringify({
  repository: MODEL_REPOSITORY,
  revision: MODEL_REVISION,
  modelLicense: MODEL_LICENSE,
  modelCredit: MODEL_CREDIT,
  licenseUrl: `${MODEL_BASE_URL}LICENSE`,
  files: Object.fromEntries(Object.entries(MODEL_HASHES).map(([name, sha256]) => [name, { sha256, size: MODEL_SIZES[name] }])),
  architecture: '33M-parameter Conformer-CTC, int8; 31 character tokens; offline full-attention model used with short rolling windows',
  fetchedAt: new Date().toISOString(),
}, null, 2));
process.stdout.write(`Model assets ready: ${directory}\n`);
