import { normalizeArabic } from './tracker.js';
import { alignKnownSourceSpellings, sourceSpellingVariants } from './recognition/quran-orthography.js';

// The speech model canonicalizer folds ta marbuta into ha. Match that spelling
// convention for comparison only; source Arabic and translations stay intact.
const characters = text => normalizeArabic(text).replace(/ة/gu,'ه').replace(/\s/gu, '');

function positionNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/u.test(value))) return null;
  const position = Number(value);
  return Number.isSafeInteger(position) && position > 0 ? position : null;
}

function canonicalTokens(progress) {
  if (progress?.canonicalWords !== undefined) {
    return Array.isArray(progress.canonicalWords) ? progress.canonicalWords : [];
  }
  return typeof progress?.canonicalText === 'string' && progress.canonicalText.trim()
    ? progress.canonicalText.trim().split(/\s+/u)
    : [];
}

/**
 * Map the recognized model token to source-provided Arabic word positions.
 *
 * The complete ayah must have exactly the same normalized character sequence,
 * allowing only pinned, source-side Uthmani spelling variants when needed.
 * Word boundaries may differ: one joined model token can overlap several source
 * words, and several model tokens can map to the same joined source word. There
 * is no fuzzy matching, proportional splitting, or assumption about English
 * word counts. Source glosses can use the returned Arabic position numbers.
 *
 * @param {{position:number, arabic:string, imlaei?:string}[]} sourceWords
 * @param {{wordIndex:number, canonicalWords?:string[], canonicalText?:string}} progress
 * @returns {number[]} Source positions, in Quranic word order; empty if uncertain.
 */
export function mapWordProgress(sourceWords, progress) {
  if (!Array.isArray(sourceWords) || sourceWords.length === 0 ||
    !Number.isSafeInteger(progress?.wordIndex) || progress.wordIndex < 1) return [];
  const tokens = canonicalTokens(progress);
  if (tokens.length === 0 || progress.wordIndex > tokens.length ||
    tokens.some(token => typeof token !== 'string' || !token.trim())) return [];

  const seen = new Set();
  const sources = [];
  const arabicSources = [];
  let completeArabic = true, safeImlaeiBoundaries = true;
  for (const word of sourceWords) {
    const position = positionNumber(word?.position);
    const hasImlaei = typeof word?.imlaei === 'string' && Boolean(word.imlaei.trim());
    const hasArabic = typeof word?.arabic === 'string' && Boolean(word.arabic.trim());
    const text = hasImlaei ? word.imlaei : word?.arabic;
    if (position === null || seen.has(position) || typeof text !== 'string' || !text.trim()) return [];
    seen.add(position);
    sources.push({ position, text, allowKnownSpelling: !hasImlaei });
    if (hasArabic) arabicSources.push({position, text: word.arabic, allowKnownSpelling: true});
    else completeArabic = false;
    if (hasArabic && hasImlaei) {
      const known = sourceSpellingVariants(word.arabic);
      // Some provider responses zip split Imlaei words onto joined Uthmani
      // gloss records. A documented joined phrase must stay in its own record.
      const changesBoundary = known.some(form => /\s/u.test(form)) || /\s/u.test(word.imlaei.trim());
      if (changesBoundary && !known.some(form => characters(form) === characters(word.imlaei))) safeImlaeiBoundaries = false;
    }
  }
  sources.sort((a, b) => a.position - b.position);
  arabicSources.sort((a, b) => a.position - b.position);
  const normalizedTokens = tokens.map(characters);
  const canonical = normalizedTokens.join('');
  if (!canonical) return [];
  const align = records => {
    if(records.map(word=>characters(word.text)).join('')===canonical){
      let offset=0;
      return records.map(word=>{const start=offset;offset+=characters(word.text).length;return{position:word.position,start,end:offset};});
    }
    return alignKnownSourceSpellings(records,canonical);
  };
  // Gloss positions belong to Uthmani words. Prefer their verified full-ayah
  // intervals before using provider Imlaei fields, which may have other splits.
  const sourceIntervals = (completeArabic ? align(arabicSources) : null)
    || (safeImlaeiBoundaries ? align(sources) : null);
  if(!sourceIntervals)return [];

  const activeIndex = progress.wordIndex - 1;
  const activeLength = normalizedTokens[activeIndex].length;
  // Explicit pause/verse markers are allowed in a displayed token sequence but
  // contain no spoken letters, so they must never receive a highlight.
  if (!activeLength) return [];
  let activeStart = 0;
  for (let index = 0; index < activeIndex; index += 1) activeStart += normalizedTokens[index].length;
  const activeEnd = activeStart + activeLength;

  const positions = [];
  for (const word of sourceIntervals) {
    if (word.end > word.start && word.start < activeEnd && word.end > activeStart) positions.push(word.position);
  }
  return positions;
}

/**
 * Same mapping for existing Arabic display spans created by whitespace split.
 * Returns their original one-based positions, retaining gaps for pause markers.
 * Unknown Uthmani spelling is never guessed: only the pinned table is accepted,
 * and non-equivalent full-ayah text returns [].
 */
export function mapArabicWordProgress(arabicText, progress) {
  if (typeof arabicText !== 'string' || !arabicText.trim()) return [];
  const source = arabicText.trim().split(/\s+/u)
    .map((arabic, index) => ({ position: index + 1, arabic }));
  const direct = mapWordProgress(source, progress);
  if (direct.length) return direct;

  // Some display corpora prefix an unnumbered basmala to surah-opening ayat.
  // The recognizer's first-ayah tokens intentionally omit that prefix. Remove
  // only these four exact spoken words, then require full equality again.
  // Keep original source positions, including any intervening pause marks.
  if (!Number.isInteger(progress?.surah) || progress.surah <= 1 || progress.surah > 114 || progress.ayah !== 1) return [];
  const basmala = ['بسم', 'الله', 'الرحمن', 'الرحيم'];
  let spoken = 0;
  let prefixEnd = -1;
  for (let index = 0; index < source.length && spoken < basmala.length; index += 1) {
    const text = characters(source[index].arabic);
    if (!text) continue;
    if (text !== basmala[spoken]) return [];
    spoken += 1;
    prefixEnd = index;
  }
  if (spoken !== basmala.length) return [];
  return mapWordProgress(source.slice(prefixEnd + 1), progress);
}
