import { itemNames } from './catalog.mjs';

// The public catalogue contains skins, agents, charms and bare (vanilla)
// knives. Search their names as names; a `|` is not always a weapon/finish
// separator. Prices are looked up only after a canonical name is selected.
const WEARS = ['factorynew', 'minimalwear', 'fieldtested', 'wellworn', 'battlescarred'];
const WEAR_SET = new Set(WEARS);
const STOP_WORDS = new Set(['a', 'an', 'at', 'base', 'buff', 'buff163', 'can', 'check', 'cost', 'current',
  'find', 'for', 'how', 'in', 'is', 'item', 'items', 'me', 'much', 'now', 'of', 'on', 'please', 'price',
  'show', 'skin', 'skins', 'the', 'what', 'you', 'maybe', 'right']);
const ALIASES = new Map([
  ['ak', 'ak47'], ['a1', 'm4a1s'], ['m1', 'm4a1s'], ['m4a1', 'm4a1s'], ['a4', 'm4a4'],
  ['m9', 'm9bayonet'], ['deagle', 'deserteagle'], ['glock', 'glock18'], ['usp', 'usps'],
  ['butter', 'butterflyknife'], ['btf', 'butterflyknife'], ['karam', 'karambit'],
  ['karmabit', 'karambit'], ['awl', 'awp'], ['dlore', 'dragonlore'],
  ['dop', 'doppler'], ['dopp', 'doppler'], ['print', 'printstream'],
  ['fn', 'factorynew'], ['mw', 'minimalwear'], ['minwear', 'minimalwear'],
  ['ft', 'fieldtested'], ['ww', 'wellworn'], ['bs', 'battlescarred'],
  ['st', 'stattrak'], ['stt', 'stattrak'], ['ouvenir', 'souvenir'],
]);
const STATUS = new Set(['stattrak', 'souvenir']);

function tokens(value) {
  const text = String(value || '').toLowerCase()
    .replace(/\bm9[\s-]*bayonet\b/g, ' m9bayonet ')
    .replace(/stat[\s-]*trak(?:™)?/g, ' stattrak ')
    .replace(/factory[\s-]*new/g, ' factorynew ')
    .replace(/minimal[\s-]*wear|\bmin[\s-]+wear\b/g, ' minimalwear ')
    .replace(/field[\s-]*tested/g, ' fieldtested ')
    .replace(/well[\s-]*worn/g, ' wellworn ')
    .replace(/battle[\s-]*scarred/g, ' battlescarred ')
    .replace(/dragon[\s-]*lore/g, ' dragonlore ')
    .replace(/long[\s-]*dog/g, ' longdog ')
    .replace(/ak[\s-]*47/g, ' ak47 ')
    .replace(/m4a1[\s-]*s/g, ' m4a1s ')
    .replace(/glock[\s-]*18/g, ' glock18 ')
    .replace(/usp[\s-]*s/g, ' usps ');
  return text.split(/[^a-z0-9]+/).filter(Boolean).map((token) => ALIASES.get(token) || token);
}

function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1,
      row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (Math.min(...next) > max) return max + 1;
    row = next;
  }
  return row[b.length];
}

function adjacentSwap(a, b) {
  if (a.length < 4 || a.length !== b.length) return false;
  let first = 0;
  while (first < a.length && a[first] === b[first]) first++;
  return first < a.length - 1 && a[first] === b[first + 1] &&
    a[first + 1] === b[first] && a.slice(first + 2) === b.slice(first + 2);
}

function trigrams(value) {
  const padded = `^${value}$`;
  const result = [];
  for (let i = 0; i < padded.length - 2; i++) result.push(padded.slice(i, i + 3));
  return result;
}

function entryFor(name) {
  const actual = typeof name === 'string' ? name : name.name;
  const all = tokens(actual);
  const left = actual.split('|')[0].replace(/^★\s*/, '');
  const wear = all.find((token) => WEAR_SET.has(token)) || '';
  const isSkin = Boolean(wear && actual.includes('|'));
  const isBareKnife = !actual.includes('|') && /^★\s*(?:StatTrak™\s*)?/.test(actual) &&
    /(?:Knife|Bayonet|Karambit|Daggers)$/i.test(actual);
  const weapon = (isSkin || isBareKnife)
    ? tokens(left).filter((token) => !STATUS.has(token)).join('') : '';
  const stem = wear ? actual.replace(/ \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '') : actual;
  const searchTokens = [...new Set(all.filter((token) => !WEAR_SET.has(token) && !STATUS.has(token) &&
    !STOP_WORDS.has(token)))];
  return { name: actual, stem, wear, weapon, isSkin, isBareKnife, searchTokens,
    stattrak: all.includes('stattrak'), souvenir: all.includes('souvenir'),
    gamma: all.includes('gamma'), doppler: all.includes('doppler') };
}

