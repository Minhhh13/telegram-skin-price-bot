import { itemNames } from './catalog.mjs';

// Collectibles do not use the weapon | finish (wear) shape. In particular,
// stickers and souvenir charms can have several meaningful `|` segments.
const WEAR = / \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
const PREFIXES = [
  ['Sticker Slab |', 'sticker-slab'],
  ['Sticker |', 'sticker'],
  ['Sealed Graffiti |', 'graffiti'],
  ['Souvenir Charm |', 'souvenir-charm'],
  ['Charm |', 'charm'],
  ['Patch |', 'patch'],
  ['StatTrak™ Music Kit |', 'stattrak-music'],
  ['Music Kit |', 'music'],
  ['Autograph Capsule |', 'autograph-capsule'],
];
const STOP = new Set(['a', 'an', 'at', 'base', 'buff', 'buff163', 'can', 'check', 'cost',
  'current', 'find', 'for', 'how', 'in', 'is', 'item', 'items', 'me', 'much', 'now',
  'of', 'on', 'please', 'price', 'show', 'skin', 'skins', 'the', 'what', 'you', 'maybe']);
const TYPE_WORDS = new Set(['sticker', 'slab', 'sealed', 'graffiti', 'souvenir', 'charm',
  'patch', 'music', 'kit', 'autograph', 'capsule', 'case', 'pin', 'package']);
const WEAR_WORDS = new Set(['fn', 'ft', 'mw', 'ww', 'bs', 'factorynew', 'fieldtested',
  'minimalwear', 'wellworn', 'battlescarred']);
const WEAPON_WORDS = new Set(['ak', 'ak47', 'awp', 'm4', 'm4a4', 'm4a1s', 'm9',
  'karambit', 'butterfly', 'glock', 'usp', 'deagle']);

function tokens(value) {
  return String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/stat[\s-]*trak(?:™)?/g, ' stattrak ')
    .replace(/ak[\s-]*47/g, ' ak47 ')
    .replace(/m4a1[\s-]*s/g, ' m4a1s ')
    .split(/[^a-z0-9]+/).filter((word) => word && !STOP.has(word));
}

function kindFor(name) {
  if (WEAR.test(name) || name.startsWith('★')) return '';
  for (const [prefix, kind] of PREFIXES) if (name.startsWith(prefix)) return kind;
  return name.includes('|') ? '' : 'standalone';
}

function entryFor(name) {
  const words = [...new Set(tokens(name))];
  const title = name.slice(name.lastIndexOf('|') + 1).trim();
  const articleTitle = /^(a|an|the)\s+(.+)/i.exec(title);
  const article = articleTitle?.[1].toLowerCase() || '';
  const titleStem = tokens(articleTitle?.[2] || title)[0] || '';
  return { name, kind: kindFor(name), words, fingerprint: [...words].sort().join('|'),
    article, titleStem };
}

