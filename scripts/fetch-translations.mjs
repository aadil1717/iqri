import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

// Public, attributed source snapshots. No API keys and no generated translations.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, 'dist', 'data');
const BASE = 'https://quran-json.risanb.com';
const downloadedAt = new Date().toISOString();
const sources = [];
const quranEncTerms = [
  'Preserve the translation content without changes, additions or deletions.',
  'Credit the publisher and QuranEnc.com.',
  'State the publisher version number.',
  'Keep transcript information with the translation data.',
  'Report translation issues to QuranEnc.com.',
  'Refresh the text when the publisher releases corrections.',
  'Do not display inappropriate advertisements with the translation.',
];
const editions = [
  { id: 'en-itani-allah', language: 'en', title: 'Talal Itani · ClearQuran', author: 'Talal Itani', provider: 'mirror', sourceUrl: 'https://clearquran.com/download/', license: 'CC BY-ND 4.0, with additional publisher permissions for reformatting and conversion; wording must remain unchanged.', credit: 'Translation by Talal Itani, ClearQuran.com', description: 'Clear contemporary English, Allah edition. This is ClearQuran by Talal Itani, not The Clear Quran by Mustafa Khattab.' },
  { id: 'en-rwwad', language: 'en', title: 'Rowwad Translation Center', author: 'Rowwad Translation Center', provider: 'quranenc', key: 'english_rwwad', description: 'A contemporary translation prepared by the Rowwad Translation Center team.' },
  { id: 'en-saheeh', language: 'en', title: 'Noor International Center', author: 'Noor International Center', provider: 'quranenc', key: 'english_saheeh', description: 'Published by Noor International Center. The upstream data uses the legacy identifier english_saheeh.' },
  { id: 'en-hilali-khan', language: 'en', title: 'Hilali & Khan', author: 'Taqi-ud-Din al-Hilali and Muhammad Muhsin Khan', provider: 'quranenc', key: 'english_hilali_khan', description: 'An explanatory English translation with extensive parenthetical commentary.' },
  { id: 'en-pickthall', language: 'en', title: 'Marmaduke Pickthall', author: 'Marmaduke Pickthall', provider: 'mirror', sourceUrl: 'https://github.com/risan/quran-json', license: 'Original 1930 translation: public domain. quran-json dataset packaging: CC BY-SA 4.0.', credit: 'Marmaduke Pickthall, The Meaning of the Glorious Koran (1930); structured dataset by Risan Bagja Pradana.', description: 'The established 1930 translation in traditional literary English.' },
  { id: 'es-garcia', language: 'es', title: 'Español · Muhammad Isa García', author: 'Muhammad Isa García', provider: 'quranenc', key: 'spanish_garcia', description: 'Spanish translation by Muhammad Isa García, with the publisher’s footnotes.' },
  { id: 'zh-suliman', language: 'zh', title: '中文 · Muhammad Suleiman', author: 'Muhammad Makeen; reviewed by Muhammad Sulaiman and other language experts', provider: 'quranenc', key: 'chinese_suliman', description: 'Chinese translation reviewed by Muhammad Sulaiman and other language experts.' },
];

async function download(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Iqri/1.0 (public translation dataset verification)' } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      sources.push({ url, downloadedAt, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      return bytes.toString('utf8').replace(/^\uFEFF/, '');
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 800));
    }
  }
  throw lastError;
}

async function getJson(url) { return JSON.parse(await download(url)); }

// RFC 4180 parser; preserve embedded newlines, quotes, spaces, and every text word.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else cell += ch;
  }
  assert.equal(quoted, false, 'CSV ends inside a quoted field');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}

function flatten(chapters, field) {
  assert.equal(chapters.length, 114, 'Source must contain 114 chapters');
  const result = new Map();
  for (const chapter of chapters) {
    for (const verse of chapter.verses) {
      const key = `${chapter.id}:${verse.id}`;
      assert(!result.has(key), `Duplicate source verse ${key}`);
      assert.equal(typeof verse[field], 'string', `Missing ${field} at ${key}`);
      assert(verse[field].trim().length > 0, `Empty ${field} at ${key}`);
      result.set(key, verse);
    }
  }
  return result;
}

function validateKeys(map, keys, label) {
  assert.equal(map.size, 6236, `${label} must contain exactly 6236 verses`);
  for (const key of keys) assert(map.has(key), `${label} missing ${key}`);
  for (const key of map.keys()) assert(keys.has(key), `${label} has unexpected ${key}`);
}

async function writeJson(name, data) {
  const temp = path.join(OUT, `${name}.tmp`);
  await writeFile(temp, `${JSON.stringify(data)}\n`, 'utf8');
  await rename(temp, path.join(OUT, name));
}

