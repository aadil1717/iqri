import { normalizeArabic } from '@tilawi/quran-asr';
import { preferredModelSpelling, modelSpellingPhrases } from './quran-orthography.js';

const NEG = -Infinity;
const add = (a,b) => a===NEG?b:b===NEG?a:Math.max(a,b)+Math.log1p(Math.exp(-Math.abs(a-b)));
const norm = text => normalizeArabic(text).replace(/[^\p{L}\s]/gu,'');

/** A lazy corpus trie shares prefixes without materializing every Quran suffix. */
export class QuranTrie {
  constructor(quran, tokenMap, {allCharacters=false,maxDepth=120}={}) {
    this.tokens=tokenMap;this.maxDepth=maxDepth;
    const ids=new Map([...tokenMap].map(([id,token])=>[token,id]));
    const chars=[],verses=[],words=[],starts=[],isStart=[];
    this.refs=quran.map(({surah,ayah})=>({surah,ayah}));
    for(const variant of [false,true]) {
      let previousSurah=0;
      for(let verseIndex=0;verseIndex<quran.length;verseIndex++) {
        const verse=quran[verseIndex];
        if(verse.surah!==previousSurah){chars.push(0);verses.push(verseIndex);words.push(0);isStart.push(0);previousSurah=verse.surah;}
        let text=norm(verse.text_clean||verse.text_uthmani);
        if(verse.surah!==1&&verse.ayah===1)text=text.replace(/^بسم الله الرحمن الرحيم\s+/u,'');
        const pieces=text.split(/\s+/).filter(Boolean);
        const phrases=variant?modelSpellingPhrases(pieces):[];
        for(let index=0;index<pieces.length;index++){
          const word=pieces[index];
          const phrase=phrases.filter(value=>value.firstWordIndex===index+1).sort((a,b)=>b.lastWordIndex-a.lastWordIndex)[0];
          const spelling=phrase?.text||(variant?preferredModelSpelling(word):word);
          const offset=chars.length;
          starts.push(offset,offset+1);
          const value=[30,...[...spelling].map(character=>ids.get(character)).filter(id=>id>0)];
          value.forEach((id,at)=>{chars.push(id);verses.push(verseIndex);words.push(phrase&&at>1?phrase.lastWordIndex:index+1);isStart.push(at<=1?1:0);});
          if(phrase)index=phrase.lastWordIndex-1;
        }
      }
    }
    this.chars=Uint8Array.from(chars);this.verses=Uint16Array.from(verses);this.words=Uint16Array.from(words);this.isStart=Uint8Array.from(isStart);
    this.starts=Int32Array.from(allCharacters?chars.flatMap((id,index)=>id?[index]:[]):starts);
    this.reset();
  }
  reset(){this.nodes=[{id:0,token:-1,parent:-1,depth:0,letters:0,spaces:0,ends:this.starts,children:null}];}
  children(node) {
    if(node.children)return node.children;
    const groups=new Map();
    if(node.depth<this.maxDepth)for(const position of node.ends){const token=this.chars[position];if(!token)continue;if(!groups.has(token))groups.set(token,[]);groups.get(token).push(position+1);}
    node.children=new Map();
    for(const [token,ends]of groups){const child={id:this.nodes.length,token,parent:node.id,depth:node.depth+1,
      letters:node.letters+(token===30?0:1),spaces:node.spaces+(token===30?1:0),ends:Int32Array.from(ends),children:null};
      this.nodes.push(child);node.children.set(token,child);}
    return node.children;
  }
  text(node){const ids=[];while(node.parent>=0){ids.push(node.token);node=this.nodes[node.parent];}return ids.reverse().map(id=>this.tokens.get(id)).join('').replaceAll('▁',' ').trim();}
}

