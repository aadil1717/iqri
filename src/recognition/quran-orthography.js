/**
 * @license MIT License
 * Copyright (c) 2026 Abdou
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import spelling from './uthmani-spelling.json' with { type: 'json' };
import { normalizeArabic } from '../tracker.js';

export const ORTHOGRAPHY_SOURCE = Object.freeze({
  sourceUrl:'https://huggingface.co/Abdou/quran-asr-small/resolve/004f898639f3127a74eac1b898a2cb3ef0b5268d/spelling.json',
  revision:'004f898639f3127a74eac1b898a2cb3ef0b5268d',
  sha256:'7adff00aa1d4b0413a3a89f898117682a22639624b3666121f6de785e0fb346a',
  license:'MIT',credit:'Copyright (c) 2026 Abdou',entries:2111,
  use:'Exact, one-step orthographic variants for canonical span matching and word alignment; never display-text rewriting.',
});

export const normalizeOrthographicWord=value=>normalizeArabic(value).replace(/ة/gu,'ه');
const forward=new Map(),inverse=new Map(),phraseStarts=new Map();
for(const [source,target] of Object.entries(spelling)){
  const from=normalizeOrthographicWord(source),to=normalizeOrthographicWord(target);
  if(!from||!to)continue;
  if(!forward.has(from))forward.set(from,new Set());
  forward.get(from).add(to);
  // Acoustic single-word aliases cannot change a model token's word boundary.
  if(!/\s/u.test(from)&&!/\s/u.test(to)){
    if(!inverse.has(to))inverse.set(to,new Set());inverse.get(to).add(from);
  }
  // The publisher also documents joined model words, for example يقوم → يا قوم.
  // Keep these as candidate-specific span edges, never standalone word aliases.
  if(!/\s/u.test(from)&&/\s/u.test(to)){
    const words=to.split(/\s+/u);
    if(!phraseStarts.has(words[0]))phraseStarts.set(words[0],[]);
    phraseStarts.get(words[0]).push({text:from,words});
  }
}

/**
 * Exact joined model spellings for a canonical word sequence. Indices are
 * 1-based and inclusive: one acoustic token consumes the entire indicated span.
 * Only entries explicitly present in the pinned publisher table are returned;
 * no arbitrary word joining, alif deletion, or transcript rewriting occurs.
 */
export function modelSpellingPhrases(canonicalWords){
  const words=canonicalWords.map(normalizeOrthographicWord),result=[];
  for(let index=0;index<words.length;index++){
    for(const phrase of phraseStarts.get(words[index])||[]){
      if(phrase.words.every((word,offset)=>words[index+offset]===word)){
        result.push({text:phrase.text,firstWordIndex:index+1,lastWordIndex:index+phrase.words.length});
      }
    }
  }
  return result;
}

/** Original plus an unambiguous exact publisher-table standard form. No chaining. */
export function sourceSpellingVariants(word){
  const normalized=normalizeOrthographicWord(word),forms=forward.get(normalized);
  return [...new Set([normalized,...(forms?.size===1?forms:[])])];
}

/** Known model spellings for one canonical word; canonical metadata stays intact. */
export function acousticWordVariants(canonicalWord){
  const canonical=normalizeOrthographicWord(canonicalWord);
  if(!canonical||/\s/u.test(canonical))return canonical?[canonical]:[];
  return [...new Set([canonical,...(inverse.get(canonical)||[])])];
}

/** Prefer a unique upstream Uthmani spelling; ambiguous inverses need context. */
export function preferredModelSpelling(canonicalWord){
  const canonical=normalizeOrthographicWord(canonicalWord),known=inverse.get(canonical);
  return known?.size===1?[...known][0]:canonical;
}

/** Exact/prefix evidence against verified variants; never fuzzy-correct a word. */
export function matchAcousticWord(observedWord,canonicalWord,{allowPrefix=true}={}){
  const observed=normalizeOrthographicWord(observedWord);
  if(!observed||/\s/u.test(observed))return null;
  const variants=acousticWordVariants(canonicalWord);
  const exact=variants.find(variant=>variant===observed);
  if(exact)return{variant:exact,quality:'word-detected'};
  const partial=allowPrefix?variants.find(variant=>variant.startsWith(observed)):null;
  return partial?{variant:partial,quality:'partial-word'}:null;
}

/**
 * Select source-side known spellings only when the complete normalized ayah
 * exactly equals the canonical character sequence. Unknown forms and ambiguous
 * word-boundary alignments fail. Canonical words are never table-rewritten.
 */
export function alignKnownSourceSpellings(sourceWords,canonicalCharacters){
  let states=new Map([[0,{path:[],count:1}]]);
  for(const word of sourceWords){
    const variants=word.allowKnownSpelling===false
      ? [normalizeOrthographicWord(word.text)] : sourceSpellingVariants(word.text);
    const forms=[...new Set(variants.map(text=>text.replace(/\s/gu,'')))];
    const next=new Map();
    for(const [offset,state] of states){
      for(const form of forms){
        if(!canonicalCharacters.startsWith(form,offset))continue;
        const end=offset+form.length;
        if(next.has(end)){next.get(end).count=Math.min(2,next.get(end).count+state.count);continue;}
        next.set(end,{path:[...state.path,{position:word.position,start:offset,end}],count:state.count});
      }
    }
    if(!next.size)return null;
    states=next;
  }
  const final=states.get(canonicalCharacters.length);
  return final?.count===1?final.path:null;
}
