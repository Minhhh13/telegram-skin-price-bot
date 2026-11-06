import { itemNames } from './catalog.mjs';

const API = 'https://api.openskin.dev/v1';
const DEFAULT_RATES = [3.6, 3.65, 3.7, 3.75, 3.78, 3.8];
const MAX_ITEMS = 10;
const MAX_AGE_MS = 5 * 60 * 1000;
const PHASE_LOOKUP_CONCURRENCY = 3;

export const helpText = `🔎 <b>BUFF163 base price lookup</b>\n\nSend a command in the group:\n<code>/price AK Redline</code>\n\nLeave out wear to see all available wears, or add FT, MW, FN, WW, or BS for one wear. Separate multiple skins with semicolons, commas, or new lines.\n\nAdd <code>rate 3.65</code> for one conversion rate, or <code>rates 3.6, 3.65, 3.7</code> for several. 3.65 means 3,650 VND per CNY. By default the bot shows 3.60–3.80 in 0.05 steps, plus 3.78, two rates per row.\n\nFor Dopplers, include a style such as Phase 2 to quote the lowest listing with that style filter. Exact float, paint seed and sticker filters are not available through this free price feed. Quotes are observed prices, not guaranteed trade prices.`;
export const floatFilterUnavailable = 'I recognized the float filter, but cannot verify a BUFF163 float-range price. OpenSkin provides the general item ask, not individual BUFF listings by float. Please check the selected float range on BUFF; I will not quote the unfiltered price as its base.';

export function requestsFloatFilter(text) {
  return /\b(?:float|paint\s*wear|paintwear|0\.\d{1,6})\b/i.test(String(text || ''));
}

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function cleanName(value) {
  return value.trim().replace(/^\s*(?:and\s+)?(?:the\s+)?(?:base\s+price\s+for\s+)?/i, '').trim();
}

