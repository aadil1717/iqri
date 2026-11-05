import test from 'node:test';
import assert from 'node:assert/strict';
import {ContiguousAudioQueue,LiveStreamController} from '../src/live-stream.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const pcm=(length,value=0.1)=>new Float32Array(length).fill(value);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const prediction=(ayah=1)=>({status:'matched',surah:112,ayah});
const event=(audioEndSample,ayah=1)=>({type:'progress',audioEndSample,prediction:prediction(ayah)});
const response=(packet,events=[])=>({type:'stream-result',sessionId:packet.sessionId,throughSample:packet.endSample,processingMs:40,events});

test('tentative references have independent freshness and cannot consume confirmed progress',async()=>{
  const guessed=[],confirmed=[];
  const controller=new LiveStreamController({
    request:async(type,p)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:p.sessionId}),
    onTentative:(event,meta)=>guessed.push([event.candidate.ayah,meta.audioEndSample]),
    onPrediction:(_p,meta)=>confirmed.push(meta.audioEndSample),
  });
  await controller.start({}, {generation:1,contextVersion:2});
  const tentative=end=>({type:'tentative',audioEndSample:end,candidate:{surah:2,ayah:255},candidates:[]});
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:2000,events:[
    tentative(1500),tentative(1400),tentative(2500),event(1100),event(1600),
  ]});
  assert.deepEqual(guessed,[[255,1500]]);assert.deepEqual(confirmed,[1100,1600]);
  const oldSession=controller.sessionId;await controller.start();
  controller.receive({type:'stream-result',sessionId:oldSession,throughSample:2000,events:[tentative(1800)]});
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:1000,events:[tentative(900)]});
  assert.deepEqual(guessed,[[255,1500],[255,900]]);
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:40000,events:[tentative(20000)]});
  assert.equal(guessed.length,2,'Old acoustic support cannot refresh a live tentative card');
  await controller.stop();
});

test('stream queue preserves every PCM sample and timestamp when coalescing and splitting',()=>{
  const queue=new ContiguousAudioQueue();
  assert.equal(queue.push(pcm(1600,1),9600),'ok');
  assert.equal(queue.push(pcm(1600,2),11200),'ok');
  const first=queue.take(2000),second=queue.take();
  assert.deepEqual([first.startSample,first.endSample,second.startSample,second.endSample],[8000,10000,10000,11200]);
  assert.equal(first.audio[1599],1);assert.equal(first.audio[1600],2);assert.ok(second.audio.every(value=>value===2));
  assert.equal(queue.samples,0);
  assert.equal(queue.push(pcm(1600),14400),'gap');
});

test('one feed stays active while contiguous captured chunks coalesce; progress is delivered on response',async()=>{
  const feeds=[],seen=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>{
      if(type==='stream-start')return{type:'stream-started',sessionId:packet.sessionId};
      if(type==='stream-stop')return{type:'stream-result',sessionId:packet.sessionId,throughSample:4800,events:[],final:true};
      const pending=deferred();feeds.push({packet,pending});return pending.promise;
    },onPrediction:(value,meta)=>seen.push({value,meta}),
  });
  await controller.start({preferredSurah:112},{generation:4,contextVersion:1});
  controller.push(pcm(1600),1600);await tick();
  controller.push(pcm(1600),3200);controller.push(pcm(1600),4800);await tick();
  assert.equal(feeds.length,1);
  feeds[0].pending.resolve(response(feeds[0].packet,[event(1200)]));await tick();
  assert.equal(seen.length,1);assert.equal(seen[0].meta.generation,4);
  assert.equal(feeds.length,2);assert.equal(feeds[1].packet.audio.length,3200);
  assert.deepEqual([feeds[1].packet.startSample,feeds[1].packet.endSample],[1600,4800]);
  feeds[1].pending.resolve(response(feeds[1].packet,[event(1200),event(4000,2)]));await tick();
  assert.deepEqual(seen.map(x=>x.value.ayah),[1,2]);
  await controller.stop();
});

test('slow inference catches up with bounded two-second feeds without losing captured samples',async()=>{
  const feeds=[];
  const controller=new LiveStreamController({request:async(type,packet)=>{
    if(type!=='stream-feed')return{type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId};
    const pending=deferred();feeds.push({packet,pending});return pending.promise;
  }});
  await controller.start();
  controller.push(pcm(1600,1),1600);await tick();
  for(let i=2;i<=27;i++)controller.push(pcm(1600,i),i*1600);
  feeds[0].pending.resolve(response(feeds[0].packet));await tick();
  assert.equal(feeds[1].packet.audio.length,32000);
  assert.deepEqual([feeds[1].packet.startSample,feeds[1].packet.endSample],[1600,33600]);
  feeds[1].pending.resolve(response(feeds[1].packet));await tick();
  assert.deepEqual([feeds[2].packet.startSample,feeds[2].packet.endSample],[33600,43200]);
  const joined=Float32Array.from(feeds.flatMap(feed=>Array.from(feed.packet.audio)));
  assert.equal(joined.length,27*1600);
  for(let i=0;i<joined.length;i++)assert.equal(joined[i],Math.floor(i/1600)+1);
  feeds[2].pending.resolve(response(feeds[2].packet));await tick();
  assert.equal(controller.queue.samples,0);
  await controller.stop();
});

