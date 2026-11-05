import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {basename} from 'node:path';
import {loadNodeRecognition} from '../src/recognition/node-engine.js';

// Public evaluation fixtures only. Download separately; audio is not part of the app.
const rate=16000,plan=JSON.parse(await readFile(new URL('../tests/acquisition-public-cases.json',import.meta.url),'utf8'));
const cases=plan.cases.map(value=>({...value,source:value.sourceUrl,file:fileURLToPath(new URL('../tests/fixtures/'+value.fixture,import.meta.url))})),label=(process.argv.find(x=>x.startsWith('--label='))||'--label=current').slice(8);
if(!/^[a-z0-9-]+$/u.test(label))throw new Error('Invalid report label.');
const sources=(await readdir(new URL('../src/recognition/',import.meta.url))).filter(name=>name.endsWith('.js')).sort();
async function hashes(){return Object.fromEntries(await Promise.all(sources.map(async name=>{try{return[name,createHash('sha256').update(await readFile(new URL('../src/recognition/'+name,import.meta.url))).digest('hex')];}catch{return[name,null];}})));}
const before=await hashes(),loadedAt=performance.now(),engine=await loadNodeRecognition({modelDirectory:fileURLToPath(new URL('../models',import.meta.url))});
const report={created:new Date().toISOString(),label,private:false,sourceHashes:before,loadMs:performance.now()-loadedAt,
  benchmarkSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  methodology:'Actual integrated native engine; independent consecutive 100 ms chunks in automatic mode. Each fixture runs from its original beginning through at most eight seconds after the provisional sustained-energy onset, followed by two seconds quiet. Native audio-position timings are not real-time browser/UI latency. Onsets are signal-derived and approximate, not manual phonetic annotations. Tentative top choices, candidate groups and confirmed claims are reported separately.',
  cases:[],failures:[]};
