import test from 'node:test';
import assert from 'node:assert/strict';
import { WordHighlightView } from '../src/word-view.js';

class Node {
  constructor() {
    this.children=[];this.dataset={};this.classes=new Set();this.attributes=new Map();this.replacements=0;
    this.classList={add:value=>this.classes.add(value),remove:value=>this.classes.delete(value)};
  }
  replaceChildren(...children){this.children=children;this.replacements++;}
  setAttribute(key,value){this.attributes.set(key,value);}
  removeAttribute(key){this.attributes.delete(key);}
}
const install = t => {
  const prior=Object.getOwnPropertyDescriptor(globalThis,'document');
  globalThis.document={createElement:()=>new Node(),createTextNode:text=>({textContent:text})};
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'document',prior);else delete globalThis.document;});
};
const progress = wordIndex => ({verseKey:'112:1',surah:112,ayah:1,wordIndex,canonicalWords:['قل','هو','الله','احد']});

test('Arabic highlighting works before any online meaning exists and preserves spans across updates', t => {
  install(t);
  const arabic=new Node(),meaning=new Node();
  const view=new WordHighlightView(arabic,meaning);
  view.setArabic('قُلْ هُوَ اللَّهُ أَحَدٌ','112:1');
  const original=[...arabic.children];
  view.apply(progress(1),'112:1');
  assert.ok(original[0].classes.has('current-word'));
  view.apply(progress(2),'112:1');
  assert.equal(original[0].classes.has('current-word'),false);
  assert.ok(original[2].classes.has('current-word'));
  view.setArabic('قُلْ هُوَ اللَّهُ أَحَدٌ','112:1');
  view.apply(progress(2),'112:1');
  assert.equal(arabic.replacements,1);
  assert.deepEqual(arabic.children,original);
});

test('English spans are created once per source response and only old/new classes change', t => {
  install(t);
  const arabic=new Node(),meaning=new Node();
  const view=new WordHighlightView(arabic,meaning);
  const words=['قل','هو','الله','احد'].map((arabic,index)=>({position:index+1,arabic,translation:`fixture${index}`}));
  view.setMeanings(words,'112:1');
  const original=[...meaning.children];
  view.apply(progress(1),'112:1');view.apply(progress(4),'112:1');
  view.setMeanings(words,'112:1');
  assert.equal(meaning.replacements,1);
  assert.equal(original[0].classes.has('current-word'),false);
  assert.ok(original[6].classes.has('current-word'));
  view.apply(null,'112:1');
  assert.equal(original[6].classes.has('current-word'),false);
});
