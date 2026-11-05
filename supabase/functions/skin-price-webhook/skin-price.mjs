const API = 'https://api.openskin.dev/v1';
const DEFAULT_RATES = [3.6, 3.65, 3.7, 3.75, 3.78, 3.8];
const MAX_ITEMS = 10;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export const helpText = `🔎 <b>BUFF163 base price lookup</b>\n\nSend a command in the group:\n<code>/price AK Redline</code>\n\nLeave out wear to see all available wears, or add FT, MW, FN, WW, or BS for one wear. Separate multiple skins with semicolons, commas, or new lines.\n\nAdd <code>rate 3.65</code> for one conversion rate, or <code>rates 3.6, 3.65, 3.7</code> for several. 3.65 means 3,650 VND per CNY. By default the bot shows 3.60–3.80 in 0.05 steps, plus 3.78, two rates per row.\n\nFor Dopplers, include a style such as Phase 2 to quote the lowest listing with that style filter. Exact float, paint seed and sticker filters are not available through this free price feed. Quotes are observed prices, not guaranteed trade prices.`;
export const floatFilterUnavailable = 'A BUFF163 float-filtered quote needs BUFF listing access. The free OpenSkin feed only has the base listing price, so I cannot verify the requested float range yet.';

export function requestsFloatFilter(text) {
  return /\b(?:float|paint\s*wear|paintwear)\b/i.test(String(text || ''));
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
  ['ak', 'ak47'], ['ak47', 'ak47'], ['m4', 'm4a4'], ['m4a1s', 'm4a1s'], ['m4a4', 'm4a4'],
  ['awl', 'awp'], ['karmabit', 'karambit'], ['dop', 'doppler'], ['ouvenir', 'souvenir'],
  ['fn', 'factorynew'], ['mw', 'minimalwear'], ['ft', 'fieldtested'],
  ['ww', 'wellworn'], ['bs', 'battlescarred'], ['st', 'stattrak'],
]);

function normalizedTokens(value) {
  let cleaned = value.toLowerCase().replaceAll('stat trak', 'stattrak').replaceAll('stat-trak', 'stattrak');
  cleaned = cleaned.replace(/field[\s-]*tested/g, ' fieldtested ').replace(/factory[\s-]*new/g, ' factorynew ')
    .replace(/dragon[\s-]*lore/g, ' dragon lore ').replace(/long[\s-]*dog/g, ' longdog ')
    .replace(/minimal[\s-]*wear/g, ' minimalwear ').replace(/well[\s-]*worn/g, ' wellworn ')
    .replace(/battle[\s-]*scarred/g, ' battlescarred ').replace(/m4a1[\s-]*s/g, ' m4a1s ')
    .replace(/ak[\s-]*47/g, ' ak47 ');
  return cleaned.split(/[^a-z0-9]+/).filter(Boolean).map((v) => alias.get(v) || v);
}

function searchTerm(query) {
  const generic = new Set(['ak47', 'awp', 'm4a1s', 'm4a4', 'karambit', 'butterfly', 'bayonet', 'fn', 'mw', 'ft', 'ww', 'bs', 'fieldtested', 'factorynew', 'minimalwear', 'wellworn', 'battlescarred', 'stattrak', 'souvenir', 'knife', 'skin', 'price']);
  const finish = query.split('|')[1]?.split('(')[0]?.replace(/\b(?:Factory New|Minimal Wear|Field[ -]Tested|Well[ -]Worn|Battle[ -]Scarred|FN|MW|FT|WW|BS)\b/ig, '').trim();
  return finish || normalizedTokens(query).filter((v) => !generic.has(v)).sort((a, b) => b.length - a.length)[0] || query.trim();
}

async function getJson(url, options = {}, fetchFn = fetch) {
  const response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`OpenSkin returned HTTP ${response.status}`);
  return response.json();
}

export async function resolveItem(query, fetchFn = fetch) {
  const term = searchTerm(query);
  const url = `${API}/items?search=${encodeURIComponent(term)}&limit=100`;
  const catalog = await getJson(url, {}, fetchFn);
  const tokens = [...new Set(normalizedTokens(query))];
  let matches = (catalog.data || []).filter((entry) => {
    const candidate = new Set(normalizedTokens(entry.name));
    return tokens.every((token) => candidate.has(token));
  });
  if (tokens.includes('doppler') && !tokens.includes('gamma')) {
    matches = matches.filter((entry) => !normalizedTokens(entry.name).includes('gamma'));
  }
  const exact = matches.find((entry) => entry.name.toLowerCase() === query.toLowerCase());
  if (exact) return { name: exact.name };
  const explicitlySpecial = tokens.includes('stattrak') || tokens.includes('souvenir');
  if (!explicitlySpecial) matches = matches.filter((entry) => !entry.is_stattrak && !entry.is_souvenir && !/^(?:Souvenir|StatTrak)/i.test(entry.name));
  if (matches.length === 1) return { name: matches[0].name };
  const wearTokens = new Set(['factorynew', 'minimalwear', 'fieldtested', 'wellworn', 'battlescarred']);
  if (matches.length > 1 && !tokens.some((token) => wearTokens.has(token))) {
    const baseNames = new Set(matches.map((entry) => entry.name.replace(/ \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '')));
    if (baseNames.size === 1 && matches.every((entry) => / \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/.test(entry.name))) {
      const order = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
      return { names: matches.map((entry) => entry.name).sort((a, b) => order.findIndex((wear) => a.endsWith(`(${wear})`)) - order.findIndex((wear) => b.endsWith(`(${wear})`))) };
    }
  }
  if (matches.length > 1) return { ambiguous: matches.slice(0, 5).map((entry) => entry.name), more: matches.length > 5 };
  return { missing: true };
}

