import { normalizeArabic } from '@tilawi/quran-asr';
import { preferredModelSpelling, matchAcousticWord } from './quran-orthography.js';

/**
 * Latest detected word from real CTC emissions. This is not a playback clock:
 * every update needs acoustic model evidence and a canonical-token alignment.
 * Frame times are estimates within the input clip, not exact word boundaries.
 */
export function ctcEmissions({ logprobs, timeSteps, vocabSize, blankId = 1024 }) {
  const emissions = [];
  let previous = -1;
  for (let frame = 0; frame < timeSteps; frame++) {
    const offset = frame * vocabSize;
    let id = 0;
    for (let candidate = 1; candidate < vocabSize; candidate++) if (logprobs[offset + candidate] > logprobs[offset + id]) id = candidate;
    if (id !== blankId) {
      if (id !== previous) emissions.push({ id, startFrame: frame, endFrame: frame, logProbability: logprobs[offset + id] });
      else emissions.at(-1).endFrame = frame;
    }
    previous = id;
  }
  return emissions;
}

/** Local token alignment ending at the latest acoustic emission. */
export function alignAcousticTail(emissions, expected, options = {}) {
  const heard = emissions.slice(-160);
  if (!heard.length || !expected.length) return null;
  const columns = expected.length + 1;
  const scores = new Float32Array((heard.length + 1) * columns);
  const moves = new Uint8Array(scores.length);
  for (let row = 1; row <= heard.length; row++) {
    for (let col = 1; col <= expected.length; col++) {
      const same = heard[row - 1].id === expected[col - 1].id;
      const diagonal = scores[(row - 1) * columns + col - 1] + (same ? 2 : -2.5);
      const skipHeard = scores[(row - 1) * columns + col] - 1.3;
      const skipExpected = scores[row * columns + col - 1] - 1.6;
      const score = Math.max(0, diagonal, skipHeard, skipExpected);
      scores[row * columns + col] = score;
      moves[row * columns + col] = score === 0 ? 0 : score === diagonal ? 1 : score === skipHeard ? 2 : 3;
    }
  }
  // Requiring an exact match at the latest emission prevents unrelated trailing
  // speech from being interpreted as progress through an expected passage.
  const candidates = [];
  const row = heard.length;
  for (let col = 1; col <= expected.length; col++) {
    if (heard.at(-1).id !== expected[col - 1].id || moves[row * columns + col] !== 1) continue;
    candidates.push({ col, score: scores[row * columns + col] });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || candidates[0].score < (options.anchored ? 3.5 : 5.5)) return null;
  let contextualWinner = false;
  if (options.anchor?.wordIndex) {
    const words = [...new Set(expected.map(word => `${word.verseKey}/${word.wordIndex}`))];
    const anchorKey = `${options.anchor.surah}:${options.anchor.ayah}/${options.anchor.wordIndex}`;
    const position = words.indexOf(anchorKey);
    if (position >= 0) {
      const best = candidates[0].score;
      const continuation = candidates.find(candidate => {
        const word = expected[candidate.col - 1];
        const key = `${word.verseKey}/${word.wordIndex}`;
        return candidate.score >= best - .5 && (key === words[position] || key === words[position + 1]);
      });
      if (continuation) {
        candidates.splice(candidates.indexOf(continuation), 1); candidates.unshift(continuation);
        contextualWinner = true;
      }
    }
  }
  const winner = candidates[0];
  const current = expected[winner.col - 1];
  const rival = candidates.find(candidate => {
    const word = expected[candidate.col - 1];
    return word.verseKey !== current.verseKey || word.wordIndex !== current.wordIndex;
  });
  if (rival && winner.score - rival.score < 1.5 && !contextualWinner) return null;
  let i = heard.length;
  let j = winner.col;
  const pairs = [];
  let edits = 0;
  while (i > 0 && j > 0 && scores[i * columns + j] > 0) {
    const move = moves[i * columns + j];
    if (move === 1) {
      if (heard[i - 1].id === expected[j - 1].id) pairs.push({ heard: heard[i - 1], expected: expected[j - 1] });
      else edits++;
      i--; j--;
    } else if (move === 2) { i--; edits++; }
    else if (move === 3) { j--; edits++; }
    else break;
  }
  pairs.reverse();
  if (options.minimumCoverage) {
    const heardLetters = heard.filter(unit => unit.id !== ' ').length;
    const matchedLetters = pairs.filter(pair => pair.heard.id !== ' ').length;
    if (matchedLetters < heardLetters * options.minimumCoverage) return null;
  }
  const recent = pairs.slice(-10);
  const wordKeys = new Set(recent.map(pair => `${pair.expected.verseKey}:${pair.expected.wordIndex}`));
  if (pairs.length < (options.anchored ? 2 : 3) || (!options.anchored && wordKeys.size < 2) || edits > pairs.length) return null;
  const currentPairs = pairs.filter(pair => pair.expected.verseKey === current.verseKey && pair.expected.wordIndex === current.wordIndex);
  const first = currentPairs[0];
  const last = currentPairs.at(-1);
  if (!first || !last) return null;
  return { current, first: first.heard, last: last.heard, pairs, matchedTokens: pairs.length, score: winner.score, margin: rival ? winner.score - rival.score : null };
}

