import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapArabicWordProgress, mapWordProgress } from '../src/word-alignment.js';
import { normalizeArabic } from '../src/tracker.js';

const words = arabic => arabic.split(' ').map((text, index) => ({position: index + 1, arabic: text}));

test('maps the active canonical token to its exact source position', () => {
  const source = words('قل هو الله أحد');
  for (let wordIndex = 1; wordIndex <= 4; wordIndex += 1) {
    assert.deepEqual(mapWordProgress(source, {wordIndex, canonicalWords: ['قل','هو','الله','أحد']}), [wordIndex]);
  }
});

test('a joined model word maps to both overlapping source words', () => {
  assert.deepEqual(mapWordProgress(words('بعد ما سمعه'), {
    wordIndex: 1, canonicalWords: ['بعدما','سمعه'],
  }), [1, 2]);
  assert.deepEqual(mapWordProgress(words('بعد ما سمعه'), {
    wordIndex: 2, canonicalWords: ['بعدما','سمعه'],
  }), [3]);
});

test('split model words map to the same joined source word', () => {
  const source = words('بعدما سمعه');
  assert.deepEqual(mapWordProgress(source, {wordIndex: 1, canonicalText: 'بعد ما سمعه'}), [1]);
  assert.deepEqual(mapWordProgress(source, {wordIndex: 2, canonicalText: 'بعد ما سمعه'}), [1]);
  assert.deepEqual(mapWordProgress(source, {wordIndex: 3, canonicalText: 'بعد ما سمعه'}), [2]);
});

test('refuses the entire mapping when any part of the ayah differs', () => {
  assert.deepEqual(mapWordProgress(words('قل هو الله أحد'), {wordIndex: 1, canonicalText: 'قل هو الله الصمد'}), []);
  assert.deepEqual(mapWordProgress(words('قل هو الله أحد'), {wordIndex: 1, canonicalText: 'قل هو الله'}), []);
  assert.deepEqual(mapWordProgress(words('قل هو الله أحد'), {wordIndex: 1, canonicalText: 'قال هو الله أحد'}), []);
});

test('permits verified Uthmani spelling variants and compatible Imlaei fields', () => {
  const source = [{position: 1, arabic: 'خَٰلِدِينَ', imlaei: 'خَالِدِينَ'}, {position: 2, arabic: 'فِيهَا'}];
  assert.deepEqual(mapWordProgress(source, {wordIndex: 1, canonicalText: 'خالدين فيها'}), [1]);
  assert.deepEqual(mapWordProgress(source.map(({imlaei, ...word}) => word), {wordIndex: 1, canonicalText: 'خالدين فيها'}), [1]);
  assert.deepEqual(mapWordProgress(words('قل فيها'), {wordIndex: 1, canonicalText: 'قال فيها'}), []);
});

test('joined vocative gloss records outrank provider Imlaei fields with shifted boundaries', () => {
  const arabic=['قال','يَـٰقَوْمِ','إني','لكم','نذير','مبين'];
  const shiftedImlaei=['قال','يا','قوم','إني','لكم','نذير مبين'];
  const source=arabic.map((text,index)=>({position:index+1,arabic:text,imlaei:shiftedImlaei[index]}));
  const canonicalWords=['قال','يا','قوم','إني','لكم','نذير','مبين'];
  const expected=[1,2,2,3,4,5,6];
  for(let index=0;index<canonicalWords.length;index++){
    assert.deepEqual(mapWordProgress(source,{wordIndex:index+1,canonicalWords}),[expected[index]]);
  }
  const uncertain=source.map(word=>({...word}));uncertain[0].arabic='مجهول';
  assert.deepEqual(mapWordProgress(uncertain,{wordIndex:4,canonicalWords}),[],
    'If full Uthmani alignment fails, contradictory Imlaei boundaries cannot shift the glosses');
  assert.deepEqual(mapWordProgress([{position:1,imlaei:'خالدين'},{position:2,imlaei:'فيها'}],
    {wordIndex:1,canonicalText:'خالدين فيها'}),[1],'compatible Imlaei-only source records retain their fallback');
});

