const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** A bounded ring and a single inference slot. Waiting audio replaces old audio. */
export class LiveAudioScheduler {
  constructor({ sampleRate = 16000, maxSeconds = 8, minimumSeconds = 1.5 } = {}) {
    this.sampleRate = sampleRate;
    this.capacity = Math.ceil(sampleRate * maxSeconds);
    this.minimumSamples = Math.ceil(sampleRate * minimumSeconds);
    this.ring = new Float32Array(this.capacity);
    this.active = null;
    this.serial = 0;
    this.epoch = 0;
    this.reset();
  }

  reset() {
    this.epoch++;
    this.writeAt = 0;
    this.count = 0;
    this.latestEnd = 0;
    this.lastEnergyEnd = 0;
    this.lastScheduledEnd = 0;
    this.lastScheduledEnergy = 0;
    this.finalEnergyEnd = 0;
    this.windowSeconds = 8;
    this.processingAverageMs = 400;
    this.lastAppliedClipEnd = -1;
    this.lastAppliedEvidenceEnd = -1;
    this.lastAppliedReference = null;
    this.lastAppliedMatchEnd = -1;
    // Keep the active slot until its promise settles, even across scope changes.
  }

  push(audio, { sampleEnd, rms = 0 } = {}) {
    if (!(audio instanceof Float32Array) || !audio.length) return false;
    const end = Number.isSafeInteger(sampleEnd) ? sampleEnd : this.latestEnd + audio.length;
    if (this.count && end <= this.latestEnd) return false;
    if (this.count && end - audio.length !== this.latestEnd) {
      // Never join audio across a dropped capture interval.
      this.count = 0;
      this.writeAt = 0;
    }
    const retained = audio.length > this.capacity ? audio.subarray(audio.length - this.capacity) : audio;
    const first = Math.min(retained.length, this.capacity - this.writeAt);
    this.ring.set(retained.subarray(0, first), this.writeAt);
    this.ring.set(retained.subarray(first), 0);
    this.writeAt = (this.writeAt + retained.length) % this.capacity;
    this.count = Math.min(this.capacity, this.count + retained.length);
    this.latestEnd = end;
    // Conservative low-energy gating only; amplitude is not voice identification.
    if (Number.isFinite(rms) && rms >= 0.002) this.lastEnergyEnd = end;
    return true;
  }

  take() {
    if (this.active || this.count < this.minimumSamples || !this.lastEnergyEnd) return null;
    const quietSamples = this.latestEnd - this.lastEnergyEnd;
    const finalPass = quietSamples >= this.sampleRate * 0.45;
    if (finalPass && this.finalEnergyEnd >= this.lastEnergyEnd) return null;
    if (!finalPass && this.lastEnergyEnd <= this.lastScheduledEnergy) return null;
    const hopSamples = this.sampleRate * clamp(this.processingAverageMs * 0.85, 400, 1500) / 1000;
    if (!finalPass && this.lastScheduledEnd && this.latestEnd - this.lastScheduledEnd < hopSamples) return null;
    const oldest = this.latestEnd - this.count;
    const endSample = finalPass
      ? Math.min(this.latestEnd, Math.max(oldest + this.minimumSamples, this.lastEnergyEnd + Math.round(this.sampleRate * 0.25)))
      : this.latestEnd;
    const startSample = Math.max(oldest, endSample - Math.round(this.windowSeconds * this.sampleRate));
    if (endSample - startSample < this.minimumSamples) return null;
    const audio = new Float32Array(endSample - startSample);
    const sourceAt = (this.writeAt - (this.latestEnd - startSample) + this.capacity) % this.capacity;
    const first = Math.min(audio.length, this.capacity - sourceAt);
    audio.set(this.ring.subarray(sourceAt, sourceAt + first));
    audio.set(this.ring.subarray(0, audio.length - first), first);
    const clip = {
      id: ++this.serial, epoch: this.epoch, audio, startSample, endSample,
      finalPass, windowSeconds: audio.length / this.sampleRate,
    };
    this.active = clip;
    this.lastScheduledEnd = this.latestEnd;
    this.lastScheduledEnergy = this.lastEnergyEnd;
    if (finalPass) this.finalEnergyEnd = this.lastEnergyEnd;
    return clip;
  }

  complete(clip, result, { applyResult = true } = {}) {
    if (this.active?.id !== clip.id) return;
    this.active = null;
    if (clip.epoch !== this.epoch) return;
    if (Number.isFinite(result?.processingMs) && result.processingMs >= 0) {
      this.processingAverageMs = 0.65 * this.processingAverageMs + 0.35 * result.processingMs;
    }
    if (!applyResult) return;
    this.windowSeconds = result?.status === 'matched' ? 4 : 8;
    if (result?.recommendedWindowSeconds === 4 || result?.recommendedWindowSeconds === 8) {
      this.windowSeconds = result.recommendedWindowSeconds;
    }
  }

  /** Compare audio time, never verse/word order: repeating earlier words is valid. */
  accept(clip, result) {
    if (clip.epoch !== this.epoch) return { accepted: false, reason: 'context-changed' };
    if (clip.endSample <= this.lastAppliedClipEnd) return { accepted: false, reason: 'older-audio' };
    const endMs = result?.wordProgress?.source === 'acoustic-ctc-alignment'
      ? result.wordProgress.estimatedAudioEndMs : undefined;
    const evidenceEnd = Number.isFinite(endMs)
      ? clamp(clip.startSample + Math.round(endMs * this.sampleRate / 1000), clip.startSample, clip.endSample)
      : null;
    if (evidenceEnd !== null && evidenceEnd <= this.lastAppliedEvidenceEnd) {
      return { accepted: false, reason: 'older-word-evidence' };
    }
    const reference = result?.status === 'matched' && Number.isInteger(result.surah) && Number.isInteger(result.ayah)
      ? (evidenceEnd !== null && /^\d+:\d+$/u.test(result.wordProgress.verseKey || '')
        ? result.wordProgress.verseKey : `${result.surah}:${result.ayah_end || result.ayah}`)
      : null;
    // A newer rolling buffer can still match its older portion. Without word
    // evidence, do not change references until that already-used speech is gone.
    // Initial acquisition and a wholly newer utterance remain eligible.
    if (reference && this.lastAppliedReference && reference !== this.lastAppliedReference &&
        evidenceEnd === null && clip.startSample < this.lastAppliedMatchEnd) {
      return { accepted: false, reason: 'overlapping-reference-without-word-evidence' };
    }
    this.lastAppliedClipEnd = clip.endSample;
    if (evidenceEnd !== null) this.lastAppliedEvidenceEnd = evidenceEnd;
    if (reference) {
      this.lastAppliedReference = reference;
      this.lastAppliedMatchEnd = evidenceEnd ?? clip.endSample;
    }
    return {
      accepted: true,
      ageMs: Math.max(0, (this.latestEnd - (evidenceEnd ?? clip.endSample)) * 1000 / this.sampleRate),
    };
  }
}
