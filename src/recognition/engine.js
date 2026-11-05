import { createAsrSession, normalizeArabic, detectSpeech } from '@tilawi/quran-asr';
import { MAX_AUDIO_SECONDS, SAMPLE_RATE } from './config.js';
import { deriveWordProgress } from './word-progress.js';
import { createContextMatcher } from './context-matcher.js';

const reference = verse => `${verse.surah}:${verse.ayah}`;
const normalize = text => normalizeArabic(text || '').replace(/\s+/g, ' ').trim();

/** Refuse an exact reference when the same Arabic passage occurs in several places. */
export function createAmbiguityResolver(quran) {
  const byRef = new Map(quran.map(verse => [reference(verse), verse]));
  const groups = new Map();
  for (const verse of quran) {
    const key = normalize(verse.text_clean || verse.text_uthmani);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(verse);
  }
  return (prediction, context = {}) => {
    if (normalize(prediction.transcript) === 'بسم الله الرحمن الرحيم' &&
        Number(context.preferredSurah) !== 1 &&
        !(context.previousReference?.surah === 1 && context.previousReference.ayah <= 1)) {
      return { ...prediction, surah: 0, ayah: 0, ayah_end: null, status: 'ambiguous', candidates: [], ambiguityReason: 'common-opening' };
    }
    if (!prediction.surah || !prediction.ayah) return { ...prediction, status: 'uncertain', candidates: [] };
    const first = byRef.get(`${prediction.surah}:${prediction.ayah}`);
    if (!first) return { ...prediction, surah: 0, ayah: 0, status: 'uncertain', candidates: [] };
    const spanLength = Math.max(1, (prediction.ayah_end || prediction.ayah) - prediction.ayah + 1);
    const firstText = normalize(first.text_clean || first.text_uthmani);
    let candidates = (groups.get(firstText) || []).filter(candidate => {
      for (let offset = 1; offset < spanLength; offset++) {
        const original = byRef.get(`${prediction.surah}:${prediction.ayah + offset}`);
        const comparison = byRef.get(`${candidate.surah}:${candidate.ayah + offset}`);
        if (!original || !comparison || normalize(original.text_clean || original.text_uthmani) !== normalize(comparison.text_clean || comparison.text_uthmani)) return false;
      }
      return true;
    }).map(verse => ({ surah: verse.surah, ayah: verse.ayah, ayah_end: spanLength > 1 ? verse.ayah + spanLength - 1 : null }));
    if (context.preferredSurah) candidates = candidates.filter(verse => verse.surah === Number(context.preferredSurah));
    if (candidates.length > 1 && context.previousReference) {
      const previous = context.previousReference;
      // Only immediately adjacent context resolves a repeated verse; never jump to the nearest arbitrary copy.
      const previousEnd = previous.ayah_end || previous.ayah;
      const continued = candidates.filter(verse => verse.surah === previous.surah &&
        ((verse.ayah <= previousEnd && (verse.ayah_end || verse.ayah) >= previousEnd) || verse.ayah === previousEnd + 1));
      if (continued.length === 1) candidates = continued;
    }
    if (candidates.length === 1) return { ...prediction, ...candidates[0], status: 'matched', candidates };
    return {
      ...prediction,
      surah: 0,
      ayah: 0,
      ayah_end: null,
      status: candidates.length ? 'ambiguous' : 'uncertain',
      candidates,
    };
  };
}

export function createRecognitionEngine(runner, assets) {
  const session = createAsrSession(runner, { ...assets, blankId: 1024 });
  const resolveAmbiguity = createAmbiguityResolver(assets.quran);
  const matcher = createContextMatcher(session.db, assets.quranCtcTokens);
  return {
    async transcribe(input, context = {}) {
      const audio = input instanceof Float32Array ? input : new Float32Array(input);
      if (audio.length < SAMPLE_RATE / 3 || audio.length > SAMPLE_RATE * MAX_AUDIO_SECONDS) {
        throw new Error('Please send between one third of a second and 30 seconds of 16 kHz mono audio.');
      }
      for (const sample of audio) if (!Number.isFinite(sample)) throw new Error('Audio contains invalid samples.');
      if (!detectSpeech(audio)) return { surah: 0, ayah: 0, ayah_end: null, score: 0, transcript: '', status: 'silence', candidates: [], wordProgress: null, processingMs: 0, searchTier: 'waiting', recommendedWindowSeconds: context.previousReference ? 4 : 8, timing: { acousticMs: 0, decodingMs: 0, matchingMs: 0, wordAlignmentMs: 0 } };
      const start = performance.now();
      const acoustic = await runner.run(audio);
      const afterAcoustic = performance.now();
      const greedy = session.decoder.decode(acoustic.logprobs, acoustic.timeSteps, acoustic.vocabSize);
      const afterDecode = performance.now();
      const found = matcher.match(greedy.text, context);
      const afterMatch = performance.now();
      const match = found.trusted ? found.match : null;
      const raw = { text: greedy.text, tokenIds: greedy.tokenIds, acoustic: { ...acoustic, blankId: session.decoder.getBlankId() } };
      let prediction = resolveAmbiguity({
        surah: match?.surah || 0,
        ayah: match?.ayah || 0,
        ayah_end: match?.ayah_end || null,
        score: match?.score || 0,
        transcript: raw.text,
        bestGuess: found.match ? { surah: found.match.surah, ayah: found.match.ayah, ayah_end: found.match.ayah_end || null, score: found.match.score, margin: found.match.margin || 0, frag_fit: found.match.frag_fit || 0, fit_margin: found.match.fit_margin || 0, trusted: found.trusted } : undefined,
      }, context);
      if (found.ambiguity) prediction = { ...prediction, surah: 0, ayah: 0, ayah_end: null, status: 'ambiguous', candidates: found.ambiguity, ambiguityReason: found.reason };
      const wordProgress = deriveWordProgress(raw, prediction, session, audio.length / SAMPLE_RATE * 1000);
      const end = performance.now();
      return { ...prediction, wordProgress, processingMs: Math.round(end - start), searchTier: found.searchTier,
        searchedSurah: found.searchedSurah || null, recommendedWindowSeconds: prediction.status === 'matched' ? 4 : 8,
        timing: { acousticMs: Math.round(afterAcoustic - start), decodingMs: Math.round(afterDecode - afterAcoustic), matchingMs: Math.round(afterMatch - afterDecode), wordAlignmentMs: Math.round(end - afterMatch) } };
    },
    session,
  };
}

export function createOnnxRunner(ort, session) {
  const audioName = session.inputNames.find(name => /audio|signal|input/i.test(name)) || session.inputNames[0];
  const lengthName = session.inputNames.find(name => /len/i.test(name)) || session.inputNames[1];
  const outputName = session.outputNames[0];
  return {
    async run(audio) {
      const feeds = {
        [audioName]: new ort.Tensor('float32', audio, [1, audio.length]),
        [lengthName]: new ort.Tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]),
      };
      const outputs = await session.run(feeds);
      const output = outputs[outputName];
      const result = { logprobs: new Float32Array(output.data), timeSteps: Number(output.dims.at(-2)), vocabSize: Number(output.dims.at(-1)) };
      for (const tensor of Object.values(feeds)) tensor.dispose?.();
      for (const tensor of Object.values(outputs)) tensor.dispose?.();
      return result;
    },
  };
}
