import test from 'node:test';
import assert from 'node:assert/strict';
import { VerseTracker, normalizeArabic } from '../src/tracker.js';

const refrain = 'فبأي آلاء ربكما تكذبان';
const verses = [
  { surah: 1, ayah: 2, text_clean: 'الحمد لله رب العالمين' },
  { surah: 1, ayah: 3, text_clean: 'الرحمن الرحيم' },
  { surah: 55, ayah: 12, text_clean: 'والحب ذو العصف والريحان' },
  { surah: 55, ayah: 13, text_clean: refrain },
  { surah: 55, ayah: 14, text_clean: 'خلق الإنسان من صلصال كالفخار' },
  { surah: 55, ayah: 15, text_clean: 'وخلق الجان من مارج من نار' },
  { surah: 55, ayah: 16, text_clean: refrain },
  { surah: 55, ayah: 17, text_clean: 'رب المشرقين ورب المغربين' },
  { surah: 55, ayah: 18, text_clean: refrain },
  { surah: 112, ayah: 1, text_clean: 'قل هو الله أحد' },
  { surah: 112, ayah: 2, text_clean: 'الله الصمد' },
];

test('identifies unique ayat anywhere and returns complete ranges', () => {
  const tracker = new VerseTracker(verses);
  assert.equal(tracker.accept({ surah: 1, ayah: 2 }).verseKey, '1:2');
  assert.deepEqual(tracker.accept({ surah: 112, ayah: 1, ayah_end: 2 }), {
    status: 'matched', verseKey: '112:2', verseKeys: ['112:1', '112:2'],
    candidates: [], reason: 'unique_text',
  });
});

test('a high model score does not disambiguate repeated Quran text', () => {
  const result = new VerseTracker(verses).accept({ surah: 55, ayah: 16, score: 0.999 });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.verseKey, null);
  assert.deepEqual(result.verseKeys, []);
  assert.deepEqual(result.candidates, ['55:13', '55:16', '55:18']);
});

test('preceding unique ayah resolves a repeated ayah even if the model chose another occurrence', () => {
  const tracker = new VerseTracker(verses);
  tracker.accept({ surah: 55, ayah: 12 });
  const result = tracker.accept({ surah: 55, ayah: 18 });
  assert.equal(result.verseKey, '55:13');
  assert.equal(result.reason, 'recitation_continuity');
  assert.equal(tracker.accept({ surah: 55, ayah: 16 }).verseKey, '55:13');
});

test('unique content within a multi-ayah prediction resolves its repeated first ayah', () => {
  const result = new VerseTracker(verses).accept({ surah: 55, ayah: 13, ayah_end: 14 });
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.verseKeys, ['55:13', '55:14']);
});

test('unrelated previous recitation does not manufacture continuity', () => {
  const tracker = new VerseTracker(verses);
  tracker.accept({ surah: 1, ayah: 2 });
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).status, 'ambiguous');
});

test('surah=0 never promotes a bestGuess into a recognized ayah', () => {
  const result = new VerseTracker(verses).accept({
    surah: 0, ayah: 0, score: 1,
    transcript: 'قل هو الله أحد', bestGuess: { surah: 112, ayah: 1 },
  });
  assert.equal(result.status, 'unmatched');
  assert.equal(result.verseKey, null);
});

test('selected surah rejects out-of-scope predictions without trusting bestGuess', () => {
  const tracker = new VerseTracker(verses).setScope(112);
  const rejected = tracker.accept({ surah: 1, ayah: 2, bestGuess: { surah: 112, ayah: 1 } });
  assert.equal(rejected.status, 'unmatched');
  assert.equal(rejected.reason, 'outside_selected_surah');
  assert.equal(tracker.accept({ surah: 112, ayah: 1 }).verseKey, '112:1');
});

test('scope narrows cross-surah duplicates but cannot resolve repeats inside one surah', () => {
  const tracker = new VerseTracker([
    { surah: 77, ayah: 15, text_clean: 'ويل يومئذ للمكذبين' },
    { surah: 77, ayah: 19, text_clean: 'ويل يومئذ للمكذبين' },
    { surah: 83, ayah: 10, text_clean: 'ويل يومئذ للمكذبين' },
  ]);
  assert.equal(tracker.accept({ surah: 83, ayah: 10 }).status, 'ambiguous');
  tracker.setScope(83);
  assert.equal(tracker.accept({ surah: 83, ayah: 10 }).verseKey, '83:10');
  tracker.setScope(77);
  assert.equal(tracker.accept({ surah: 77, ayah: 19 }).status, 'ambiguous');
});

