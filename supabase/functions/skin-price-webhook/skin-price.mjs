const API = 'https://api.openskin.dev/v1';
const DEFAULT_RATES = [3.5, 3.6, 3.65, 3.7, 3.71, 3.72, 3.73, 3.74, 3.75, 3.76];
const MAX_ITEMS = 10;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export const helpText = `🔎 <b>BUFF163 base price lookup</b>\n\nSend a command in the group:\n<code>/price AK-47 | Redline (Field-Tested)</code>\n\nFor multiple skins, separate names with a semicolon or a new line:\n<code>/price AK-47 | Redline (Field-Tested); AWP | Asiimov (Field-Tested)</code>\n\nAdd <code>rate 3.65</code> for one conversion rate, or <code>rates 3.6, 3.65, 3.7</code> for several. 3.65 means 3,650 VND per CNY. Without a rate, the bot shows 3.50, 3.60, 3.65 and 3.70–3.76.\n\n“Base price” means the cheapest current BUFF163 listing for the exact item and wear. Float, stickers, phases and special patterns can cost more. Quotes are observed prices, not guaranteed trade prices.`;

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
  ['ak', 'ak47'], ['ak47', 'ak47'], ['m4a1s', 'm4a1s'], ['m4a4', 'm4a4'],
  ['fn', 'factorynew'], ['mw', 'minimalwear'], ['ft', 'fieldtested'],
  ['ww', 'wellworn'], ['bs', 'battlescarred'], ['st', 'stattrak'],
]);

function normalizedTokens(value) {
  let cleaned = value.toLowerCase().replaceAll('stat trak', 'stattrak').replaceAll('stat-trak', 'stattrak');
  cleaned = cleaned.replace(/field[\s-]*tested/g, ' fieldtested ').replace(/factory[\s-]*new/g, ' factorynew ')
    .replace(/minimal[\s-]*wear/g, ' minimalwear ').replace(/well[\s-]*worn/g, ' wellworn ')
    .replace(/battle[\s-]*scarred/g, ' battlescarred ').replace(/m4a1[\s-]*s/g, ' m4a1s ')
    .replace(/ak[\s-]*47/g, ' ak47 ');
  return cleaned.split(/[^a-z0-9]+/).filter(Boolean).map((v) => alias.get(v) || v);
}

function searchTerm(query) {
  const generic = new Set(['ak47', 'awp', 'm4a1s', 'm4a4', 'fn', 'mw', 'ft', 'ww', 'bs', 'fieldtested', 'factorynew', 'minimalwear', 'wellworn', 'battlescarred', 'stattrak', 'souvenir', 'knife', 'skin', 'price']);
  const finish = query.split('|')[1]?.split('(')[0]?.trim();
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
  const exact = matches.find((entry) => entry.name.toLowerCase() === query.toLowerCase());
  if (exact) return { name: exact.name };
  const explicitlySpecial = tokens.includes('stattrak') || tokens.includes('souvenir');
  if (!explicitlySpecial) matches = matches.filter((entry) => !entry.is_stattrak && !entry.is_souvenir && !/^(?:Souvenir|StatTrak)/i.test(entry.name));
  if (matches.length === 1) return { name: matches[0].name };
  if (matches.length > 1) return { ambiguous: matches.slice(0, 5).map((entry) => entry.name), more: matches.length > 5 };
  return { missing: true };
}

function formatRate(rate) {
  return rate.toFixed(2);
}

function vnd(cny, rate) {
  return Math.round(cny * rate * 1000).toLocaleString('en-US');
}

function formatQuote(name, result, rates, now) {
  const buff = result?.buff;
  const ask = buff?.native_currency?.code === 'CNY' ? Number(buff.native_currency.ask) : NaN;
  if (!Number.isFinite(ask) || ask <= 0) return `<b>${escapeHtml(name)}</b>\nBUFF163 CNY listing unavailable.\n`;
  const observed = Date.parse(buff.updated_at || '');
  const age = Number.isFinite(observed) ? now - observed : Infinity;
  const freshness = Number.isFinite(observed) ? new Date(observed).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown time';
  const source = /^https:\/\/buff\.163\.com\/goods\/\d+$/.test(result?.links?.buff || '') ? ` · <a href="${result.links.buff}">BUFF listing</a>` : '';
  const stale = age > MAX_AGE_MS || age < -5 * 60 * 1000;
  const lines = [`<b>${escapeHtml(name)}</b>`, `<b>BUFF163 lowest ask: ¥${ask.toFixed(2)} CNY</b>${source}`, `Observed: ${freshness}${stale ? ' ⚠️ stale/uncertain' : ''}`];
  for (const rate of rates) lines.push(`<code>${formatRate(rate)} → ${vnd(ask, rate)} VND</code>`);
  return lines.join('\n') + '\n';
}

export async function buildReply(input, botUsername = '', fetchFn = fetch, now = Date.now()) {
  let parsed;
  try { parsed = parseRequest(input, botUsername); }
  catch (error) { return [escapeHtml(error.message) + '\n\n' + helpText]; }
  const resolved = await Promise.all(parsed.items.map(async (item) => ({ query: item, match: await resolveItem(item, fetchFn) })));
  const names = [...new Set(resolved.filter((r) => r.match.name).map((r) => r.match.name))];
  let data = {};
  if (names.length) {
    const batch = await getJson(`${API}/prices/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: names }),
    }, fetchFn);
    data = batch.data || {};
  }
  const blocks = ['<b>BUFF163 base prices · CNY → VND</b>\nRate units: 1 CNY = rate × 1,000 VND'];
  for (const { query, match } of resolved) {
    if (match.name) blocks.push(formatQuote(match.name, data[match.name], parsed.rates, now));
    else if (match.ambiguous) blocks.push(`<b>${escapeHtml(query)}</b> could mean:\n${match.ambiguous.map((name) => `• ${escapeHtml(name)}`).join('\n')}${match.more ? '\n• …' : ''}\nSend the exact name.`);
    else blocks.push(`<b>${escapeHtml(query)}</b>: no matching item found. Include weapon and wear, such as <code>AK-47 | Redline (Field-Tested)</code>.`);
  }
  blocks.push('Lowest listing only · verify float, stickers and special pattern before buying.');
  const messages = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > 3500) { messages.push(current); current = ''; }
    current += (current ? '\n\n' : '') + block;
  }
  if (current) messages.push(current);
  return messages;
}

export function shouldReply(message, botUsername = '') {
  const text = message?.text || '';
  if (/^\/(?:price|p|find|start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
    const commandTarget = text.match(/^\/\w+@(\w+)/)?.[1];
    return !commandTarget || commandTarget.toLowerCase() === botUsername.toLowerCase();
  }
  return Boolean(botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`));
}

export { DEFAULT_RATES };

