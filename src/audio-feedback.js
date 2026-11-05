/**
 * Microphone feedback adapted from WhimprFlow (MIT), pinned at
 * bb222a23563d076f50d8d068d3d0e1b8267c1a7a.
 * Copyright (c) 2026 WhimprFlow contributors
 * Full license: ../licenses/WhimprFlow-LICENSE.txt
 *
 * Six chronological RMS levels and perceptual gain:
 * https://github.com/Blueturboguy07/WhimprFlow/blob/bb222a23563d076f50d8d068d3d0e1b8267c1a7a/crates/whimpr-audio/src/lib.rs
 * Near-silent capture threshold:
 * https://github.com/Blueturboguy07/WhimprFlow/blob/bb222a23563d076f50d8d068d3d0e1b8267c1a7a/src-tauri/src/win.rs#L340-L350
 *
 * Iqri updates the meter once per received PCM chunk, and waits for sustained
 * near-silence before advising the user. This is a level meter and microphone
 * advisory, not voice activity detection or a gate on Quran recognition.
 */

const WAVE_BARS = 6;
const LEVEL_GAIN = 14;
const NEAR_SILENT_PEAK = 0.005;

/**
 * Feed mono PCM chunks in recording order. update(samples) returns
 * { levels, rms, peak, nearSilent }; levels contains six values in [0, 1],
 * oldest first. nearSilent means four seconds of near-silent audio by default;
 * it does not diagnose permissions or decide whether a person is speaking.
 * Call reset() when a recording starts or stops. No audio is retained.
 */
export class AudioFeedback {
  #levels = Array(WAVE_BARS).fill(0);
  #rms = 0;
  #peak = 0;
  #silentSamples = 0;
  #silentLimit;

  constructor({ sampleRate = 16000, silenceAfterMs = 4000 } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be a positive finite number');
    }
    if (!Number.isFinite(silenceAfterMs) || silenceAfterMs <= 0) {
      throw new RangeError('silenceAfterMs must be a positive finite number');
    }
    this.#silentLimit = sampleRate * silenceAfterMs / 1000;
  }

  reset() {
    this.#levels.fill(0);
    this.#rms = this.#peak = this.#silentSamples = 0;
    return this.#snapshot();
  }

  update(samples) {
    if (!samples || !Number.isSafeInteger(samples.length) || samples.length < 0) {
      throw new TypeError('samples must be a mono PCM array');
    }
    if (!samples.length) return this.#snapshot();

    let sumSquares = 0;
    let peak = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample)) throw new TypeError('PCM samples must be finite numbers');
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    this.#rms = Math.sqrt(sumSquares / samples.length);
    this.#peak = peak;
    this.#levels.shift();
    this.#levels.push(Math.min(1, this.#rms * LEVEL_GAIN));
    this.#silentSamples = peak < NEAR_SILENT_PEAK
      ? Math.min(this.#silentLimit, this.#silentSamples + samples.length)
      : 0;
    return this.#snapshot();
  }

  #snapshot() {
    return {
      levels: this.#levels.slice(),
      rms: this.#rms,
      peak: this.#peak,
      nearSilent: this.#silentSamples >= this.#silentLimit,
    };
  }
}
