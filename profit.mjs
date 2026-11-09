import { createHash } from 'node:crypto';
import { catalogSuggestionsForText, DEFAULT_RATES, extractItemVariant, parseRequest, requestsFloatFilter, resolveItem } from './supabase/functions/skin-price-webhook/skin-price.mjs';

const phases = new Set(['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Ruby', 'Sapphire', 'Emerald', 'Black Pearl']);
export const PROFIT_DEFAULT_RATES = Object.freeze(DEFAULT_RATES.filter((rate) => rate !== 3.78));
export const profitBuyingRates = (rates) => rates === DEFAULT_RATES ? PROFIT_DEFAULT_RATES : rates;
export class TradeDeskError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
export const identityKey = (item) => `${item.game || '730'}\u0000${item.name}\u0000${item.phase || ''}`;
export const identityId = (item) => createHash('sha256').update(identityKey(item)).digest('hex').slice(0, 24);
export const itemLabel = (item) => `${item.name}${item.phase ? ` · ${item.phase}` : ''}`;
const exactProfitCatalogues = new WeakMap();
const PROFIT_RATE_SUFFIX = /\b(rates?|at|@)\s*[:=]?\s*((?:\d+(?:\.\d+)?\s*(?:,|\/|&|\band\b)?\s*)+)$/i;
function parseProfitRateSuffix(text) {
  let rates;
  try { rates = profitBuyingRates(parseRequest(`placeholder ${text}`).rates); }
  catch (error) { throw new TradeDeskError(error.message, 400); }
  if (rates.some((rate) => !decimalUnits(rate, 3))) throw new TradeDeskError('Use at most three decimal places for a CNY buying rate.', 400);
  return rates;
}
function exactProfitCatalogue(catalogue) {
  const saved = exactProfitCatalogues.get(catalogue);
  if (saved) return saved;
  const literal = new Map(), foldedLiteral = new Map(), labels = new Map(), foldedLabels = new Map();
  const add = (map, key, item) => { if (!map.has(key)) map.set(key, []); map.get(key).push(item); };
  for (const item of catalogue.items) {
    add(literal, item.name, item); add(foldedLiteral, item.name.toLowerCase(), item);
    if (item.phase) for (const label of [itemLabel(item), `${item.name} ${item.phase}`]) {
      add(labels, label, item); add(foldedLabels, label.toLowerCase(), item);
    }
  }
  const prepared = { literal, foldedLiteral, labels, foldedLabels };
  if (Object.isFrozen(catalogue.names) || Object.isFrozen(catalogue.items)) exactProfitCatalogues.set(catalogue, prepared);
  return prepared;
}

function exactProfitRequest(text, catalogue) {
  const raw = String(text).replace(/^!profit\b/i, '').trim(), index = exactProfitCatalogue(catalogue);
  const find = (value) => {
    const literal = index.literal.get(value);
    if (literal) return { rows: literal, explicitPhase: false };
    const labeled = index.labels.get(value);
    if (labeled) return { rows: labeled, explicitPhase: true };
    const folded = index.foldedLiteral.get(value.toLowerCase());
    if (folded) return { rows: folded, explicitPhase: false };
    const foldedLabel = index.foldedLabels.get(value.toLowerCase());
    return foldedLabel ? { rows: foldedLabel, explicitPhase: true } : null;
  };
  let match = find(raw), rates = PROFIT_DEFAULT_RATES;
  if (!match) {
    const suffix = raw.match(PROFIT_RATE_SUFFIX);
    if (suffix) {
      match = find(raw.slice(0, suffix.index).trim());
      if (match) {
        rates = parseProfitRateSuffix(suffix[0]);
      }
    }
  }
  if (!match) return null;
  const rows = [...new Map(match.rows.map((item) => [identityKey(item), item])).values()];
  const distinctNames = new Set(rows.map((item) => item.name));
  const plain = rows.filter((item) => !item.phase);
  if (distinctNames.size > 1 || !match.explicitPhase && !plain.length) return {
    items: [], rates, assumedFactoryNew: new Set(), unresolved: [{ query: raw,
      message: distinctNames.size > 1 ? 'Choose the intended item.' : 'Choose a Doppler style.', candidates: rows.slice(0, 5) }],
  };
  const items = match.explicitPhase ? rows : plain;
  if (items.length > 10) throw new TradeDeskError('Send a more specific wear or at most 10 items per check.', 400);
  return { items, rates, unresolved: [], assumedFactoryNew: new Set() };
}
const cleanIdentity = (item) => item && item.game === '730' && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 512 &&
  (item.phase == null || phases.has(item.phase)) ? { game: '730', name: item.name, phase: item.phase || null } : null;

