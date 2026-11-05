import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL_HASHES, MODEL_SIZES } from '../src/recognition/config.js';
import { recognitionAssetOptions } from '../src/native-platform.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// Use the parsers already required by our pinned Capacitor CLI, including pnpm.
const cliRequire = createRequire(require.resolve('@capacitor/cli/package.json'));
const plist = cliRequire('plist');
const xcode = cliRequire('xcode');
const native = path.join(root, 'ios/App/App');
const bundle = path.join(native, 'public');
const readJson = async name => JSON.parse(await readFile(name, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unquote = value => typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;

async function filesIn(folder, prefix = '') {
  const output = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Unexpected symlink in signed assets: ${prefix}${entry.name}`);
    if (entry.isDirectory()) output.push(...await filesIn(path.join(folder, entry.name), `${prefix}${entry.name}/`));
    else output.push(`${prefix}${entry.name}`);
  }
  return output;
}

const sourceConfig = await readJson(path.join(root, 'capacitor.config.json'));
const nativeConfig = await readJson(path.join(native, 'capacitor.config.json'));
for (const [label, config] of [['source', sourceConfig], ['native', nativeConfig]]) {
  assert(!config.server?.url, `${label}: hosted server.url must not replace signed assets`);
  assert(!config.server?.hostname || config.server.hostname === 'localhost', `${label}: native hostname must remain localhost`);
  assert(!config.server?.iosScheme || config.server.iosScheme === 'capacitor', `${label}: unexpected native URL scheme`);
  assert.equal(config.webDir, 'mobile-web', `${label}: wrong native asset staging folder`);
  assert.equal(config.ios?.webContentsDebuggingEnabled, false, `${label}: release web debugging should be disabled`);
}
assert.equal(nativeConfig.appId, sourceConfig.appId, 'Native app identifier is out of sync');
assert(nativeConfig.packageClassList?.includes('AppPlugin'), 'App lifecycle plugin is missing from the native bridge');
assert.deepEqual(recognitionAssetOptions({ native: true, href: 'capacitor://localhost/index.html' }), {
  baseUrl: 'capacitor://localhost/models/',
  quranUrl: 'capacitor://localhost/data/quran.json',
  wasmPaths: {
    mjs: 'capacitor://localhost/ort/ort-wasm-simd-threaded.js',
    wasm: 'capacitor://localhost/ort/ort-wasm-simd-threaded.wasm',
  },
}, 'Native recognition must use bundled assets');

for (const [name, expected] of Object.entries(MODEL_HASHES)) {
  const bytes = await readFile(path.join(bundle, 'models', name));
  assert.equal(bytes.length, MODEL_SIZES[name], `Model asset size mismatch: ${name}`);
  assert.equal(digest(bytes), expected, `Model asset checksum mismatch: ${name}`);
}
const ortFolder = path.dirname(require.resolve('onnxruntime-web'));
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  assert.equal(digest(await readFile(path.join(bundle, 'ort', name))), digest(await readFile(path.join(ortFolder, name))), `Native runtime differs from installed ONNX Runtime: ${name}`);
}
assert.equal(digest(await readFile(path.join(bundle, 'ort/ort-wasm-simd-threaded.js'))), digest(await readFile(path.join(bundle, 'ort/ort-wasm-simd-threaded.mjs'))), 'Native JavaScript MIME alias must be byte-identical to the ONNX module');
for (const name of ['index.html', 'app.js', 'recognition-worker.js', 'mic-worklet.js', 'styles.css', 'privacy.html', 'terms.html']) {
  assert((await stat(path.join(bundle, name))).size > 0, `Missing native asset: ${name}`);
  assert.equal(digest(await readFile(path.join(bundle, name))), digest(await readFile(path.join(root, 'dist', name))), `Native asset is stale; run mobile:sync: ${name}`);
}
const quran = await readJson(path.join(bundle, 'data/quran.json'));
assert.equal(quran.length, 6236, 'Native Quran corpus is incomplete');

const allowedRoots = new Set(['data', 'licenses', 'models', 'ort', 'app.js', 'app.js.LEGAL.txt', 'apple-touch-icon.png', 'cordova_plugins.js', 'cordova.js', 'icon-192.png', 'icon-512.png', 'icon.svg', 'index.html', 'manifest.webmanifest', 'mic-worklet.js', 'privacy.html', 'recognition-worker.js', 'recognition-worker.js.LEGAL.txt', 'styles.css', 'terms.html', 'words.css']);
const files = await filesIn(bundle);
for (const name of files) {
  assert(allowedRoots.has(name.split('/')[0]), `Unreviewed file or directory in native bundle: ${name}`);
  assert(!/\.(?:map|wav|mp3|mp4|m4a|f32|pcm|log|p8|p12|mobileprovision)$/i.test(name), `Development, recording, or credential file in native bundle: ${name}`);
  assert(!/(?:^|\/)(?:\.[^/]+|tests?|fixtures?|evaluation|qa)(?:\/|$)/i.test(name) && !/(?:private|recording|replay|benchmark|harness)/i.test(name), `Private evaluation material must never ship: ${name}`);
}

const info = plist.parse(await readFile(path.join(native, 'Info.plist'), 'utf8'));
assert(typeof info.NSMicrophoneUsageDescription === 'string' && info.NSMicrophoneUsageDescription.trim().length > 30, 'A clear microphone purpose string is required');
assert(!info.UIBackgroundModes?.includes('audio'), 'Background recording is not part of Iqri');
const icon = await readFile(path.join(native, 'Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'App Store icon must be a PNG');
assert.equal(icon.toString('ascii', 12, 16), 'IHDR', 'App Store icon is missing its PNG header');
assert.equal(icon.readUInt32BE(16), 1024, 'App Store icon must be 1024 pixels wide');
assert.equal(icon.readUInt32BE(20), 1024, 'App Store icon must be 1024 pixels tall');
assert.equal(icon[24], 8, 'App Store icon must use 8-bit color');
assert.equal(icon[25], 2, 'Default App Store icon must be RGB without an alpha channel');
const privacy = plist.parse(await readFile(path.join(native, 'PrivacyInfo.xcprivacy'), 'utf8'));
assert.equal(privacy.NSPrivacyTracking, false, 'Tracking is not part of Iqri');
for (const key of ['NSPrivacyTrackingDomains', 'NSPrivacyCollectedDataTypes', 'NSPrivacyAccessedAPITypes']) {
  assert.deepEqual(privacy[key], [], `Privacy declaration changed; review the app and SDK API/data use: ${key}`);
}
const project = xcode.project(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'));
project.parseSync();
const objects = project.hash.project.objects;
const targets = Object.values(objects.PBXNativeTarget).filter(target => target?.isa === 'PBXNativeTarget' && unquote(target.name) === 'App');
assert.equal(targets.length, 1, 'Expected one App target');
const target = targets[0];
const resources = target.buildPhases.map(phase => objects.PBXResourcesBuildPhase[phase.value]).filter(Boolean);
const resourceRefs = resources.flatMap(phase => phase.files.map(file => objects.PBXBuildFile[file.value]?.fileRef));
assert(resourceRefs.some(ref => unquote(objects.PBXFileReference[ref]?.path) === 'PrivacyInfo.xcprivacy'), 'Privacy manifest is not in the App target Resources phase');
assert(resourceRefs.some(ref => unquote(objects.PBXFileReference[ref]?.path) === 'public'), 'Signed web assets are not in the App target Resources phase');
const configs = Object.values(objects.XCBuildConfiguration).filter(config => config?.isa === 'XCBuildConfiguration');
assert(configs.length >= 4, 'Expected project and app build configurations');
for (const config of configs) {
  assert.equal(String(config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET), '17.0', `${config.name}: iOS deployment target must be 17.0`);
  if (config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER) assert.equal(unquote(config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER), sourceConfig.appId, 'Xcode app identifier differs from Capacitor');
}
const swift = await readFile(path.join(root, 'ios/App/CapApp-SPM/Package.swift'), 'utf8');
assert(swift.includes('.iOS(.v17)'), 'SPM platform floor must match iOS 17');
assert(/capacitor-swift-pm\.git",\s*exact:\s*"8\.6\.0"/.test(swift), 'SPM must pin the native Capacitor runtime to 8.6.0');
for (const match of swift.matchAll(/\.package\(name:\s*"[^"]+",\s*path:\s*"([^"]+)"\)/g)) {
  assert((await stat(path.resolve(root, 'ios/App/CapApp-SPM', match[1], 'Package.swift'))).isFile(), 'Install pinned JavaScript dependencies before resolving local Swift packages');
}
console.log(`Mobile assembly passed: ${files.length} files; verified model and runtime; bundled native URLs; iOS 17; microphone permission; target privacy manifest. Apple compilation and a physical-iPhone microphone check remain separate.`);