test('session replacement waits for active feed and rejects its old events; nonzero origin remains valid',async()=>{
  const calls=[],seen=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>{
      if(type==='stream-feed'){const pending=deferred();calls.push({type,packet,pending});return pending.promise;}
      calls.push({type,packet});return{type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId};
    },onPrediction:value=>seen.push(value),
  });
  await controller.start({preferredSurah:96});
  controller.push(pcm(1600),1600);await tick();
  const old=calls.find(call=>call.type==='stream-feed');
  const restarting=controller.start({preferredSurah:112});
  controller.push(pcm(1600),9600);await tick();
  assert.equal(calls.filter(call=>call.type==='stream-start').length,1);
  old.pending.resolve(response(old.packet,[event(1200)]));await restarting;await tick();
  assert.equal(seen.length,0);
  const next=calls.filter(call=>call.type==='stream-feed').at(-1);
  assert.notEqual(next.packet.sessionId,old.packet.sessionId);
  assert.equal(next.packet.startSample,8000);
  next.pending.resolve(response(next.packet,[event(9000)]));await tick();
  assert.equal(seen.length,1);await controller.stop();
});

test('overflow announces a cache reset instead of silently skipping queued model audio',async()=>{
  const feeds=[],recoveries=[];
  const controller=new LiveStreamController({maxBacklogSeconds:.2,
    request:async(type,packet)=>{
      if(type==='stream-feed'){const pending=deferred();feeds.push({packet,pending});return pending.promise;}
      return{type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId};
    },onRecovery:reason=>recoveries.push(reason),
  });
  await controller.start({preferredSurah:112,previousReference:{surah:112,ayah:1}});
  controller.push(pcm(1600),1600);await tick();
  controller.push(pcm(1600),3200);controller.push(pcm(3200),6400);
  assert.deepEqual(recoveries,['overflow']);assert.equal(controller.context.previousReference,undefined);
  feeds[0].pending.resolve(response(feeds[0].packet));await tick();await tick();
  assert.equal(feeds[1].packet.startSample,3200);
  feeds[1].pending.resolve(response(feeds[1].packet));await tick();await controller.stop();
});

test('feed failure stops the pipeline without retrying the same samples',async()=>{
  let feeds=0,errors=0;
  const controller=new LiveStreamController({
    request:async(type,packet)=>{
      if(type==='stream-feed'){feeds++;throw new Error('fixture transport failure');}
      return{type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId};
    },onError:()=>errors++,
  });
  await controller.start();controller.push(pcm(1600),1600);await tick();
  controller.push(pcm(1600),3200);await tick();
  assert.equal(feeds,1);assert.equal(errors,1);assert.equal(controller.running,false);
  await controller.stop();
});

test('status events report ambiguity without consuming word evidence timestamps',async()=>{
  const seen=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId}),
    onPrediction:(prediction,metadata)=>seen.push([prediction.status,metadata.audioEndSample]),
  });
  await controller.start();
  const envelope={type:'stream-result',sessionId:controller.sessionId,throughSample:2000,events:[
    event(800),
    {type:'status',audioEndSample:1200,prediction:{status:'ambiguous',candidates:[]}},
    {type:'status',audioEndSample:1000,prediction:{status:'uncertain'}},
    event(1100,2),
    {type:'status',audioEndSample:2500,prediction:{status:'silence'}},
  ]};
  controller.receive(envelope);
  assert.deepEqual(seen,[['matched',800],['ambiguous',1200],['matched',1100]]);
  assert.equal(controller.lastEvidence,1100);assert.equal(controller.lastStatusEvidence,1200);
  await controller.stop();
});

test('ayah completion uses a separate callback and deduplication without consuming word evidence',async()=>{
  const words=[],completed=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId}),
    onPrediction:(_prediction,metadata)=>words.push(metadata.audioEndSample),
    onAyahComplete:(event,metadata)=>completed.push({event,metadata}),
  });
  await controller.start({}, {generation:7,contextVersion:2});
  const complete={type:'ayah-complete',verseKey:'112:1',surah:112,ayah:1,audioEndSample:1000,completedAtSample:1500,occurrenceId:'first',prediction:prediction()};
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:2000,events:[
    event(1000),complete,{...complete,completedAtSample:1600},
    {...complete,completedAtSample:2500,occurrenceId:'invalid'},event(1400,2),
  ]});
  assert.deepEqual(words,[1000,1400]);assert.equal(controller.lastEvidence,1400);
  assert.equal(completed.length,1);assert.equal(completed[0].metadata.generation,7);
  assert.equal(completed[0].metadata.completedAtSample,1500);
  await controller.stop();
});

