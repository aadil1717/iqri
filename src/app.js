import { VerseTracker } from './tracker.js';
import { fetchWords, WORD_MEANINGS_SOURCE } from './word-meanings.js';
import { WordHighlightView } from './word-view.js';
import { LiveAudioScheduler } from './live-audio.js';
import { AudioFeedback } from './audio-feedback.js';
import { LiveStreamController } from './live-stream.js';
import { prepareBrowserAcceleration } from './browser-acceleration.js';
import { AyahPreparation } from './ayah-preparation.js';
import { LikelyMatch } from './likely-match.js';
import { isNativeApp, recognitionAssetOptions, unlockAudioContext, microphoneErrorMessage, registerNativeLifecycle } from './native-platform.js';

const $ = id => document.getElementById(id);
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`iqri:${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`iqri:${key}`, JSON.stringify(value)); } catch {} }
};
const state = {
  catalog: null, verses: [], byKey: new Map(), translation: {}, translationId: '',
  language: storage.get('language', 'en'), englishEdition: storage.get('englishEdition', 'en-itani-allah'),
  key: storage.get('lastAyah', '1:1'), scope: null, bookmarks: storage.get('bookmarks', []),
  showArabic: Boolean(storage.get('showArabic', false)), showTranslation: storage.get('showTranslation', true) !== false,
  autoFollow: storage.get('autoFollow', true) !== false, fontSize: Math.max(24, Math.min(48, Number(storage.get('fontSize', 34)) || 34)),
  listening: false, initializing: false, preview: false, engine: null, local: false, worker: null,
  tracker: null, previousReference: null, stream: null, audioContext: null, worklet: null,
  inFlight: false, generation: 0, requestId: 0,
  waiters: new Map(), translationGeneration: 0, contextVersion: 0,
  wordMode:storage.get('wordMode',true)!==false, wordProgress:null, wordData:[], wordKey:'', wordLoadingKey:'', wordError:'',wordRequestVersion:0,
  wordFailures:0, wordRetryAt:0, lastRenderedKey:'', lastRenderedEntry:null, lastRenderedLanguage:'', lastRenderedEdition:'',
  details:null, nearSilent:false, workerThreads:1, workerIsolated:false, prefetchedAfterKey:'',
  streaming:false, liveStream:null, preparation:null, likely:null, transcript:''
};
const scheduler = new LiveAudioScheduler();
const audioFeedback = new AudioFeedback();
const wordView = new WordHighlightView($('arabic-text'), $('word-meaning'));
const acousticSources = new Set(['acoustic-ctc-alignment','acoustic-ctc-small','streaming-phoneme-alignment']);
if (!Array.isArray(state.bookmarks)) state.bookmarks = [];
let toastTimer, previewTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
function feedback(message) { $('listen-feedback').textContent = message; }
async function json(url, options) { const response = await fetch(url, options); if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`); return response.json(); }
function dialog(id) { $(id).showModal(); }
function titleFor(key) { const [surah, ayah] = key.split(':').map(Number); return `${state.catalog.surahs.find(s => s.id === surah)?.name ?? surah} · ${surah}:${ayah}`; }
function plainText(value) {
  // Some attributed publisher footnotes contain formatting tags. Display as text;
  // untrusted source data is never inserted into the document as live HTML.
  const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
  return doc.body.textContent || '';
}
function selectedEdition() { return state.catalog?.translations.find(t => t.id === state.translationId); }
function setVerse(key, {matched = false, preview = false, tentative = false} = {}) {
  if (!state.byKey.has(key)) return;
  if(state.likely?.pending&&key!==state.likely.pending.key&&!tentative)state.likely.clear();
  const prepared = state.preparation?.pending;
  if(prepared && key !== (prepared.key || prepared.fromKey))state.preparation.clear();
  const changed = state.key !== key;
  if(changed){state.wordRequestVersion++;state.wordLoadingKey='';state.wordData=[];state.wordKey='';state.wordFailures=0;state.wordRetryAt=0;}
  if(!matched&&!preview)state.wordProgress=null;
  state.key = key;
  if (changed&&!tentative) storage.set('lastAyah', key);
  const verse = state.byKey.get(key);
  const entry = state.translation[key];
  if (state.lastRenderedKey !== key || state.lastRenderedEntry !== entry ||
      state.lastRenderedLanguage !== state.language || state.lastRenderedEdition !== state.translationId) {
    const surah = state.catalog.surahs.find(s => s.id === verse.surah);
    $('surah-title').textContent = surah.name;
    $('ayah-reference').textContent = `${verse.surah}:${verse.ayah}`;
    $('verse-position').textContent = `AYAH ${verse.ayah} OF ${surah.versesCount}`;
    wordView.setArabic(verse.text_uthmani, key);
    $('translation-text').lang = state.language;
    $('translation-text').textContent = state.language === 'ti' ? 'A verified Tigrinya translation is not available yet.' : (entry?.text || 'Loading translation…');
    $('footnote-text').textContent = plainText(entry?.footnotes);
    $('edition-button').textContent = selectedEdition()?.title || '';
    $('translation-label').textContent = selectedEdition()?.version && selectedEdition().version !== 'n/a' ? `Translation of the meaning · Source version ${selectedEdition().version}` : 'Translation of the meaning';
    const index = state.verses.indexOf(verse);
    $('previous-verse').disabled = index === 0;
    $('next-verse').disabled = index === state.verses.length - 1;
    state.lastRenderedKey=key;state.lastRenderedEntry=entry;state.lastRenderedLanguage=state.language;state.lastRenderedEdition=state.translationId;
  }
  $('verse-state-text').textContent = preview ? 'GUIDED PREVIEW · MICROPHONE OFF' : matched ? 'FOLLOWING YOUR RECITATION' : 'YOUR READING SPACE';
  document.querySelector('.reader').classList.toggle('is-matched', matched || preview);
  $('save-verse').setAttribute('aria-pressed', String(state.bookmarks.includes(key)));
  $('save-verse').setAttribute('aria-label', state.bookmarks.includes(key) ? 'Remove current ayah from saved ayahs' : 'Save current ayah');
  updateWordView();
  renderPreparedAyah();
  renderLikelyMatch();
}
function renderLikelyMatch() {
  const likely=state.likely?.pending,visible=Boolean(likely&&state.listening&&state.autoFollow&&state.key===likely.key);
  document.querySelector('.reader').classList.toggle('is-tentative',visible);
  if(!visible)return false;
  document.querySelector('.reader').classList.remove('is-matched');
  $('verse-state-text').textContent='LIKELY MATCH · STILL LISTENING';
  $('transcript-state').textContent=`Likely ${likely.key}`;
  $('listen-title').textContent='Your likely place.';
  $('listen-description').textContent=likely.keys.length>1?'These opening words occur in more than one ayah. Keep reciting to confirm.':'Keep reciting to confirm this ayah and follow each word.';
  feedback(`${titleFor(likely.key)} · Tentative${likely.keys.length>1?` · Also possible: ${likely.keys.filter(k=>k!==likely.key).slice(0,4).join(', ')}`:''}`);
  return true;
}
function showTentative(event,metadata) {
  if(!currentStream(metadata)||!state.listening||state.preview||!state.autoFollow)return;
  const likely=state.likely.offer(event,{scope:state.scope,prepared:state.preparation?.pending});
  if(!likely)return;
  state.preparation.clear();state.wordProgress=null;$('ambiguity').hidden=true;
  setVerse(likely.key,{tentative:true});
}
function nextRecitationKey(key) {
  const verse=state.byKey.get(key),index=state.verses.indexOf(verse),next=state.verses[index+1];
  return next&&(!state.scope||next.surah===state.scope)?`${next.surah}:${next.ayah}`:null;
}
function renderTranscript(text=state.transcript) {
  state.transcript=typeof text==='string'?text.slice(-1000):'';
  $('transcript-panel').hidden=!state.listening&&!state.initializing;
  $('live-transcript').textContent=state.transcript;
  $('live-transcript').hidden=!state.transcript;
  $('transcript-placeholder').hidden=Boolean(state.transcript);
}
function waitingForReference(ambiguous=false) {
  state.wordProgress=null;applyWordHighlight();
  $('transcript-state').textContent=ambiguous?'More context needed':'Finding your ayah';
  $('listen-title').textContent=ambiguous?'Keep reciting for an exact match.':'Finding your place…';
  $('listen-description').textContent='Matching the Arabic words you recite to the Quran.';
}
function renderPreparedAyah() {
  const prepared=state.preparation?.pending;
  if(!prepared||!state.listening||!state.autoFollow||state.key!==(prepared.key||prepared.fromKey))return false;
  document.querySelector('.reader').classList.remove('is-matched');
  if(prepared.kind==='next'){
    $('transcript-state').textContent=`Ready for ${prepared.key}`;
    $('verse-state-text').textContent='READY FOR YOUR NEXT AYAH';
    $('listen-title').textContent='Your next ayah is ready.';
    $('listen-description').textContent='Take your time. The words will highlight when you recite.';
    feedback(`${titleFor(prepared.fromKey)} complete · ${titleFor(prepared.key)} is ready when you are.`);
  }else{
    $('transcript-state').textContent='Ayah complete';
    const label=prepared.end==='quran'?'Final ayah complete':'Surah complete';
    $('verse-state-text').textContent=label.toUpperCase();
    $('listen-title').textContent=label+'.';
    $('listen-description').textContent=prepared.end==='surah'?'Choose another surah, or switch to finding your place anywhere.':'You can repeat an ayah or choose another place to recite.';
    feedback(`${titleFor(prepared.fromKey)} complete. ${$('listen-description').textContent}`);
  }
  return true;
}
function prepareNextAyah(event,metadata) {
  if(!currentStream(metadata)||!state.listening||!state.autoFollow||state.preview)return;
  const previous=state.previousReference;
  const recognizedKey=previous?`${previous.surah}:${previous.ayah}`:null;
  const prepared=state.preparation.complete(event,{currentKey:state.key,recognizedKey,scope:state.scope});
  if(!prepared)return;
  state.likely.clear();
  // A prepared verse is presentation only: retain the last heard reference
  // and the recognizer's continuous session until new speech identifies it.
  state.wordProgress=null;
  setVerse(prepared.key||prepared.fromKey);
  applyWordHighlight();
}
function updateDisplay() {
  $('show-arabic').checked = state.showArabic; $('show-translation').checked = state.showTranslation;
  $('arabic-text').hidden = !state.showArabic; $('translation-text').hidden = !state.showTranslation;
  $('hidden-message').hidden = state.showArabic || state.showTranslation;
  document.querySelector('.edition-credit').hidden = !state.showTranslation || state.language === 'ti';
  $('footnotes').hidden = !state.translation[state.key]?.footnotes || !state.showTranslation || state.language === 'ti';
  document.documentElement.style.setProperty('--text-size', `${state.fontSize}px`);
  const wordView=state.wordMode&&state.language==='en';
  $('word-mode').classList.toggle('selected',wordView);$('word-mode').setAttribute('aria-pressed',String(wordView));
  $('ayah-mode').classList.toggle('selected',!wordView);$('ayah-mode').setAttribute('aria-pressed',String(!wordView));
  $('word-mode').disabled=state.language!=='en';$('word-mode').title=state.language==='en'?'Follow the meaning of each recognized Arabic word':'Word-level meanings are currently available in English';
  $('word-meaning').hidden=!(wordView&&state.showTranslation&&state.wordKey===state.key&&state.wordData.length);
  $('word-caption').hidden=!(wordView&&state.showTranslation);
  $('translation-text').classList.toggle('parallel-translation',!$('word-meaning').hidden);
}
function updateWordView() {
  updateDisplay();
  // Local Arabic progress must never wait for the online English gloss request.
  applyWordHighlight();
  if(!(state.wordMode&&state.language==='en'&&state.showTranslation))return;
  if(state.wordKey===state.key&&state.wordData.length)return;
  if(state.wordLoadingKey===state.key)return;
  if (Date.now() < state.wordRetryAt) return;
  const key=state.key,version=state.wordRequestVersion;state.wordLoadingKey=key;state.wordData=[];state.wordKey='';state.wordError='';
  $('word-meaning').hidden=true;$('word-caption').textContent='Loading word-by-word meaning…';$('word-caption').classList.add('empty');
  fetchWords(key).then(words=>{
    if(state.key!==key||version!==state.wordRequestVersion)return;
    state.wordData=words;state.wordKey=key;state.wordLoadingKey='';state.wordFailures=0;state.wordRetryAt=0;renderWordMeanings();
  }).catch(()=>{
    if(state.key!==key||version!==state.wordRequestVersion)return;
    state.wordLoadingKey='';state.wordFailures++;state.wordRetryAt=Date.now()+Math.min(60000,3000*2**(state.wordFailures-1));
    state.wordError='Word meanings could not load. Arabic and the full translation remain available. ';
    $('word-caption').replaceChildren(document.createTextNode(state.wordError));$('word-caption').classList.add('empty');
    const retry=document.createElement('button');retry.type='button';retry.className='text-button';retry.textContent='Try again';
    retry.onclick=()=>{state.wordRetryAt=0;updateWordView();};$('word-caption').append(retry);
  });
}
function renderWordMeanings(){
  if(state.wordKey!==state.key)return;
  wordView.setMeanings(state.wordData,state.key);
  $('word-caption').replaceChildren(document.createTextNode('Word-by-word meaning · '));
  const source=document.createElement('a');source.href=`https://quran.com/${state.key.replace(':','/')}`;source.target='_blank';source.rel='noopener';source.textContent='Quran.com';$('word-caption').append(source,document.createTextNode(' · Full translation below'));
  $('word-caption').classList.remove('empty');updateDisplay();applyWordHighlight();
}
function applyWordHighlight(){
  wordView.apply(state.wordProgress,state.key);
}
async function setLanguage(language) {
  if (!['en','es','ti','zh'].includes(language)) language = 'en';
  const generation = ++state.translationGeneration;
  state.language = language; storage.set('language', language);
  document.querySelectorAll('[data-language]').forEach(button => { const selected = button.dataset.language === language; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  const edition = language === 'en' ? state.catalog.translations.find(t => t.id === state.englishEdition && t.language === 'en') || state.catalog.translations[0] : state.catalog.translations.find(t => t.language === language);
  state.translationId = edition.id; state.translation = {};
  $('language-notice').hidden = language !== 'ti';
  if (language === 'ti') $('language-notice').textContent = 'Tigrinya is planned. We have not verified a complete, attributed translation with reuse permission. Choose another language to follow the meaning; Arabic remains available independently.';
  setVerse(state.key);
  if (!edition.available) return;
  try {
    const data = await json(`/data/${edition.id}.json`);
    if (generation !== state.translationGeneration) return;
    state.translation = data; setVerse(state.key, {matched: state.listening && Boolean(state.previousReference), preview: state.preview});
  } catch (error) {
    if (generation !== state.translationGeneration) return;
    $('translation-text').textContent = 'This translation could not be loaded. Check your connection and choose the language again.';
    toast('Translation unavailable. Please try again.');
  }
}
function updateScope(surah) {
  state.scope = surah; state.contextVersion++; state.previousReference = null; state.tracker.setScope(surah);state.tracker.reset();state.wordProgress=null;clearAudio();applyWordHighlight(); $('ambiguity').hidden=true;
  const selected = state.catalog.surahs.find(s => s.id === surah);
  $('scope-label').textContent = selected ? `Listening in ${selected.name}` : 'Find my place anywhere';
  $('scope-hint').textContent = selected ? `Start at any of its ${selected.versesCount} ayahs` : 'All 114 surahs';
  if((state.listening||state.initializing)&&state.streaming)restartStreaming().catch(()=>{});
}
let browseMode = 'browse';
function openBrowse(mode) { browseMode = mode; $('browse-title').textContent = mode === 'scope' ? 'Where would you like to recite?' : 'Explore the Quran'; $('scope-anywhere').hidden = mode !== 'scope'; $('surah-search').value = ''; renderSurahs(); dialog('browse-dialog'); }
function renderSurahs() {
  const query = $('surah-search').value.trim().toLowerCase();
  const reference = /^(\d{1,3})\s*[:.]\s*(\d{1,3})$/.exec(query);
  const root = $('surah-list'); root.replaceChildren();
  const items = reference ? state.catalog.surahs.filter(s => s.id === Number(reference[1])) : state.catalog.surahs.filter(s => !query || `${s.id} ${s.name} ${s.nameArabic} ${s.meaning}`.toLowerCase().includes(query));
  for (const surah of items) {
    const target = reference ? `${surah.id}:${Number(reference[2])}` : `${surah.id}:1`;
    if (!state.byKey.has(target)) continue;
    const button = document.createElement('button'); button.className = 'surah-choice';
    const number = document.createElement('span'); number.className = 'surah-number'; number.textContent = surah.id;
    const info = document.createElement('span'); info.className = 'surah-info'; const name = document.createElement('span'); name.textContent = surah.name; const description = document.createElement('small'); description.textContent = `${surah.meaning} · ${reference ? `Ayah ${reference[2]}` : `${surah.versesCount} ayahs`}`; info.append(name, description);
    const arabic = document.createElement('span'); arabic.className = 'surah-arabic'; arabic.lang = 'ar'; arabic.textContent = surah.nameArabic;
    button.append(number, info, arabic); button.onclick = () => {
      stopPreview();
      if (browseMode === 'scope') {
        updateScope(surah.id);
        if (reference) setVerse(target);
        feedback(`Recite from any ayah in ${surah.name}. Iqri will find your place.`);
      } else {state.preparation?.clear();state.likely.clear();setVerse(target);}
      $('browse-dialog').close();
    };
    root.append(button);
  }
  if (!root.children.length) { const p = document.createElement('p'); p.className = 'help-text'; p.textContent = 'No matching surah or valid ayah reference.'; root.append(p); }
}
function renderSaved() {
  const root = $('saved-list'); root.replaceChildren();
  $('saved-count').textContent = state.bookmarks.length;
  if (!state.bookmarks.length) { const p = document.createElement('p'); p.className = 'help-text'; p.textContent = 'Keep an ayah close. Use the bookmark button on the reading card to save it here.'; root.append(p); }
  for (const key of state.bookmarks.filter(k => state.byKey.has(k)).slice().reverse()) {
    const button = document.createElement('button'); button.className = 'saved-item';
    const title = document.createElement('strong'); title.textContent = titleFor(key); const excerpt = document.createElement('p'); excerpt.textContent = state.translation[key]?.text || state.byKey.get(key).text_uthmani;
    button.append(title, excerpt); button.onclick = () => { stopPreview(); state.preparation?.clear();state.likely.clear();setVerse(key); $('saved-dialog').close(); }; root.append(button);
  }
}
function renderSources() {
  const root = $('source-list');
  for (const edition of state.catalog.translations) {
    const item = document.createElement('div'); item.className = 'source-item'; const link = document.createElement('a'); link.textContent = edition.title; link.href = edition.sourceUrl || '#'; link.target = '_blank'; link.rel = 'noopener';
    const text = document.createElement('p'); text.textContent = `${edition.description || ''} ${edition.available ? `${edition.credit || edition.author}. ${edition.version && edition.version !== 'n/a' ? `Version ${edition.version}. ` : ''}${edition.license}` : 'Verified complete dataset not yet available.'}`;
    item.append(link, text); root.append(item);
  }
  const item=document.createElement('div');item.className='source-item';const link=document.createElement('a');link.href=WORD_MEANINGS_SOURCE.sourceUrl;link.target='_blank';link.rel='noopener';link.textContent=WORD_MEANINGS_SOURCE.title;const text=document.createElement('p');text.textContent='Live word-by-word learning meanings, separate from the five full translation editions. Requested per ayah and held in memory only. The verse reference is sent to Quran.com; your audio is not.';item.append(link,text);root.append(item);
}
function clearAudio() { scheduler.reset();audioFeedback.reset();state.preparation?.clear();state.likely?.reset();renderLikelyMatch();renderTranscript('');$('transcript-state').textContent='Listening';state.nearSilent=false;state.prefetchedAfterKey='';renderRecognitionDetails(); }
function context() { return {preferredSurah: state.scope || undefined, previousReference: state.previousReference || undefined}; }
function workerRequest(type, values = {}) {
  if(!state.worker)return Promise.reject(new Error('Voice recognition stopped. Tap Start reciting to restart it.'));
  return new Promise((resolve, reject) => {
    const id = ++state.requestId;
    const timeout = setTimeout(() => { state.waiters.delete(id); reject(new Error('Voice recognition took too long. Please stop and try again.')); }, type === 'load' ? 240000 : 90000);
    state.waiters.set(id, {resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); }, type});
    state.worker.postMessage({type, id, ...values}, values.audio ? [values.audio.buffer] : []);
  });
}
let enginePromise;
async function ensureEngine() {
  if (state.engine) return;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    feedback(state.local ? 'Preparing voice recognition on your laptop…' : isNativeApp() ? 'Opening the voice model included with Iqri…' : 'Preparing recognition on this device. The first use downloads the voice model.');
    $('model-progress').hidden = state.local;
    if (state.local) {
      const response = await fetch('/api/load', {method:'POST'}); const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not start local voice recognition.');
      state.streaming=result.streaming===true;
      state.engine = 'local';
    } else {
      const worker = state.worker ||= new Worker('/recognition-worker.js', {type:'module'});
      worker.onmessage = ({data}) => {
        if(state.worker!==worker)return;
        if (data.type === 'progress') { feedback(isNativeApp() && data.phase === 'download' ? 'Opening the included voice model…' : data.message); if (data.loaded) $('model-progress').value = Math.min(100, data.loaded / data.total * 100); return; }
        if (data.type === 'ready') {
          state.workerThreads=Number.isInteger(data.threads)?data.threads:1;state.workerIsolated=data.crossOriginIsolated===true;state.streaming=data.streaming===true;renderRecognitionDetails();
          for (const [id, waiter] of state.waiters) if (waiter.type === 'load') { state.waiters.delete(id); waiter.resolve(data); }
        } else if (data.type === 'result') { state.waiters.get(data.id)?.resolve(data.prediction); state.waiters.delete(data.id); }
        else if (data.type === 'stream-started'||data.type === 'stream-result') {state.waiters.get(data.id)?.resolve(data);state.waiters.delete(data.id);}
        else if (data.type === 'error') {
          if (data.id) { state.waiters.get(data.id)?.reject(new Error(data.message)); state.waiters.delete(data.id); }
          else for (const [id, waiter] of state.waiters) { waiter.reject(new Error(data.message)); state.waiters.delete(id); }
        } else if (data.type === 'busy') { state.waiters.get(data.id)?.reject(new Error('Voice recognition is finishing the previous segment.')); state.waiters.delete(data.id); }
      };
      worker.onerror = () => {
        if(state.worker!==worker)return;
        for (const waiter of state.waiters.values()) waiter.reject(new Error(isNativeApp()
          ? 'This device could not start voice recognition. Close and reopen Iqri, then try again.'
          : 'This browser could not start voice recognition. Update Safari or your browser, then try again.'));
        state.waiters.clear();state.worker?.terminate();state.worker=null;state.engine=null;enginePromise=null;
      };
      await workerRequest('load', recognitionAssetOptions()); state.engine = 'browser';
    }
    $('model-progress').hidden = true;
  })().catch(error => { enginePromise = null; $('model-progress').hidden = true; throw error; });
  return enginePromise;
}
async function recognize(audio, recognitionContext = context()) {
  if (state.local) {
    const params = new URLSearchParams(); if (recognitionContext.preferredSurah) params.set('preferredSurah', recognitionContext.preferredSurah); if (recognitionContext.previousReference) params.set('previousReference', `${recognitionContext.previousReference.surah}:${recognitionContext.previousReference.ayah}`);
    const response = await fetch(`/api/transcribe?${params}`, {method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:audio});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Recognition failed. Please try again.'); return data.prediction;
  }
  return workerRequest('transcribe', {audio, context: recognitionContext});
}
async function streamRequest(type,values) {
  if(!state.local)return workerRequest(type,values);
  const route=type.replace('stream-','');
  let url=`/api/stream/${route}`,body,headers;
  if(type==='stream-feed'){
    url+=`?${new URLSearchParams({sessionId:values.sessionId,startSample:values.startSample,endSample:values.endSample})}`;
    body=values.audio;headers={'Content-Type':'application/octet-stream'};
  }else{body=JSON.stringify(values);headers={'Content-Type':'application/json'};}
  const response=await fetch(url,{method:'POST',headers,body});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Live recognition could not continue. Please start again.');
  return result;
}
function currentStream(metadata) {
  return metadata.generation===state.generation&&metadata.contextVersion===state.contextVersion&&(state.listening||state.initializing);
}
function markFindingPlace() {
  state.likely?.reset();renderLikelyMatch();
  state.wordProgress=null;applyWordHighlight();
  $('transcript-state').textContent='Finding your ayah';
  $('verse-state-text').textContent='FINDING YOUR PLACE';document.querySelector('.reader').classList.remove('is-matched');
}
async function restartStreaming() {
  if(!state.streaming)return;
  state.liveStream ||= new LiveStreamController({
    request:streamRequest,
    onPrediction:(prediction,metadata)=>{if(currentStream(metadata)&&state.listening)showPrediction(prediction,metadata);},
    onAyahComplete:prepareNextAyah,
    onTentative:showTentative,
    onTranscript:(text,metadata)=>{if(currentStream(metadata)&&state.listening)renderTranscript(text);},
    onMetrics:(metrics,metadata)=>{
      if(!currentStream(metadata))return;
      if(metrics.processingMs>0||!state.details)state.details={...metrics,streaming:true,searchTier:'tracking'};
      renderRecognitionDetails();
    },
    onRecovery:(reason,metadata)=>{
      if(!currentStream(metadata))return;
      state.previousReference=null;state.preparation.clear();state.tracker.reset();markFindingPlace();
      renderTranscript('');
      feedback('Iqri is catching up. Keep reciting while it finds your place again.');
    },
    onError:(error,metadata)=>{if(currentStream(metadata))stopListening(error.message);},
  });
  markFindingPlace();
  await state.liveStream.start(context(),{generation:state.generation,contextVersion:state.contextVersion});
}
function showPrediction(prediction,metadata={}) {
  if(prediction.status!=='matched'&&renderLikelyMatch())return;
  $('ambiguity').hidden = true;
  if (prediction.status === 'silence') { if(renderPreparedAyah())return; $('verse-state-text').textContent=state.previousReference?'LAST RECOGNIZED AYAH':'LISTENING FOR YOUR RECITATION';document.querySelector('.reader').classList.remove('is-matched');feedback('Listening for your recitation…'); return; }
  if (prediction.status === 'ambiguous') { waitingForReference(true);$('verse-state-text').textContent='MORE CONTEXT NEEDED';document.querySelector('.reader').classList.remove('is-matched');showAmbiguity(prediction.candidates || []); return; }
  let acceptedPrediction=prediction;
  let tracked = state.tracker.accept(prediction,{commit:false});
  if (tracked.status === 'ambiguous') { if(renderLikelyMatch())return tracked;waitingForReference(true);$('verse-state-text').textContent='MORE CONTEXT NEEDED';document.querySelector('.reader').classList.remove('is-matched');showAmbiguity(tracked.candidates); return; }
  if (tracked.status !== 'matched') { if(renderPreparedAyah())return tracked; waitingForReference();$('verse-state-text').textContent=state.previousReference?'LISTENING FOR MORE CONTEXT':'FINDING YOUR PLACE';document.querySelector('.reader').classList.remove('is-matched');feedback(state.scope ? 'Keep reciting a little more. Iqri is listening within your selected surah.' : 'Keep reciting a little more. Iqri is finding your exact place.'); return tracked; }
  const progress=prediction.wordProgress;
  if(acousticSources.has(progress?.source)&&state.byKey.has(progress.verseKey)&&progress.surah===Number(tracked.verseKey.split(':')[0])){
    const lastAyah=Number(tracked.verseKey.split(':')[1]);
    if(progress.ayah>=prediction.ayah&&progress.ayah<=lastAyah+1){const wordPrediction={surah:progress.surah,ayah:progress.ayah,score:prediction.score};const wordTracked=state.tracker.accept(wordPrediction,{commit:false});if(wordTracked.status==='matched'){tracked=wordTracked;acceptedPrediction=wordPrediction;}}
  }
  const heardAt=prediction.acquisition&&!progress?prediction.acquisitionAudioEndSample:(metadata.audioEndSample??progress?.audioEndSample);
  if(!state.likely.confirm(tracked.verseKey,heardAt,{commit:false})){renderLikelyMatch();return tracked;}
  if(state.preparation?.pending&&!state.preparation.acceptProgress(tracked.verseKey,heardAt)){
    renderPreparedAyah();return tracked;
  }
  state.tracker.accept(acceptedPrediction);
  state.likely.confirm(tracked.verseKey,heardAt);renderLikelyMatch();
  const verse = state.byKey.get(tracked.verseKey);
  if(state.listening&&!state.preview&&state.language==='en'&&state.wordMode&&state.showTranslation&&state.prefetchedAfterKey!==tracked.verseKey){
    state.prefetchedAfterKey=tracked.verseKey;
    const nextKey=nextRecitationKey(tracked.verseKey);
    // One adjacent ayah for the live reading flow; existing memory-only cache,
    // deduplication and expiry apply. Failure leaves foreground loading intact.
    if(state.byKey.has(nextKey))fetchWords(nextKey).catch(()=>{});
  }
  if(state.autoFollow&&(state.previousReference?.surah!==verse.surah||state.previousReference?.ayah!==verse.ayah))storage.set('lastAyah',tracked.verseKey);
  state.previousReference = {surah:verse.surah,ayah:verse.ayah};
  $('transcript-state').textContent=`Following ${tracked.verseKey}`;
  if(prediction.wordProgress)state.wordProgress=prediction.wordProgress;
  else if(prediction.acquisition||state.wordProgress?.verseKey!==tracked.verseKey)state.wordProgress=null;
  if (state.autoFollow && state.key !== tracked.verseKey) setVerse(tracked.verseKey, {matched:true});
  else {
    applyWordHighlight();
    if (state.autoFollow) {
      $('verse-state-text').textContent='FOLLOWING YOUR RECITATION';document.querySelector('.reader').classList.add('is-matched');
      if(state.wordKey!==state.key&&!state.wordLoadingKey&&Date.now()>=state.wordRetryAt)updateWordView();
    }
  }
  const wordDetail=state.wordProgress?.verseKey===tracked.verseKey?` · Word ${state.wordProgress.wordIndex} of ${state.wordProgress.wordCount}`:'';
  feedback(`${titleFor(tracked.verseKey)}${wordDetail}${state.autoFollow ? ' · Following your recitation' : ' recognized · Automatic following is off'}`);
  $('listen-title').textContent = 'Stay with the meaning.';
  $('listen-description').textContent = 'Iqri is following your recitation.';
  return tracked;
}
function showAmbiguity(candidates) {
  feedback('These words appear in more than one ayah. Keep reciting for context, or select your place.');
  const root = $('ambiguity'); root.replaceChildren(); root.hidden = false;
  const text = document.createElement('div'); text.textContent = 'More context needed for an exact reference.'; root.append(text);
  const keys = [...new Set(candidates.map(c => typeof c === 'string' ? c : `${c.surah}:${c.ayah_end || c.ayah}`))].filter(k => state.byKey.has(k));
  for (const key of keys.slice(0,5)) { const button = document.createElement('button'); button.textContent = key; button.onclick = () => { const v=state.byKey.get(key); state.contextVersion++;state.previousReference={surah:v.surah,ayah:v.ayah}; state.tracker.anchor(key); clearAudio();setVerse(key); root.hidden=true;if(state.listening&&state.streaming)restartStreaming().catch(()=>{});feedback('Place selected. Continue reciting for Iqri to follow.'); }; root.append(button); }
  if (keys.length > 5) { const button = document.createElement('button'); button.textContent = `View surahs (${keys.length} possible ayahs)`; button.onclick=()=>openBrowse('scope'); root.append(button); }
}
function updateListeningUi() {
  renderTranscript();
  $('listen-button').classList.toggle('recording', state.listening || state.initializing);
  $('listen-button-label').textContent = state.initializing ? 'Cancel' : state.listening ? 'Stop listening' : 'Start reciting';
  $('waveform').classList.toggle('active', state.listening);
  if (!state.listening && !state.initializing) { $('listen-title').textContent='The meaning is a recitation away.'; $('listen-description').textContent='Recite in Arabic, starting at any ayah. Iqri follows your place.'; }
}
async function startListening() {
  if(state.inFlight){feedback('Please wait for the current audio segment to finish, then start reciting.');return;}
  stopPreview();
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode || !window.AudioContext) { feedback(isNativeApp()
    ? 'Live recitation is unavailable on this device. Update iOS and reopen Iqri. You can still explore the translations.'
    : 'Live recitation needs an up-to-date Safari, Chrome, Edge, or Firefox browser with microphone access. You can still explore the translations.'); return; }
  const generation = ++state.generation;
  state.initializing = true; state.tracker.reset(); state.previousReference=null; $('ambiguity').hidden=true; updateListeningUi();
  try {
    // Unlock the native audio clock in the original user gesture. Model loading
    // can take longer than Safari's transient activation window.
    const unlocked = unlockAudioContext();
    const audioContext = unlocked.context;
    state.audioContext = audioContext;
    await unlocked.ready;
    if (generation !== state.generation) return;
    await ensureEngine();
    if (generation !== state.generation) return;
    if(state.streaming){await restartStreaming();if(generation!==state.generation)return;}
    else markFindingPlace();
    feedback('Allow microphone access to begin.');
    const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if (generation !== state.generation) { stream.getTracks().forEach(t=>t.stop()); return; }
    state.stream=stream;
    // Keep capture on the device's native audio clock. The worklet resamples
    // continuously to 16 kHz without creating a second browser clock domain.
    await audioContext.audioWorklet.addModule('/mic-worklet.js');
    if (generation !== state.generation) { stream.getTracks().forEach(t=>t.stop());if(audioContext.state!=='closed')await audioContext.close().catch(()=>{});return; }
    const source=audioContext.createMediaStreamSource(stream); state.worklet=new AudioWorkletNode(audioContext,'iqri-microphone');
    const mute=audioContext.createGain(); mute.gain.value=0; source.connect(state.worklet); state.worklet.connect(mute); mute.connect(audioContext.destination);
    clearAudio();
    state.worklet.port.onmessage=({data})=>onAudio(data, generation);
    stream.getAudioTracks()[0].onended=()=>stopListening('Microphone disconnected. Reconnect it and start again.');
    audioContext.onstatechange=()=>{
      if(state.audioContext===audioContext && state.listening && ['interrupted','suspended'].includes(audioContext.state))
        void stopListening('Listening paused after an audio interruption. Tap Start reciting when you are ready.');
    };
    await audioContext.resume();if(generation!==state.generation){stream.getTracks().forEach(t=>t.stop());if(audioContext.state!=='closed')await audioContext.close().catch(()=>{});return;}state.listening=true; state.initializing=false; updateListeningUi();
    $('listen-title').textContent='Listening. Take your time.'; $('listen-description').textContent='Recite a few words clearly, at your own pace.'; feedback('Listening for your recitation…');
  } catch(error) {
    if (generation !== state.generation) return;
    await stopListening(microphoneErrorMessage(error));
  }
}
async function stopListening(message = '') {
  ++state.generation; state.listening=false; state.initializing=false;
  const stoppingStream=state.liveStream?.stop();
  state.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();}); state.stream=null;
  if (state.worklet) {state.worklet.port.onmessage=null;state.worklet.disconnect();state.worklet=null;}
  const audioContext=state.audioContext;state.audioContext=null;if(audioContext){audioContext.onstatechange=null;if(audioContext.state!=='closed') await audioContext.close().catch(()=>{});}
  clearAudio(); updateListeningUi();if(state.catalog)setVerse(state.key); $('model-progress').hidden=true; feedback(message || 'Listening stopped. Your recording was not saved.');
  for(const bar of $('waveform').children) bar.style.height='5px';
  await stoppingStream;
}
function onAudio(data, generation) {
  if (!state.listening || generation !== state.generation) return;
  const meter = audioFeedback.update(data.audio);
  [...$('waveform').children].forEach((bar,index)=>{bar.style.height=`${3+15*(meter.levels[index]||0)}px`;});
  if(meter.nearSilent!==state.nearSilent){state.nearSilent=meter.nearSilent;renderRecognitionDetails();}
  if(state.streaming){state.liveStream?.push(data.audio,data.sampleEnd);return;}
  scheduler.push(data.audio,{sampleEnd:data.sampleEnd,rms:meter.rms});
  drainAudio(generation);
}
function renderRecognitionDetails() {
  const output=$('recognition-details');if(!output)return;
  const engine=state.local?'On this laptop':'In this browser';
  const details=state.details;
  const timing=details?` · ${(details.processingMs/1000).toFixed(2)} s processing${details.streaming?'':` · ${details.windowSeconds.toFixed(1)} s of recent audio`}`:'';
  const place=details?.searchTier==='surah'?' · Searching this surah':details?.searchTier==='nearby'?' · Following your place':'';
  const quiet=state.nearSilent?' · Very quiet input; check your microphone or speak a little closer.':'';
  const parallel=!state.local&&state.workerThreads>1?' · Parallel processing':'';
  const streaming=state.streaming?' · Live tracking':'';
  output.textContent=`Recitation language: Arabic · ${engine}${parallel}${streaming}${timing}${place}${quiet}`;
}
function drainAudio(generation = state.generation) {
  if(!state.listening||generation!==state.generation||state.inFlight)return;
  const clip=scheduler.take();if(!clip)return;
  const contextVersion=state.contextVersion,recognitionContext=context();
  state.inFlight=true;
  let prediction,applyResult=true;
  recognize(clip.audio,recognitionContext).then(result=>{
    prediction=result;
    if(generation!==state.generation||contextVersion!==state.contextVersion||!state.listening)return;
    const freshness=scheduler.accept(clip,result);
    applyResult=freshness.accepted;
    state.details={processingMs:result.processingMs||0,windowSeconds:clip.windowSeconds,searchTier:result.searchTier,ageMs:freshness.ageMs,heldReason:freshness.reason};
    renderRecognitionDetails();
    if(freshness.accepted)showPrediction(result);
  }).catch(error=>{
    if(generation===state.generation&&contextVersion===state.contextVersion&&state.listening)feedback(error.message);
  }).finally(()=>{
    scheduler.complete(clip,prediction,{applyResult});
    state.inFlight=false;
    // Only the newest captured audio is considered; there is no backlog of clips.
    if(state.listening)drainAudio(state.generation);
  });
}
function findAgain() {
  stopPreview();state.contextVersion++;state.previousReference=null;state.wordProgress=null;
  state.tracker.reset();clearAudio();applyWordHighlight();$('ambiguity').hidden=true;
  if((state.listening||state.initializing)&&state.streaming)restartStreaming().catch(()=>{});
  feedback(state.scope?'Recite from any ayah in your selected surah. Iqri is finding your place again.':'Recite a few words. Iqri is finding your place again.');
}
function stopPreview() { clearTimeout(previewTimer); state.preview=false; $('preview-button').innerHTML='Explore a guided preview <span aria-hidden="true">→</span>'; }
async function startPreview() {
  if (state.preview) {stopPreview();setVerse(state.key);feedback('Guided preview stopped.');return;}
  if(state.listening||state.initializing)await stopListening();
  state.preview=true;$('preview-button').textContent='Stop guided preview';
  const keys=['1:1','1:2','1:3','1:4','1:5','1:6','1:7'];let index=0;
  const advance=()=>{if(!state.preview)return;setVerse(keys[index],{preview:true});feedback('Guided preview only · Showing how ayahs follow one another. No audio recognition is running.');index++;if(index<keys.length)previewTimer=setTimeout(advance,5000);else previewTimer=setTimeout(()=>{stopPreview();setVerse(state.key);feedback('Preview complete. Choose Start reciting to try real voice recognition.');},5000);};advance();
}
async function recognizeFile(file) {
  if(!file)return;
  if(file.size>30*1024*1024){feedback('Choose an audio file smaller than 30 MB.');return;}
  stopPreview();if(state.listening||state.initializing)await stopListening();
  if(state.inFlight){feedback('Please wait for the current audio segment to finish.');return;}
  state.inFlight=true;const generation=++state.generation;state.previousReference=null;state.tracker.reset();
  try {
    feedback('Opening the audio file on your device…');
    // Decode at the model rate to avoid resampling through the speaker device rate.
    const decoder=new AudioContext({sampleRate:16000});let decoded;try{decoded=await decoder.decodeAudioData(await file.arrayBuffer());}finally{await decoder.close();}
    if(decoded.duration>30)throw new Error('Please choose a clip of 30 seconds or less.');
    const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
    const audio=(await offline.startRendering()).getChannelData(0);
    await ensureEngine();if(generation!==state.generation)return;feedback('Finding the ayah in your audio…');const contextVersion=state.contextVersion;const result=await recognize(audio);
    if(generation===state.generation&&contextVersion===state.contextVersion){state.details={processingMs:result.processingMs||0,windowSeconds:decoded.duration,searchTier:result.searchTier};renderRecognitionDetails();const tracked=showPrediction(result);if(tracked?.status==='matched'){feedback(`${titleFor(tracked.verseKey)}${result.wordProgress?` · Word ${result.wordProgress.wordIndex} of ${result.wordProgress.wordCount}`:''} · Recognized from your audio. The recording was not saved.${state.autoFollow?'':' Automatic following is off.'}`);$('listen-title').textContent='The meaning, found.';$('listen-description').textContent='Identified from your audio file.';}}
  }catch(error){if(generation===state.generation)feedback(error.message);}finally{state.inFlight=false;$('audio-upload').value='';}
}
function bindEvents() {
  for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>button.closest('dialog').close();
  for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',event=>{if(event.target===d){const rect=d.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)d.close();}});
  $('about-button').onclick=$('sources-button').onclick=()=>dialog('about-dialog');
  $('settings-button').onclick=$('preferences-shortcut').onclick=$('edition-button').onclick=()=>dialog('settings-dialog');
  $('nav-browse').onclick=()=>openBrowse('browse');$('scope-button').onclick=()=>openBrowse('scope');$('surah-title').style.cursor='pointer';$('surah-title').onclick=()=>openBrowse('browse');
  $('nav-recite').onclick=()=>$('listen-button').focus();$('nav-saved').onclick=()=>{renderSaved();dialog('saved-dialog');};
  $('mobile-recite').onclick=()=>$('listen-button').focus();$('mobile-browse').onclick=()=>openBrowse('browse');$('mobile-saved').onclick=()=>{renderSaved();dialog('saved-dialog');};$('mobile-settings').onclick=()=>dialog('settings-dialog');
  $('scope-anywhere').onclick=()=>{updateScope(null);$('browse-dialog').close();};$('surah-search').oninput=renderSurahs;
  for(const button of document.querySelectorAll('[data-language]'))button.onclick=()=>setLanguage(button.dataset.language);
  $('show-arabic').onchange=event=>{state.showArabic=event.target.checked;storage.set('showArabic',state.showArabic);updateDisplay();applyWordHighlight();};
  $('show-translation').onchange=event=>{state.showTranslation=event.target.checked;storage.set('showTranslation',state.showTranslation);updateWordView();};
  $('word-mode').onclick=()=>{state.wordMode=true;storage.set('wordMode',true);updateWordView();};$('ayah-mode').onclick=()=>{state.wordMode=false;storage.set('wordMode',false);updateDisplay();};
  $('edition-select').onchange=event=>{state.englishEdition=event.target.value;storage.set('englishEdition',state.englishEdition);setLanguage('en');};
  $('font-size').value=state.fontSize;$('font-size').oninput=event=>{state.fontSize=Number(event.target.value);storage.set('fontSize',state.fontSize);updateDisplay();};
  $('auto-follow').checked=state.autoFollow;$('auto-follow').onchange=event=>{state.autoFollow=event.target.checked;state.preparation?.clear();state.likely.clear();storage.set('autoFollow',state.autoFollow);setVerse(state.key);};
  $('save-verse').onclick=()=>{if(state.bookmarks.includes(state.key))state.bookmarks=state.bookmarks.filter(k=>k!==state.key);else state.bookmarks.push(state.key);storage.set('bookmarks',state.bookmarks);renderSaved();setVerse(state.key,{matched:state.listening&&Boolean(state.previousReference),preview:state.preview});toast(state.bookmarks.includes(state.key)?'Ayah saved in this browser.':'Ayah removed from saved ayahs.');};
  $('copy-verse').onclick=async()=>{const parts=[titleFor(state.key)];if(state.showArabic)parts.push(state.byKey.get(state.key).text_uthmani);if(state.showTranslation&&state.translation[state.key])parts.push(state.translation[state.key].text,selectedEdition().credit||selectedEdition().title,selectedEdition().sourceUrl);try{await navigator.clipboard.writeText(parts.join('\n\n'));toast('Ayah copied with its source.');}catch{toast('Your browser could not copy the ayah.');}};
  function moveVerse(direction){stopPreview();state.preparation?.clear();state.likely.clear();const index=state.verses.indexOf(state.byKey.get(state.key));const verse=state.verses[index+direction];if(verse)setVerse(`${verse.surah}:${verse.ayah}`);}
  $('previous-verse').onclick=()=>moveVerse(-1);$('next-verse').onclick=()=>moveVerse(1);
  $('listen-button').onclick=()=>state.listening||state.initializing?stopListening():startListening();
  if($('find-again'))$('find-again').onclick=findAgain;
  $('preview-button').onclick=startPreview;$('audio-upload').onchange=event=>recognizeFile(event.target.files[0]);
  $('data-notices').href='/data/LICENSES.txt';
  const pauseListening=()=>{if(state.listening||state.initializing)return stopListening('Listening paused. Tap Start reciting when you return.');};
  void registerNativeLifecycle({isListening:()=>state.listening,onPause:pauseListening});
  document.addEventListener('visibilitychange',()=>{if(isNativeApp()&&document.hidden&&state.listening)void pauseListening();});
  window.addEventListener('pagehide',()=>{
    void pauseListening();
    for(const waiter of state.waiters.values())waiter.reject(new Error('Listening paused because Iqri was closed.'));
    state.waiters.clear();state.worker?.terminate();state.worker=null;state.engine=null;enginePromise=null;
  });
  for(let i=0;i<6;i++){const bar=document.createElement('i');bar.style.height='3px';$('waveform').append(bar);}
}
async function init() {
  $('listen-button').disabled=true;
  try {
    const [catalog,verses]=await Promise.all([json('/data/catalog.json'),json('/data/quran.json')]);
    state.catalog=catalog;state.verses=verses;state.byKey=new Map(verses.map(v=>[`${v.surah}:${v.ayah}`,v]));state.tracker=new VerseTracker(verses);state.preparation=new AyahPreparation(verses);state.likely=new LikelyMatch(verses);
    state.bookmarks=state.bookmarks.filter(k=>typeof k==='string'&&state.byKey.has(k));
    if(!state.byKey.has(state.key))state.key='1:1';
    for(const edition of catalog.translations.filter(t=>t.language==='en')){const option=document.createElement('option');option.value=edition.id;option.textContent=edition.title;$('edition-select').append(option);}
    if(!catalog.translations.some(t=>t.id===state.englishEdition&&t.language==='en'))state.englishEdition=catalog.defaultTranslation;
    $('edition-select').value=state.englishEdition;bindEvents();renderSources();renderSaved();await setLanguage(state.language);
    if(!isNativeApp())try{const health=await json('/api/health',{signal:AbortSignal.timeout(2000)});state.local=health.localRecognition===true;}catch{}
    $('engine-description').textContent=(state.local?'Voice recognition runs locally on this laptop. Audio stays on this device.':isNativeApp()?'Voice recognition runs on this device using the model included with Iqri.':'Voice recognition runs in this browser. A voice model downloads once, then audio stays on this device.')+' English word meanings are requested from Quran.com using the ayah reference; audio is never sent there. Word highlighting follows detected speech with processing delay.';
    $('privacy-note').textContent='Audio stays on your device. Recordings are not saved.';
    renderRecognitionDetails();
    $('listen-button').disabled=false;
  }catch(error){$('translation-text').textContent='Your reading library could not be opened. Please reload the app.';feedback(error.message);}
}
prepareBrowserAcceleration().then(reloading=>{if(!reloading)init();}).catch(()=>init());