function prepare(names) {
  const entries = names.map(entryFor);
  const byWeapon = new Map();
  const byToken = new Map();
  const byGram = new Map();
  for (const entry of entries) {
    if (entry.weapon) {
      if (!byWeapon.has(entry.weapon)) byWeapon.set(entry.weapon, []);
      byWeapon.get(entry.weapon).push(entry);
    }
    for (const token of entry.searchTokens) {
      if (!byToken.has(token)) {
        byToken.set(token, []);
        for (const gram of trigrams(token)) {
          if (!byGram.has(gram)) byGram.set(gram, new Set());
          byGram.get(gram).add(token);
        }
      }
      byToken.get(token).push(entry);
    }
  }
  return { entries, byWeapon, byToken, byGram, weaponNames: [...byWeapon.keys()].sort((a, b) => b.length - a.length) };
}

let defaultIndex;
function indexFor(names) {
  if (names !== itemNames) return prepare(names);
  return defaultIndex ||= prepare(itemNames);
}

function requestedWeapon(query, index) {
  const compact = query.join('');
  for (const side of ['start', 'end']) {
    for (let size = Math.min(4, query.length); size >= 1; size--) {
      const slice = side === 'start' ? query.slice(0, size) : query.slice(-size);
      const value = slice.join('');
      if (!value) continue;
      if (value === 'm4') return { names: ['m4a1s', 'm4a4'], remainder: side === 'start' ? query.slice(size) : query.slice(0, -size) };
      const exact = index.byWeapon.has(value) ? [value] : [];
      const prefix = exact.length ? [] : index.weaponNames.filter((name) =>
        value.length >= 4 && name.startsWith(value) && value.length / name.length >= 0.6);
      const fuzzy = exact.length || prefix.length ? [] : index.weaponNames.filter((name) =>
        value.length >= 5 && Math.abs(name.length - value.length) <= (value.length >= 8 ? 2 : 1) &&
        editDistance(value, name, value.length >= 8 ? 2 : 1) <= (value.length >= 8 ? 2 : 1));
      const names = exact.length ? exact : prefix.length === 1 ? prefix : fuzzy.length === 1 ? fuzzy : [];
      if (names.length) return { names, remainder: side === 'start' ? query.slice(size) : query.slice(0, -size) };
    }
  }
  return { names: [], remainder: query, compact };
}

function nearbyTokens(token, index) {
  if (index.byToken.has(token)) return [token];
  const names = new Set();
  for (const gram of trigrams(token)) for (const candidate of index.byGram.get(gram) || []) names.add(candidate);
  const result = [];
  for (const name of names) {
    if (token.length >= 4 && name.startsWith(token) && token.length / name.length >= 0.5) result.push(name);
    else if (name.length >= 3 && token.startsWith(name) && name.length / token.length >= 0.5) result.push(name);
    else if (adjacentSwap(token, name)) result.push(name);
    else {
      const max = token.length >= 8 ? 2 : token.length >= 4 ? 1 : 0;
      if (max && editDistance(token, name, max) <= max) result.push(name);
    }
  }
  return result;
}

function tokenQuality(typed, actual) {
  if (typed === actual) return 1;
  if (typed.length >= 4 && actual.startsWith(typed) && typed.length / actual.length >= 0.55) return 0.82;
  if (actual.length >= 3 && typed.startsWith(actual) && actual.length / typed.length >= 0.5) return 0.65;
  if (adjacentSwap(typed, actual)) return 0.78;
  const max = typed.length >= 8 ? 2 : typed.length >= 4 ? 1 : 0;
  if (!max) return 0;
  const error = editDistance(typed, actual, max);
  return error <= max ? (error === 1 ? 0.72 : 0.53) : 0;
}

function requestFor(text, index) {
  const raw = tokens(text);
  const last = raw.at(-1);
  const partialWear = new Map([['factory', 'factorynew'], ['minimal', 'minimalwear'],
    ['field', 'fieldtested'], ['well', 'wellworn'], ['battle', 'battlescarred']]);
  const closeWear = last?.length >= 4 ? [...partialWear].filter(([word]) =>
    editDistance(last, word, 1) <= 1 || adjacentSwap(last, word)) : [];
  const trailingWear = partialWear.get(last) || (closeWear.length === 1 ? closeWear[0][1] : '');
  const wear = raw.find((token) => WEAR_SET.has(token)) || trailingWear;
  const stattrak = raw.includes('stattrak');
  const souvenir = raw.includes('souvenir');
  const vanilla = raw.some((token) => token === 'vanilla' ||
    (token.length >= 5 && editDistance(token, 'vanilla', 1) === 1));
  const phase = raw.some((token) => /^p[1-4]$|^phase[1-4]$/.test(token)) ||
    (raw.includes('phase') && raw.some((token) => /^[1-4]$/.test(token)));
  const stripped = trailingWear ? raw.slice(0, -1) : raw;
  const base = stripped.filter((token) => !WEAR_SET.has(token) && !STATUS.has(token) &&
    !STOP_WORDS.has(token) && token !== 'phase' && !/^p[1-4]$|^phase[1-4]$|^[1-4]$/.test(token) &&
    token !== 'vanilla' && !(token.length >= 5 && editDistance(token, 'vanilla', 1) === 1));
  const weapon = requestedWeapon(base, index);
  const knife = weapon.names.some((name) => index.byWeapon.get(name)?.some((entry) => entry.isBareKnife));
  // Ruby and Emerald are also literal words in unrelated skin finishes. They
  // mean Doppler styles only when a knife or Doppler is actually requested.
  const styleContext = knife || raw.includes('doppler');
  const gamma = styleContext && (raw.includes('gamma') || raw.includes('gmma') || raw.includes('emerald'));
  const ruby = styleContext && (raw.includes('ruby') || raw.includes('sapphire') ||
    raw.includes('blackpearl') || (raw.includes('black') && raw.includes('pearl')));
  const standardDoppler = raw.includes('doppler') && !gamma || ruby;
  const doppler = raw.includes('doppler') || (knife && (gamma || ruby || phase));
  const nameTokens = weapon.remainder.map((token) => styleContext && token === 'gmma' ? 'gamma' : token)
    .filter((token) => token !== 'knife' && token !== 'glove' &&
    token !== 'gloves' && (!styleContext || !['ruby', 'sapphire', 'black', 'pearl',
      'blackpearl', 'emerald'].includes(token)));
  return { raw, nameTokens, wear, stattrak, souvenir, vanilla, gamma, doppler, standardDoppler,
    gloveOnly: base.includes('glove') || base.includes('gloves'), weapon: weapon.names };
}