await mkdir(OUT, { recursive: true });
const [chapters, uthmani, clean, mirrorCatalog, officialCatalog] = await Promise.all([
  getJson(`${BASE}/chapters.json`),
  getJson(`${BASE}/text/uthmani/quran.json`),
  getJson(`${BASE}/text/simple-clean/quran.json`),
  getJson(`${BASE}/translations/index.json`),
  getJson('https://quranenc.com/api/v1/translations/list/'),
]);
assert.equal(chapters.length, 114);
const surahs = chapters.map((chapter, index) => {
  assert.equal(chapter.id, index + 1, 'Surah metadata must be ordered 1..114');
  return { id: chapter.id, name: chapter.transliteration, nameArabic: chapter.name, versesCount: chapter.total_verses, meaning: chapter.translation };
});
const keys = new Set(surahs.flatMap(surah => Array.from({ length: surah.versesCount }, (_, i) => `${surah.id}:${i + 1}`)));
assert.equal(keys.size, 6236);
const arabicMap = flatten(uthmani, 'text');
const cleanMap = flatten(clean, 'text');
validateKeys(arabicMap, keys, 'Arabic Uthmani');
validateKeys(cleanMap, keys, 'Arabic simple-clean');
const arabicNotice = uthmani[0].notice;
assert(arabicNotice?.includes('Tanzil'), 'Missing required Tanzil notice');
const quran = [...keys].map(key => {
  const [surah, ayah] = key.split(':').map(Number);
  return { surah, ayah, text_uthmani: arabicMap.get(key).text, text_clean: cleanMap.get(key).text, surah_name: surahs[surah - 1].name };
});
quran[0].source_notice = arabicNotice;
quran[0].dataset_notice = 'Structured dataset by Risan Bagja Pradana (risan/quran-json), CC BY-SA 4.0. Underlying Tanzil text retains its own licence and verbatim-only terms.';

const translationResults = await Promise.all(editions.map(async edition => {
  let map, metadata;
  if (edition.provider === 'quranenc') {
    const current = officialCatalog.translations.find(item => item.key === edition.key);
    assert(current, `Missing official catalogue entry ${edition.key}`);
    const downloadUrl = `https://quranenc.com/en/home/d/csv/${edition.key}`;
    const rows = parseCsv(await download(downloadUrl));
    const headerIndex = rows.findIndex(row => row[0] === 'id' && row[1] === 'sura' && row[2] === 'aya');
    assert(headerIndex >= 0, `Missing CSV headers for ${edition.id}`);
    assert.deepEqual(rows[headerIndex].slice(0, 5), ['id', 'sura', 'aya', 'translation', 'footnotes']);
    const transcriptInformation = rows.slice(0, headerIndex).map(row => row[0]).filter(Boolean).join('\n');
    assert(transcriptInformation.includes(edition.key), `Missing publisher information for ${edition.id}`);
    assert(transcriptInformation.includes(`v${current.version}`), `CSV/catalogue version mismatch for ${edition.id}`);
    map = new Map();
    for (const row of rows.slice(headerIndex + 1)) {
      if (row.every(value => value === '')) continue;
      assert.equal(row.length, 5, `Bad CSV row in ${edition.id}`);
      const key = `${Number(row[1])}:${Number(row[2])}`;
      assert(!map.has(key), `Duplicate ${edition.id} verse ${key}`);
      assert(row[3].trim().length > 0, `Empty ${edition.id} verse ${key}`);
      map.set(key, { text: row[3], ...(row[4] ? { footnotes: row[4] } : {}) });
    }
    metadata = { ...edition, sourceUrl: `https://quranenc.com/en/browse/${edition.key}/`, downloadUrl, version: current.version, license: 'QuranEnc permission for verbatim reuse with publisher/source credit, version, retained transcript information and ongoing updates.', licenseUrl: 'https://quranenc.com/en/home/about', terms: quranEncTerms, transcriptInformation, publisherTitle: current.title, publisherDescription: current.description };
  } else {
    const mirrorEdition = mirrorCatalog.editions.find(item => item.path === `/translations/${edition.id}/`);
    assert(mirrorEdition, `Missing mirror edition ${edition.id}`);
    assert.equal(mirrorEdition.license.status, 'granted', `Unapproved mirror licence for ${edition.id}`);
    const downloadUrl = `${BASE}/translations/${edition.id}/quran.json`;
    const chapterMap = flatten(await getJson(downloadUrl), 'translation');
    map = new Map([...chapterMap].map(([key, verse]) => [key, { text: verse.translation, ...(verse.footnotes ? { footnotes: verse.footnotes } : {}) }]));
    metadata = { ...edition, downloadUrl, version: mirrorEdition.version, upstreamLicense: mirrorEdition.license, datasetLicense: 'CC BY-SA 4.0', datasetSource: 'https://github.com/risan/quran-json', licenseUrl: edition.id.startsWith('en-itani') ? 'https://clearquran.com/download/' : 'https://github.com/risan/quran-json/blob/main/LICENSE.txt' };
  }
  validateKeys(map, keys, edition.id);
  const { provider, key: sourceKey, ...catalogEntry } = metadata;
  const data = { _meta: { ...catalogEntry, sourceKey, downloadedAt, verseCount: map.size, reading: 'Hafs', numbering: 'surah:ayah' }, ...Object.fromEntries(map) };
  return { id: edition.id, data, entry: { ...catalogEntry, available: true, versesCount: map.size }, validation: { id: edition.id, count: map.size, complete: true, footnotes: [...map.values()].filter(verse => verse.footnotes).length } };
}));