test('reset and scope changes remove old continuity', () => {
  const tracker = new VerseTracker(verses);
  tracker.accept({ surah: 55, ayah: 12 });
  tracker.reset();
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).status, 'ambiguous');
  tracker.accept({ surah: 55, ayah: 12 });
  tracker.setScope(55);
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).status, 'ambiguous');
  assert.equal(tracker.scope, 55);
});

test('intermittent unrecognized chunks do not erase valid continuity', () => {
  const tracker = new VerseTracker(verses);
  tracker.accept({ surah: 55, ayah: 15 });
  tracker.accept({ surah: 0, ayah: 0 });
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).verseKey, '55:16');
});

test('explicit user selection anchors repeated text without trusting a model guess', () => {
  const tracker = new VerseTracker(verses);
  assert.equal(tracker.accept({ surah: 55, ayah: 16 }).status, 'ambiguous');
  assert.deepEqual(tracker.anchor('55:16'), {
    status: 'matched', verseKey: '55:16', verseKeys: ['55:16'],
    candidates: [], reason: 'user_selected',
  });
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).verseKey, '55:16');
  assert.equal(tracker.accept({ surah: 55, ayah: 17 }).verseKey, '55:17');
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).verseKey, '55:18');
});

test('invalid and out-of-scope anchors cannot replace an established reference', () => {
  const tracker = new VerseTracker(verses).setScope(55);
  tracker.anchor('55:16');
  for (const invalid of [undefined, null, {}, '55:999', 'no', '55:16-18']) {
    assert.equal(tracker.anchor(invalid).status, 'unmatched');
  }
  assert.equal(tracker.anchor('112:1').reason, 'outside_selected_surah');
  assert.equal(tracker.accept({ surah: 55, ayah: 13 }).verseKey, '55:16');
  tracker.reset();
  assert.equal(tracker.accept({ surah: 55, ayah: 16 }).status, 'ambiguous');
});

test('consecutive identical ayat remain ambiguous when continuity has two explanations', () => {
  // Synthetic corpus exercises a boundary case without claiming actual ayat.
  const tracker = new VerseTracker([
    { surah: 1, ayah: 1, text_clean: 'بسم الله' },
    { surah: 1, ayah: 2, text_clean: 'الحمد لله' },
    { surah: 1, ayah: 3, text_clean: 'الحمد لله' },
  ]);
  tracker.accept({ surah: 1, ayah: 1 });
  assert.equal(tracker.accept({ surah: 1, ayah: 2 }).verseKey, '1:2');
  assert.equal(tracker.accept({ surah: 1, ayah: 3 }).status, 'ambiguous');
});

test('rejects unknown, reversed, missing, fractional, and oversized ranges', () => {
  const tracker = new VerseTracker(verses);
  for (const prediction of [
    null, {}, { surah: 115, ayah: 1 }, { surah: 112, ayah: 3 },
    { surah: 112, ayah: 2, ayah_end: 1 }, { surah: 112, ayah: 1.5 },
    { surah: 112, ayah: 1, ayah_end: Number.MAX_SAFE_INTEGER },
    { surah: 55, ayah: 12, ayah_end: 18.5 }, { surah: true, ayah: 2 },
  ]) assert.equal(tracker.accept(prediction).status, 'unmatched');
});

test('normalization detects duplicates across vocalization and alif variants', () => {
  assert.equal(normalizeArabic('قُلْ هُوَ ٱللَّهُ أَحَدٌ ۝١'), 'قل هو الله احد');
  const tracker = new VerseTracker([
    { surah: 77, ayah: 15, text_uthmani: 'وَيْلٌ يَوْمَئِذٍ لِّلْمُكَذِّبِينَ' },
    { surah: 83, ayah: 10, text_clean: 'ويل يومئذ للمكذبين' },
  ]);
  assert.deepEqual(tracker.accept({ surah: 83, ayah: 10 }).candidates, ['77:15', '83:10']);
});

test('validates corpus and scope without modifying caller data', () => {
  const corpus = Object.freeze(verses.map((verse) => Object.freeze({ ...verse })));
  const tracker = new VerseTracker(corpus);
  assert.equal(tracker.accept({ surah: '112', ayah: '1' }).status, 'matched');
  for (const scope of [0, -1, 115, 1.5, 'no', true]) {
    assert.throws(() => tracker.setScope(scope));
  }
  assert.throws(() => new VerseTracker([]));
  assert.throws(() => new VerseTracker([verses[0], verses[0]]));
  assert.throws(() => new VerseTracker([{ surah: 1, ayah: 1 }]));
  assert.throws(() => new VerseTracker([{ surah: -1, ayah: 1, text_clean: 'نص' }]));
});
