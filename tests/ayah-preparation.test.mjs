import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AyahPreparation} from '../src/ayah-preparation.js';

const verses=JSON.parse(readFileSync(new URL('../dist/data/quran.json',import.meta.url),'utf8'));
const completion=(verseKey='112:1',audioEndSample=1000,completedAtSample=1500,occurrenceId='one')=>{
  const [surah,ayah]=verseKey.split(':').map(Number);
  return{type:'ayah-complete',verseKey,surah,ayah,audioEndSample,completedAtSample,occurrenceId};
};
const context=(currentKey='112:1',scope=null)=>({currentKey,recognizedKey:currentKey,scope});

test('only an explicit completion of the actually recognized displayed ayah prepares its successor',()=>{
  const preparation=new AyahPreparation(verses);
  assert.equal(preparation.complete({...completion(),type:'progress'},context()),null);
  assert.equal(preparation.complete(completion(),{...context(),recognizedKey:'112:2'}),null);
  assert.equal(preparation.complete(completion(),{...context(),currentKey:'1:1'}),null);
  assert.equal(preparation.complete(completion(),context('112:1',1)),null);
  assert.equal(preparation.pending,null);
  const next=preparation.complete(completion(),context());
  assert.deepEqual(next,{kind:'next',fromKey:'112:1',key:'112:2',audioEndSample:1000,completedAtSample:1500,occurrenceId:'one'});
});

test('duplicate completion leaves a prepared card intact and never advances twice',()=>{
  const preparation=new AyahPreparation(verses);
  const pending=preparation.complete(completion(),context());
  assert.equal(preparation.complete(completion(),context()),null);
  assert.equal(preparation.complete(completion('112:1',1100,1600,'one'),context()),null);
  assert.equal(preparation.pending,pending);
});

test('late completed-ayah evidence is held, while a newly recited repeat clears preparation',()=>{
  const preparation=new AyahPreparation(verses);
  preparation.complete(completion(),context());
  assert.equal(preparation.acceptProgress('112:1',1000),false);
  assert.equal(preparation.acceptProgress('112:1',1500),false);
  assert.equal(preparation.pending.key,'112:2');
  assert.equal(preparation.acceptProgress('112:1',1700),true);
  assert.equal(preparation.pending,null);
  assert.equal(preparation.complete(completion('112:1',2000,2500,'repeat'),context()).key,'112:2');
});

test('actual next-ayah speech or a fresh recognized jump clears the prepared state',()=>{
  for(const key of ['112:2','36:15']){
    const preparation=new AyahPreparation(verses);
    preparation.complete(completion(),context());
    assert.equal(preparation.acceptProgress(key,1800),true);
    assert.equal(preparation.pending,null);
  }
});

test('fixed scope stops at surah end, global mode crosses canonically, and Quran end never wraps',()=>{
  const preparation=new AyahPreparation(verses);
  assert.deepEqual(preparation.complete(completion('112:4'),context('112:4',112)),{
    kind:'end',fromKey:'112:4',audioEndSample:1000,completedAtSample:1500,occurrenceId:'one',end:'surah',
  });
  assert.equal(preparation.acceptProgress('112:4',1500),false);
  assert.equal(preparation.pending.kind,'end');
  preparation.clear();
  assert.equal(preparation.complete(completion('112:4'),context('112:4')).key,'113:1');
  preparation.clear();
  const final=preparation.complete(completion('114:6'),context('114:6'));
  assert.equal(final.kind,'end');assert.equal(final.end,'quran');assert.equal(final.key,undefined);
});

test('held status needs no timer or reset, while explicit clear removes preparation',()=>{
  const preparation=new AyahPreparation(verses);
  const pending=preparation.complete(completion(),context());
  // Silence / ambiguous status is not word progress or an ayah completion.
  assert.equal(preparation.complete({type:'status',status:'silence'},context()),null);
  assert.equal(preparation.pending,pending);
  preparation.clear();assert.equal(preparation.pending,null);
  assert.equal(preparation.acceptProgress('112:1',100),true);
});

test('malformed completion cannot claim an ayah or an impossible acoustic frontier',()=>{
  const preparation=new AyahPreparation(verses);
  for(const event of [{...completion(),surah:113},{...completion(),completedAtSample:500},
    {...completion(),occurrenceId:''},{...completion(),audioEndSample:NaN},completion('114:7')]){
    assert.equal(preparation.complete(event,context(event.verseKey)),null);
  }
  assert.equal(preparation.pending,null);
});
