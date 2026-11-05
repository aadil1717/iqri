import { mapWordProgress, mapArabicWordProgress } from './word-alignment.js';

/** Keep source spans stable while acoustic progress only changes their classes. */
export class WordHighlightView {
  constructor(arabicRoot, meaningRoot) {
    this.arabicRoot = arabicRoot;
    this.meaningRoot = meaningRoot;
    this.arabic = { key: '', text: '', spans: new Map(), active: [], cache: new Map() };
    this.meaning = { key: '', words: null, spans: new Map(), active: [], cache: new Map() };
  }

  setArabic(text, key) {
    const view = this.arabic;
    if (view.key === key && view.text === text) return false;
    Object.assign(view, { key, text, spans: new Map(), active: [], cache: new Map() });
    const nodes = [];
    let position = 0;
    for (const part of text.split(/(\s+)/u)) {
      if (!part) continue;
      if (/^\s+$/u.test(part)) { nodes.push(document.createTextNode(part)); continue; }
      const span = document.createElement('span');
      span.className = 'arabic-word';
      span.textContent = part;
      view.spans.set(++position, span);
      nodes.push(span);
    }
    this.arabicRoot.replaceChildren(...nodes);
    return true;
  }

  setMeanings(words, key) {
    const view = this.meaning;
    if (view.key === key && view.words === words) return false;
    Object.assign(view, { key, words, spans: new Map(), active: [], cache: new Map() });
    const nodes = [];
    for (const word of words) {
      const span = document.createElement('span');
      span.className = 'meaning-word';
      span.dataset.position = word.position;
      span.textContent = word.translation;
      span.title = word.arabic;
      view.spans.set(word.position, span);
      nodes.push(span, document.createTextNode(' '));
    }
    this.meaningRoot.replaceChildren(...nodes);
    return true;
  }

  apply(progress, key) {
    const current = progress?.verseKey === key ? progress : null;
    const signature = current
      ? `${current.wordIndex}|${current.canonicalText || ''}|${current.canonicalWords?.join(' ') || ''}`
      : '';
    for (const [type, view] of [['arabic', this.arabic], ['meaning', this.meaning]]) {
      let positions = [];
      if (current && view.key === key) {
        positions = view.cache.get(signature);
        if (!positions) {
          positions = type === 'arabic'
            ? mapArabicWordProgress(view.text, current)
            : mapWordProgress(view.words, current);
          view.cache.set(signature, positions);
          if (view.cache.size > 300) view.cache.delete(view.cache.keys().next().value);
        }
      }
      for (const position of view.active) {
        if (positions.includes(position)) continue;
        const span = view.spans.get(position);
        span?.classList.remove('current-word');
        span?.removeAttribute('aria-current');
      }
      for (const position of positions) {
        if (view.active.includes(position)) continue;
        const span = view.spans.get(position);
        span?.classList.add('current-word');
        span?.setAttribute('aria-current', 'true');
      }
      view.active = positions;
    }
  }
}