/** Standard CTC prefix beam recurrences, restricted to actual corpus paths. */
export function decodeQuran(acoustic,trie,{beamSize=32,tokenBeam=8,beamThreshold=16,trimFrames=4,preferredSurah=null,previousReference=null}={}) {
  if(trie.nodes.length>30000)trie.reset();
  const started=performance.now();
  let beam=[{node:trie.nodes[0],pb:0,pn:NEG,vb:0,vn:NEG,eb:-1,en:-1,sb:-1,sn:-1}];
  const frames=Math.max(1,acoustic.timeSteps-trimFrames),vocab=acoustic.vocabSize;
  let greedyPath=0,nonblankFrames=0,peakedness=0;
  for(let frame=0;frame<frames;frame++){
    const offset=frame*vocab,values=acoustic.logprobs;
    const ordered=Array.from({length:vocab-1},(_,index)=>index+1).sort((a,b)=>values[offset+b]-values[offset+a]).slice(0,tokenBeam);
    const best=ordered[0];greedyPath+=Math.max(values[offset],values[offset+best]);
    if(values[offset+best]>values[offset]){nonblankFrames++;peakedness+=Math.exp(values[offset+best]);}
    const next=new Map();
    const put=(node,blank,prob,viterbi,end,start)=>{
      let state=next.get(node.id);if(!state){state={node,pb:NEG,pn:NEG,vb:NEG,vn:NEG,eb:-1,en:-1,sb:-1,sn:-1};next.set(node.id,state);}
      const p=blank?'pb':'pn',v=blank?'vb':'vn',e=blank?'eb':'en',s=blank?'sb':'sn';state[p]=add(state[p],prob);
      if(viterbi>state[v]){state[v]=viterbi;state[e]=end;state[s]=start;}
    };
    for(const state of beam){
      const total=add(state.pb,state.pn),fromBlank=state.vb>=state.vn;
      const v=fromBlank?state.vb:state.vn,end=fromBlank?state.eb:state.en,start=fromBlank?state.sb:state.sn;
      put(state.node,true,total+values[offset],v+values[offset],end,start);
      if(state.node.token>0)put(state.node,false,state.pn+values[offset+state.node.token],state.vn+values[offset+state.node.token],frame,state.sn);
      const children=trie.children(state.node);
      for(const token of ordered){
        const child=children.get(token);if(!child)continue;
        const repeated=token===state.node.token;
        put(child,false,(repeated?state.pb:total)+values[offset+token],(repeated?state.vb:v)+values[offset+token],frame,
          state.node.depth===0?frame:(repeated?state.sb:start));
      }
    }
    beam=[...next.values()].map(state=>({...state,score:add(state.pb,state.pn)})).sort((a,b)=>b.score-a.score);
    const bestScore=beam[0]?.score??NEG;beam=beam.filter(state=>state.score>=bestScore-beamThreshold).slice(0,beamSize);
  }
  const candidates=new Map();
  for(const state of beam){
    const node=state.node;if(node.letters<4)continue;
    const matchedText=trie.text(node);
    const fromBlank=state.vb>=state.vn,viterbi=fromBlank?state.vb:state.vn,endFrame=fromBlank?state.eb:state.en;
    const fit=Math.exp(-Math.max(0,greedyPath-viterbi)/Math.max(1,nonblankFrames));
    for(const end of node.ends){
      const start=end-node.depth;
      let lastLetter=end-1;while(lastLetter>start&&trie.chars[lastLetter]===30)lastLetter--;
      const verseId=trie.verses[lastLetter],reference=trie.refs[verseId];
      if(preferredSurah&&reference.surah!==Number(preferredSurah))continue;
      const startsAtWord=Boolean(trie.isStart[start]);
      if(node.letters<(startsAtWord?6:10)||node.spaces<(startsAtWord?1:2))continue;
      const completeWords=Math.max(0,node.spaces+(trie.chars[start]===30?0:1)-(startsAtWord?0:1)-([0,30].includes(trie.chars[end])?0:1));
      const candidate={...reference,score:state.score,acousticFit:fit,wordIndex:trie.words[lastLetter],startWordIndex:trie.words[start],
        startsAtWord,startsAtAyah:startsAtWord&&trie.words[start]===1,letters:node.letters,completeWords,
        matchedText,startFrame:fromBlank?state.sb:state.sn,endFrame,
        prefixNode:node.id};
      const key=`${reference.surah}:${reference.ayah}`,prior=candidates.get(key);
      if(!prior||candidate.score>prior.score+.01||(Math.abs(candidate.score-prior.score)<=.01&&candidate.startsAtAyah&&!prior.startsAtAyah))candidates.set(key,candidate);
    }
  }
  const preference=value=>(previousReference&&value.surah===Number(previousReference.surah)?2:0)+
    (value.startsAtAyah?1:(value.startsAtWord&&value.startWordIndex<=2?.5:0));
  const ranked=[...candidates.values()].sort((a,b)=>Math.abs(a.score-b.score)>.05?b.score-a.score:
    preference(b)-preference(a)||a.surah-b.surah||a.ayah-b.ayah);
  const top=ranked[0],near=top?ranked.filter(candidate=>candidate.score>=top.score-2.5):[];
  return {usable:Boolean(top&&top.acousticFit>=.9&&top.letters>=10&&top.completeWords>=2&&nonblankFrames>=6&&peakedness/Math.max(1,nonblankFrames)>=.4),
    processingMs:performance.now()-started,nodes:trie.nodes.length,frames,nonblankFrames,
    peakedness:peakedness/Math.max(1,nonblankFrames),greedyPath,
    best:top||null,candidates:near.slice(0,12),candidateCount:near.length,
    margin:ranked.length>1?ranked[0].score-ranked[1].score:null,all:ranked.slice(0,12)};
}

