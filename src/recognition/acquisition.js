import { normalizeArabic } from '@tilawi/quran-asr';
import { acousticWordVariants, modelSpellingPhrases } from './quran-orthography.js';
import { ctcEmissions } from './word-progress.js';

const RATE = 16000;
const clean = text => normalizeArabic(text).replace(/[^\p{L}]/gu, '').replace(/ءا/g, 'ا');
const refKey = value => `${value.surah}:${value.ayah}:${value.ayah_end || value.ayah}`;

/** Words keep their actual CTC sample positions. The model's right edge is excluded. */
export function acousticWords(acoustic, tokens, startSample, length) {
  const frameSamples = length / acoustic.timeSteps;
  const stableFrames = Math.max(1, acoustic.timeSteps - 6);
  const words = [];
  let word = null;
  const finish = () => { if (word?.text) words.push(word); word = null; };
  for (const emission of ctcEmissions({ ...acoustic, timeSteps: stableFrames })) {
    const piece = tokens.get(emission.id) || '';
    if (piece.includes('▁')) finish();
    const text = clean(piece.replaceAll('▁', ''));
    if (!text) continue;
    if (!word) word = { text: '', start: startSample + Math.round(emission.startFrame * frameSamples), end: 0 };
    word.text += text;
    word.end = startSample + Math.round((emission.endFrame + 1) * frameSamples);
  }
  finish();
  return words;
}

/**
 * Bounded text evidence, not an audio recording. Two overlapping observations
 * must agree on each word and its absolute sample position. Remembered words
 * can join only when the model actually observed them as adjacent words.
 */
export function createAcquisitionHistory({ maxObservationGap = .6 } = {}) {
  let previous = [], history = [], nextId = 0;
  const links = new Map();
  return {
    update(words, throughSample) {
      const oldHistory = [...history], usedPrevious = new Set(), usedHistory = new Set();
      const distance = (left, right) => Math.abs(left.start - right.start) + Math.abs(left.end - right.end);
      const current = words.map(word => {
        const before = previous.filter(value => !usedPrevious.has(value) && value.text === word.text &&
          Math.abs(value.start - word.start) <= RATE * .12 && Math.abs(value.end - word.end) <= RATE * .16 &&
          throughSample > value.seen && throughSample - value.seen <= RATE * maxObservationGap)
          .sort((a, b) => distance(a, word) - distance(b, word))[0];
        if (before) usedPrevious.add(before);
        const count = before ? before.count + 1 : 1;
        const existing = oldHistory.filter(value => !usedHistory.has(value) && Math.abs(value.start - word.start) <= RATE * .12 &&
          Math.abs(value.end - word.end) <= RATE * .16).sort((a, b) => distance(a, word) - distance(b, word))[0];
        if (existing) usedHistory.add(existing);
        const sameIdentity = existing?.text === word.text && Math.abs(existing.start - word.start) <= RATE * .08 &&
          Math.abs(existing.end - word.end) <= RATE * .08;
        const value = { ...word, seen: throughSample, count, id: sameIdentity ? existing.id : ++nextId };
        if (count >= 2) {
          if (existing) history.splice(history.indexOf(existing), 1, value);
          else history.push(value);
        }
        return value;
      });
      for (let index = 1; index < current.length; index++) {
        const left = current[index - 1], right = current[index];
        if (left.count >= 2 && right.count >= 2) links.set(`${left.id}:${right.id}`, throughSample);
      }
      previous = current;
      history = history.filter(word => throughSample - word.end <= RATE * 16).sort((a, b) => a.start - b.start).slice(-64);
      for (const [key, seen] of links) if (throughSample - seen > RATE * 16) links.delete(key);
      const chains = [];
      for (const word of history) {
        const chain = chains.at(-1);
        if (chain && links.has(`${chain.at(-1).id}:${word.id}`)) chain.push(word);
        else chains.push([word]);
      }
      // Only evidence near the current speech can acquire a location. Earlier
      // remembered phrases must not pull the cursor back after a jump.
      const latest = words.at(-1)?.end ?? throughSample;
      return chains.filter(chain => latest - chain.at(-1).end <= RATE * 1.2).map(chain => chain.slice(-16));
    },
    reset() { previous = []; history = []; nextId = 0; links.clear(); },
  };
}

