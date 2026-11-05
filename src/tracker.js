/**
 * Conservative reference tracking for Quran recognition results.
 *
 * A model's reference identifies canonical text, not necessarily one unique
 * occurrence of that text. Repeated ayat remain ambiguous unless a selected
 * surah or immediately preceding accepted recitation resolves the occurrence.
 * Scores are deliberately not thresholded here: providers use different score
 * scales. The speech adapter must apply its own documented confidence policy.
 */

/** Normalize spelling and vocalization differences without changing the source. */
export function normalizeArabic(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/gu, '')
    .replace(/[\u0622\u0623\u0625\u0671]/gu, '\u0627')
    .replace(/\u0649/gu, '\u064a')
    .replace(/\u06cc/gu, '\u064a')
    .replace(/\u06a9/gu, '\u0643')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function integer(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function key(surah, ayah) {
  return `${surah}:${ayah}`;
}

function emptyResult(status, reason, candidates = []) {
  return { status, verseKey: null, verseKeys: [], candidates, reason };
}

export class VerseTracker {
  constructor(verses) {
    if (!Array.isArray(verses) || verses.length === 0) {
      throw new TypeError('VerseTracker requires canonical verse records.');
    }
    this._byKey = new Map();
    this._byText = new Map();
    this._scope = null;
    this._previous = null;

    for (const source of verses) {
      const surah = integer(source?.surah);
      const ayah = integer(source?.ayah);
      const text = normalizeArabic(source?.text_clean || source?.text_uthmani);
      if (!surah || surah < 1 || surah > 114 || !ayah || ayah < 1 || !text) {
        throw new TypeError('Each canonical verse needs a valid surah, ayah, and text.');
      }
      const verseKey = key(surah, ayah);
      if (this._byKey.has(verseKey)) {
        throw new TypeError(`Duplicate canonical reference: ${verseKey}`);
      }
      const verse = { surah, ayah, text, verseKey };
      this._byKey.set(verseKey, verse);
      const occurrences = this._byText.get(text) ?? [];
      occurrences.push(verse);
      this._byText.set(text, occurrences);
    }

    for (const occurrences of this._byText.values()) {
      occurrences.sort((a, b) => a.surah - b.surah || a.ayah - b.ayah);
    }
  }

  get scope() {
    return this._scope;
  }

  /** Changing scope clears continuity; selecting the current scope preserves it. */
  setScope(surah = null) {
    const selected = surah === null ? null : integer(surah);
    if (selected !== null && (selected < 1 || selected > 114)) {
      throw new RangeError('Surah must be between 1 and 114, or null.');
    }
    if (surah !== null && selected === null) {
      throw new TypeError('Surah must be an integer or null.');
    }
    if (selected !== this._scope) {
      this._scope = selected;
      this.reset();
    }
    return this;
  }

  /** Begin a fresh listening session while retaining the selected surah. */
  reset() {
    this._previous = null;
    return this;
  }

  /**
   * Establish an explicit, user-confirmed reference. This is deliberately
   * separate from accept(): a model's guess cannot disambiguate repeated text,
   * while the person selecting their exact place can provide that context.
   */
  anchor(verseKey) {
    const verse = typeof verseKey === 'string' ? this._byKey.get(verseKey) : null;
    if (!verse) return emptyResult('unmatched', 'unknown_reference');
    if (this._scope !== null && verse.surah !== this._scope) {
      return emptyResult('unmatched', 'outside_selected_surah');
    }
    this._previous = { surah: verse.surah, start: verse.ayah, end: verse.ayah };
    return {
      status: 'matched', verseKey: verse.verseKey, verseKeys: [verse.verseKey],
      candidates: [], reason: 'user_selected',
    };
  }

  /**
   * @param {{surah:number, ayah:number, ayah_end?:number, score?:number,
   *   transcript?:string, bestGuess?:unknown}} prediction
   * @returns {{status:'matched'|'ambiguous'|'unmatched', verseKey:string|null,
   *   verseKeys:string[], candidates:string[], reason:string}}
   * `verseKey` is the last ayah in a matched range. `candidates` lists possible
   * last-ayah keys for ambiguous ranges. Unknown results never advance context.
   * `bestGuess` is not recognition evidence and is never promoted to a match.
   */
  accept(prediction, {commit = true} = {}) {
    const surah = integer(prediction?.surah);
    const start = integer(prediction?.ayah);
    if (!surah || surah < 1 || surah > 114 || !start || start < 1) {
      return emptyResult('unmatched', 'unrecognized');
    }
    if (this._scope !== null && surah !== this._scope) {
      return emptyResult('unmatched', 'outside_selected_surah');
    }
    const end = prediction.ayah_end == null ? start : integer(prediction.ayah_end);
    if (end === null || end < start) {
      return emptyResult('unmatched', 'invalid_range');
    }
    // Canonical ayah counts are bounded by the corpus, before building a range.
    if (!this._byKey.has(key(surah, start)) || !this._byKey.has(key(surah, end))) {
      return emptyResult('unmatched', 'unknown_reference');
    }

    const sequence = [];
    for (let ayah = start; ayah <= end; ayah += 1) {
      const verse = this._byKey.get(key(surah, ayah));
      if (!verse) return emptyResult('unmatched', 'invalid_range');
      sequence.push(verse.text);
    }

    const possibleStarts = this._byText.get(sequence[0]) ?? [];
    const matches = possibleStarts
      .filter((verse) => this._scope === null || verse.surah === this._scope)
      .filter((verse) => sequence.every((text, offset) =>
        this._byKey.get(key(verse.surah, verse.ayah + offset))?.text === text))
      .map((verse) => ({
        surah: verse.surah,
        start: verse.ayah,
        end: verse.ayah + sequence.length - 1,
      }));

    let selected = matches.length === 1 ? matches[0] : null;
    let reason = this._scope === null ? 'unique_text' : 'selected_surah';
    if (!selected && this._previous) {
      const previous = this._previous;
      const adjacent = matches.filter((candidate) =>
        candidate.surah === previous.surah &&
        ((candidate.start <= previous.end && candidate.end >= previous.end) ||
          candidate.start === previous.end + 1));
      if (adjacent.length === 1) {
        [selected] = adjacent;
        reason = 'recitation_continuity';
      }
    }

    if (!selected) {
      return emptyResult('ambiguous', 'repeated_ayah',
        matches.map((candidate) => key(candidate.surah, candidate.end)));
    }

    if(commit)this._previous = selected;
    const verseKeys = Array.from(
      { length: selected.end - selected.start + 1 },
      (_, offset) => key(selected.surah, selected.start + offset),
    );
    return {
      status: 'matched',
      verseKey: key(selected.surah, selected.end),
      verseKeys,
      candidates: [],
      reason,
    };
  }
}