// Some catalogue titles differ only by their leading article, for example
// "Defender", "A Defender" and "The Defender". Keep an explicit article from
// the request, but do not invent one when it was omitted.
function filterTitleArticle(found, query) {
  const queryWords = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const groups = new Map();
  for (const item of found) {
    const key = item.entry.fingerprint;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const allowed = new Set(found);
  for (const group of groups.values()) {
    if (group.length < 2 || new Set(group.map(({ entry }) => entry.article)).size < 2) continue;
    const stems = new Set(group.map(({ entry }) => entry.titleStem));
    if (stems.size !== 1) continue;
    const [stem] = stems;
    const articles = new Set();
    for (let i = 1; i < queryWords.length; i++) {
      if (queryWords[i] === stem && ['a', 'an', 'the'].includes(queryWords[i - 1])) {
        articles.add(queryWords[i - 1]);
      }
    }
    if (articles.size !== 1) continue;
    const [requested] = articles;
    if (group.some(({ entry }) => entry.article === requested)) {
      for (const item of group) if (item.entry.article !== requested) allowed.delete(item);
    }
  }
  return found.filter((item) => allowed.has(item));
}

function makeIndex(names) {
  const entries = names.map((value) => typeof value === 'string' ? value : value?.name)
    .filter((name) => typeof name === 'string' && kindFor(name))
    .map(entryFor);
  const byName = new Map();
  const byFingerprint = new Map();
  const byWord = new Map();
  for (const entry of entries) {
    byName.set(entry.name, entry);
    if (!byFingerprint.has(entry.fingerprint)) byFingerprint.set(entry.fingerprint, []);
    byFingerprint.get(entry.fingerprint).push(entry);
    for (const word of entry.words) {
      if (!byWord.has(word)) byWord.set(word, []);
      byWord.get(word).push(entry);
    }
  }
  return { byName, byFingerprint, byWord, words: [...byWord.keys()] };
}

let defaultIndex;
const customIndexes = new WeakMap();
function indexFor(names) {
  if (names !== itemNames) {
    if(!Object.isFrozen(names))return makeIndex(names);
    let index=customIndexes.get(names);
    if(!index){index=makeIndex(names);customIndexes.set(names,index);}
    return index;
  }
  return defaultIndex ||= makeIndex(itemNames);
}

function distance(a, b, max = 1) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(
      current[j - 1] + 1, previous[j] + 1,
      previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (Math.min(...current) > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

function swapped(a, b) {
  if (a.length < 4 || a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] &&
    a.slice(i + 2) === b.slice(i + 2);
}

function quality(typed, actual) {
  if (typed === actual) return 1;
  if (/^\d+$/.test(typed) || /^\d+$/.test(actual)) return 0;
  if (typed.length >= 4 && actual.startsWith(typed) && typed.length / actual.length >= 0.6) return 0.8;
  if (typed.length >= 4 && (distance(typed, actual, 1) <= 1 || swapped(typed, actual))) return 0.72;
  return 0;
}

function requestedKind(words) {
  if (words.some((word) => ['box', 'pack', 'key', 'pass'].includes(word))) return ['standalone'];
  if (words.includes('sticker') && words.includes('capsule')) return ['standalone'];
  if (words.includes('slab')) return ['sticker-slab'];
  if (words.includes('sticker')) return ['sticker'];
  if (words.includes('graffiti')) return words.includes('box')
    ? ['graffiti', 'standalone'] : ['graffiti'];
  if (words.includes('patch')) return ['patch'];
  if (words.includes('charm')) return words.includes('souvenir')
    ? ['souvenir-charm'] : ['charm'];
  if (words.includes('music') && words.includes('kit')) return words.includes('stattrak')
    ? ['stattrak-music'] : ['music'];
  if (words.includes('autograph') && words.includes('capsule')) return ['autograph-capsule', 'standalone'];
  if (words.includes('capsule')) return ['autograph-capsule', 'standalone'];
  if (words.some((word) => ['case', 'pin', 'package', 'pass'].includes(word))) return ['standalone'];
  return null;
}

function nearbyWords(word, index) {
  if (index.byWord.has(word)) return [word];
  if (word.length < 4) return [];
  return index.words.filter((known) =>
    Math.abs(known.length - word.length) <= 1 &&
    (distance(word, known, 1) <= 1 || swapped(word, known)));
}

function ranked(query, names = itemNames, limit = 5) {
  const words = [...new Set(tokens(query))];
  if (!words.length || words.some((word) => WEAR_WORDS.has(word))) return [];
  const index = indexFor(names);
  const exactName = index.byName.get(String(query).trim());
  if (exactName) return [{ entry: exactName, score: 100, average: 1 }];
  const kinds = requestedKind(words);
  if (!kinds && words.some((word) => WEAPON_WORDS.has(word))) return [];
  const informative = words.filter((word) => !TYPE_WORDS.has(word));
  if (!informative.length) return [];
  const fingerprint = [...words].sort().join('|');
  const exact = (index.byFingerprint.get(fingerprint) || [])
    .filter((entry) => !kinds || kinds.includes(entry.kind));
  if (exact.length) return filterTitleArticle(
    exact.map((entry) => ({ entry, score: 100, average: 1 })), query).slice(0, limit);
  const postings = informative.map((word) => nearbyWords(word, index)
    .flatMap((near) => index.byWord.get(near) || []))
    .filter((items) => items.length);
  if (!postings.length) return [];
  const pool = postings.reduce((smallest, items) => items.length < smallest.length ? items : smallest);
  const scores = [];
  for (const entry of pool) {
    if (kinds && !kinds.includes(entry.kind)) continue;
    let sum = 0;
    let all = true;
    for (const word of words) {
      const best = Math.max(0, ...entry.words.map((actual) => quality(word, actual)));
      if (!best) { all = false; break; }
      sum += best;
    }
    if (!all) continue;
    const extra = entry.words.filter((actual) => !words.some((word) => quality(word, actual))).length;
    const average = sum / words.length;
    scores.push({ entry, score: sum * 10 - extra * 2, average });
  }
  scores.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return filterTitleArticle(scores.filter((item) => item.average >= 0.7 &&
    item.score >= scores[0].score - 5), query).slice(0, limit);
}

// Return an existing, unambiguous catalogue name, or leave selection to the
// user. We never discard an explicit modifier, event, year, or item class.
export function resolveCollectible(query, names = itemNames) {
  const found = ranked(query, names, 6);
  if (!found.length) return null;
  const first = found[0];
  if (first.average >= 0.85 && (!found[1] || first.score - found[1].score >= 3)) {
    return { name: first.entry.name };
  }
  return { ambiguous: found.slice(0, 5).map(({ entry }) => entry.name), more: found.length > 5 };
}

export function collectibleSuggestions(query, names = itemNames, limit = 5) {
  return ranked(query, names, Math.max(0, Math.min(5, limit)))
    .map(({ entry }) => entry.name);
}