export function deriveWordProgress(raw, prediction, session, durationMs, options = {}) {
  if (prediction.status !== 'matched' || !prediction.surah) return null;
  const lastAyah = prediction.ayah_end || prediction.ayah;
  const expected = [];
  // Include the immediately following ayah: the recognizer may have identified
  // the completed ayah while its acoustic tail has already entered the next.
  for (let ayah = options.strictVerse ? prediction.ayah : Math.max(1, prediction.ayah - 1); ayah <= lastAyah + (options.strictVerse ? 0 : 1); ayah++) {
    const verse = session.db.getVerse(prediction.surah, ayah);
    if (!verse) continue;
    const canonicalText = verse.surah !== 1 && verse.ayah === 1 && verse.phonemes_joined_no_bsm
      ? verse.phonemes_joined_no_bsm : verse.text_clean || verse.phonemes_joined;
    const words = normalizeArabic(canonicalText).trim().split(/\s+/);
    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
      const metadata = { verseKey: `${prediction.surah}:${ayah}`, surah: prediction.surah, ayah, wordIndex: wordIndex + 1, wordCount: words.length, arabicWord: words[wordIndex], canonicalText, canonicalWords: words };
      const acousticWord = options.orthography ? preferredModelSpelling(words[wordIndex]) : words[wordIndex];
      expected.push({ id: ' ', ...metadata, finalToken: false });
      for (let character = 0; character < acousticWord.length; character++) {
        expected.push({ id: acousticWord[character], ...metadata, finalToken: character === acousticWord.length - 1 });
      }
    }
  }
  if (options.anchor?.wordIndex) {
    const keys = [...new Set(expected.map(word => `${word.verseKey}/${word.wordIndex}`))];
    const at = keys.indexOf(`${options.anchor.surah}:${options.anchor.ayah}/${options.anchor.wordIndex}`);
    if (at >= 0) {
      const allowed = new Set(keys.slice(Math.max(0, at - 3), at + 6));
      const local = expected.filter(word => allowed.has(`${word.verseKey}/${word.wordIndex}`));
      expected.splice(0, expected.length, ...local);
    }
  }
  const emissions = [];
  for (const token of ctcEmissions(raw.acoustic)) {
    const piece = session.decoder.tokenIdsToRawTokens([token.id])[0] || '';
    // Vocabulary may encode fully vocalized text. Normalize for comparison,
    // retaining each surviving character's acoustic frame provenance.
    if (piece.includes('▁') && emissions.length && emissions.at(-1).id !== ' ') emissions.push({ ...token, id: ' ' });
    const normalized = normalizeArabic(piece.replaceAll('▁', ''));
    for (const character of normalized) if (/\p{L}/u.test(character)) emissions.push({ ...token, id: character });
  }
  while (emissions.at(-1)?.id === ' ') emissions.pop();
  const alignment = alignAcousticTail(emissions, expected, options);
  if (!alignment) return options.candidatesOnly ? [] : null;
  if (options.candidatesOnly) {
    const groups = new Map();
    for (const pair of alignment.pairs) {
      if (pair.heard.id === ' ') continue;
      const key = `${pair.expected.verseKey}/${pair.expected.wordIndex}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pair);
    }
    const frameMs = durationMs / raw.acoustic.timeSteps;
    const candidates = [];
    for (const pairs of groups.values()) {
      const first = pairs[0].heard;
      const last = pairs.at(-1).heard;
      const word = pairs.at(-1).expected;
      if (pairs.length < Math.min(2, word.arabicWord.length)) continue;
      let begin = emissions.indexOf(first);
      while (begin > 0 && emissions[begin - 1].id !== ' ') begin--;
      let end = emissions.indexOf(last) + 1;
      while (end < emissions.length && emissions[end].id !== ' ') end++;
      const observedWord = emissions.slice(begin, end).map(character => character.id).join('');
      const matchedWord = options.orthography ? matchAcousticWord(observedWord, word.arabicWord) : word.arabicWord.startsWith(observedWord) ? { quality: observedWord === word.arabicWord ? 'word-detected' : 'partial-word' } : null;
      if (!matchedWord) continue;
      // A bare article is shared by thousands of nouns and cannot identify
      // which expected word has begun, even with a continuation preference.
      if (matchedWord.quality === 'partial-word' && ['ال', 'وال', 'فال', 'بال', 'لل'].includes(observedWord)) continue;
      candidates.push({
        verseKey: word.verseKey, surah: word.surah, ayah: word.ayah,
        wordIndex: word.wordIndex, wordCount: word.wordCount,
        arabicWord: word.arabicWord, observedWord,
        canonicalText: word.canonicalText, canonicalWords: word.canonicalWords,
        source: 'acoustic-ctc-alignment', quality: matchedWord.quality,
        estimatedAudioStartMs: Math.round(first.startFrame * frameMs),
        estimatedAudioEndMs: Math.round((last.endFrame + 1) * frameMs),
        clipDurationMs: Math.round(durationMs), timingIsApproximate: true, matchedCharacters: pairs.length,
      });
    }
    return candidates;
  }
  const { current, first, last } = alignment;
  let startOfWord = emissions.length - 1;
  while (startOfWord > 0 && emissions[startOfWord - 1].id !== ' ') startOfWord--;
  const observedWord = emissions.slice(startOfWord).map(character => character.id).join('');
  const match = options.orthography ? matchAcousticWord(observedWord, current.arabicWord) : current.arabicWord.startsWith(observedWord) ? { quality: observedWord === current.arabicWord ? 'word-detected' : 'partial-word' } : null;
  if (!match) return null;
  const canonicalText = current.canonicalText;
  const frameMs = durationMs / raw.acoustic.timeSteps;
  return {
    verseKey: current.verseKey,
    surah: current.surah,
    ayah: current.ayah,
    wordIndex: current.wordIndex,
    wordCount: current.wordCount,
    arabicWord: current.arabicWord,
    observedWord,
    canonicalText,
    canonicalWords: current.canonicalWords,
    source: 'acoustic-ctc-alignment',
    quality: match.quality,
    estimatedAudioStartMs: Math.round(first.startFrame * frameMs),
    estimatedAudioEndMs: Math.round((last.endFrame + 1) * frameMs),
    clipDurationMs: Math.round(durationMs),
    timingIsApproximate: true,
    matchedCharacters: alignment.matchedTokens,
  };
}
