/** A presentation-only hypothesis. It never supplies a recognition anchor. */
export class LikelyMatch {
  constructor(verses) { this.keys=new Set(verses.map(v=>`${v.surah}:${v.ayah}`));this.reset(); }
  reset() { this.pending=null;this.confirmedKey=null;this.confirmedAt=-1; }
  clear() { this.pending=null; }
  offer(event,{scope=null,prepared=null}={}) {
    const candidate=event?.candidate;let key=candidate?`${candidate.surah}:${candidate.ayah}`:'';
    const end=event?.audioEndSample;
    if(!this.keys.has(key)||!Number.isSafeInteger(end)||end<0||
      (scope&&candidate.surah!==scope)||end<=this.confirmedAt||
      (this.pending&&end<=this.pending.audioEndSample))return null;
    if(prepared&&key===prepared.fromKey&&end<=prepared.completedAtSample)return null;
    // A weaker reading of the same words cannot unconfirm an established ayah.
    if(key===this.confirmedKey)return null;
    const candidates=[candidate,...(Array.isArray(event.candidates)?event.candidates:[])].filter(c=>c&&Number.isInteger(c.surah)&&Number.isInteger(c.ayah));
    const incumbent=this.pending&&candidates.find(c=>`${c.surah}:${c.ayah}`===this.pending.key);
    // Extra audio can leave the same shared phrase acoustically tied. Keep
    // its existing card rather than flickering to another equivalent location.
    if(incumbent&&Number.isFinite(incumbent.score)&&Number.isFinite(candidate.score)&&
      Math.abs(incumbent.score-candidate.score)<.001)key=this.pending.key;
    const keys=[...new Set(candidates.map(c=>`${c.surah}:${c.ayah}`))]
      .filter(k=>this.keys.has(k)&&(!scope||Number(k.split(':')[0])===scope));
    this.pending={key,keys,audioEndSample:end,reason:event.reason};
    return this.pending;
  }
  confirm(key,end,{commit=true}={}) {
    if(Number.isSafeInteger(end)&&end<this.confirmedAt)return false;
    // Late evidence for the previous ayah must not pull a newer preview back.
    if(this.pending&&key!==this.pending.key&&(!Number.isSafeInteger(end)||end<=this.pending.audioEndSample))return false;
    if(commit){
      this.pending=null;this.confirmedKey=key;
      if(Number.isSafeInteger(end))this.confirmedAt=Math.max(this.confirmedAt,end);
    }
    return true;
  }
}
