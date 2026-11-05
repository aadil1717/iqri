import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ORTHOGRAPHY_SOURCE,acousticWordVariants,preferredModelSpelling,matchAcousticWord,sourceSpellingVariants,alignKnownSourceSpellings,modelSpellingPhrases} from '../src/recognition/quran-orthography.js';

test('publisher spelling table remains the exact pinned MIT source',async()=>{
  const bytes=await readFile(new URL('../src/recognition/uthmani-spelling.json',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),ORTHOGRAPHY_SOURCE.sha256);
  assert.equal(Object.keys(JSON.parse(bytes)).length,2111);
  assert.equal(ORTHOGRAPHY_SOURCE.license,'MIT');
});

test('known Uthmani forms support acoustic evidence without changing canonical metadata',()=>{
  assert.deepEqual(acousticWordVariants('العالمين'),['العالمين','العلمين']);
  assert.equal(preferredModelSpelling('العالمين'),'العلمين');
  assert.equal(matchAcousticWord('العلمين','العالمين').quality,'word-detected');
  assert.equal(matchAcousticWord('العلم','العالمين').quality,'partial-word');
  assert.equal(matchAcousticWord('العلم','العالمين',{allowPrefix:false}),null);
  assert.equal(matchAcousticWord('العلمون','العالمين'),null);
  assert.equal(matchAcousticWord('خالدون','خالدين'),null);
  assert.equal(preferredModelSpelling('سماوات'),'سماوات','ambiguous inverses are not guessed');
});

test('forward conversion is exact and one step, never global alif removal or canonical rewriting',()=>{
  assert.deepEqual(sourceSpellingVariants('ٱلْعَٰلَمِينَ'),['العلمين','العالمين']);
  assert.deepEqual(sourceSpellingVariants('قل'),['قل']);
  assert.equal(matchAcousticWord('قل','قال'),null);
  assert.equal(matchAcousticWord('قال','قل'),null);
  assert.equal(matchAcousticWord('كتاب','كتب'),null,'a canonical standard word is not rewritten using a colliding source key');
});

test('full-ayah selection chooses source variants contextually and preserves token intervals',()=>{
  const sources=[{position:1,text:'الحمد'},{position:2,text:'لله'},{position:3,text:'رب'},{position:4,text:'العلمين'}];
  const alignment=alignKnownSourceSpellings(sources,'الحمدللهربالعالمين');
  assert.deepEqual(alignment.at(-1),{position:4,start:10,end:18});
  assert.equal(alignKnownSourceSpellings(sources,'الحمدللهربالظالمين'),null);
  // الكتب can be a real plural in canonical text; do not blanket-map it to الكتاب.
  assert.ok(alignKnownSourceSpellings([{position:1,text:'الكتب'},{position:2,text:'العلمين'}],'الكتبالعالمين'));
  assert.equal(alignKnownSourceSpellings([{position:1,text:'العلمين',allowKnownSpelling:false}],'العالمين'),null);
});

test('published joined vocatives preserve their exact canonical span',()=>{
  const words=['قَالَ','يَا','قَوْمِ','إِنِّي','لَكُمْ','نَذِيرٌ','مُبِينٌ'];
  assert.deepEqual(modelSpellingPhrases(words),[{text:'يقوم',firstWordIndex:2,lastWordIndex:3}]);
  assert.equal(words[1],'يَا','source text remains unchanged');
  assert.deepEqual(modelSpellingPhrases(['يا','قوم','ويا','قوم']),[
    {text:'يقوم',firstWordIndex:1,lastWordIndex:2},
    {text:'ويقوم',firstWordIndex:3,lastWordIndex:4},
  ]);
  assert.equal(matchAcousticWord('يقوم','قوم'),null,'the joined vocative is not a standalone قوم alias');
  assert.deepEqual(modelSpellingPhrases(['قوم','يا','مجهول']),[],'unknown vocatives are not invented');
  assert.deepEqual(modelSpellingPhrases(['يا','انه','قوم']),[],'a gap cannot manufacture a joined phrase');
  assert.deepEqual(modelSpellingPhrases(['يا قوم']),[],'the API requires the actual canonical token boundaries');
});
