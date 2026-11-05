import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const url='http://127.0.0.1:4317/';
async function ready(){try{const r=await fetch(url+'api/health',{signal:AbortSignal.timeout(1000)});const h=await r.json();return h.ok&&h.localRecognition;}catch{return false;}}
if(!await ready()){
  const log=openSync(path.join(root,'iqri-launch.log'),'a');
  const child=spawn(process.execPath,[path.join(root,'scripts/server.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log,log]});child.unref();
  let success=false;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,300));if(await ready()){success=true;break;}}
  if(!success){console.error('Iqri could not start. See iqri-launch.log in the app folder.');process.exitCode=1;}
}
if(await ready()){
  const browser=spawn('powershell.exe',['-NoProfile','-Command',"Start-Process 'http://127.0.0.1:4317/'"],{detached:true,windowsHide:true,stdio:'ignore'});browser.unref();
}
