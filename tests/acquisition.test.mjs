import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisitionHistory, createAcquisitionSearch } from '../src/recognition/acquisition.js';
import { createContextMatcher } from '../src/recognition/context-matcher.js';

const verse = (surah, ayah, text_clean) => ({ surah, ayah, text_clean });
const quran = [
  verse(2, 255, 'الله لا اله الا هو الحي القيوم لا تاخذه سنه ولا نوم'),
  verse(3, 2, 'الله لا اله الا هو الحي القيوم'),
  verse(55, 13, 'فباي الاء ربكما تكذبان'), verse(55, 16, 'فباي الاء ربكما تكذبان'),
  verse(1, 2, 'الحمد لله رب العالمين'), verse(6, 45, 'الحمد لله رب العالمين'),
  verse(112, 3, 'لم يلد ولم يولد'),
];
const words = (text, start = 0) => text.split(' ').map((text, index) => ({ text, start: start + index * 4000, end: start + index * 4000 + 2000 }));

test('initial proof retains another verse where the final heard word is still incomplete', () => {
  const corpus = [
    { surah: 26, ayah: 117, phonemes_joined: 'قال رب ان قومي كذبون' },
    { surah: 71, ayah: 5, phonemes_joined: 'قال رب اني دعوت قومي ليلا ونهارا' },
  ];
  const matcher = createContextMatcher({ getSurah: surah => corpus.filter(value => value.surah === surah) }, {});
  const text = 'قال رب ان';
  assert.equal(matcher.match(text, {}, { allowFuzzy: false }).trusted, true, 'Legacy established matching is unchanged');
  const guarded = matcher.match(text, {}, { allowFuzzy: false, includeTrailingWordRivals: true });
  assert.equal(guarded.trusted, false);
  assert.deepEqual(guarded.ambiguity.map(value => value.surah), [26, 71]);
  assert.equal(matcher.match(text, { preferredSurah: 26 }, { allowFuzzy: false, includeTrailingWordRivals: true }).trusted, true);
  assert.equal(matcher.match(text, { preferredSurah: 71 }, { allowFuzzy: false, includeTrailingWordRivals: true }).trusted, false,
    'A sole partial-word rival must not itself become confirmation');
  assert.equal(matcher.match('قال رب اني دعوت', {}, { allowFuzzy: false, includeTrailingWordRivals: true }).match.surah, 71);
});

test('distinctive complete interior words locate a verse while noisy edges are excluded', () => {
  const search = createAcquisitionSearch(quran);
  const result = search.search([words('ال القيوم لا تاخذه سنه و ا')]);
  assert.equal(result.trusted, true);
  assert.equal(result.reference.surah, 2);
  assert.equal(result.reference.ayah, 255);
  assert.equal(search.search([words('سم')]), null);
  assert.equal(search.search([words('غريب غريب غريب القيوم لا تاخذه سنه غريب غريب غريب')]), null,
    'An arbitrary interior substring cannot ignore unrelated surrounding speech');
});

test('shared openings, repeated ayahs and published spelling aliases retain all locations', () => {
  const search = createAcquisitionSearch(quran);
  const shared = search.search([words('الله لا اله الا هو الحي القيوم')], { previousReference: { surah: 2, ayah: 255 } });
  assert.equal(shared.trusted, false);
  assert.deepEqual(shared.candidates.map(value => value.surah), [2, 3]);
  const repeated = search.search([words('فباي الاء ربكما تكذبان')], { preferredSurah: 55 });
  assert.equal(repeated.trusted, false);
  assert.equal(repeated.candidates.length, 2);
  const spelling = search.search([words('الحمد لله رب العلمين')]);
  assert.equal(spelling.trusted, false);
  assert.equal(spelling.candidates.length, 2);
  assert.equal(search.search([words('القيوم لا تاخذه سنه')], { preferredSurah: 112 }), null);
});

