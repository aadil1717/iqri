import { QuranDB, normalizeArabic, detectSpeech } from '@tilawi/quran-asr';
import { KaldiFbank } from './fbank.js';
import { createContextMatcher } from './context-matcher.js';
import { createAmbiguityResolver } from './engine.js';
import { deriveWordProgress } from './word-progress.js';
import { createAyahCompletion } from './ayah-completion.js';
import { acousticWords, createAcquisitionHistory, createAcquisitionSearch } from './acquisition.js';
import { createTentativeDecoder } from './quran-decoder.js';

const RATE = 16000;
const HOP = Math.round(.2 * RATE);
const TRACK_WINDOW = 2 * RATE;
const SEARCH_WINDOW = 6 * RATE;

/** Expensive fuzzy lookup is a fallback, never a gate for direct acoustic evidence. */
export function shouldRunFuzzyLookup({ recovery = false, currentSample = null, firstSpeechSample = Infinity,
  previous = null, preferredSurah = null, usableCandidate = false, lastFuzzySample = -Infinity } = {}) {
  if (recovery) return false;
  // A file transcription has no live backlog or initial capture grace period.
  if (currentSample === null) return true;
  if (!preferredSurah) {
    if (!previous?.wordIndex && Number.isFinite(firstSpeechSample) && currentSample - firstSpeechSample < RATE * 4) return false;
    if (usableCandidate) return false;
  }
  return currentSample - lastFuzzySample >= RATE * .8;
}

export function parseCharacterTokens(text) {
  return new Map(text.trim().split(/\r?\n/).map(line => { const [token, id] = line.trim().split(/\s+/); return [Number(id), token]; }));
}

export function createCharacterRunner(ort, session) {
  return {
    async run(audio) {
      const fbank = new KaldiFbank();
      const frames = [...fbank.acceptWaveform(audio), ...fbank.inputFinished()];
      const data = new Float32Array(frames.length * 80);
      frames.forEach((frame, index) => data.set(frame, index * 80));
      const feeds = { x: new ort.Tensor('float32', data, [1, frames.length, 80]), x_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames.length)]), [1]) };
      let outputs;
      try {
        outputs = await session.run(feeds);
        const tensor = outputs.log_probs;
        const timeSteps = Number(outputs.log_probs_len.data[0]);
        const vocabSize = Number(tensor.dims.at(-1));
        return { logprobs: new Float32Array(tensor.data.slice(0, timeSteps * vocabSize)), timeSteps, vocabSize, blankId: 0 };
      } finally { for (const tensor of [...Object.values(feeds), ...Object.values(outputs || {})]) tensor.dispose?.(); }
    },
  };
}