export function createTradeDeskClient({ url, apiKey, guildId }, fetchFn = fetch, now = Date.now) {
  const base = new URL(url || 'https://tradedesk.click');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) throw new Error('Trade Desk must use HTTPS.');
  let cached = null, pending = null;
  const call = async (path, discordUserId, body = {}) => {
    if (!apiKey || !guildId) throw new TradeDeskError('The profit checker is being connected. Please try again shortly.');
    const response = await fetchFn(new URL(`/api/integrations/discord/${path}`, base).href, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, guildId, discordUserId }), redirect: 'error',
      signal: AbortSignal.timeout(path === 'quotes' ? 40_000 : path === 'catalogue' ? 20_000 : 9000),
    });
    if (!response.ok) throw new TradeDeskError(response.status === 403 || response.status === 401
      ? 'Set up an active team Account ID to use the profit checker.'
      : 'Trade Desk prices are temporarily unavailable. Please try again shortly.', response.status);
    return response.json();
  };
  return {
    status: (actor) => call('status', actor),
    setup: (actor, accountId) => call('setup', actor, { accountId }),
    quotes: (actor, items) => call('quotes', actor, { items }),
    rate: (actor, vndPerUsd) => call('rate', actor, vndPerUsd === undefined ? {} : { vndPerUsd }),
    async catalogue(actor) {
      if (cached && cached.until > now()) return cached;
      if (!pending) pending = call('catalogue', actor, cached?.version ? { version: cached.version } : {}).then((result) => {
        if (result.unchanged === true && cached && result.version === cached.version) {
          cached.until = now() + Math.min(60_000, Math.max(1000, Number(result.ttlMs) || 60_000));
          return cached;
        }
        if (!Array.isArray(result.items) || result.items.length > 100_000) throw new TradeDeskError('Trade Desk catalogue is temporarily unavailable.');
        const unique = new Map();
        for (const item of result.items) {
          const valid = cleanIdentity(item);
          if (valid) unique.set(identityKey(valid), valid);
        }
        if (!unique.size) throw new TradeDeskError('Trade Desk catalogue is temporarily unavailable.');
        const items = Object.freeze([...unique.values()].map(Object.freeze));
        cached = { version: typeof result.version === 'string' ? result.version : '', items, names: Object.freeze([...new Set(items.map((item) => item.name))]),
          byId: new Map(items.map((item) => [identityId(item), item])),
          until: now() + Math.min(60_000, Math.max(1000, Number(result.ttlMs) || 60_000)) };
        return cached;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

export async function resolveProfitRequest(text, catalogue) {
  const exact = exactProfitRequest(text, catalogue);
  if (exact) return exact;
  let raw = String(text).replace(/^!profit\b/i, '').trim();
  let segments = raw.split(/\s*[;\r\n]+\s*/).filter(Boolean);
  if (segments.length > 1) {
    let rates = PROFIT_DEFAULT_RATES;
    // A literal last title wins over rate-looking words in the title itself.
    const lastExact = exactProfitRequest(segments.at(-1), catalogue);
    if (!lastExact || lastExact.rates !== PROFIT_DEFAULT_RATES) {
      const suffix = raw.match(PROFIT_RATE_SUFFIX);
      if (suffix) {
        rates = parseProfitRateSuffix(suffix[0]);
        raw = raw.slice(0, suffix.index).trim();
        segments = raw.split(/\s*[;\r\n]+\s*/).filter(Boolean);
      }
    }
    if (segments.length > 10) throw new TradeDeskError('Send at most 10 skins per request.', 400);
    const selected = new Map(), unresolved = [], assumedFactoryNew = new Set();
    for (const segment of segments) {
      const result = await resolveProfitRequest(segment, catalogue);
      if (result.rates !== PROFIT_DEFAULT_RATES) throw new TradeDeskError('Put one shared rate or rates suffix at the end of the request.', 400);
      for (const item of result.items) selected.set(identityKey(item), item);
      unresolved.push(...result.unresolved);
      for (const key of result.assumedFactoryNew || []) assumedFactoryNew.add(key);
    }
    if (selected.size > 10) throw new TradeDeskError('Send a more specific wear or at most 10 items per check.', 400);
    return { items: [...selected.values()], rates, unresolved, assumedFactoryNew };
  }
  if (requestsFloatFilter(text)) throw new TradeDeskError('Exact float-range prices are unavailable. Enter a wear such as FN, MW, FT, WW or BS.', 400);
  let parsed;
  try { parsed = parseRequest(String(text).replace(/^!profit\b/i, '').trim()); }
  catch (error) { throw new TradeDeskError(error.message, 400); }
  parsed.rates = profitBuyingRates(parsed.rates);
  if (parsed.rates.some((rate) => !decimalUnits(rate, 3))) throw new TradeDeskError('Use at most three decimal places for a CNY buying rate.', 400);
  const selected = new Map(), unresolved = [], assumedFactoryNew = new Set();
  const expand = (name, pattern = '') => catalogue.items.filter((item) => item.name === name &&
    (!pattern || item.phase?.toLowerCase() === pattern.toLowerCase()));
  for (const query of parsed.items) {
    const variant = extractItemVariant(query);
    if (variant.needDopplerFamily) {
      unresolved.push({ query, message: `Choose Doppler or Gamma Doppler for ${variant.pattern}.`, candidates: [] });
      continue;
    }
    const match = await resolveItem(variant.lookup, undefined, catalogue.names);
    const names = match.names || (match.name ? [match.name] : []);
    if (names.length) {
      const rows = names.flatMap((name) => expand(name, variant.pattern));
      if (variant.assumedFactoryNew) for (const item of rows) assumedFactoryNew.add(identityId(item));
      if (!variant.pattern && rows.some((item) => item.phase)) {
        const plain = rows.filter((item) => !item.phase);
        if (plain.length) for (const item of plain) selected.set(identityKey(item), item);
        else unresolved.push({ query, message: 'Choose a Doppler style.', candidates: rows.slice(0, 5) });
      } else if (rows.length) for (const item of rows) selected.set(identityKey(item), item);
      else unresolved.push({ query, message: 'That exact style is unavailable in the Trade Desk catalogue.', candidates: [] });
    } else {
      const candidates = (match.ambiguous || catalogSuggestionsForText(variant.lookup, 5, catalogue.names))
        .flatMap((name) => expand(name, variant.pattern)).slice(0, 5);
      unresolved.push({ query, message: candidates.length ? 'Choose the intended item.' : 'No matching Trade Desk item found. Try more of its name.', candidates });
    }
  }
  if (selected.size > 10) throw new TradeDeskError('Send a more specific wear or at most 10 items per check.', 400);
  return { items: [...selected.values()], rates: parsed.rates, unresolved, assumedFactoryNew };
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
// Quantize the decimal representation exactly; reject sub-cent/sub-rate input
// rather than silently rounding an unrepresentable currency amount.
function decimalUnits(value, places) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const digits = match[1] + (match[2] || ''), shift = Number(match[3] || 0) + places - (match[2]?.length || 0);
  let units = BigInt(digits);
  if (shift >= 0) {
    if (shift > 16) return null;
    units *= 10n ** BigInt(shift);
  } else {
    if (-shift > digits.length) return null;
    const divisor = 10n ** BigInt(-shift);
    if (units % divisor !== 0n) return null;
    units /= divisor;
  }
  return units > 0n && units <= MAX_SAFE ? units : null;
}
const halfUp = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
export function convertUsdToVnd(usdCents, vndPerUsd) {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0 || vndPerUsd > 1_000_000) return null;
  const fxUnits = decimalUnits(vndPerUsd, 2);
  if (!fxUnits) return null;
  const result = halfUp(BigInt(usdCents) * fxUnits, 10_000n);
  return result <= MAX_SAFE ? Number(result) : null;
}
export function convertCnyCentsToVnd(cnyCents, rate) {
  const cents = typeof cnyCents === 'bigint' ? cnyCents : Number.isSafeInteger(cnyCents) ? BigInt(cnyCents) : null;
  if (cents === null || cents <= 0n || cents > MAX_SAFE || rate < 1 || rate > 10) return null;
  const rateUnits = decimalUnits(rate, 3);
  if (!rateUnits) return null;
  const result = halfUp(cents * rateUnits, 100n);
  return result > 0n && result <= MAX_SAFE ? Number(result) : null;
}
export function calculateProfit({ usdCents, cny, vndPerUsd, buyingRate }) {
  if (buyingRate < 2 || buyingRate > 6) return null;
  const cnyUnits = decimalUnits(cny, 2), rateUnits = decimalUnits(buyingRate, 3);
  const proceeds = convertUsdToVnd(usdCents, vndPerUsd);
  if (!cnyUnits || !rateUnits || proceeds === null) return null;
  const cost = convertCnyCentsToVnd(cnyUnits, buyingRate);
  if (cost === null) return null;
  const profit = proceeds - cost;
  return { proceeds, cost, profit, roi: profit / cost * 100, breakEven: proceeds / cny / 1000 };
}

const money = (value) => `₫${Math.round(value).toLocaleString('en-US')}`;
const centsText = (value) => `${(value / 100n).toLocaleString('en-US')}.${String(value % 100n).padStart(2, '0')}`;
const safe = (text) => String(text).replace(/@/g, '@\u200b').replace(/([\\`*_~|])/g, '\\$1');
export function formatProfitItem(item, rate, rates = PROFIT_DEFAULT_RATES, now = Date.now()) {
  const usd = typeof item.usdCents === 'number' ? item.usdCents : NaN, cny = Number(item.buff?.cny), fx = Number(rate?.vndPerUsd);
  const sourceCurrent = (value) => Number.isFinite(Date.parse(value || '')) && now - Date.parse(value) <= 2 * 60 * 60_000 && Date.parse(value) <= now + 5 * 60_000;
  const tdKnown = usd > 0 && Number.isSafeInteger(usd);
  const tdExpiry = Date.parse(item.expiresAt || '');
  const tdStale = item.stale === true || !sourceCurrent(item.updatedAt) || Number.isFinite(tdExpiry) && tdExpiry <= now;
  const tdAvailable = item.available === true && tdKnown && !tdStale;
  const buffAvailable = item.buff?.available === true && decimalUnits(cny, 2) !== null;
  const proceeds = convertUsdToVnd(usd, fx);
  const current = tdAvailable && buffAvailable && sourceCurrent(item.updatedAt) && sourceCurrent(item.buff.updatedAt);
  const lines = [`**${safe(itemLabel(item))}${item.assumedFactoryNew ? ' (FN assumed)' : ''}**`];
  lines.push(`Trade Desk: ${tdKnown ? `**$${centsText(BigInt(usd))}**${proceeds !== null ? ` → **${money(proceeds)}**` : ''}${tdStale ? ' · outdated' : item.available !== true ? ' · unavailable' : ''}` : 'unavailable'}`);
  const url = /^https:\/\/buff\.163\.com\/goods\/\d+$/.test(item.buff?.url || '') ? ` · [BUFF listing](<${item.buff.url}>)` : '';
  lines.push(`BUFF: ${buffAvailable ? `**¥${centsText(decimalUnits(cny, 2))} CNY**${url}` : 'unavailable'}`);
  if (!tdKnown || !buffAvailable) lines.push('⚪ Profit unavailable until both prices are available.');
  else if (!(fx > 0)) lines.push('⚪ The owner needs to set the weekly USD→VND rate with /ratechange.');
  else if (proceeds === null) lines.push('⚪ Currency conversion is unavailable for this amount.');
  else if (!current) lines.push('⚪ Profit unavailable until both current prices are available.');
  else {
    for (const buyingRate of rates) {
      const result = calculateProfit({ usdCents: usd, cny, vndPerUsd: fx, buyingRate });
      if (!result) continue;
      const sign = result.profit > 0 ? '+' : result.profit < 0 ? '−' : '';
      const rateLabel=buyingRate.toFixed(3).replace(/0$/, '');
      lines.push(`${result.profit > 0 ? '🟢' : result.profit < 0 ? '🔴' : '⚪'} **${rateLabel}** · ${money(result.cost)} · **${sign}${money(Math.abs(result.profit))} (${result.roi >= 0 ? '+' : ''}${result.roi.toFixed(2)}%)**`);
    }
    const cnyUnits = decimalUnits(cny, 2);
    if (cnyUnits) {
      const thousandths = halfUp(BigInt(proceeds) * 100n, cnyUnits);
      lines.push(`Break-even buying rate: **${thousandths / 1000n}.${String(thousandths % 1000n).padStart(3, '0')}**`);
    }
  }
  return lines.join('\n');
}

export function profitQuery(text) { return String(text || '').replace(/```|`/g, '').replace(/[\r\n]+/g, '; ').trim(); }
export const queryFooter = (text) => `\n\nSearch: \`${profitQuery(text)}\``;
export function queryFromMessage(message, applicationId) {
  if (message?.author?.id !== applicationId || message.author.bot !== true) return '';
  return String(message.content || '').match(/\n\nSearch: `([^`]{1,1100})`$/)?.[1] || '';
}
