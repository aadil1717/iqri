// Pin model bytes independently of package versions for reproducible recognition.
export const MODEL_REPOSITORY = 'Abdou/quran-asr-small';
export const MODEL_REVISION = '004f898639f3127a74eac1b898a2cb3ef0b5268d';
export const MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`;
export const MODEL_FILE = 'model.int8.onnx';
export const MODEL_ASSETS = [MODEL_FILE, 'tokens.txt'];
// The model digest also matches the pinned Hugging Face Git LFS object ID.
// Small-file digests are over their exact bytes at the same immutable revision.
export const MODEL_HASHES = Object.freeze({
  'model.int8.onnx': '88f9df290d57b8890275d79187b77515aeeb12626a42bc76cbd0f8bfcaff00f0',
  'tokens.txt': '75b53814499cee84a07c7b7a318524d30bcaf84273c0f8b28a04176023e8c74f',
  'LICENSE': '3a9d79091d3c680c22dfa9af3dc8dfa12e62f6f9eb94bad36361393453a5583c',
});
export const MODEL_SIZES = Object.freeze({ 'model.int8.onnx': 36081762, 'tokens.txt': 180, 'LICENSE': 1062 });
export const MODEL_LICENSE = 'MIT';
export const MODEL_CREDIT = 'Abdou / Abdeladim Fadheli, quran-asr-small';
export const QURAN_URL = '/data/quran.json';
export const SAMPLE_RATE = 16000;
export const MAX_AUDIO_SECONDS = 30;