/** Exact word/letter spans, including published spelling variants, keep ALL rivals. */
export function createAcquisitionSearch(quran) {
  const surahs = new Map(), postings = new Map();
  const addEdge = (word, text, endAt) => {
    if (!word.edges.has(text)) word.edges.set(text, new Set());
    if (word.edges.get(text).has(endAt)) return;
    word.edges.get(text).add(endAt);
    if (!postings.has(text)) postings.set(text, []);
    postings.get(text).push({ word, endAt });
  };
  for (const verse of quran) {
    if (!surahs.has(verse.surah)) surahs.set(verse.surah, []);
    const passage = surahs.get(verse.surah);
    const canonicalWords = normalizeArabic(verse.text_clean || verse.text_uthmani).split(/\s+/).filter(Boolean);
    const verseStart = passage.length;
    for (const text of canonicalWords) {
      const forms = new Set(acousticWordVariants(text).map(clean));
      const word = { surah: verse.surah, ayah: verse.ayah, at: passage.length, edges: new Map() };
      passage.push(word);
      for (const form of forms) addEdge(word, form, word.at + 1);
    }
    for (const phrase of modelSpellingPhrases(canonicalWords)) {
      const word = passage[verseStart + phrase.firstWordIndex - 1];
      addEdge(word, clean(phrase.text), verseStart + phrase.lastWordIndex);
    }
  }
  return {
    search(chains, context = {}) {
      const spans = [];
      for (const chain of chains) {
        // The two uncertain edge words are the only omissions allowed. We do
        // not pick an arbitrary convenient substring from unrelated speech.
        for (let left = 0; left <= Math.min(2, chain.length - 3); left++) {
          for (let right = 0; right <= Math.min(2, chain.length - left - 3); right++) {
            const words = chain.slice(left, chain.length - right);
            const letters = words.reduce((total, word) => total + clean(word.text).length, 0);
            if (letters < 12 || words.length < 3 || words.length < chain.length * .55) continue;
            const query = words.map(word => clean(word.text));
            const candidates = new Map();
            for (const firstEdge of postings.get(query[0]) || []) {
              const first = firstEdge.word;
              if (context.preferredSurah && first.surah !== Number(context.preferredSurah)) continue;
              const passage = surahs.get(first.surah);
              let ends = new Set([firstEdge.endAt]);
              for (const text of query.slice(1)) {
                ends = new Set([...ends].flatMap(at => [...(passage[at]?.edges.get(text) || [])]));
                if (!ends.size) break;
              }
              for (const endAt of ends) {
                const last = passage[endAt - 1];
                const ref = { surah: first.surah, ayah: first.ayah, ayah_end: first.ayah === last.ayah ? null : last.ayah };
                candidates.set(refKey(ref), ref);
              }
            }
            if (candidates.size) spans.push({ words, letters, candidates: [...candidates.values()] });
          }
        }
      }
      // A longer remembered phrase must not outweigh a new spoken passage.
      spans.sort((a, b) => b.words.at(-1).end - a.words.at(-1).end || b.letters - a.letters);
      if (!spans.length) return null;
      const newestEnd = spans[0].words.at(-1).end;
      const recent = spans.filter(span => newestEnd - span.words.at(-1).end <= RATE * .1)
        .sort((a, b) => b.letters - a.letters);
      const best = recent[0];
      // Equally substantial evidence for different places is not a location.
      const rivals = recent.filter(span => span.letters >= best.letters - 2);
      const candidates = [...new Map(rivals.flatMap(span => span.candidates).map(ref => [refKey(ref), ref])).values()];
      if (candidates.length !== 1) return { trusted: false, candidates, reason: 'repeated-stable-words' };
      const reference = candidates[0];
      return { trusted: true, reference, candidates, score: 1, searchTier: context.preferredSurah ? 'surah' : 'global',
        evidence: 'stable-acoustic-words', audioStartSample: best.words[0].start,
        audioEndSample: best.words.at(-1).end, transcript: best.words.map(word => word.text).join(' ') };
    },
  };
}
