/** PCM waiting for a stateful model must remain consecutive; never drop silently. */
export class ContiguousAudioQueue {
  constructor({ sampleRate = 16000, maxSeconds = 6 } = {}) {
    this.maxSamples = Math.ceil(sampleRate * maxSeconds);
    this.reset();
  }
  reset() { this.chunks=[];this.samples=0;this.expectedEnd=null;this.origin=null; }
  push(audio, endSample) {
    if (!(audio instanceof Float32Array) || !audio.length || !Number.isSafeInteger(endSample)) throw new Error('Invalid streaming audio.');
    const startSample=endSample-audio.length;
    if(startSample<0 || (this.expectedEnd!==null&&startSample!==this.expectedEnd)) return 'gap';
    if(this.samples+audio.length>this.maxSamples)return 'overflow';
    this.origin??=startSample;
    this.chunks.push({audio,startSample,endSample});this.samples+=audio.length;this.expectedEnd=endSample;
    return 'ok';
  }
  take(maxSamples = 7680) {
    if(!this.samples)return null;
    const length=Math.min(maxSamples,this.samples),audio=new Float32Array(length);
    const startSample=this.chunks[0].startSample;
    let offset=0;
    while(offset<length){
      const head=this.chunks[0],count=Math.min(head.audio.length,length-offset);
      audio.set(head.audio.subarray(0,count),offset);offset+=count;this.samples-=count;
      if(count===head.audio.length)this.chunks.shift();
      else{head.audio=head.audio.subarray(count);head.startSample+=count;}
    }
    return {audio,startSample,endSample:startSample+length};
  }
}

let sessionSerial=0;

