import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../src/mic-worklet.js',import.meta.url),'utf8');
for(const rate of [16000,44100,48000]){
  test(`worklet emits continuous 16 kHz sample timestamps from ${rate} Hz input`,()=>{
    const messages=[];let Worklet;
    const context=vm.createContext({
      AudioWorkletProcessor:class{constructor(){this.port={postMessage:value=>messages.push(value)};}},
      sampleRate:rate,Float32Array,
      registerProcessor:(name,Class)=>{assert.equal(name,'iqri-microphone');Worklet=Class;},
    });
    vm.runInContext(source,context);
    const processor=new Worklet();
    const total=Math.ceil(rate*2/128)*128;
    for(let offset=0;offset<total;offset+=128){
      const input=Float32Array.from({length:128},(_,index)=>Math.sin((offset+index)*2*Math.PI*220/rate)*.05);
      assert.equal(processor.process([[input]]),true);
    }
    let samples=0;
    for(const message of messages){
      samples+=message.audio.length;
      assert.equal(message.sampleEnd,samples);
      assert.ok(message.rms>0.02&&message.rms<0.05);
      assert.equal(message.audio.length,1600);
      for(let index=0;index<message.audio.length;index++){
        const expected=Math.sin((samples-message.audio.length+index)*2*Math.PI*220/16000)*.05;
        assert.ok(Math.abs(message.audio[index]-expected)<.00003,'Resampling must not drop or duplicate samples at packet boundaries');
      }
    }
    assert.ok(Math.abs(total/rate*16000-samples)<1601);
    assert.ok(messages.length>=19);
  });
}