test('history requires independent stable observations and preserves nonzero sample origins', () => {
  const history = createAcquisitionHistory();
  const spoken = words('القيوم لا تاخذه سنه', 100000);
  assert.deepEqual(history.update(spoken, 120000), []);
  assert.deepEqual(history.update(spoken, 120000), [], 'Identical repeated windows are not confirmation');
  const confirmed = history.update(spoken, 123200);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0][0].start, 100000);
  assert.equal(confirmed[0].length, 4);
  history.reset();
  assert.deepEqual(history.update(spoken, 126400), []);
});

test('history cannot invent adjacency across gaps, corrected words or old speech', () => {
  const history = createAcquisitionHistory();
  const first = words('القيوم لا', 0), second = words('تاخذه سنه', 12000);
  history.update(first, 16000); history.update(first, 19200);
  history.update(second, 22400);
  const chains = history.update(second, 25600);
  assert.ok(chains.every(chain => chain.length <= 2));
  const search = createAcquisitionSearch(quran);
  assert.equal(search.search(chains), null, 'Separate observations cannot manufacture a four-word phrase');
  assert.deepEqual(history.update([], 400000), []);
});

test('close adjacent words keep distinct acoustic identities', () => {
  const history = createAcquisitionHistory();
  const spoken = ['قل', 'غير', 'الله', 'احد'].map((text, index) => ({ text, start: index * 1600, end: index * 1600 + 800 }));
  history.update(spoken, 10000);
  const chains = history.update(spoken, 12000);
  assert.deepEqual(chains.flat().map(word => word.text), ['قل', 'غير', 'الله', 'احد']);
  assert.equal(new Set(chains.flat().map(word => word.id)).size, 4);
  const updated = history.update(spoken, 14000);
  assert.deepEqual(updated.flat().map(word => word.text), ['قل', 'غير', 'الله', 'احد']);
});

test('new spoken evidence outranks a longer remembered passage', () => {
  const search = createAcquisitionSearch(quran);
  const older = words('القيوم لا تاخذه سنه ولا نوم');
  const newer = words('لم يلد ولم يولد', 24000);
  const result = search.search([older, newer]);
  assert.equal(result.trusted, true);
  assert.equal(result.reference.surah, 112);
  assert.equal(result.reference.ayah, 3);
  assert.equal(result.audioEndSample, newer.at(-1).end);
});

test('repeated lookup work is cached by context and discarded on reset', () => {
  let calls = 0;
  const matcher = createContextMatcher({ getSurah: () => [], bestJoint03Match: () => { calls++; return null; } }, {});
  matcher.match('كلام غير معروف'); matcher.match('كلام غير معروف');
  assert.equal(calls, 1);
  matcher.match('كلام غير معروف', { previousReference: { surah: 2, ayah: 255 } });
  assert.equal(calls, 2, 'Changed context needs an independent decision');
  matcher.clear(); matcher.match('كلام غير معروف');
  assert.equal(calls, 3, 'Reset must release cached recognized text and decisions');
});

test('a documented joined vocative consumes both canonical words without losing rivals', () => {
  const search = createAcquisitionSearch([
    verse(71, 2, 'قال يا قوم إني لكم نذير مبين'),
    verse(11, 25, 'إني لكم نذير مبين'),
  ]);
  const result = search.search([words('قال يقوم اني لكم نذير مبين')]);
  assert.equal(result.trusted, true);
  assert.deepEqual(result.reference, { surah: 71, ayah: 2, ayah_end: null });
  assert.equal(search.search([words('قال يقوم اني لكم نذير مبين')], { preferredSurah: 112 }), null);
  const repeated = createAcquisitionSearch([
    verse(71, 2, 'قال يا قوم إني لكم نذير مبين'),
    verse(7, 59, 'قال يا قوم إني لكم نذير مبين'),
  ]).search([words('قال يقوم اني لكم نذير مبين')]);
  assert.equal(repeated.trusted, false);
  assert.equal(repeated.candidates.length, 2);
});