const reference=p=>p?.surah?`${p.surah}:${p.ayah}`:null;
const sharedOnly=new Set(['1:2','2:255','55:13']);
const round=x=>Number(x.toFixed(4));
try{
  for(let index=0;index<cases.length;index++){
    const item=cases[index],bytes=await readFile(item.file),pcm=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Fixture hash mismatch: '+item.fixture);
    const clipLength=Math.min(pcm.length,Math.ceil(((item.provisionalSpeechOnsetSeconds??0)+8)*rate));
    const audio=new Float32Array(clipLength+2*rate);audio.set(pcm.subarray(0,clipLength));
    const sessionId=`public-acquisition-${index}`,events=[],wrongConfirmed=[],nonTargetTopTentatives=[],groupsMissingTarget=[];
    let firstAnyTentative=null,firstTargetTentative=null,firstTargetCandidateGroup=null,firstConfirmed=null,firstHighlight=null;
    await engine.start({sessionId,context:{}});const started=performance.now();
    const inspect=(result,through)=>{
      for(const event of result.events||[]){
        const at=through/rate;
        if(event.type==='tentative'){
          const top=reference(event.candidate),candidates=[...new Set([top,...(event.candidates||[]).map(reference)].filter(Boolean))];
          const row={type:'tentative',atSeconds:round(at),audioEndSeconds:event.audioEndSample/rate,reference:top,candidates,score:event.candidate?.score,reason:event.reason};
          events.push(row);firstAnyTentative??=at;
          if(top===item.reference)firstTargetTentative??=at;else nonTargetTopTentatives.push(row);
          if(candidates.includes(item.reference))firstTargetCandidateGroup??=at;else groupsMissingTarget.push(row);
          continue;
        }
        const p=event.prediction;
        if(!p||p.status!=='matched')continue;
        const ref=reference(p),wordRef=p.wordProgress?.verseKey??null;
        const row={type:event.type,atSeconds:round(at),reference:ref,wordReference:wordRef,wordIndex:p.wordProgress?.wordIndex??null,audioEndSeconds:event.audioEndSample/rate};
        events.push(row);
        // These standalone recordings contain only a shared phrase in this prefix.
        // A tentative group is useful; any unique confirmation would be invented.
        const invalid=sharedOnly.has(item.reference)||ref!==item.reference||(wordRef&&wordRef!==item.reference);
        if(invalid)wrongConfirmed.push(row);
        if(ref===item.reference){firstConfirmed??=at;if(wordRef===item.reference)firstHighlight??=at;}
      }
    };
    for(let offset=0;offset<audio.length;offset+=1600){const end=Math.min(offset+1600,audio.length);inspect(await engine.feed(audio.subarray(offset,end),{sessionId,startSample:offset,endSample:end}),end);}
    inspect(await engine.stop({sessionId}),audio.length);
    const fromOnset=value=>value===null||item.provisionalSpeechOnsetSeconds===null?null:round(value-item.provisionalSpeechOnsetSeconds);
    const tentativeIntervals=events.flatMap((event,i)=>event.type==='tentative'?[{
      reference:event.reference,candidates:event.candidates,startSeconds:event.atSeconds,
      endSeconds:events[i+1]?.atSeconds??audio.length/rate,
      durationSeconds:round((events[i+1]?.atSeconds??audio.length/rate)-event.atSeconds),
      targetIncluded:event.candidates.includes(item.reference),topIsTarget:event.reference===item.reference,
    }]:[]);
    const result={reference:item.reference,source:item.source,fixture:basename(item.file),
      fixtureSha256:createHash('sha256').update(bytes).digest('hex'),
      inputPcmWithSilenceSha256:createHash('sha256').update(new Uint8Array(audio.buffer)).digest('hex'),
      clipAudioSeconds:clipLength/rate,provisionalSpeechOnsetSeconds:item.provisionalSpeechOnsetSeconds,
      firstAnyTentativeSeconds:firstAnyTentative,firstTargetTentativeSeconds:firstTargetTentative,firstTargetCandidateGroupSeconds:firstTargetCandidateGroup,firstConfirmedSeconds:firstConfirmed,firstHighlightSeconds:firstHighlight,
      firstTargetTentativeAfterProvisionalOnset:fromOnset(firstTargetTentative),firstTargetGroupAfterProvisionalOnset:fromOnset(firstTargetCandidateGroup),firstConfirmedAfterProvisionalOnset:fromOnset(firstConfirmed),firstHighlightAfterProvisionalOnset:fromOnset(firstHighlight),
      candidateGroupWithinFiveSeconds:fromOnset(firstTargetCandidateGroup)!==null&&fromOnset(firstTargetCandidateGroup)<=5,
      nonTargetTopTentatives,groupsMissingTarget,tentativeIntervals,
      nonTargetTopTentativeSeconds:round(tentativeIntervals.filter(v=>!v.topIsTarget).reduce((sum,v)=>sum+v.durationSeconds,0)),
      tentativeMissingTargetSeconds:round(tentativeIntervals.filter(v=>!v.targetIncluded).reduce((sum,v)=>sum+v.durationSeconds,0)),
      wrongConfirmed,events,wallProcessingMs:round(performance.now()-started)};
    const useful=[firstTargetCandidateGroup,sharedOnly.has(item.reference)?null:firstConfirmed].filter(value=>value!==null);
    result.firstUsefulLocationAfterProvisionalOnset=useful.length?fromOnset(Math.min(...useful)):null;
    result.usefulLocationWithinFiveSeconds=result.firstUsefulLocationAfterProvisionalOnset!==null&&result.firstUsefulLocationAfterProvisionalOnset<=5;
    report.cases.push(result);
    if(wrongConfirmed.length)report.failures.push(`${item.reference}: ${wrongConfirmed.length} unsupported confirmed claims`);
    console.log(JSON.stringify({reference:item.reference,candidateAfterOnset:result.firstTargetGroupAfterProvisionalOnset,confirmedAfterOnset:result.firstConfirmedAfterProvisionalOnset,wrongConfirmed:wrongConfirmed.length}));
  }
}finally{await engine.dispose();}
report.sourceHashesAfter=await hashes();report.sourceChanged=JSON.stringify(before)!==JSON.stringify(report.sourceHashesAfter);
if(report.sourceChanged)report.failures.push('Production source changed during evaluation; repeat on a frozen source.');
report.safetyPassed=report.failures.length===0;
report.fiveSecondCandidateCases=report.cases.filter(value=>value.candidateGroupWithinFiveSeconds).length;
report.fiveSecondUsefulLocationCases=report.cases.filter(value=>value.usefulLocationWithinFiveSeconds).length;
await writeFile(new URL('../tests/acquisition-native-public.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({cases:report.cases.length,safetyPassed:report.safetyPassed,fiveSecondCandidateCases:report.fiveSecondCandidateCases,fiveSecondUsefulLocationCases:report.fiveSecondUsefulLocationCases,failures:report.failures}));
if(!report.safetyPassed)process.exitCode=1;