/** Continuous app tracking over a short rolling buffer; this model is noncausal. */
export function createStreamingRecognition({ runner, tokens, quran }) {
  const db = new QuranDB(quran.map(verse => ({ ...verse, text_clean: normalizeArabic(verse.text_clean || verse.text_uthmani), phonemes: normalizeArabic(verse.text_clean || verse.text_uthmani), phonemes_joined: normalizeArabic(verse.text_clean || verse.text_uthmani), phonemes_joined_ns: normalizeArabic(verse.text_clean || verse.text_uthmani).replace(/\s/g, ''), phoneme_words: normalizeArabic(verse.text_clean || verse.text_uthmani).split(' ') })), undefined, {});
  const matcher = createContextMatcher(db, {});
  const ambiguity = createAmbiguityResolver(quran);
  const acquisitionSearch = createAcquisitionSearch(quran);
  const acquisitionHistory = createAcquisitionHistory();
  const tentativeDecoder = createTentativeDecoder(quran, tokens);
  const recoveryHistory = createAcquisitionHistory({ maxObservationGap: 1.2 });
  const recoveryDecoder = createTentativeDecoder(quran, tokens, { sharedTrie: tentativeDecoder.trie, maxObservationGap: 1.2 });
  const recoveryEvidence = new Map();
  const decoder = { tokenIdsToRawTokens: ids => ids.map(id => tokens.get(id) || '') };
  const alignmentSession = { db, decoder };
  let sessionId;
  let context = {};
  let buffer = new Float32Array(0);
  let originSample;
  let throughSample = 0;
  let lastInference = 0;
  let anchor = null;
  let misses = 0;
  let lastEvidence = -1;
  let lastWord = null;
  let lastEvidenceStart = -1;
  let lastStatus = '';
  let lastTranscript = '';
  let acquiredReference = '';
  let lastFuzzySample = -Infinity;
  let lastRecoverySample = -Infinity;
  let lastVoicedSample = -Infinity;
  let firstSpeechSample = Infinity;
  let searchSince = 0;
  const evidence = new Map();
  const completion = createAyahCompletion();
  let completionContext = null;
  let busy = false;
  let closed = true;

  function decode(acoustic) {
    let previous = -1;
    const ids = [];
    for (let frame = 0; frame < acoustic.timeSteps; frame++) {
      let best = 0;
      for (let id = 1; id < acoustic.vocabSize; id++) if (acoustic.logprobs[frame * acoustic.vocabSize + id] > acoustic.logprobs[frame * acoustic.vocabSize + best]) best = id;
      if (best && best !== previous) ids.push(best);
      previous = best;
    }
    return { text: normalizeArabic(ids.map(id => tokens.get(id) || '').join('').replaceAll('▁', ' ')), tokenIds: ids, acoustic };
  }
  async function analyze(audio, requestContext, previous = null, allowRecovery = true, streamStartSample = null, recovery = false) {
    const started = performance.now();
    if (!detectSpeech(audio)) return { prediction: { status: 'silence', surah: 0, ayah: 0, score: 0, transcript: '', wordProgress: null, processingMs: 0, searchTier: 'waiting' }, raw: null };
    const acoustic = await runner.run(audio);
    const raw = decode(acoustic);
    const tentative = Number.isSafeInteger(streamStartSample) ? (recovery ? recoveryDecoder : tentativeDecoder).observe(acoustic, {
      clipStartSample: streamStartSample, audioLength: audio.length, throughSample: streamStartSample + audio.length,
      context: requestContext, anchor: previous,
    }) : null;
    const stableLocation = Number.isSafeInteger(streamStartSample)
      ? acquisitionSearch.search((recovery ? recoveryHistory : acquisitionHistory).update(acousticWords(acoustic, tokens, streamStartSample, audio.length),
        streamStartSample + audio.length), requestContext) : null;
    const locationIsCurrent = stableLocation?.trusted && (lastWord?.startsWith(`${stableLocation.reference.surah}:${stableLocation.reference.ayah_end || stableLocation.reference.ayah}/`) ||
      stableLocation.audioEndSample > lastEvidence);
    const newVerifiedLocation = previous && stableLocation?.trusted &&
      (previous.surah !== stableLocation.reference.surah || previous.ayah !== (stableLocation.reference.ayah_end || stableLocation.reference.ayah)) &&
      stableLocation.audioEndSample > lastEvidence;
    const acquired = locationIsCurrent && (!previous || (allowRecovery && (misses >= 3 || newVerifiedLocation))) ? stableLocation : null;
    // A noncausal model can complete the phrase at its right edge. Keep a
    // little acoustic lookahead before using a frame to move the highlight.
    const stableFrames = Math.max(1, acoustic.timeSteps - 6);
    const stableRaw = { ...raw, acoustic: { ...acoustic, timeSteps: stableFrames, logprobs: acoustic.logprobs.subarray(0, stableFrames * acoustic.vocabSize) } };
    const stableDurationMs = audio.length / 16 * stableFrames / acoustic.timeSteps;
    let prediction;
    let progress;
    let candidates = [];
    const keepsWordAnchor = acquired?.trusted && previous?.wordIndex &&
      previous.surah === acquired.reference.surah && previous.ayah === (acquired.reference.ayah_end || acquired.reference.ayah);
    if (acquired?.trusted && !keepsWordAnchor) {
      prediction = ambiguity({ ...acquired.reference, score: 1, transcript: raw.text,
        searchTier: acquired.searchTier, acquisition: true, acquisitionEvidence: acquired.evidence,
        acquisitionAudioEndSample: acquired.audioEndSample }, requestContext);
      progress = deriveWordProgress(stableRaw, prediction, alignmentSession, stableDurationMs, { strictVerse: true, minimumCoverage: .65, orthography: true });
      candidates = deriveWordProgress(stableRaw, prediction, alignmentSession, stableDurationMs, { strictVerse: true, minimumCoverage: .65, orthography: true, candidatesOnly: true }) || [];
    } else if (previous) {
      prediction = { ...previous, status: 'matched', transcript: raw.text, searchTier: 'tracking' };
      progress = deriveWordProgress(stableRaw, prediction, alignmentSession, stableDurationMs, { anchored: Boolean(previous.wordIndex), anchor: previous, strictVerse: !previous.wordIndex, minimumCoverage: .65, orthography: true });
      candidates = deriveWordProgress(stableRaw, prediction, alignmentSession, stableDurationMs, { anchored: Boolean(previous.wordIndex), anchor: previous, strictVerse: !previous.wordIndex, minimumCoverage: .65, orthography: true, candidatesOnly: true }) || [];
    }
    if (!acquired?.trusted && (!previous || (allowRecovery && !progress && misses >= 3))) {
      const currentSample = Number.isSafeInteger(streamStartSample) ? streamStartSample + audio.length : null;
      const allowFuzzy = shouldRunFuzzyLookup({ recovery, currentSample, firstSpeechSample, previous,
        preferredSurah: requestContext.preferredSurah, usableCandidate: Boolean(tentative?.result?.usable), lastFuzzySample });
      const found = matcher.match(raw.text, requestContext, { allowFuzzy });
      if (currentSample !== null && found.evidence === 'fuzzy') lastFuzzySample = currentSample;
      const match = found.trusted ? found.match : null;
      prediction = ambiguity({ surah: match?.surah || 0, ayah: match?.ayah || 0, ayah_end: match?.ayah_end || null, score: match?.score || 0, transcript: raw.text, searchTier: found.searchTier,
        lookupDeferred: found.reason === 'deferred-fuzzy' }, requestContext);
      if (found.ambiguity) prediction = { ...prediction, status: 'ambiguous', candidates: found.ambiguity };
      progress = deriveWordProgress(stableRaw, prediction, alignmentSession, stableDurationMs, { anchored: Boolean(previous?.wordIndex), strictVerse: true, orthography: true });
      candidates = deriveWordProgress(stableRaw, prediction, alignmentSession, stableDurationMs, { anchored: Boolean(previous?.wordIndex), strictVerse: true, orthography: true, candidatesOnly: true }) || [];
    }
    const completionCandidates = candidates;
    let initialLocationVerified = false;
    if (!previous?.wordIndex && !acquired?.trusted && candidates.length) {
      // A raw right-edge completion is only a location hypothesis. Its shared
      // first word cannot establish a cursor unless the full stable acoustic
      // words themselves distinguish this location in the selected corpus.
      const runs = [];
      for (const word of candidates.filter(value => value.quality === 'word-detected')) {
        const run = runs.at(-1), before = run?.at(-1);
        if (before?.verseKey === word.verseKey && before.wordIndex + 1 === word.wordIndex) run.push(word);
        else runs.push([word]);
      }
      const established = runs.some(run => {
        const found = matcher.match(run.map(word => word.observedWord).join(' '),
          { preferredSurah: requestContext.preferredSurah }, { allowFuzzy: false, includeTrailingWordRivals: true });
        return found.trusted && found.evidence === 'exact-fragment' && found.match.surah === prediction.surah &&
          found.match.ayah === prediction.ayah && (found.match.ayah_end || found.match.ayah) === (prediction.ayah_end || prediction.ayah);
      });
      initialLocationVerified = established;
      if (!established) { progress = null; candidates = []; }
    }
    return { prediction: { ...prediction, wordProgress: progress || null, processingMs: Math.round(performance.now() - started), recommendedWindowSeconds: 2 }, raw, candidates, completionCandidates, initialLocationVerified, acquired, tentative: tentative?.event || null };
  }
  function checkId(id) { if (closed || id !== sessionId) throw new Error('This listening session is no longer active.'); }
  function completionState() {
    const quietSamples = Math.round(RATE * .12);
    const quiet = buffer.length >= quietSamples &&
      !detectSpeech(buffer.subarray(buffer.length - quietSamples), { minVoicedMs: 30 });
    const pending = completionContext && (!anchor?.wordIndex || (anchor.surah === completionContext.anchor.surah && anchor.ayah === completionContext.anchor.ayah)) &&
      (!lastWord || completionContext.end >= lastEvidence);
    return { quiet, throughSample, anchor: pending ? completionContext.anchor : anchor,
      lastWord: pending ? completionContext.key : lastWord, sessionId };
  }
  function completedAyah() {
    if (completionContext?.needsLocation && !completionContext.confirmed) return null;
    return completion.complete(completionState());
  }
  function appendCompletion(events, event) {
    if (!event) return;
    if (completionContext?.needsLocation) {
      // The ending has now independently confirmed the current ayah. Show
      // that location without inventing a normal word-highlight event.
      for (let index = events.length - 1; index >= 0; index--) if (events[index].type === 'status') events.splice(index, 1);
      events.push({ type: 'status', audioEndSample: throughSample, prediction: { ...event.prediction,
        wordProgress: null, acquisition: true, acquisitionEvidence: 'confirmed-ayah-ending',
        acquisitionAudioEndSample: event.audioEndSample } });
      anchor = { surah: event.surah, ayah: event.ayah, wordIndex: event.prediction.wordProgress.wordCount, score: 1 };
      lastWord = completionContext.key; lastEvidence = event.audioEndSample; lastEvidenceStart = completionContext.start;
    }
    events.push(event);
  }
  async function verifyCompletion() {
    const state = completionState();
    if (!completion.reserveVerification(state)) return { event: completedAyah(), processingMs: 0 };
    const started = performance.now();
    // Completion alone may use more context to corroborate a held final word.
    // This pass does not move the recognition cursor or perform verse search.
    const verificationSamples = completionContext?.needsLocation
      ? Math.min(SEARCH_WINDOW, Math.max(RATE * 4, throughSample - completionContext.tail[0].start + RATE * .2))
      : RATE * 4;
    const clip = buffer.subarray(Math.max(0, buffer.length - verificationSamples));
    const start = throughSample - clip.length;
    const { prediction, candidates = [] } = await analyze(clip, context, state.anchor, false);
    const final = candidates.find(progress => `${progress.verseKey}/${progress.wordIndex}` === state.lastWord &&
      progress.wordIndex === progress.wordCount && progress.quality === 'word-detected');
    const corroboratedTail = !completionContext?.needsLocation || completionContext.tail.every(before => {
      const after = candidates.find(word => word.verseKey === before.verseKey && word.wordIndex === before.wordIndex &&
        word.quality === 'word-detected' && word.matchedCharacters >= Array.from(word.observedWord).length);
      return after && Math.abs(start + Math.round(after.estimatedAudioStartMs * 16) - before.start) <= RATE * .1 &&
        Math.abs(start + Math.round(after.estimatedAudioEndMs * 16) - before.end) <= RATE * .1;
    });
    if (final && corroboratedTail) {
      if (completionContext) completionContext.confirmed = true;
      completion.observe(final, {
      audioStartSample: start + Math.round(final.estimatedAudioStartMs * 16),
      audioEndSample: Math.min(throughSample, start + Math.round(final.estimatedAudioEndMs * 16)),
      throughSample, windowStartSample: start, prediction,
      });
    }
    return { event: completedAyah(), processingMs: Math.round(performance.now() - started) };
  }
  return {
    streaming: true,
    async transcribe(input, requestContext = {}) {
      const audio = input instanceof Float32Array ? input : new Float32Array(input);
      if (audio.length < RATE / 3 || audio.length > RATE * 30) throw new Error('Choose between one third of a second and 30 seconds of audio.');
      for (const sample of audio) if (!Number.isFinite(sample)) throw new Error('Audio contains invalid samples.');
      return (await analyze(audio, requestContext)).prediction;
    },
    start({ sessionId: id, context: requested = {} } = {}) {
      if (busy) throw new Error('Wait for the current audio chunk before restarting.');
      if (typeof id !== 'string' || !id || id.length > 160) throw new Error('A listening session identifier is required.');
      buffer.fill(0);
      sessionId = id; context = { preferredSurah: requested.preferredSurah, previousReference: requested.previousReference || null }; buffer = new Float32Array(0);
      originSample = undefined; throughSample = 0; lastInference = 0; anchor = null; misses = 0; lastEvidence = -1; lastEvidenceStart = -1; lastWord = null; lastStatus = ''; evidence.clear(); closed = false;
      lastVoicedSample = -Infinity; firstSpeechSample = Infinity; searchSince = 0;
      lastTranscript = ''; acquiredReference = ''; acquisitionHistory.reset(); matcher.clear();
      tentativeDecoder.reset(); lastFuzzySample = -Infinity;
      recoveryDecoder.reset(); recoveryHistory.reset(); recoveryEvidence.clear(); lastRecoverySample = -Infinity;
      completion.reset();
      completionContext = null;
      const explicit = requested.previousReference;
      const previousVerse = explicit && db.getVerse(Number(explicit.surah), Number(explicit.ayah_end || explicit.ayah));
      if (previousVerse && (!requested.preferredSurah || Number(requested.preferredSurah) === previousVerse.surah)) {
        const text = previousVerse.phonemes_joined_no_bsm || previousVerse.text_clean;
        anchor = { surah: previousVerse.surah, ayah: previousVerse.ayah, wordIndex: Number(explicit.wordIndex) || text.split(/\s+/).length, score: 1 };
      }
      return { type: 'stream-started', sessionId };
    },
    async feed(input, { sessionId: id, startSample, endSample } = {}) {
      checkId(id);
      if (busy) throw new Error('Audio chunks must be sent in order.');
      const audio = input instanceof Float32Array ? input : new Float32Array(input);
      if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample) || startSample < 0 || endSample - startSample !== audio.length || !audio.length || audio.length > RATE * 2) throw new Error('Send up to two seconds of consecutive 16 kHz mono audio.');
      if (originSample !== undefined && startSample !== throughSample) throw new Error('Audio was interrupted. Restart listening to continue.');
      for (const sample of audio) if (!Number.isFinite(sample)) throw new Error('Audio contains invalid samples.');
      if (originSample === undefined) { originSample = startSample; lastInference = startSample; searchSince = startSample; }
      throughSample = endSample;
      const joined = new Float32Array(Math.min(SEARCH_WINDOW, buffer.length + audio.length));
      const kept = Math.min(buffer.length, joined.length - audio.length);
      joined.set(buffer.subarray(buffer.length - kept)); joined.set(audio, kept); buffer.fill(0); buffer = joined;
      if (buffer.length < RATE * .8 || endSample - lastInference < HOP) {
        const events = [];
        appendCompletion(events, completedAyah());
        return { type: 'stream-result', sessionId, throughSample, processingMs: 0, events };
      }
      busy = true;
      lastInference = endSample;
      try {
        const recentSpeech = detectSpeech(buffer.subarray(Math.max(0, buffer.length - RATE * .3)), { minVoicedMs: 60 });
        if (recentSpeech) { lastVoicedSample = endSample; firstSpeechSample = Math.min(firstSpeechSample, endSample); }
        const settling = !recentSpeech && anchor && endSample - lastVoicedSample <= RATE * .4;
        if (!recentSpeech && !settling) {
          const events = lastStatus === 'silence' ? [] : [{ type: 'status', audioEndSample: endSample, prediction: { status: 'silence', surah: 0, ayah: 0, score: 0, transcript: '', wordProgress: null } }];
          const verified = await verifyCompletion();
          appendCompletion(events, verified.event);
          lastStatus = 'silence';
          return { type: 'stream-result', sessionId, throughSample, processingMs: verified.processingMs, events };
        }
        // A known verse is not yet a word lock. Retain acquisition context
        // until an actual acoustic word establishes the short tracking window.
        const clip = buffer.subarray(Math.max(0, buffer.length - (anchor?.wordIndex ? TRACK_WINDOW : Math.min(SEARCH_WINDOW, endSample - searchSince))));
        const clipStartSample = endSample - clip.length;
        const { prediction, candidates = [], completionCandidates = [], initialLocationVerified, acquired, tentative } = await analyze(clip, { ...context, previousReference: anchor || context.previousReference }, anchor, !settling, clipStartSample);
        const events = [];
        if (tentative) events.push(tentative);
        if (prediction.transcript !== lastTranscript) {
          lastTranscript = prediction.transcript;
          events.push({ type: 'transcript', transcript: lastTranscript, audioEndSample: endSample });
        }
        // A provisional guess has no word cursor to preserve. Fresh exact
        // stable words can replace it internally, so the next observation
        // can corroborate the correct verse instead of retrying an old guess.
        if (!anchor?.wordIndex && initialLocationVerified && prediction.status === 'matched')
          anchor = { surah: prediction.surah, ayah: prediction.ayah_end || prediction.ayah, score: prediction.score };
        if (acquired?.trusted && prediction.status === 'matched') {
          const key = `${prediction.surah}:${prediction.ayah}:${prediction.ayah_end || prediction.ayah}`;
          if (key !== acquiredReference || anchor?.surah !== prediction.surah || anchor?.ayah !== (prediction.ayah_end || prediction.ayah)) {
            acquiredReference = key;
            events.push({ type: 'status', audioEndSample: endSample, prediction: { ...prediction, wordProgress: null } });
          }
          if (!anchor || anchor.surah !== prediction.surah || anchor.ayah !== (prediction.ayah_end || prediction.ayah))
            anchor = { surah: prediction.surah, ayah: prediction.ayah_end || prediction.ayah, score: 1 };
        }
        if (prediction.status === 'matched') {
          if (candidates.length) {
            const stable = [];
            for (const progress of candidates) {
              if (settling && (progress.surah !== anchor.surah || progress.ayah !== anchor.ayah || progress.wordIndex < anchor.wordIndex || progress.wordIndex > anchor.wordIndex + 2)) continue;
              const backwards = anchor?.wordIndex && progress.surah === anchor.surah && (progress.ayah < anchor.ayah || (progress.ayah === anchor.ayah && progress.wordIndex < anchor.wordIndex));
              if (backwards) {
                const anotherFreshWord = candidates.some(other => other.surah === progress.surah && other.ayah === progress.ayah && other.wordIndex !== progress.wordIndex && clipStartSample + other.estimatedAudioStartMs * 16 >= lastEvidence - RATE * .12);
                if (!anotherFreshWord) continue;
                const heard = normalizeArabic(prediction.transcript).replace(/\s/g, '');
                const near = progress.canonicalWords.slice(Math.max(0, progress.wordIndex - 2), Math.min(progress.wordCount, progress.wordIndex + 1));
                if (near.length < 2 || !heard.includes(normalizeArabic(near.join('')).replace(/\s/g, ''))) continue;
              }
              const audioStartSample = clipStartSample + Math.round(progress.estimatedAudioStartMs * 16);
              const audioEndSample = Math.min(endSample, clipStartSample + Math.round(progress.estimatedAudioEndMs * 16));
              const key = `${progress.verseKey}/${progress.wordIndex}`;
              const before = evidence.get(key);
              const agrees = before && endSample - before.seen <= RATE * .5 && Math.abs(audioStartSample - before.start) <= RATE * .1;
              const count = agrees ? before.count + 1 : 1;
              evidence.set(key, { start: audioStartSample, end: audioEndSample, seen: endSample, count, progress });
              if (count >= 2 && key === lastWord && audioStartSample >= lastEvidenceStart - RATE * .1) lastEvidence = Math.max(lastEvidence, audioEndSample);
              // Hallucinated completions drift with the moving window edge.
              // Real word evidence must recur at the same acoustic position.
              if (count >= 2 && audioEndSample > lastEvidence && audioStartSample >= lastEvidenceStart && key !== lastWord) stable.push({ key, progress, audioStartSample, audioEndSample });
            }
            stable.sort((left, right) => left.audioStartSample - right.audioStartSample);
            const current = stable.at(-1);
            if (current) {
              const { progress, key, audioStartSample, audioEndSample } = current;
              lastEvidence = audioEndSample; lastEvidenceStart = audioStartSample; lastWord = key; lastStatus = 'matched';
              anchor = { surah: progress.surah, ayah: progress.ayah, wordIndex: progress.wordIndex, score: prediction.score };
              events.push({ type: 'progress', audioEndSample, prediction: { ...prediction, surah: progress.surah, ayah: progress.ayah, ayah_end: null, wordProgress: { ...progress, audioEndSample } } });
            }
            misses = 0;
          } else { if (!anchor) anchor = { surah: prediction.surah, ayah: prediction.ayah_end || prediction.ayah, score: prediction.score }; misses++; }
        } else if (prediction.status !== 'silence' && !prediction.lookupDeferred) { misses++; if (misses >= 6 && anchor) { anchor = null; searchSince = Math.max(originSample, endSample - RATE * 2.4); } }
        for (const [key, value] of evidence) if (endSample - value.seen > RATE * 3) evidence.delete(key);
        let recoveryMs = 0;
        let effectivePrediction = prediction;
        const previewMoved = tentative && (tentative.candidate.surah !== anchor?.surah || tentative.candidate.ayah !== anchor?.ayah);
        if (recentSpeech && anchor?.wordIndex && endSample - lastRecoverySample >= RATE * .8 &&
            (endSample - lastEvidence >= RATE * 1.2 || previewMoved)) {
          lastRecoverySample = endSample;
          const wide = buffer.subarray(Math.max(0, buffer.length - RATE * 4));
          const wideStart = endSample - wide.length;
          const found = await analyze(wide, { ...context, previousReference: anchor }, anchor, true, wideStart, true);
          recoveryMs = found.prediction.processingMs;
          if (found.tentative) events.push(found.tentative);
          if (found.acquired?.trusted && found.prediction.status === 'matched') {
            const location = found.prediction;
            if (location.surah !== anchor.surah || (location.ayah_end || location.ayah) !== anchor.ayah) {
              anchor = { surah: location.surah, ayah: location.ayah_end || location.ayah, score: location.score };
              effectivePrediction = location;
              lastStatus = 'matched';
              events.push({ type: 'status', audioEndSample: endSample, prediction: { ...location, wordProgress: null } });
            }
          }
          const fresh = [];
          for (const progress of found.candidates || []) {
            if (found.prediction.status !== 'matched') continue;
            const backwards = anchor?.wordIndex && progress.surah === anchor.surah &&
              (progress.ayah < anchor.ayah || (progress.ayah === anchor.ayah && progress.wordIndex < anchor.wordIndex));
            if (backwards) {
              const heard = normalizeArabic(found.prediction.transcript).replace(/\s/g, '');
              const near = progress.canonicalWords.slice(Math.max(0, progress.wordIndex - 2), Math.min(progress.wordCount, progress.wordIndex + 1));
              const otherFresh = found.candidates.some(other => other.surah === progress.surah && other.ayah === progress.ayah &&
                other.wordIndex !== progress.wordIndex && wideStart + other.estimatedAudioStartMs * 16 >= lastEvidence - RATE * .12);
              if (!otherFresh || near.length < 2 || !heard.includes(normalizeArabic(near.join('')).replace(/\s/g, ''))) continue;
            }
            const key = `${progress.verseKey}/${progress.wordIndex}`;
            const start = wideStart + Math.round(progress.estimatedAudioStartMs * 16);
            const end = Math.min(endSample, wideStart + Math.round(progress.estimatedAudioEndMs * 16));
            const previous = recoveryEvidence.get(key);
            const count = previous && endSample - previous.seen <= RATE * 1.2 && Math.abs(start - previous.start) <= RATE * .1
              ? previous.count + 1 : 1;
            recoveryEvidence.set(key, { start, end, seen: endSample, count, progress });
            // This is the same real-word proof used by short tracking. A wide
            // probe never moves to an older acoustic position or fabricates a word.
            if (count >= 2 && key !== lastWord && end > lastEvidence && start >= lastEvidenceStart)
              fresh.push({ key, progress, start, end });
          }
          for (const [key, value] of recoveryEvidence) if (endSample - value.seen > RATE * 3.5) recoveryEvidence.delete(key);
          fresh.sort((a,b)=>a.start-b.start);
          const current = fresh.at(-1);
          if (current) {
            lastWord = current.key; lastEvidence = current.end; lastEvidenceStart = current.start;
            anchor = { surah: current.progress.surah, ayah: current.progress.ayah, wordIndex: current.progress.wordIndex, score: found.prediction.score };
            misses = 0; lastStatus = 'matched';
            effectivePrediction = found.prediction;
            evidence.set(current.key, { ...current, seen: endSample, count: 2, clipStartSample: wideStart, prediction: found.prediction });
            events.push({ type: 'progress', audioEndSample: current.end, prediction: { ...found.prediction,
              surah: current.progress.surah, ayah: current.progress.ayah, ayah_end: null,
              wordProgress: { ...current.progress, audioEndSample: current.end } } });
          }
        }
        const latest = evidence.get(lastWord);
        if (latest?.seen === endSample && (latest.prediction || prediction).status === 'matched') {
          completionContext = null;
          completion.observe(latest.progress, { audioStartSample: latest.start, audioEndSample: latest.end,
            throughSample: endSample, windowStartSample: latest.clipStartSample ?? clipStartSample, prediction: latest.prediction || prediction });
        }
        if (prediction.status === 'matched' && prediction.score === 1 && !lastWord) {
          const final = completionCandidates.find(word => word.wordIndex === word.wordCount && word.quality === 'word-detected');
          if (final && final.wordCount >= 3 && (!anchor?.wordIndex || (anchor.surah === final.surah && anchor.ayah === final.ayah))) {
            const tail = completionCandidates.filter(word => word.verseKey === final.verseKey && word.wordIndex > final.wordCount - 3 &&
              word.quality === 'word-detected' && word.matchedCharacters >= Array.from(word.observedWord).length);
            if (tail.length === 3) {
              const location = matcher.match(tail.map(word => word.observedWord).join(' '), { preferredSurah: context.preferredSurah });
              if (location.trusted && location.evidence === 'exact-fragment' && location.match.surah === final.surah &&
                  location.match.ayah === final.ayah && (location.match.ayah_end || final.ayah) === final.ayah) {
                completionContext = { anchor: { surah: final.surah, ayah: final.ayah, wordIndex: final.wordCount, score: 1 },
                  key: `${final.verseKey}/${final.wordIndex}`, needsLocation: true, confirmed: false,
                  start: clipStartSample + Math.round(final.estimatedAudioStartMs * 16),
                  end: clipStartSample + Math.round(final.estimatedAudioEndMs * 16),
                  tail: tail.map(word => ({ ...word, start: clipStartSample + Math.round(word.estimatedAudioStartMs * 16),
                    end: clipStartSample + Math.round(word.estimatedAudioEndMs * 16) })) };
                completion.observe(final, { audioStartSample: completionContext.start, audioEndSample: completionContext.end,
                  throughSample: endSample, windowStartSample: clipStartSample, prediction });
              }
            }
          }
        }
        const verified = await verifyCompletion();
        appendCompletion(events, verified.event);
        if (effectivePrediction.status !== 'matched' && effectivePrediction.status !== lastStatus) {
          lastStatus = effectivePrediction.status;
          events.push({ type: 'status', audioEndSample: endSample, prediction: effectivePrediction });
        }
        return { type: 'stream-result', sessionId, throughSample, processingMs: prediction.processingMs + recoveryMs + verified.processingMs, events };
      } finally { busy = false; }
    },
    async stop({ sessionId: id } = {}) {
      checkId(id); if (busy) throw new Error('Wait for the current audio chunk before stopping.');
      const events = [];
      appendCompletion(events, completedAyah());
      closed = true; buffer.fill(0); buffer = new Float32Array(0); evidence.clear(); completion.reset();
      acquisitionHistory.reset(); lastTranscript = ''; matcher.clear(); completionContext = null;
      tentativeDecoder.reset();
      recoveryDecoder.reset(); recoveryHistory.reset(); recoveryEvidence.clear();
      return { type: 'stream-result', sessionId, throughSample, processingMs: 0, events, final: true };
    },
    dispose() { closed = true; buffer.fill(0); buffer = new Float32Array(0); evidence.clear(); completion.reset(); acquisitionHistory.reset(); tentativeDecoder.reset(); recoveryDecoder.reset(); recoveryHistory.reset(); recoveryEvidence.clear(); lastTranscript = ''; matcher.clear(); completionContext = null; },
  };
}
