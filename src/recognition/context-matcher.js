import { QuranDB, normalizeArabic, arabicLetterCount, isTrustedChampion, MIN_TRUSTED_LETTERS } from '@tilawi/quran-asr';

export function isTrustedTextMatch(match, text) {
  return arabicLetterCount(text) >= MIN_TRUSTED_LETTERS && isTrustedChampion(match, text.replace(/\s/g, '').length);
}
const validSurah = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 114 ? Number(value) : null;
// Tanzil spells some long alifs as hamza+alif (ءا); the decoder commonly emits
// the equivalent آ, which normalizeArabic already folds to ا.
const compact = text => normalizeArabic(text || '').replace(/[^\p{L}]/gu, '').replace(/ءا/g, 'ا');
const occurrenceKey = value => value.surah + ':' + value.ayah + ':' + (value.ayah_end || value.ayah);

/**
 * Exact canonical evidence is cheap to locate across the whole Quran, and
 * prevents a previous-surah preference from overriding a similar new verse.
 * Inexact evidence searches the whole explicit scope, or the whole Quran in
 * automatic mode. Context cannot turn a fuzzy neighbor into certainty.
 */
export function createContextMatcher(globalDb, quranCtcTokens) {
  const surahs = new Map();
  const passages = [];
  for (let surah = 1; surah <= 114; surah++) {
    let text = '';
    const segments = [];
    const wordStarts = new Set();
    const wordEnds = new Set();
    for (const verse of globalDb.getSurah(surah)) {
      const start = text.length;
      for (const word of verse.phonemes_joined.split(/\s+/)) {
        const value = compact(word);
        if (!value) continue;
        wordStarts.add(text.length);
        text += value;
        wordEnds.add(text.length);
      }
      segments.push({ ayah: verse.ayah, start, end: text.length });
    }
    passages.push({ surah, text, segments, wordStarts, wordEnds });
  }
  const surahDb = surah => {
    if (!surahs.has(surah)) surahs.set(surah, new QuranDB(globalDb.getSurah(surah).map(verse => ({ ...verse })), undefined, quranCtcTokens));
    return surahs.get(surah);
  };
  const exactOccurrences = query => {
    // Keep substring copies even when one occurrence is a complete ayah. Audio
    // alone cannot distinguish a complete short ayah from another ayah's tail.
    const candidates = new Map(), trailingWordRivals = new Map();
    let partialWord = false;
    for (const passage of passages) {
      let offset = passage.text.indexOf(query);
      while (offset !== -1) {
        const startsAtWord = passage.wordStarts.has(offset);
        const endsAtWord = passage.wordEnds.has(offset + query.length);
        if (!startsAtWord || !endsAtWord) {
          partialWord = true;
          if (startsAtWord && !endsAtWord) {
            const start = passage.segments.find(segment => segment.end > offset);
            const end = passage.segments.find(segment => segment.end >= offset + query.length);
            if (start && end) {
              const value = { surah: passage.surah, ayah: start.ayah, ayah_end: end.ayah === start.ayah ? null : end.ayah };
              trailingWordRivals.set(occurrenceKey(value), value);
            }
          }
          offset = passage.text.indexOf(query, offset + 1);
          continue;
        }
        const start = passage.segments.find(segment => segment.end > offset);
        const end = passage.segments.find(segment => segment.end >= offset + query.length);
        if (start && end) {
          const value = { surah: passage.surah, ayah: start.ayah, ayah_end: end.ayah === start.ayah ? null : end.ayah };
          candidates.set(occurrenceKey(value), value);
        }
        offset = passage.text.indexOf(query, offset + 1);
      }
    }
    return { source: 'exact-fragment', candidates: [...candidates.values()], trailingWordRivals: [...trailingWordRivals.values()], partialWord };
  };
  const choose = (candidates, selected, previous) => {
    const eligible = selected ? candidates.filter(value => value.surah === selected) : candidates;
    if (eligible.length === 1) return { chosen: eligible[0], eligible };
    if (previous && eligible.length > 1) {
      const previousEnd = Number(previous.ayah_end || previous.ayah);
      const adjacent = eligible.filter(value => value.surah === Number(previous.surah) &&
        ((value.ayah <= previousEnd && (value.ayah_end || value.ayah) >= previousEnd) || value.ayah === previousEnd + 1));
      if (adjacent.length === 1) return { chosen: adjacent[0], eligible };
    }
    return { chosen: null, eligible };
  };
  const makeExactMatch = occurrence => {
    const verses = globalDb.getSurah(occurrence.surah).filter(verse => verse.ayah >= occurrence.ayah && verse.ayah <= (occurrence.ayah_end || occurrence.ayah));
    return { ...occurrence, text: verses.map(verse => verse.text_uthmani).join(' '), phonemes_joined: verses.map(verse => verse.phonemes_joined).join(' '), score: 1, raw_score: 1, bonus: 0, frag_fit: 1, fit_margin: 0, margin: 0 };
  };
  const matchUncached = (text, context = {}, allowFuzzy = true, includeTrailingWordRivals = false) => {
      if (arabicLetterCount(text) < MIN_TRUSTED_LETTERS) return { match: null, trusted: false, searchTier: 'waiting' };
      const selected = validSurah(context.preferredSurah);
      const previousSurah = validSurah(context.previousReference?.surah);
      const previousAyah = Number(context.previousReference?.ayah_end || context.previousReference?.ayah);
      const exact = exactOccurrences(compact(text));
      if (exact.candidates.length) {
        const candidates = includeTrailingWordRivals
          ? [...new Map([...exact.candidates, ...exact.trailingWordRivals].map(value => [occurrenceKey(value), value])).values()]
          : exact.candidates;
        const { chosen, eligible } = choose(candidates, selected, context.previousReference);
        if (!chosen) return { match: null, trusted: false, searchTier: selected ? 'surah' : 'global', searchedSurah: selected, ambiguity: eligible.length > 1 ? eligible : null, reason: eligible.length ? 'repeated-fragment' : 'outside-selected-surah' };
        if (!exact.candidates.some(value => occurrenceKey(value) === occurrenceKey(chosen)))
          return { match: null, trusted: false, searchTier: selected ? 'surah' : 'global', searchedSurah: selected, reason: 'partial-word-boundary' };
        const nearPrevious = chosen.surah === previousSurah && chosen.ayah <= previousAyah + 3 && (chosen.ayah_end || chosen.ayah) >= previousAyah - 2;
        return { match: makeExactMatch(chosen), trusted: true, searchTier: nearPrevious ? 'nearby' : selected || chosen.surah === previousSurah ? 'surah' : 'global', searchedSurah: selected || previousSurah || null, evidence: exact.source };
      }
      // A partial trailing word must not claim the following ayah. Keep the
      // previous display until a complete, distinctive word arrives.
      if (exact.partialWord) return { match: null, trusted: false, searchTier: selected ? 'surah' : 'global', searchedSurah: selected, reason: 'partial-word-boundary' };
      if (!allowFuzzy) return { match: null, trusted: false, searchTier: selected ? 'surah' : 'global', searchedSurah: selected, reason: 'deferred-fuzzy' };
      const database = selected ? surahDb(selected) : globalDb;
      const match = database.bestJoint03Match(text);
      let trusted = isTrustedTextMatch(match, text);
      // Upstream's flat score>=.8 gate ignores competing fragment fit. Shared
      // phrases with equally good locations must not become verse claims.
      if (trusted && (match.fit_margin || 0) < .12) trusted = false;
      return { match, trusted, searchTier: selected ? 'surah' : 'global', searchedSurah: selected, evidence: 'fuzzy', reason: trusted ? undefined : 'insufficient-distinctive-context' };
  };
  const cache = new Map();
  return {
    clear() { cache.clear(); },
    match(text, context = {}, { allowFuzzy = true, includeTrailingWordRivals = false } = {}) {
      const key = JSON.stringify([normalizeArabic(text), validSurah(context.preferredSurah),
        validSurah(context.previousReference?.surah), Number(context.previousReference?.ayah || 0),
        Number(context.previousReference?.ayah_end || 0), allowFuzzy, includeTrailingWordRivals]);
      if (cache.has(key)) return cache.get(key);
      const result = matchUncached(text, context, allowFuzzy, includeTrailingWordRivals);
      cache.set(key, result);
      if (cache.size > 128) cache.delete(cache.keys().next().value);
      return result;
    },
  };
}
