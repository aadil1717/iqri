const RATE = 16000;

/** Completion is an acoustic observation; it never predicts the next ayah. */
export function createAyahCompletion() {
  let candidate = null;
  let sequence = 0;
  const completed = new Map();
  function eligible({ quiet, throughSample, anchor, lastWord }) {
    return candidate && quiet && candidate.key === lastWord &&
      candidate.progress.surah === anchor?.surah && candidate.progress.ayah === anchor?.ayah &&
      throughSample - candidate.end >= RATE * .12 && throughSample - candidate.seen <= RATE * 1.2;
  }
  return {
    observe(progress, { audioStartSample, audioEndSample, throughSample, windowStartSample, prediction }) {
      if (!progress || progress.source !== 'acoustic-ctc-alignment' ||
          progress.wordIndex !== progress.wordCount || progress.quality !== 'word-detected' ||
          !progress.observedWord || progress.matchedCharacters < Array.from(progress.observedWord).length ||
          !Number.isSafeInteger(audioStartSample) || !Number.isSafeInteger(audioEndSample) ||
          !Number.isSafeInteger(throughSample) || audioStartSample < 0 ||
          audioEndSample <= audioStartSample || audioEndSample > throughSample) {
        candidate = null;
        return;
      }
      const key = `${progress.verseKey}/${progress.wordIndex}`;
      if (candidate?.seen === throughSample && candidate.windowStart === windowStartSample) return;
      const sameOccurrence = candidate?.key === key && Math.abs(audioStartSample - candidate.start) <= RATE * .1;
      const agrees = sameOccurrence && throughSample - candidate.seen <= RATE * .5 &&
        Math.abs(audioEndSample - candidate.end) <= RATE * .1;
      candidate = { key, progress, start: audioStartSample, end: audioEndSample,
        seen: throughSample, windowStart: windowStartSample, count: agrees ? candidate.count + 1 : 1, prediction,
        verifications: sameOccurrence ? candidate.verifications : 0,
        lastVerification: sameOccurrence ? candidate.lastVerification : -Infinity };
    },
    reserveVerification(state) {
      if (!eligible(state) || candidate.count >= 2 || candidate.verifications >= 2 ||
          state.throughSample - candidate.lastVerification < RATE * .2) return false;
      const prior = completed.get(candidate.progress.verseKey);
      if (prior && candidate.start <= prior.end + RATE * .1) return false;
      candidate.verifications++;
      candidate.lastVerification = state.throughSample;
      return true;
    },
    complete({ quiet, throughSample, anchor, lastWord, sessionId }) {
      if (!eligible({ quiet, throughSample, anchor, lastWord }) || candidate.count < 2) return null;
      const prior = completed.get(candidate.progress.verseKey);
      // Re-reading the same audio in an overlapping window is not a repeat.
      // A new occurrence must start after the previous occurrence ended.
      if (prior && candidate.start <= prior.end + RATE * .1) return null;
      completed.set(candidate.progress.verseKey, { start: candidate.start, end: candidate.end });
      const progress = { ...candidate.progress, audioEndSample: candidate.end };
      return {
        type: 'ayah-complete', verseKey: progress.verseKey, surah: progress.surah, ayah: progress.ayah,
        audioEndSample: candidate.end, completedAtSample: throughSample,
        occurrenceId: `${sessionId}:${++sequence}`,
        prediction: { ...candidate.prediction, status: 'matched', surah: progress.surah, ayah: progress.ayah,
          ayah_end: null, wordProgress: progress },
      };
    },
    reset() { candidate = null; sequence = 0; completed.clear(); },
  };
}