const tigrinyaCatalogue = await getJson('https://quranenc.com/api/v1/translations/list/ti?localization=en');
assert.equal(tigrinyaCatalogue.translations.length, 0, 'A Tigrinya source now exists: review and enable it instead of shipping the old unavailable state');
const tigrinya = { id: 'ti-pending', language: 'ti', title: 'ትግርኛ · Tigrinya', author: null, sourceUrl: null, license: null, available: false, description: 'A complete, attributed Tigrinya translation with verified reuse permission has not yet been sourced. QuranEnc currently has no Tigrinya edition. Amharic and machine-generated text are not substituted.', checkedAt: downloadedAt, evidenceUrl: 'https://quranenc.com/api/v1/translations/list/ti?localization=en' };
const catalog = { schemaVersion: 1, generatedAt: downloadedAt, reading: 'Hafs', defaultTranslation: 'en-itani-allah', translations: [...translationResults.map(result => result.entry), tigrinya], surahs, arabic: { source: 'Tanzil Project via risan/quran-json', sourceUrl: 'https://tanzil.net', licenseUrl: 'https://tanzil.net/docs/Text_License', notice: arabicNotice }, note: 'Five reusable English editions are offered; this selection is not an independently verified popularity ranking.' };

// Commit only after every corpus has passed complete-key and nonempty-text checks.
await writeJson('quran.json', quran);
for (const result of translationResults) await writeJson(`${result.id}.json`, result.data);
await writeJson('catalog.json', catalog);
await writeJson('provenance.json', { downloadedAt, sources, arabicNotice, dataset: { name: 'risan/quran-json', source: 'https://github.com/risan/quran-json', license: 'CC BY-SA 4.0', licenseUrl: 'https://github.com/risan/quran-json/blob/main/LICENSE.txt' }, officialTerms: { url: 'https://quranenc.com/en/home/about', summary: quranEncTerms }, clearQuran: { terms: 'CC BY-ND 4.0 and additional publisher permissions. Keep the translation wording and credit unchanged.', credit: 'Translation by Talal Itani, ClearQuran.com', url: 'https://clearquran.com/download/' } });
await writeJson('validation.json', { generatedAt: downloadedAt, expectedSurahs: 114, expectedVerses: 6236, arabic: { uthmani: arabicMap.size, simpleClean: cleanMap.size, complete: true }, translations: translationResults.map(result => result.validation), tigrinya: { available: false, reason: tigrinya.description } });
await writeFile(path.join(OUT, 'LICENSES.txt'), `${arabicNotice}\n\nStructured Quran dataset: Risan Bagja Pradana, https://github.com/risan/quran-json (CC BY-SA 4.0).\nDataset licence: https://github.com/risan/quran-json/blob/main/LICENSE.txt\n\nQuranEnc editions: preserve the publisher transcript and version embedded in each edition's _meta field. Terms: https://quranenc.com/en/home/about\n${quranEncTerms.map((term, index) => `${index + 1}. ${term}`).join('\n')}\n\nTranslation by Talal Itani, ClearQuran.com\nCC BY-ND 4.0 and additional publisher permission for conversion and reformatting without changing translation words. https://clearquran.com/download/\n\nMarmaduke Pickthall: original 1930 translation, public domain. Structured dataset packaging remains attributed above.\n\nSee catalog.json and provenance.json for edition-specific versions, download URLs and hashes.\n`, 'utf8');
console.log(JSON.stringify({ ok: true, directory: OUT, arabicVerses: quran.length, translations: translationResults.map(result => result.validation), tigrinya: 'unavailable — verified source needed' }, null, 2));