/** Early likely locations are deliberately separate from confirmed recognition. */
export function createTentativeDecoder(quran,tokens,{sharedTrie=null,maxObservationGap=.8}={}) {
  // This decoder targets the pinned 31-symbol Arabic character model. Other
  // tokenization schemes keep their existing recognition path.
  if(tokens.size!==31||tokens.get(30)!=='▁'||tokens.get(2)!=='ا')return{observe:()=>({event:null}),reset(){}};
  const trie=sharedTrie||new QuranTrie(quran,tokens);
  let previous=null,lastEmittedEnd=-1;
  return {
    trie,
    observe(acoustic,{clipStartSample,audioLength,throughSample,context={},anchor=null}) {
      const result=decodeQuran(acoustic,trie,{preferredSurah:context.preferredSurah,
        previousReference:anchor?.wordIndex?anchor:null});
      const best=result.best;
      if(!result.usable||result.candidateCount>6){previous=null;return{result,event:null};}
      const key=`${best.surah}:${best.ayah}`;
      const audioEndSample=clipStartSample+Math.round((best.endFrame+1)*audioLength/acoustic.timeSteps);
      const text=best.matchedText.replace(/\s/gu,'');
      const overlap=previous&&(text.includes(previous.text)||previous.text.includes(text)||
        Array.from({length:Math.max(0,Math.min(text.length,previous.text.length)-7)},(_,index)=>index+8)
          .some(length=>text.startsWith(previous.text.slice(-length))||previous.text.startsWith(text.slice(-length))));
      const agrees=previous?.key===key&&throughSample>previous.through&&throughSample-previous.through<=16000*maxObservationGap&&
        audioEndSample>=previous.end-16000*.12&&overlap;
      const count=agrees?previous.count+1:1;
      previous={key,text,through:throughSample,end:audioEndSample,count};
      const required=anchor?.wordIndex&&anchor.surah!==best.surah?3:2;
      if(count<required||audioEndSample<=lastEmittedEnd)return{result,event:null};
      lastEmittedEnd=audioEndSample;
      return{result,event:{type:'tentative',audioEndSample,
        candidate:{surah:best.surah,ayah:best.ayah,score:best.acousticFit},
        candidates:result.candidates.map(value=>({surah:value.surah,ayah:value.ayah,score:value.acousticFit})),
        reason:result.candidateCount>1?'shared-phrase':'partial-match'}};
    },
    reset(){previous=null;lastEmittedEnd=-1;},
  };
}