/** Serial transport, bounded capture FIFO, and sample-time event freshness. */
export class LiveStreamController {
  constructor({request,onPrediction=()=>{},onTranscript=()=>{},onTentative=()=>{},onAyahComplete=()=>{},onMetrics=()=>{},onRecovery=()=>{},onError=()=>{},maxBacklogSeconds=6}) {
    this.request=request;this.onPrediction=onPrediction;this.onMetrics=onMetrics;
    this.onAyahComplete=onAyahComplete;this.onTranscript=onTranscript;this.onTentative=onTentative;
    this.onRecovery=onRecovery;this.onError=onError;
    this.queue=new ContiguousAudioQueue({maxSeconds:maxBacklogSeconds});
    this.operations=Promise.resolve();this.running=false;this.ready=false;this.activeFeed=false;
    this.sessionId=0;this.lastEvidence=-1;this.lastStatusEvidence=-1;this.lastTranscriptEvidence=-1;this.lastThrough=-1;
    this.lastCompletionAt=-1;this.lastTentativeEvidence=-1;this.completedOccurrences=new Set();
  }
  enqueue(action) {
    const next=this.operations.catch(()=>{}).then(action);
    this.operations=next.catch(()=>{});
    return next;
  }
  start(context={},metadata={}) {
    const sessionId=`iqri-${++sessionSerial}`;
    this.sessionId=sessionId;this.context={...context};this.metadata={...metadata};
    this.running=true;this.ready=false;this.queue.reset();this.lastEvidence=-1;this.lastStatusEvidence=-1;this.lastTranscriptEvidence=-1;this.lastThrough=-1;
    this.lastCompletionAt=-1;this.lastTentativeEvidence=-1;this.completedOccurrences.clear();
    return this.enqueue(async()=>{
      if(!this.running||sessionId!==this.sessionId)return;
      const result=await this.request('stream-start',{sessionId,context:this.context});
      if(!this.running||sessionId!==this.sessionId)return;
      if(result?.type!=='stream-started'||result.sessionId!==sessionId)throw new Error('The live recognition session could not start.');
      this.ready=true;this.drain();
    }).catch(error=>{this.fail(error,sessionId);throw error;});
  }
  push(audio,endSample) {
    if(!this.running)return;
    const result=this.queue.push(audio,endSample);
    if(result!=='ok'){
      // Losing samples invalidates model caches. Announce and create a new
      // session, retaining only the explicit scope; never splice over a gap.
      const metadata=this.metadata,context={preferredSurah:this.context.preferredSurah};
      this.onRecovery(result,metadata);
      this.start(context,metadata).catch(()=>{});
      this.queue.push(audio,endSample);
    }
    this.drain();
  }
  drain() {
    if(!this.running||!this.ready||this.activeFeed)return;
    // The rolling recognizer accepts two seconds per feed. Coalesce captured
    // samples after a slow update so we catch up to the live edge instead of
    // replaying a growing queue in 480 ms steps. No PCM samples are discarded.
    const packet=this.queue.take(32000);if(!packet)return;
    const sessionId=this.sessionId,metadata=this.metadata;
    this.activeFeed=true;
    this.enqueue(async()=>{
      if(!this.running||sessionId!==this.sessionId)return;
      const result=await this.request('stream-feed',{sessionId,...packet});
      if(!this.running||sessionId!==this.sessionId)return;
      this.receive(result,metadata);
      this.onMetrics({processingMs:result.processingMs||0,windowSeconds:(packet.endSample-packet.startSample)/16000,
        backlogMs:this.queue.samples/16,throughSample:result.throughSample},metadata);
    }).catch(error=>this.fail(error,sessionId)).finally(()=>{
      this.activeFeed=false;this.drain();
    });
  }
  receive(result,metadata=this.metadata) {
    const current=()=>this.running&&result?.sessionId===this.sessionId&&
      metadata?.generation===this.metadata?.generation&&metadata?.contextVersion===this.metadata?.contextVersion;
    if(!current())return;
    if(result.type!=='stream-result'||!Number.isSafeInteger(result.throughSample)||result.throughSample<this.lastThrough||!Array.isArray(result.events))throw new Error('Live recognition returned an invalid audio position.');
    this.lastThrough=result.throughSample;
    for(const event of result.events){
      // A callback may stop or replace this session while dispatching an envelope.
      if(!current())return;
      if(event?.type==='tentative'){
        const end=event.audioEndSample,candidate=event.candidate;
        if(!Number.isSafeInteger(end)||end<(this.queue.origin??0)||end>result.throughSample||
          end<=this.lastTentativeEvidence||result.throughSample-end>16000*1.2||
          !Number.isInteger(candidate?.surah)||!Number.isInteger(candidate?.ayah))continue;
        this.lastTentativeEvidence=end;
        this.onTentative(event,{...metadata,sessionId:this.sessionId,eventType:'tentative',
          audioEndSample:end,throughSample:result.throughSample});
        continue;
      }
      if(event?.type==='transcript'){
        const end=event.audioEndSample;
        if(typeof event.transcript!=='string'||!Number.isSafeInteger(end)||
          end<(this.queue.origin??0)||end>result.throughSample||end<=this.lastTranscriptEvidence)continue;
        this.lastTranscriptEvidence=end;
        // Raw model text is temporary display feedback, never recognition evidence.
        // Keep only the callback argument; there is no retained transcript history.
        const transcript=event.transcript.slice(0,1000).replace(/[\uD800-\uDBFF]$/u,'');
        this.onTranscript(transcript,{...metadata,sessionId:this.sessionId,eventType:'transcript',
          audioEndSample:end,throughSample:result.throughSample});
        continue;
      }
      if(event?.type==='ayah-complete'){
        const end=event.audioEndSample,completedAt=event.completedAtSample;
        const occurrence=typeof event.occurrenceId==='string'||Number.isSafeInteger(event.occurrenceId)?String(event.occurrenceId):'';
        if(!occurrence||!Number.isSafeInteger(end)||!Number.isSafeInteger(completedAt)||
          end<(this.queue.origin??0)||end>completedAt||completedAt>result.throughSample||
          completedAt<this.lastCompletionAt||this.completedOccurrences.has(occurrence))continue;
        this.lastCompletionAt=completedAt;this.completedOccurrences.add(occurrence);
        if(this.completedOccurrences.size>256)this.completedOccurrences.delete(this.completedOccurrences.values().next().value);
        this.onAyahComplete(event,{...metadata,sessionId:this.sessionId,eventType:'ayah-complete',
          audioEndSample:end,completedAtSample:completedAt,throughSample:result.throughSample});
        continue;
      }
      if(!['progress','status'].includes(event?.type)||!event.prediction||typeof event.prediction.status!=='string')continue;
      const end=event.audioEndSample;
      if(!Number.isSafeInteger(end)||end<(this.queue.origin??0)||end>result.throughSample)continue;
      if(event.type==='status'){
        if(end<=this.lastStatusEvidence||end<=this.lastEvidence)continue;
        this.lastStatusEvidence=end;
      }else{
        if(end<=this.lastEvidence)continue;
        this.lastEvidence=end;
      }
      this.onPrediction(event.prediction,{...metadata,sessionId:this.sessionId,eventType:event.type,audioEndSample:end,throughSample:result.throughSample});
    }
  }
  fail(error,sessionId) {
    if(sessionId!==this.sessionId)return;
    this.running=false;this.ready=false;this.queue.reset();this.lastTranscriptEvidence=-1;
    this.onError(error,this.metadata);
  }
  stop() {
    const sessionId=this.sessionId;
    this.running=false;this.ready=false;this.sessionId=`iqri-${++sessionSerial}`;this.queue.reset();this.lastTranscriptEvidence=-1;
    return this.enqueue(()=>sessionId?this.request('stream-stop',{sessionId}):undefined).catch(()=>{});
  }
}
