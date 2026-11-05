const reference=verse=>`${verse.surah}:${verse.ayah}`;

/** Prepare the next reading card only from an explicit acoustic completion. */
export class AyahPreparation {
  constructor(verses) {
    this.verses=[...verses].sort((a,b)=>a.surah-b.surah||a.ayah-b.ayah);
    this.byKey=new Map(this.verses.map((verse,index)=>[reference(verse),{verse,index}]));
    this.clear();
  }
  clear() { this.pending=null;this.completed=new Map(); }

  complete(event,{currentKey,recognizedKey,scope=null}={}) {
    if(event?.type!=='ayah-complete'||typeof event.verseKey!=='string')return null;
    const entry=this.byKey.get(event.verseKey);
    if(!entry||event.verseKey!==`${event.surah}:${event.ayah}`||
      currentKey!==event.verseKey||recognizedKey!==event.verseKey)return null;
    if(scope!==null&&scope!==undefined&&Number(scope)!==entry.verse.surah)return null;
    const audioEndSample=event.audioEndSample,completedAtSample=event.completedAtSample;
    const occurrenceId=typeof event.occurrenceId==='string'||Number.isSafeInteger(event.occurrenceId)?String(event.occurrenceId):'';
    if(!occurrenceId||!Number.isSafeInteger(audioEndSample)||audioEndSample<0||
      !Number.isSafeInteger(completedAtSample)||completedAtSample<audioEndSample)return null;
    const prior=this.completed.get(event.verseKey);
    if(prior&&(prior.occurrenceId===occurrenceId||completedAtSample<=prior.completedAtSample||audioEndSample<=prior.audioEndSample))return null;
    const next=this.verses[entry.index+1];
    const scoped=scope!==null&&scope!==undefined;
    const common={fromKey:event.verseKey,audioEndSample,completedAtSample,occurrenceId};
    const endsScope=scoped&&(!next||next.surah!==entry.verse.surah);
    const endsQuran=entry.verse.surah===114&&entry.verse.ayah===6;
    if(endsScope||endsQuran){
      this.pending={kind:'end',...common,end:endsQuran&&!scoped?'quran':'surah'};
    }else{
      // Never jump over a missing record or wrap around the canonical corpus.
      if(!next||!((next.surah===entry.verse.surah&&next.ayah===entry.verse.ayah+1)||
        (next.surah===entry.verse.surah+1&&next.ayah===1)))return null;
      this.pending={kind:'next',...common,key:reference(next)};
    }
    this.completed.set(event.verseKey,{audioEndSample,completedAtSample,occurrenceId});
    return this.pending;
  }

  /** Actual new speech clears preparation; late evidence from its old ayah does not. */
  acceptProgress(verseKey,audioEndSample) {
    if(!this.pending)return true;
    if(verseKey===this.pending.fromKey&&(!Number.isSafeInteger(audioEndSample)||audioEndSample<=this.pending.completedAtSample))return false;
    if(this.byKey.has(verseKey))this.pending=null;
    return true;
  }
}
