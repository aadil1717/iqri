import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAsrSession } from '@tilawi/quran-asr';
import { createContextMatcher } from '../src/recognition/context-matcher.js';
const directory = new URL('../models/', import.meta.url);
const [vocab, quranCtcTokens, quran] = await Promise.all(['vocab.json', 'quran_ctc_tokens.json', 'quran.json'].map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
const session = createAsrSession({ run() { throw new Error('Text regression checks must not invoke speech inference.'); } }, { vocab, quranCtcTokens, quran });
const matcher = createContextMatcher(session.db, quranCtcTokens);
for (const [expected, previous, preferredSurah] of [
  ['2:136', '3:84', null], ['3:84', '2:136', null], ['7:65', '11:50', null],
  ['26:106', '26:124', 26], ['26:124', '26:106', 26], ['26:161', '26:124', 26],
]) {
  const [surah, ayah] = expected.split(':').map(Number);
  const [previousSurah, previousAyah] = previous.split(':').map(Number);
  const transcript = session.db.getVerse(surah, ayah).text_clean;
  const context = { preferredSurah, previousReference: { surah: previousSurah, ayah: previousAyah } };
  const result = matcher.match(transcript, context);
  assert.equal(result.trusted, true, 'Canonical full verse must resolve');
  assert.equal(result.match.surah + ':' + result.match.ayah, expected, 'Previous context must not override a similar verse');
  // One substitution must either resolve the correct verse globally/in-scope,
  // or abstain; the old inferred-neighbor rule chose the previous similar verse.
  const noisy = transcript.replace(/ا/, 'و');
  const uncertain = matcher.match(noisy, context);
  if (uncertain.trusted) assert.equal(uncertain.match.surah + ':' + uncertain.match.ayah, expected);
}
assert.equal(matcher.match('قال يا قوم اعبدوا الله', { preferredSurah: 11 }).trusted, false, 'Shared fuzzy phrase is not an exact location');
const repeated = matcher.match('إن الله على كل شيء قدير');
assert.equal(repeated.trusted, false, 'Shared exact phrase needs context');
assert.ok(repeated.ambiguity.length > 1);
const sharedShortVerse = matcher.match(session.db.getVerse(1, 2).text_clean);
assert.equal(sharedShortVerse.trusted, false, 'A complete short ayah is still ambiguous when the same text occurs inside other ayahs');
assert.ok(sharedShortVerse.ambiguity.length > 1);
assert.equal(matcher.match(session.db.getVerse(1, 2).text_clean, { preferredSurah: 1 }).trusted, true);
const contextual = matcher.match('إن الله على كل شيء قدير', { previousReference: { surah: 2, ayah: 20 } });
assert.equal(contextual.trusted, true);
assert.equal(contextual.match.surah + ':' + contextual.match.ayah, '2:20', 'Immediate context can retain the same repeated phrase');
const wrongScope = matcher.match(session.db.getVerse(7, 65).text_clean, { preferredSurah: 11, previousReference: { surah: 11, ayah: 50 } });
assert.equal(wrongScope.trusted, false, 'A full verse known to be outside the selected surah must not become an in-scope lookalike');
for (const fragment of ['صمدلم', 'الله الصمد ل', 'ولم يكن له كفوا اح']) {
  assert.equal(matcher.match(fragment).trusted, false, 'A cut word must not trigger an exact reference or advance to a new ayah');
}
console.log('Similar-verse, same-surah jump, fuzzy-noise, shared-fragment, and scope regression checks passed.');