export function parseRequest(input, botUsername = '') {
  let text = String(input || '').trim();
  if (text.length > 1800) throw new Error('Request is too long. Send up to 10 skin names.');
  if (botUsername) text = text.replace(new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '');
  text = text.replace(/^\/(?:price|p|find|start|help)(?:@\w+)?\b/i, '').trim();
  text = text.replace(/^(?:please\s+)?(?:find|check|show|look up|what(?:'s| is))\s+(?:me\s+)?(?:the\s+)?(?:current\s+)?(?:buff163?\s+)?(?:base\s+)?(?:price\s+)?(?:for|of)?\s*/i, '');
  text = text.replace(/^(?:these\s+)?items?\s*:?\s*/i, '');
  text = text.replace(/[.?!]+$/, '').trim();

  const rateMatch = text.match(/\b(rates?|at|@)\s*[:=]?\s*((?:\d+(?:\.\d+)?\s*(?:,|\/|&|\band\b)?\s*)+)$/i);
  let rates = DEFAULT_RATES;
  if (rateMatch) {
    const values = [...rateMatch[2].matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    if (!values.length || values.length > 12) throw new Error('Use 1–12 conversion rates, such as rate 3.65.');
    rates = [...new Set(values.map((v) => v >= 100 ? v / 1000 : v))];
    if (rates.some((v) => !Number.isFinite(v) || v < 2 || v > 6)) throw new Error('Rates must be 2.00–6.00 (thousand VND per CNY).');
    text = text.slice(0, rateMatch.index).trim();
  }
  text = text.replace(/\b(?:on\s+)?buff(?:163)?\b\s*$/i, '').replace(/\b(?:in\s+)?cny\b\s*$/i, '').trim();
  const parts = text.split(/\s*[;\n]+\s*|\s*,\s*(?!\d)|\s+and\s+(?=(?:★\s*)?(?:AK|AWP|M4|USP|Glock|Desert|P250|P2000|MP|MAC|FAMAS|Galil|Karambit|Butterfly|Bayonet)\b)/i).map(cleanName).filter(Boolean);
  if (!parts.length) throw new Error('Send /price followed by one or more skin names.');
  if (parts.length > MAX_ITEMS) throw new Error(`Send at most ${MAX_ITEMS} skins per request.`);
  return { items: parts, rates };
}

const alias = new Map([
  ['ak', 'ak47'], ['ak47', 'ak47'], ['m4', 'm4a4'], ['m4a1s', 'm4a1s'], ['m4a4', 'm4a4'], ['m9', 'm9bayonet'],
  ['deagle', 'deserteagle'], ['glock', 'glock18'], ['usp', 'usps'], ['glove', 'gloves'],
  ['butter', 'butterflyknife'], ['btf', 'butterflyknife'], ['talon', 'talonknife'],
  ['awl', 'awp'], ['karmabit', 'karambit'], ['dop', 'doppler'], ['ouvenir', 'souvenir'], ['dlore', 'dragonlore'],
  ['fn', 'factorynew'], ['mw', 'minimalwear'], ['min', 'minimalwear'], ['ft', 'fieldtested'],
  ['ww', 'wellworn'], ['bs', 'battlescarred'], ['st', 'stattrak'], ['stt', 'stattrak'],
]);

function normalizedTokens(value) {
  let cleaned = value.toLowerCase().replaceAll('stat trak', 'stattrak').replaceAll('stat-trak', 'stattrak');
  cleaned = cleaned.replace(/field[\s-]*tested/g, ' fieldtested ').replace(/factory[\s-]*new/g, ' factorynew ')
    .replace(/\bm9\s*bayonet\b/g, ' m9 ')
    .replace(/\btalon\s+knife\b/g, ' talonknife ')
    .replace(/\bbutterfly\s+knife\b/g, ' butterflyknife ')
    .replace(/\busp[\s-]*s\b/g, ' usps ')
    .replace(/dragon[\s-]*lore/g, ' dragon lore ').replace(/long[\s-]*dog/g, ' longdog ')
    .replace(/minimal[\s-]*wear/g, ' minimalwear ').replace(/well[\s-]*worn/g, ' wellworn ')
    .replace(/battle[\s-]*scarred/g, ' battlescarred ').replace(/m4a1[\s-]*s/g, ' m4a1s ')
    .replace(/ak[\s-]*47/g, ' ak47 ');
  return cleaned.split(/[^a-z0-9]+/).filter(Boolean).map((v) => alias.get(v) || v);
}

const wears = new Set(['factorynew', 'minimalwear', 'fieldtested', 'wellworn', 'battlescarred']);
const ignored = new Set(['price', 'skin', 'skins', 'item', 'items', 'buff', 'buff163', 'for', 'a', 'an', 'on', 'in', 'base', 'current', 'find', 'check', 'show', 'me', 'please', 'what', 'is', 'of', 'now', 'how', 'much', 'does', 'cost', 'can', 'you', 'tell', 'the', 'right']);
const special = new Set(['souvenir', 'stattrak', ...wears]);
const weaponNames = [...new Set(itemNames.filter((name) => name.includes('|')).map((name) => normalizedTokens(name.split('|')[0]).filter((token) => !special.has(token)).join('')))].filter(Boolean).sort((a, b) => b.length - a.length);
const weapons = new Set(weaponNames);
function entryFor(name) {
  const [left, right = ''] = name.split('|');
  const tokens = normalizedTokens(name);
  const finishTokens = normalizedTokens((right || name).replace(/\([^)]*\)/g, '')).filter((token) => !special.has(token));
  return { name, tokens, weapon: right ? normalizedTokens(left).filter((token) => !special.has(token)).join('') : '',
    finish: finishTokens.join(''), finishNoArticle: finishTokens.filter((token) => token !== 'the').join(''), finishTokens,
    wear: tokens.find((token) => wears.has(token)) || '', souvenir: tokens.includes('souvenir'), stattrak: tokens.includes('stattrak') };
}
const catalog = itemNames.map(entryFor);
const catalogCueTokens = new Set(catalog.flatMap((entry) => entry.tokens.filter((token) =>
  token.length >= 4 && !ignored.has(token) && !special.has(token))));

export function isLikelySkinRequest(text) {
  const tokens = normalizedTokens(String(text || ''));
  if (tokens.some((token) => ['buff', 'buff163', 'price', 'skin', 'skins'].includes(token))) return true;
  if (tokens.some((token) => catalogCueTokens.has(token))) return true;
  return tokens.some((token) => wears.has(token)) && tokens.some((token) => token.length >= 4 && !ignored.has(token) && !special.has(token));
}

export function catalogHintsForText(text, limit = 16) {
  const tokens = [...new Set(normalizedTokens(String(text || '')).filter((token) =>
    !ignored.has(token) && token !== 'the' && token !== 'phase' && !/^[1-4]$/.test(token)))];
  if (!tokens.length) return [];
  const ranked = [];
  for (const entry of catalog) {
    if (!entry.weapon || !entry.finish) continue;
    let score = 0;
    for (const token of tokens) {
      if (entry.tokens.includes(token)) score += wears.has(token) ? 1 : special.has(token) ? 2 : 3;
      else if (token.length >= 4 && entry.finish.startsWith(token)) score += 2;
    }
    if (entry.stattrak && !tokens.includes('stattrak')) score -= 3;
    if (entry.souvenir && !tokens.includes('souvenir')) score -= 3;
    if (score >= 3) ranked.push({ name: entry.name, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const seen = new Set();
  return ranked.filter(({ name }) => {
    const base = name.replace(/ \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '');
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  }).slice(0, limit).map(({ name }) => name);
}

function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...current) > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

function resolveFromCatalog(query, entries) {
  const corrected = String(query).replace(/\bawp\s+the\s+price\b/i, 'awp the prince');
  const tokens = [...new Set(normalizedTokens(corrected))];
  const baseTokens = tokens.filter((token) => !special.has(token) && !ignored.has(token) && token !== 'the');
  let compact = baseTokens.join('');
  const gloveHint = compact.endsWith('gloves') || compact.startsWith('gloves');
  if (compact.endsWith('gloves') && compact !== 'gloves') compact = compact.slice(0, -6);
  else if (compact.startsWith('gloves') && compact !== 'gloves') compact = compact.slice(6);
  const weapon = weaponNames.find((name) => compact.startsWith(name) || compact.endsWith(name)) || '';
  const wear = tokens.find((token) => wears.has(token)) || '';
  const souvenir = tokens.includes('souvenir');
  const stattrak = tokens.includes('stattrak');
  const finishKey = weapon ? compact.startsWith(weapon) ? compact.slice(weapon.length) : compact.slice(0, -weapon.length) : compact;
  if (!finishKey || finishKey.length < 3) return weapon ? { needFinish: weapon } : { missing: true };
  const maxError = finishKey.length >= 8 ? 2 : finishKey.length >= 5 ? 1 : 0;
  const ranked = [];
  for (const entry of entries) {
    if (weapon && entry.weapon !== weapon) continue;
    if (gloveHint && !entry.weapon.endsWith('gloves')) continue;
    if (wear && entry.wear !== wear) continue;
    if (entry.souvenir !== souvenir || entry.stattrak !== stattrak) continue;
    if (tokens.includes('doppler') && !tokens.includes('gamma') && entry.finish.includes('gamma')) continue;
    if (!entry.finish) continue;
    const error = Math.min(...[...new Set([entry.finish, entry.finishNoArticle])].map((finish) =>
      finish === finishKey ? 0
        : finishKey.length >= 4 && finish.startsWith(finishKey) ? 0.5
        : distance(finishKey, finish, maxError)),
      weapon && finishKey.length >= 4 && entry.finishTokens.includes(finishKey) ? 0.25 : Infinity);
    if (error <= maxError || error === 0.5 || error === 0.25) ranked.push({ entry, error });
  }
  if (!ranked.length) return { missing: true };
  const best = Math.min(...ranked.map((r) => r.error));
  const matches = ranked.filter((r) => r.error === best).map((r) => r.entry);
  if (matches.length === 1) return { name: matches[0].name };
  const baseNames = new Set(matches.map((r) => r.name.replace(/ \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '')));
  if (!wear && baseNames.size === 1 && matches.every((r) => r.wear)) {
    const order = ['factorynew', 'minimalwear', 'fieldtested', 'wellworn', 'battlescarred'];
    return { names: matches.sort((a, b) => order.indexOf(a.wear) - order.indexOf(b.wear)).map((r) => r.name) };
  }
  return { ambiguous: matches.slice(0, 5).map((r) => r.name), more: matches.length > 5 };
}

export function aiItemSupportedByText(source, item) {
  const sourceTokens = normalizedTokens(source);
  const candidate = entryFor(item);
  const sourceWears = [...new Set(sourceTokens.filter((token) => wears.has(token)))];
  const singleItem = (() => {
    try { return parseRequest(source).items.length === 1; } catch { return false; }
  })();
  if (singleItem ? (sourceWears[0] || '') !== candidate.wear
    : candidate.wear && !sourceWears.includes(candidate.wear)) return false;
  if ((!sourceTokens.includes('stattrak') && candidate.stattrak) ||
      (!sourceTokens.includes('souvenir') && candidate.souvenir)) return false;
  if (singleItem && (sourceTokens.includes('stattrak') !== candidate.stattrak ||
      sourceTokens.includes('souvenir') !== candidate.souvenir)) return false;
  const sourceWeapons = sourceTokens.filter((token) => weapons.has(token));
  if (sourceWeapons.length && candidate.weapon && !sourceWeapons.includes(candidate.weapon)) return false;
  const finish = candidate.finishNoArticle;
  const sourceKey = sourceTokens.filter((token) => token !== 'the').join('');
  if (!finish || !sourceKey) return false;
  if (sourceKey.includes(finish)) return true;
  const exactFinishWord = candidate.finishTokens.find((token) => token.length >= 4 &&
    token !== 'the' && sourceTokens.includes(token));
  if (candidate.weapon && sourceWeapons.includes(candidate.weapon) && exactFinishWord) {
    const finishes = new Set(catalog.filter((entry) => entry.weapon === candidate.weapon &&
      entry.souvenir === candidate.souvenir && entry.stattrak === candidate.stattrak &&
      entry.finishTokens.includes(exactFinishWord)).map((entry) => entry.finish));
    if (finishes.size === 1 && finishes.has(candidate.finish)) return true;
  }
  for (let start = 0; start < sourceKey.length; start++) {
    for (let length = Math.max(3, finish.length - 2); length <= Math.min(finish.length + 2, sourceKey.length - start); length++) {
      if (distance(sourceKey.slice(start, start + length), finish, 2) <= 2) return true;
    }
  }
  return false;
}

async function getJson(url, options = {}, fetchFn = fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error(`OpenSkin returned HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      const retryable = error?.message === 'fetch failed' || /^OpenSkin returned HTTP 5\d\d$/.test(error?.message || '');
      if (!retryable || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export async function resolveItem(query, _fetchFn = fetch, names = null) {
  const entries = names ? names.map((name) => entryFor(typeof name === 'string' ? name : name.name)) : catalog;
  return resolveFromCatalog(query, entries);
}

function formatRate(rate) {
  return rate.toFixed(2);
}

function extractPattern(query) {
  const match = String(query).match(/\b(phase\s*[1-4]|p[1-4]|black\s*pearl|ruby|sapphire|emerald)\b/i);
  if (!match) return { lookup: query, pattern: '' };
  const pattern = /^(?:phase|p[1-4]$)/i.test(match[1]) ? `Phase ${match[1].match(/[1-4]/)[0]}`
    : /^black/i.test(match[1]) ? 'Black Pearl'
    : match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  let lookup = String(query).slice(0, match.index) + String(query).slice(match.index + match[0].length);
  lookup = lookup.trim().replace(/\s{2,}/g, ' ');
  // BUFF lists these gemstones as style filters on Doppler items, not as item names.
  const gemstone = ['Ruby', 'Sapphire', 'Black Pearl', 'Emerald'].includes(pattern);
  if (gemstone && /\b(?:m9|m9\s*bayonet)\b/i.test(lookup) && !/\bdop(?:pler)?\b/i.test(lookup)) {
    lookup += pattern === 'Emerald' ? ' Gamma Doppler' : ' Doppler';
  } else if (/^Phase [1-4]$/.test(pattern) && /\bgamma\b/i.test(lookup) && !/\bdop(?:pler)?\b/i.test(lookup)) {
    lookup += ' Doppler';
  } else if (pattern === 'Emerald' && /\bgamma\b/i.test(lookup) && !/\bdop(?:pler)?\b/i.test(lookup)) {
    lookup += ' Doppler';
  }
  const hasWear = /\b(?:factory\s*new|minimal\s*wear|field\s*tested|well\s*worn|battle\s*scarred|fn|mw|min|ft|ww|bs)\b/i.test(lookup);
  const assumedFactoryNew = !hasWear && /\b(?:doppler|dop)\b/i.test(lookup);
  if (assumedFactoryNew) lookup += ' Factory New';
  return { lookup, pattern, assumedFactoryNew };
}

function vnd(cny, rate) {
  return Math.round(Math.round(cny * 100) * Math.round(rate * 1000) / 100).toLocaleString('en-US');
}

function formatQuote(name, result, rates, now) {
  const buff = result?.buff;
  const ask = buff?.native_currency?.code === 'CNY' ? Number(buff.native_currency.ask) : NaN;
  if (!Number.isFinite(ask) || ask <= 0) return `<b>${escapeHtml(name)}</b>\nBUFF163 CNY listing unavailable.\n`;
  const observed = Date.parse(buff.updated_at || '');
  const age = Number.isFinite(observed) ? now - observed : Infinity;
  const freshness = Number.isFinite(observed) ? new Date(observed).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown time';
  const ageLabel = Number.isFinite(observed) && age >= 0 ? ` (${Math.floor(age / 60_000)} min old)` : '';
  const source = /^https:\/\/buff\.163\.com\/goods\/\d+$/.test(result?.links?.buff || '')
    ? ` · <a href="${result.links.buff}">${result.phasePattern ? `BUFF item (select ${escapeHtml(result.phasePattern)})` : 'BUFF listing'}</a>` : '';
  const stale = age > MAX_AGE_MS || age < -5 * 60 * 1000;
  const lines = [`<b>${escapeHtml(name)}</b>`];
  if (result.phasePattern) lines.push(`Style filter: <b>${escapeHtml(result.phasePattern)}</b>`);
  else if (/\bdoppler\b/i.test(name)) lines.push('Style filter: All styles (unfiltered)');
  lines.push(`<b>¥${ask.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CNY</b>${source}`);
  for (let i = 0; i < rates.length; i += 2) {
    lines.push(`<code>${rates.slice(i, i + 2).map((rate) => `${formatRate(rate)} → ₫${vnd(ask, rate)}`).join('   |   ')}</code>`);
  }
  lines.push(`Feed snapshot ${freshness}${ageLabel}${stale ? ' ⚠️ May miss newer listings' : ''}`);
  return lines.join('\n') + '\n';
}

export async function buildParsedReply(parsed, fetchFn = fetch, now = Date.now(), names = null) {
  if (!Array.isArray(parsed?.items) || !parsed.items.length || parsed.items.length > MAX_ITEMS ||
      !Array.isArray(parsed?.rates) || !parsed.rates.length || parsed.rates.some((r) => !Number.isFinite(r) || r < 2 || r > 6)) {
    return [helpText];
  }
  const resolved = await Promise.all(parsed.items.map(async (item) => {
    const variant = extractPattern(item);
    return { query: item, variant, match: await resolveItem(variant.lookup, fetchFn, names) };
  }));
  const priceNames = [...new Set(resolved.flatMap((r) => r.match.names || (r.match.name ? [r.match.name] : [])))];
  let data = {};
  if (priceNames.length) {
    const batch = await getJson(`${API}/prices/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: priceNames }),
    }, fetchFn);
    data = batch.data || {};
  }
  const phaseNames = [...new Set(resolved.filter(({ match, variant }) => match.name && variant.pattern)
    .map(({ match }) => match.name))];
  const phasesByName = new Map();
  let nextPhase = 0;
  await Promise.all(Array.from({ length: Math.min(PHASE_LOOKUP_CONCURRENCY, phaseNames.length) }, async () => {
    while (nextPhase < phaseNames.length) {
      const name = phaseNames[nextPhase++];
      try {
        phasesByName.set(name, await getJson(`${API}/prices/buff/phases?item=${encodeURIComponent(name)}`, {}, fetchFn));
      } catch (error) {
        console.error('BUFF phase lookup failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }));
  const blocks = ['<b>BUFF163 base prices · CNY → VND</b>'];
  for (const { query, variant, match } of resolved) {
    if (match.names) {
      for (const name of match.names) blocks.push(formatQuote(name, data[name], parsed.rates, now));
      continue;
    }
    if (match.name) {
      if (variant.pattern) {
        const phase = phasesByName.get(match.name)?.patterns?.find((entry) =>
          entry.pattern?.toLowerCase() === variant.pattern.toLowerCase());
        if (!phase) blocks.push(`<b>${escapeHtml(match.name)} · ${escapeHtml(variant.pattern)}</b>\nBUFF163 CNY listing unavailable.`);
        else {
          const result = { ...data[match.name], buff: phase, phasePattern: variant.pattern };
          const label = `${match.name} · ${variant.pattern}${variant.assumedFactoryNew ? ' (FN assumed)' : ''}`;
          blocks.push(formatQuote(label, result, parsed.rates, now));
        }
      } else blocks.push(formatQuote(match.name, data[match.name], parsed.rates, now));
    }
    else if (match.ambiguous) blocks.push(`<b>${escapeHtml(query)}</b> could mean:\n${match.ambiguous.map((name) => `• ${escapeHtml(name)}`).join('\n')}${match.more ? '\n• …' : ''}\nSend the exact name.`);
    else if (match.needFinish) blocks.push(`<b>${escapeHtml(query)}</b>: which skin finish? For example, <code>AWP The Prince FT</code> or <code>AWP Redline FT</code>.`);
    else blocks.push(`<b>${escapeHtml(query)}</b>: no matching item found. Include weapon and wear, such as <code>AK-47 | Redline (Field-Tested)</code>.`);
  }
  const messages = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > 3500) { messages.push(current); current = ''; }
    current += (current ? '\n\n' : '') + block;
  }
  if (current) messages.push(current);
  return messages;
}

export async function buildReply(input, botUsername = '', fetchFn = fetch, now = Date.now(), names = null) {
  if (requestsFloatFilter(input)) return [floatFilterUnavailable];
  let parsed;
  try { parsed = parseRequest(input, botUsername); }
  catch (error) { return [escapeHtml(error.message) + '\n\n' + helpText]; }
  return buildParsedReply(parsed, fetchFn, now, names);
}

export function shouldReply(message, botUsername = '') {
  const text = message?.text || message?.caption || '';
  if (/^\/(?:price|p|find|start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
    const commandTarget = text.match(/^\/\w+@(\w+)/)?.[1];
    return !commandTarget || commandTarget.toLowerCase() === botUsername.toLowerCase();
  }
  return Boolean(botUsername && (
    text.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ||
    message?.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase()
  ));
}

export { DEFAULT_RATES };



