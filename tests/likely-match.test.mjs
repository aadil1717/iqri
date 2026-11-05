import test from 'node:test';
import assert from 'node:assert/strict';
import {LikelyMatch} from '../src/likely-match.js';
import {VerseTracker} from '../src/tracker.js';
const verses=[{surah:2,ayah:255},{surah:3,ayah:2},{surah:71,ayah:1},{surah:71,ayah:2}];
const offer=(surah,ayah,end)=>({candidate:{surah,ayah},candidates:[{surah:3,ayah:2}],audioEndSample:end,reason:'shared-phrase'});
test('tentative reference retains alternatives without becoming an anchor',()=>{
  const view=new LikelyMatch(verses);
  assert.deepEqual(view.offer(offer(2,255,16000)).keys,['2:255','3:2']);
  assert.equal(view.confirmedKey,null);
  assert.equal(view.confirm('3:2',20000),true);
  assert.equal(view.pending,null);assert.equal(view.confirmedKey,'3:2');
});
test('late previous-ayah evidence cannot overwrite a newer preview',()=>{
  const view=new LikelyMatch(verses);
  view.confirm('71:1',10000);view.offer(offer(71,2,20000));
  assert.equal(view.confirm('71:1',15000),false);
  assert.equal(view.pending.key,'71:2');
  assert.equal(view.confirm('71:2',19000),true);
  assert.equal(view.offer(offer(71,2,22000)),null);
});
test('scope, canonical references and evidence boundaries constrain previews',()=>{
  const view=new LikelyMatch(verses);
  assert.equal(view.offer(offer(2,255,100),{scope:71}),null);
  assert.equal(view.offer(offer(2,999,100)),null);
  assert.equal(view.offer(offer(71,1,100.5)),null);
  assert.equal(view.offer(offer(71,1,100),{prepared:{fromKey:'71:1',completedAtSample:150}}),null);
  view.offer(offer(71,2,300));assert.equal(view.offer(offer(71,1,200)),null);
  view.reset();assert.equal(view.pending,null);assert.equal(view.confirmedAt,-1);
});
test('confirmed evidence cannot regress through a fresh envelope with stale acoustic time',()=>{
  const view=new LikelyMatch(verses);view.confirm('71:2',30000);
  assert.equal(view.confirm('71:1',20000),false);
  assert.equal(view.confirmedKey,'71:2');
  assert.equal(view.confirm('71:1',40000),true);
});
test('an acoustically tied shared phrase keeps its current tentative card until distinguished',()=>{
  const view=new LikelyMatch(verses);
  view.offer({...offer(2,255,1000),candidate:{surah:2,ayah:255,score:1}});
  const tied={candidate:{surah:3,ayah:2,score:1},candidates:[{surah:2,ayah:255,score:1}],audioEndSample:2000};
  assert.equal(view.offer(tied).key,'2:255');
  assert.equal(view.offer({...tied,candidates:[],audioEndSample:3000}).key,'3:2');
});
test('checking a reference before freshness validation does not establish continuity',()=>{
  const tracker=new VerseTracker([
    {surah:1,ayah:1,text_clean:'الف'}, {surah:1,ayah:2,text_clean:'باء'},
    {surah:2,ayah:1,text_clean:'جيم'}, {surah:2,ayah:2,text_clean:'باء'},
  ]);
  assert.equal(tracker.accept({surah:1,ayah:1},{commit:false}).status,'matched');
  assert.equal(tracker.accept({surah:1,ayah:2}).status,'ambiguous');
  tracker.accept({surah:1,ayah:1});
  assert.equal(tracker.accept({surah:1,ayah:2}).verseKey,'1:2');
});
