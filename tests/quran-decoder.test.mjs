import test from 'node:test';
import assert from 'node:assert/strict';
import { QuranTrie, decodeQuran, createTentativeDecoder } from '../src/recognition/quran-decoder.js';

const alphabet=['<blk>','ء','ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ي','▁'];
const tokens=new Map(alphabet.map((token,id)=>[id,token]));
const ids=new Map([...tokens].map(([id,token])=>[token,id]));
const verse=(surah,ayah,text_clean)=>({surah,ayah,text_clean});
const quran=[verse(2,255,'الله لا اله الا هو الحي القيوم لا تاخذه سنه ولا نوم'),
  verse(3,2,'الله لا اله الا هو الحي القيوم'),verse(71,1,'انا ارسلنا نوحا الي قومه'),
  verse(71,2,'قال يا قوم اني لكم نذير مبين'),verse(112,1,'قل هو الله احد'),
  verse(55,13,'فباي الاء ربكما تكذبان'),verse(55,16,'فباي الاء ربكما تكذبان')];

function acoustic(text,{wrongLetter=false,uniform=false,padding=8}={}) {
  const sequence=[0,...[...text.replaceAll(' ','▁')].flatMap(character=>[ids.get(character),0]),...Array(padding).fill(0)];
  const logprobs=new Float32Array(sequence.length*31);
  sequence.forEach((id,frame)=>{
    for(let token=0;token<31;token++)logprobs[frame*31+token]=Math.log(uniform?1/31:token===id?.97:.03/30);
    if(wrongLetter&&id===ids.get('ر')){
      logprobs[frame*31+ids.get('غ')]=Math.log(.52);
      logprobs[frame*31+id]=Math.log(.46);
    }
  });
  return {logprobs,timeSteps:sequence.length,vocabSize:31,blankId:0};
}

test('constrained CTC recovers a secondary acoustic letter without forcing weak noise into Quran',()=>{
  const trie=new QuranTrie(quran,tokens);
  const recovered=decodeQuran(acoustic('انا ارسلنا نوحا',{wrongLetter:true}),trie);
  assert.equal(recovered.usable,true);assert.equal(recovered.best.surah,71);assert.equal(recovered.best.ayah,1);
  assert.ok(recovered.best.acousticFit>.9);
  assert.equal(decodeQuran(acoustic('انا ارسلنا نوحا',{uniform:true}),trie).usable,false);
  assert.equal(decodeQuran(acoustic('اله الق'),trie).usable,false,'A short, corrupted opening must not produce a plausible-looking verse');
  assert.equal(decodeQuran(acoustic('الله'),trie).usable,false,'One common word is insufficient');
});

test('shared openings retain all corpus competitors and remain only tentative',()=>{
  const decoder=createTentativeDecoder(quran,tokens),origin=90000;
  const anchor=Object.freeze({surah:2,ayah:255,wordIndex:3});
  let event=null;
  for(let index=0;index<2;index++){
    const raw=acoustic('الله لا اله الا هو الحي',{padding:8+index*5});
    const length=raw.timeSteps*640;
    event=decoder.observe(raw,{clipStartSample:origin,audioLength:length,throughSample:origin+length,anchor}).event;
    if(!index)assert.equal(event,null,'A single uncertain observation cannot preview a verse');
  }
  assert.equal(event.type,'tentative');assert.equal(event.reason,'shared-phrase');
  assert.deepEqual(event.candidates.map(value=>`${value.surah}:${value.ayah}`),['2:255','3:2']);
  assert.equal(event.prediction,undefined,'A preview must not impersonate confirmed recognition');
  assert.ok(event.audioEndSample>origin);
  assert.ok(event.audioEndSample<origin+acoustic('الله لا اله الا هو الحي',{padding:13}).timeSteps*640);
  assert.deepEqual(anchor,{surah:2,ayah:255,wordIndex:3});
});

test('real word starts inside an ayah and documented joined vocatives use canonical references',()=>{
  const trie=new QuranTrie(quran,tokens);
  const middle=decodeQuran(acoustic('لا تاخذه سنه ولا نوم'),trie);
  assert.equal(middle.usable,true);assert.equal(middle.best.ayah,255);assert.equal(middle.best.startsAtAyah,false);
  const joined=decodeQuran(acoustic('قال يقوم اني لكم نذير مبين'),trie);
  assert.equal(joined.usable,true);assert.equal(joined.best.surah,71);assert.equal(joined.best.ayah,2);
  assert.ok(joined.best.acousticFit>.95);
});

test('explicit scope is enforced and repeated verses are not collapsed',()=>{
  const trie=new QuranTrie(quran,tokens);
  const scoped=decodeQuran(acoustic('الله لا اله الا هو الحي'),trie,{preferredSurah:3});
  assert.equal(scoped.best.surah,3);assert.ok(scoped.candidates.every(value=>value.surah===3));
  const repeated=decodeQuran(acoustic('فباي الاء ربكما تكذبان'),trie,{preferredSurah:55});
  assert.equal(repeated.candidateCount,2);
  assert.deepEqual(repeated.candidates.map(value=>value.ayah),[13,16]);
});

test('replayed windows and a new session cannot reuse tentative consistency',()=>{
  const decoder=createTentativeDecoder(quran,tokens);
  const raw=acoustic('الله لا اله الا هو الحي'),length=raw.timeSteps*640;
  const context={clipStartSample:0,audioLength:length,throughSample:length};
  assert.equal(decoder.observe(raw,context).event,null);
  assert.equal(decoder.observe(raw,context).event,null);
  decoder.reset();
  const later=acoustic('الله لا اله الا هو الحي',{padding:13});
  assert.equal(decoder.observe(later,{clipStartSample:100000,audioLength:later.timeSteps*640,throughSample:100000+later.timeSteps*640}).event,null);
});
