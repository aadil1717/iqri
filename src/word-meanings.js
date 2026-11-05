// Live display only: do not add these responses to a build, disk cache, or export.
export const WORD_MEANINGS_SOURCE = Object.freeze({
  title: 'English word meanings via Quran.com',
  provider: 'Quran.com / Quran Foundation',
  sourceUrl: 'https://quran.com',
  termsUrl: 'https://api-docs.quran.com/legal/developer-terms/',
  apiBase: 'https://api.quran.com/api/v4/verses/by_key/',
  language: 'en',
  attribution: 'English word meanings provided by Quran.com / Quran Foundation. Source content retains its respective rights.',
  description: 'Per-word learning glosses, separate from the selected published full-ayah translation.',
  storage: 'Memory only; up to 50 ayahs, expiring after six hours. No offline data bundle.',
});

const MAX_ENTRIES = 50;
const MAX_PENDING = 10;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const cache = new Map();
const pending = new Map();

function validateKey(verseKey) {
  if (typeof verseKey !== 'string' || !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(verseKey)) {
    throw new TypeError('Use a Quran reference such as 112:1.');
  }
  const [surah, ayah] = verseKey.split(':').map(Number);
  if (surah > 114 || ayah > 286) throw new RangeError('Quran reference is out of range.');
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Word meanings are missing ${field}.`);
  }
  return value;
}

function validateResponse(data, verseKey) {
  if (data?.verse?.verse_key !== verseKey || !Array.isArray(data.verse.words)) {
    throw new Error('Word meanings did not match the requested ayah.');
  }
  const words = data.verse.words.filter((word) => word?.char_type_name === 'word');
  if (!words.length || words.length > 1000) throw new Error('Word meanings are unavailable for this ayah.');
  return Object.freeze(words.map((word, index) => {
    if (!Number.isInteger(word.position) || word.position !== index + 1) {
      throw new Error('Word meanings have inconsistent word positions.');
    }
    if (typeof word.translation?.language_name !== 'string'
      || word.translation.language_name.toLowerCase() !== 'english') {
      throw new Error('English word meanings are unavailable for this ayah.');
    }
    return Object.freeze({
      position: word.position,
      arabic: requiredText(word.text_uthmani, 'Arabic text'),
      imlaei: requiredText(word.text_imlaei, 'Imlaei text'),
      translation: requiredText(word.translation.text, 'an English meaning'),
    });
  }));
}

async function requestWords(verseKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(encodeURIComponent(verseKey), WORD_MEANINGS_SOURCE.apiBase);
    url.searchParams.set('language', 'en');
    url.searchParams.set('words', 'true');
    url.searchParams.set('word_fields', 'text_uthmani,text_imlaei');
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Word meanings are temporarily unavailable (HTTP ${response.status}).`);
    const words = validateResponse(await response.json(), verseKey);
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.fetchedAt >= MAX_AGE_MS) cache.delete(key);
    }
    cache.set(verseKey, { words, fetchedAt: now });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return words;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Word meanings took too long to load. Please try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch one ayah's source-aligned English glosses for display.
 * Display via textContent, not innerHTML. Match Arabic tokens before using
 * recognition positions; model and provider token boundaries can differ.
 * These glosses do not align word-for-word to the five full translation editions.
 */
export function fetchWords(verseKey) {
  try { validateKey(verseKey); } catch (error) { return Promise.reject(error); }
  const hit = cache.get(verseKey);
  if (hit && Date.now() - hit.fetchedAt < MAX_AGE_MS) {
    cache.delete(verseKey);
    cache.set(verseKey, hit);
    return Promise.resolve(hit.words);
  }
  cache.delete(verseKey);
  if (pending.has(verseKey)) return pending.get(verseKey);
  if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Word meanings are busy loading. Please try again.'));
  const promise = requestWords(verseKey).finally(() => pending.delete(verseKey));
  pending.set(verseKey, promise);
  return promise;
}