test('Fatiha Uthmani spelling highlights correctly while the complete ayah must still agree',()=>{
  const text='ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ';
  assert.deepEqual(mapArabicWordProgress(text,{wordIndex:4,canonicalText:'الحمد لله رب العالمين'}),[4]);
  assert.deepEqual(mapArabicWordProgress(text,{wordIndex:4,canonicalText:'الحمد لله رب الظالمين'}),[]);
  assert.deepEqual(mapArabicWordProgress('هَٰذَا كِتَٰبٌ',{wordIndex:2,canonicalText:'هذا كتاب'}),[2]);
});

test('normalizes vocalization, hamza-bearing alif, alif wasla, and alif maqsura', () => {
  assert.deepEqual(mapWordProgress(words('قُلْ هُوَ ٱللَّهُ أَحَدٌ'), {
    wordIndex: 4, canonicalText: 'قل هو الله احد',
  }), [4]);
  assert.deepEqual(mapWordProgress(words('إِلَىٰ رَبِّكَ'), {
    wordIndex: 1, canonicalText: 'الي ربك',
  }), [1]);
});

test('compares ta marbuta with the speech model ha convention without changing source text', () => {
  const source = Object.freeze([
    Object.freeze({position: 1, arabic: 'مَسْغَبَةٍ', imlaei: 'مَسْغَبَةٍ'}),
  ]);
  assert.deepEqual(mapWordProgress(source, {wordIndex: 1, canonicalWords: ['مسغبه']}), [1]);
  assert.deepEqual(mapArabicWordProgress('مَسْغَبَةٍ', {wordIndex: 1, canonicalText: 'مسغبه'}), [1]);
  assert.equal(source[0].arabic, 'مَسْغَبَةٍ');
  assert.equal(source[0].imlaei, 'مَسْغَبَةٍ');
  assert.deepEqual(mapWordProgress(source, {wordIndex: 1, canonicalWords: ['مرحمه']}), []);
});

test('preserves display token positions while ignoring nonspoken pause marks', () => {
  assert.deepEqual(mapArabicWordProgress('لَا رَيْبَ ۛ فِيهِ', {
    wordIndex: 3, canonicalWords: ['لا','ريب','فيه'],
  }), [4]);
  assert.deepEqual(mapArabicWordProgress('لَا رَيْبَ ۛ فِيهِ', {
    wordIndex: 3, canonicalWords: ['لا','ريب','ۛ','فيه'],
  }), []);
});

test('repeated words map by character interval rather than first substring match', () => {
  assert.deepEqual(mapWordProgress(words('إياك نعبد وإياك نستعين'), {
    wordIndex: 3, canonicalText: 'اياك نعبد واياك نستعين',
  }), [3]);
});

test('uses source position order without mutating caller records', () => {
  const source = Object.freeze([
    Object.freeze({position: 2, arabic: 'الصمد'}),
    Object.freeze({position: 1, arabic: 'الله'}),
  ]);
  assert.deepEqual(mapWordProgress(source, {wordIndex: 1, canonicalText: 'الله الصمد'}), [1]);
  assert.equal(source[0].position, 2);
});

test('rejects invalid word indices and missing canonical text', () => {
  const source = words('الله الصمد');
  for (const wordIndex of [undefined, null, 0, -1, 1.5, 3, '1', true, Infinity]) {
    assert.deepEqual(mapWordProgress(source, {wordIndex, canonicalText: 'الله الصمد'}), []);
  }
  for (const progress of [undefined, {}, {wordIndex: 1}, {wordIndex: 1, canonicalWords: []},
    {wordIndex: 1, canonicalWords: ['الله', null]}, {wordIndex: 1, canonicalText: ''}]) {
    assert.deepEqual(mapWordProgress(source, progress), []);
  }
});

test('rejects missing source data and duplicate or invalid positions', () => {
  const progress = {wordIndex: 1, canonicalText: 'الله الصمد'};
  for (const source of [undefined, [], [{position: 1, arabic: ''}],
    [{position: 1, arabic: 'الله'}, {position: 1, arabic: 'الصمد'}],
    [{position: 0, arabic: 'الله'}, {position: 2, arabic: 'الصمد'}],
    [{position: 1, arabic: 'الله'}, {position: 2}],
  ]) assert.deepEqual(mapWordProgress(source, progress), []);
});