function rank(query, names = itemNames, limit = 5) {
  const index = indexFor(names);
  const request = requestFor(query, index);
  if (!request.nameTokens.length && !request.vanilla && !request.doppler) return [];
  let possible;
  if (request.weapon.length) {
    possible = request.weapon.flatMap((name) => index.byWeapon.get(name) || []);
  } else {
    const found = new Set();
    for (const token of request.nameTokens) {
      for (const near of nearbyTokens(token, index)) {
        for (const entry of index.byToken.get(near) || []) found.add(entry);
      }
    }
    possible = [...found];
  }
  const ranked = [];
  for (const entry of possible) {
    if (request.vanilla ? !entry.isBareKnife : entry.isBareKnife) continue;
    if (request.wear && entry.wear !== request.wear) continue;
    if (entry.stattrak !== request.stattrak || entry.souvenir !== request.souvenir) continue;
    if (request.gloveOnly && !entry.weapon.endsWith('gloves')) continue;
    if (request.doppler && !entry.doppler) continue;
    if (request.gamma && !entry.gamma) continue;
    if (request.standardDoppler && !request.gamma && entry.gamma) continue;
    if (!request.doppler && entry.doppler && request.nameTokens.length) {
      // A bare weapon name is not permission to pick a Doppler finish.
      if (!request.nameTokens.includes('doppler')) continue;
    }
    let quality = 0;
    let matched = 0;
    for (const token of request.nameTokens) {
      const best = Math.max(0, ...entry.searchTokens.map((actual) => tokenQuality(token, actual)));
      quality += best;
      if (best > 0) matched++;
    }
    if (request.nameTokens.length && (matched / request.nameTokens.length < 0.6 || quality < 0.55)) continue;
    if (request.vanilla && !request.weapon.length) continue;
    const avgQuality = request.nameTokens.length ? quality / request.nameTokens.length : 1;
    const score = quality * 10 + (request.weapon.length ? 6 : 0) +
      (request.vanilla ? 10 : 0) - Math.max(0, entry.searchTokens.length - request.nameTokens.length -
        (request.weapon.length ? 2 : 0)) * 0.15;
    ranked.push({ entry, score, avgQuality });
  }
  const byStem = new Map();
  for (const item of ranked) {
    const previous = byStem.get(item.entry.stem);
    if (!previous) byStem.set(item.entry.stem, { ...item, variants: [item.entry] });
    else {
      previous.variants.push(item.entry);
      if (item.score > previous.score || (item.score === previous.score &&
        WEARS.indexOf(item.entry.wear) < WEARS.indexOf(previous.entry.wear))) {
        previous.entry = item.entry;
        previous.score = item.score;
        previous.avgQuality = item.avgQuality;
      }
    }
  }
  return [...byStem.values()].sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .filter((item, _, sorted) => item.score >= sorted[0].score - 4 && item.avgQuality >= 0.55)
    .slice(0, Math.max(0, Math.min(5, limit)));
}

// Ranked real catalogue names for a selection menu. No filler is added when
// fewer than five entries satisfy the caller's explicit constraints.
export function fuzzyCatalogMatches(query, names = itemNames, limit = 5) {
  return rank(query, names, limit).map(({ entry }) => entry.name);
}

// Use only after the exact/alias resolver fails. Close spellings can be
// accepted automatically when every meaningful word is supported by one
// catalogue item, with enough separation from the next candidate.
export function fuzzyUniqueMatch(query, names = itemNames) {
  const found = rank(query, names, 5);
  const first = found[0];
  if (!first || first.avgQuality < 0.68 ||
    (found[1] && first.score - found[1].score < 3)) return null;
  if (!first.entry.wear) return { name: first.entry.name };
  const index = indexFor(names);
  const request = requestFor(query, index);
  if (request.wear) return { name: first.entry.name };
  return { names: first.variants.sort((a, b) => WEARS.indexOf(a.wear) - WEARS.indexOf(b.wear))
    .map((entry) => entry.name) };
}