function formatRate(rate) {
  return rate.toFixed(2);
}

function extractPattern(query) {
  const match = String(query).match(/\b(phase\s*[1-4]|black\s*pearl|ruby|sapphire|emerald)\b/i);
  if (!match) return { lookup: query, pattern: '' };
  const pattern = /^phase/i.test(match[1]) ? `Phase ${match[1].match(/[1-4]/)[0]}`
    : /^black/i.test(match[1]) ? 'Black Pearl'
    : match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  let lookup = String(query).slice(0, match.index) + String(query).slice(match.index + match[0].length);
  lookup = lookup.trim().replace(/\s{2,}/g, ' ');
  const hasWear = /\b(?:factory\s*new|minimal\s*wear|field\s*tested|well\s*worn|battle\s*scarred|fn|mw|ft|ww|bs)\b/i.test(lookup);
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
  const source = /^https:\/\/buff\.163\.com\/goods\/\d+$/.test(result?.links?.buff || '')
    ? ` · <a href="${result.links.buff}">${result.phasePattern ? `BUFF item (select ${escapeHtml(result.phasePattern)})` : 'BUFF listing'}</a>` : '';
  const stale = age > MAX_AGE_MS || age < -5 * 60 * 1000;
  const lines = [`<b>${escapeHtml(name)}</b>`];
  if (result.phasePattern) lines.push(`Style filter: <b>${escapeHtml(result.phasePattern)}</b>`);
  else if (/\bdoppler\b/i.test(name)) lines.push('Style filter: All styles (unfiltered)');
  lines.push(`<b>¥${ask.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CNY</b> · BUFF163 ${result.phasePattern ? `${escapeHtml(result.phasePattern)} ` : ''}lowest ask${source}`);
  for (let i = 0; i < rates.length; i += 2) {
    lines.push(`<code>${rates.slice(i, i + 2).map((rate) => `${formatRate(rate)} → ₫${vnd(ask, rate)}`).join('   |   ')}</code>`);
  }
  lines.push(`Checked ${freshness}${stale ? ' ⚠️ stale/uncertain' : ''}`);
  return lines.join('\n') + '\n';
}

export async function buildParsedReply(parsed, fetchFn = fetch, now = Date.now()) {
  if (!Array.isArray(parsed?.items) || !parsed.items.length || parsed.items.length > MAX_ITEMS ||
      !Array.isArray(parsed?.rates) || !parsed.rates.length || parsed.rates.some((r) => !Number.isFinite(r) || r < 2 || r > 6)) {
    return [helpText];
  }
  const resolved = await Promise.all(parsed.items.map(async (item) => {
    const variant = extractPattern(item);
    return { query: item, variant, match: await resolveItem(variant.lookup, fetchFn) };
  }));
  const names = [...new Set(resolved.flatMap((r) => r.match.names || (r.match.name ? [r.match.name] : [])))];
  let data = {};
  if (names.length) {
    const batch = await getJson(`${API}/prices/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: names }),
    }, fetchFn);
    data = batch.data || {};
  }
  const blocks = ['<b>BUFF163 base prices · CNY → VND</b>'];
  for (const { query, variant, match } of resolved) {
    if (match.names) {
      for (const name of match.names) blocks.push(formatQuote(name, data[name], parsed.rates, now));
      continue;
    }
    if (match.name) {
      if (variant.pattern) {
        let phase;
        try {
          const phaseData = await getJson(`${API}/prices/buff/phases?item=${encodeURIComponent(match.name)}`, {}, fetchFn);
          phase = phaseData.patterns?.find((entry) => entry.pattern?.toLowerCase() === variant.pattern.toLowerCase());
        } catch (error) {
          console.error('BUFF phase lookup failed:', error instanceof Error ? error.message : String(error));
        }
        if (!phase) blocks.push(`<b>${escapeHtml(match.name)} · ${escapeHtml(variant.pattern)}</b>\nBUFF163 CNY listing unavailable.`);
        else {
          const result = { ...data[match.name], buff: phase, phasePattern: variant.pattern };
          const label = `${match.name} · ${variant.pattern}${variant.assumedFactoryNew ? ' (FN assumed)' : ''}`;
          blocks.push(formatQuote(label, result, parsed.rates, now));
        }
      } else blocks.push(formatQuote(match.name, data[match.name], parsed.rates, now));
    }
    else if (match.ambiguous) blocks.push(`<b>${escapeHtml(query)}</b> could mean:\n${match.ambiguous.map((name) => `• ${escapeHtml(name)}`).join('\n')}${match.more ? '\n• …' : ''}\nSend the exact name.`);
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

export async function buildReply(input, botUsername = '', fetchFn = fetch, now = Date.now()) {
  if (requestsFloatFilter(input)) return [floatFilterUnavailable];
  let parsed;
  try { parsed = parseRequest(input, botUsername); }
  catch (error) { return [escapeHtml(error.message) + '\n\n' + helpText]; }
  return buildParsedReply(parsed, fetchFn, now);
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