test('uncertain transcript feedback has its own clock and cannot suppress confirmed words',async()=>{
  const words=[],transcripts=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId}),
    onPrediction:(_prediction,metadata)=>words.push(metadata.audioEndSample),
    onTranscript:(text,metadata)=>transcripts.push({text,metadata}),
  });
  await controller.start({}, {generation:8,contextVersion:3});
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:2000,events:[
    event(800),
    {type:'transcript',audioEndSample:1500,transcript:'الحمد لله'},
    {type:'status',audioEndSample:1600,prediction:{status:'uncertain'}},
    event(1100,2),
    {type:'transcript',audioEndSample:1400,transcript:'old'},
    {type:'transcript',audioEndSample:1500,transcript:'duplicate'},
    {type:'transcript',audioEndSample:1800,transcript:''},
  ]});
  assert.deepEqual(words,[800,1600,1100]);
  assert.deepEqual(transcripts.map(item=>item.text),['الحمد لله','']);
  assert.equal(transcripts[0].metadata.generation,8);
  assert.equal(transcripts[0].metadata.contextVersion,3);
  assert.equal(transcripts[0].metadata.eventType,'transcript');
  assert.equal(transcripts[0].metadata.audioEndSample,1500);
  assert.equal(controller.lastEvidence,1100);
  await controller.stop();
});

test('transcripts require valid in-session sample positions and are bounded for display',async()=>{
  const seen=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId}),
    onTranscript:text=>seen.push(text),
  });
  await controller.start();
  controller.queue.push(pcm(1600),9600);
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:9600,events:[
    {type:'transcript',audioEndSample:7999,transcript:'before origin'},
    {type:'transcript',audioEndSample:9601,transcript:'future'},
    {type:'transcript',audioEndSample:8500.5,transcript:'fraction'},
    {type:'transcript',audioEndSample:'8500',transcript:'wrong type'},
    {type:'transcript',audioEndSample:8500,transcript:null},
    {type:'transcript',audioEndSample:8500,transcript:'ا'.repeat(999)+'😀tail'},
  ]});
  assert.deepEqual(seen,['ا'.repeat(999)]);
  assert.equal(controller.lastEvidence,-1);
  assert.equal(controller.lastStatusEvidence,-1);
  await controller.stop();
});

test('session replacement clears transcript freshness and rejects old session or context callbacks',async()=>{
  const seen=[];
  const controller=new LiveStreamController({
    request:async(type,packet)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId}),
    onTranscript:(text,metadata)=>seen.push([text,metadata.generation,metadata.contextVersion]),
  });
  const oldMetadata={generation:1,contextVersion:2};
  await controller.start({},oldMetadata);
  const oldSession=controller.sessionId;
  const deliver=(sessionId,end,text,metadata)=>controller.receive({type:'stream-result',sessionId,throughSample:2000,
    events:[{type:'transcript',audioEndSample:end,transcript:text}]},metadata);
  deliver(oldSession,1500,'first');
  await controller.start({}, {generation:2,contextVersion:3});
  deliver(oldSession,1800,'old session',oldMetadata);
  deliver(controller.sessionId,1800,'old generation',{generation:1,contextVersion:3});
  deliver(controller.sessionId,1800,'old scope',{generation:2,contextVersion:2});
  deliver(controller.sessionId,1000,'new session');
  assert.deepEqual(seen,[['first',1,2],['new session',2,3]]);
  await controller.stop();
  deliver(controller.sessionId,1900,'after stop');
  assert.equal(seen.length,2);
  assert.equal(controller.lastTranscriptEvidence,-1);
});

test('stopping from a transcript callback prevents remaining envelope events from appearing',async()=>{
  const seen=[];
  let stopping;
  const controller=new LiveStreamController({
    request:async(type,packet)=>({type:type==='stream-start'?'stream-started':'stream-result',sessionId:packet.sessionId}),
    onTranscript:text=>{seen.push(text);stopping=controller.stop();},
    onPrediction:()=>seen.push('obsolete word'),
  });
  await controller.start();
  controller.receive({type:'stream-result',sessionId:controller.sessionId,throughSample:2000,events:[
    {type:'transcript',audioEndSample:1200,transcript:'latest'},event(1500),
    {type:'transcript',audioEndSample:1800,transcript:'obsolete text'},
  ]});
  await stopping;
  assert.deepEqual(seen,['latest']);
});