test('Arabic display variant supports whitespace and remains conservative', () => {
  assert.deepEqual(mapArabicWordProgress('  قُلْ\nهُوَ  ٱللَّهُ أَحَدٌ  ', {
    wordIndex: 2, canonicalText: 'قل هو الله احد',
  }), [2]);
  assert.deepEqual(mapArabicWordProgress('قُلْ هُوَ ٱللَّهُ أَحَدٌ', {wordIndex: 2, canonicalText: 'الله الصمد'}), []);
  assert.deepEqual(mapArabicWordProgress(null, {wordIndex: 1, canonicalText: 'الله'}), []);
});

test('maps exact opening-ayah basmala prefixes while retaining display positions', () => {
  const display = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ قُلْ هُوَ ٱللَّهُ أَحَدٌ';
  const progress = {surah: 112, ayah: 1, wordIndex: 3, canonicalWords: ['قل','هو','الله','احد']};
  assert.deepEqual(mapArabicWordProgress(display, progress), [7]);
  assert.deepEqual(mapArabicWordProgress(display.replace('قُلْ', 'ۛ قُلْ'), progress), [8]);
  assert.deepEqual(mapArabicWordProgress(display.replace('ٱللَّهِ', 'ٱللَّهِ ۛ'), progress), [8]);
  // A model sequence containing the prefix remains a normal direct alignment.
  assert.deepEqual(mapArabicWordProgress(display, {...progress, wordIndex: 7,
    canonicalText: 'بسم الله الرحمن الرحيم قل هو الله احد', canonicalWords: undefined}), [7]);
});

test('never drops a prefix outside a verified surah-opening basmala case', () => {
  const display = 'بسم الله الرحمن الرحيم قل هو الله أحد';
  const progress = {surah: 112, ayah: 1, wordIndex: 1, canonicalText: 'قل هو الله أحد'};
  assert.deepEqual(mapArabicWordProgress(display, {...progress, surah: 1}), []);
  assert.deepEqual(mapArabicWordProgress(display, {...progress, ayah: 2}), []);
  assert.deepEqual(mapArabicWordProgress(display, {...progress, surah: undefined}), []);
  assert.deepEqual(mapArabicWordProgress(display.replace('الرحيم', 'الكريم'), progress), []);
  assert.deepEqual(mapArabicWordProgress(display, {...progress, canonicalText: 'قل هو الله الصمد'}), []);
});

test('recorded native word observations map to the correct displayed ayah and word', () => {
  const report = JSON.parse(readFileSync(new URL('./word-progress-native.json', import.meta.url), 'utf8'));
  const verses = JSON.parse(readFileSync(new URL('../dist/data/quran.json', import.meta.url), 'utf8'));
  let checked = 0;
  let nextAyahObserved = false;
  for (const observation of report.observations.filter(item => item.word)) {
    const [verseKey, wordNumber] = observation.word.split('/');
    const [surah, ayah] = verseKey.split(':').map(Number);
    const verse = verses.find(item => item.surah === surah && item.ayah === ayah);
    const displayWords = verse.text_uthmani.trim().split(/\s+/u);
    const opening = surah !== 1 && ayah === 1;
    const canonicalText = opening ? verse.text_clean.split(/\s+/u).slice(4).join(' ') : verse.text_clean;
    const progress = {surah, ayah, verseKey, wordIndex: Number(wordNumber), canonicalText};
    const mapped = mapArabicWordProgress(verse.text_uthmani, progress);
    assert.deepEqual(mapped, [Number(wordNumber) + (opening ? 4 : 0)], `Observation at ${observation.seconds}s`);
    assert.equal(normalizeArabic(displayWords[mapped[0] - 1]), observation.arabicWord);
    if (observation.reference !== verseKey) nextAyahObserved = true;
    checked += 1;
  }
  assert.ok(checked >= 20, 'A meaningful set of recorded words was checked.');
  assert.ok(nextAyahObserved, 'Includes acoustic progress in the ayah after the coarse verse prediction.');
});
