class IqriMicrophone extends AudioWorkletProcessor {
  constructor(){super();this.pending=[];this.phase=0;this.source=[];this.outputSamples=0;}
  process(inputs){
    const input=inputs[0]?.[0];if(!input)return true;
    // Interpolate continuously across worklet blocks to the model's 16 kHz.
    for(const sample of input)this.source.push(sample);
    const ratio=sampleRate/16000;
    while(this.phase+1<this.source.length){const i=Math.floor(this.phase),f=this.phase-i;this.pending.push(this.source[i]*(1-f)+this.source[i+1]*f);this.phase+=ratio;}
    const consumed=Math.min(Math.floor(this.phase),this.source.length);this.source=this.source.slice(consumed);this.phase-=consumed;
    while(this.pending.length>=1600){
      // Keep the capture clock at exact 100 ms boundaries. Retain the tail;
      // worklet block sizes must not make recognition windows drift over time.
      const audio=new Float32Array(this.pending.splice(0,1600));let power=0;
      for(const sample of audio)power+=sample*sample;
      this.outputSamples+=audio.length;
      this.port.postMessage({audio,rms:Math.sqrt(power/audio.length),sampleEnd:this.outputSamples},[audio.buffer]);
    }
    return true;
  }
}
registerProcessor('iqri-microphone',IqriMicrophone);
