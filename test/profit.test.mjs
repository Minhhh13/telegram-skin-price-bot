import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProfit, convertUsdToVnd, createTradeDeskClient, formatProfitItem, identityId, queryFooter, queryFromMessage, resolveProfitRequest } from '../profit.mjs';
import { createProfitService } from '../profit-discord.mjs';

const now = Date.now();
const identity = { game: '730', name: 'AK-47 | Redline (Field-Tested)', phase: null };
const catalogue = { items: [identity, { game: '730', name: 'AK-47 | Wild Lotus (Factory New)', phase: null },
  { game: '730', name: '★ Butterfly Knife | Doppler (Factory New)', phase: 'Phase 3' },
  { game: '730', name: '★ Butterfly Knife | Gamma Doppler (Factory New)', phase: 'Phase 3' }],
};
catalogue.names = [...new Set(catalogue.items.map((item) => item.name))];
const config = { tradeDeskUrl: 'https://tradedesk.test', tradeDeskKey: 'test-integration-key', guildId: '123456789012345678', profitOwnerId: '123456789012345679' };
const row = { ...identity, usdCents: 14500, available: true, updatedAt: new Date(now).toISOString(),
  buff: { cny: 1000, available: true, updatedAt: new Date(now).toISOString(), url: 'https://buff.163.com/goods/12345' } };

test('profit uses USD cents, full CNY buying units and return on purchase cost', () => {
  assert.deepEqual(calculateProfit({ usdCents: 14500, cny: 1000, vndPerUsd: 26000, buyingRate: 3.65 }),
    { proceeds: 3770000, cost: 3650000, profit: 120000, roi: 120000 / 3650000 * 100, breakEven: 3.77 });
  const loss = calculateProfit({ usdCents: 14500, cny: 1000, vndPerUsd: 26000, buyingRate: 3.8 });
  assert.equal(loss.profit, -30000);
  for (const invalid of [null, NaN, Infinity, 0, -1]) assert.equal(calculateProfit({ usdCents: invalid, cny: 1000, vndPerUsd: 26000, buyingRate: 3.65 }), null);
});

test('currency multiplication rounds exactly with BigInt at the safe-integer boundary', () => {
  const exact = convertUsdToVnd(Number.MAX_SAFE_INTEGER, 99.99);
  assert.equal(exact, 9006298534815517);
  assert.equal(Math.round(Number.MAX_SAFE_INTEGER * 9999 / 10000), exact - 1);
  const result = calculateProfit({ usdCents: Number.MAX_SAFE_INTEGER, cny: 1000000000, vndPerUsd: 99.99, buyingRate: 3.65 });
  assert.equal(result.proceeds, exact);
  assert.equal(result.cost, 3650000000000);
  assert.equal(result.profit, exact - 3650000000000);
  assert.equal(convertUsdToVnd(Number.MAX_SAFE_INTEGER, 1000000), null);
  assert.equal(calculateProfit({ usdCents: 10000, cny: 12.345, vndPerUsd: 26000, buyingRate: 3.65 }), null);
  assert.equal(calculateProfit({ usdCents: 10000, cny: 100, vndPerUsd: 26000.001, buyingRate: 3.65 }), null);
  assert.equal(calculateProfit({ usdCents: 10000, cny: 100, vndPerUsd: 26000, buyingRate: 3.6501 }), null);
  assert.match(formatProfitItem({ ...row, usdCents: Number.MAX_SAFE_INTEGER, buff: { ...row.buff, cny: 1000000000 } }, { vndPerUsd: 99.99 }, [3.65], now), /₫9,006,298,534,815,517/);
});

test('an absent conversion or unavailable or stale price never shows a green profit', () => {
  const fresh = formatProfitItem(row, { vndPerUsd: 26000 }, [3.65], now);
  assert.match(fresh, /🟢 \*\*3\.65\*\*.*\+₫120,000 \(\+3\.29%\)/);
  assert.match(fresh, /\$145\.00.*₫3,770,000/);
  assert.match(formatProfitItem(row,{vndPerUsd:26000},[3.615],now),/\*\*3\.615\*\* · ₫3,615,000/);
  for (const [item, rate] of [
    [row, { vndPerUsd: null }], [{ ...row, available: false }, { vndPerUsd: 26000 }],
    [{ ...row, buff: { ...row.buff, available: false } }, { vndPerUsd: 26000 }],
    [{ ...row, updatedAt: new Date(now - 3 * 3600_000).toISOString() }, { vndPerUsd: 26000 }],
  ]) assert.doesNotMatch(formatProfitItem(item, rate, [3.65], now), /🟢/);
});

test('missing Trade Desk prices stay neutral without a misleading conversion error', () => {
  for (const usdCents of [null, undefined, NaN, 0]) {
    const text = formatProfitItem({ ...row, usdCents, available: false }, { vndPerUsd: 25800 }, undefined, now);
    assert.match(text, /Trade Desk: unavailable/);
    assert.match(text, /⚪ Profit unavailable until both prices are available/);
    assert.doesNotMatch(text, /Currency conversion|🟢|🔴/);
  }
});

test('a known saved Trade Desk price remains visible but cannot produce stale profit', () => {
  const saved = { ...row, usdCents: 71892, available: false, updatedAt: new Date(now - 3 * 3600000).toISOString() };
  const text = formatProfitItem(saved, { vndPerUsd: 25800 }, undefined, now);
  assert.match(text, /Trade Desk: \*\*\$718\.92\*\* → \*\*₫18,548,136\*\*/);
  assert.match(text, /· outdated/);
  assert.match(text, /⚪ Profit unavailable until both current prices are available/);
  assert.doesNotMatch(text, /Currency conversion|🟢|🔴|Sources:|UTC/);
});

test('canonical names preserve commas, articles and terminal punctuation before request parsing', async () => {
  const names = Object.freeze([
    'StatTrak™ Music Kit | Daniel Sadowski, Eye of the Dragon',
    'Music Kit | bbno$, u mad!',
    'The Example Agent | Example Unit',
    'Music Kit | Tigrenok, Clubbing in Georgia',
    'Music Kit | Tigrenok, Clubbing In Georgia',
  ]);
  const source = { names, items: Object.freeze(names.map((name) => ({ game: '730', name, phase: null }))) };
  for (const item of source.items) {
    const match = await resolveProfitRequest(item.name, source);
    assert.deepEqual(match.items, [item]);
    assert.equal(match.unresolved.length, 0);
  }
  const rated = await resolveProfitRequest(`${names[0]} rate 3.78`, source);
  assert.equal(rated.items[0].name, names[0]); assert.deepEqual(rated.rates, [3.78]);
  const folded = await resolveProfitRequest('MUSIC KIT | TIGRENOK, CLUBBING IN GEORGIA', source);
  assert.equal(folded.items.length, 0);
  assert.deepEqual(new Set(folded.unresolved[0].candidates.map((item) => item.name)), new Set(names.slice(3)));
});

test('semicolon and newline compositions preserve whole canonical titles and one shared rate suffix', async () => {
  const first = { game: '730', name: 'StatTrak™ Music Kit | Daniel Sadowski, Eye of the Dragon', phase: null };
  const second = { game: '730', name: 'StatTrak™ Music Kit | Austin Wintory, Desert Fire', phase: null };
  const source = { items: Object.freeze([first, second, identity]), names: Object.freeze([first.name, second.name, identity.name]) };
  for (const separator of ['; ', '\n']) {
    const result = await resolveProfitRequest(`${first.name}${separator}${second.name} rate 3.78`, source);
    assert.deepEqual(result.items, [first, second]);
    assert.deepEqual(result.rates, [3.78]);
    assert.equal(result.unresolved.length, 0);
  }
  const mixed = await resolveProfitRequest(`${first.name}; ak redline ft rates 3.615, 3.78`, source);
  assert.deepEqual(mixed.items, [first, identity]);
  assert.deepEqual(mixed.rates, [3.615, 3.78]);
  assert.equal(mixed.unresolved.length, 0);
  const separateRate = await resolveProfitRequest(`${Array(10).fill(first.name).join('; ')}; rate 3.78`, source);
  assert.deepEqual(separateRate.items, [first]);
  assert.deepEqual(separateRate.rates, [3.78]);
  await assert.rejects(resolveProfitRequest(Array(11).fill(first.name).join('; '), source), /at most 10/);
});

test('multi-item Gemini output with comma-bearing names fetches only the two exact price rows', async () => {
  const items = ['StatTrak™ Music Kit | Daniel Sadowski, Eye of the Dragon', 'StatTrak™ Music Kit | Austin Wintory, Desert Fire']
    .map((name) => ({ game: '730', name, phase: null }));
  let quoteCalls = 0;
  const service = createProfitService({ ...config, geminiKey: 'test-photo-key' }, async (url, options) => {
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ items, version: 'music' }) };
    if (url.includes('generativelanguage.googleapis.com')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
      { text: JSON.stringify({ items: items.map((item) => item.name) }) },
    ] } }] }) };
    assert.ok(url.endsWith('/quotes')); quoteCalls++;
    assert.deepEqual(JSON.parse(options.body).items, items);
    return { ok: true, json: async () => ({ items: items.map((item) => ({ ...row, ...item })), rate: { vndPerUsd: 25800 } }) };
  });
  const result = await service.lookup(config.profitOwnerId, 'rate 3.78', '', { image: { mimeType: 'image/png', base64: 'test-photo' } });
  assert.equal(quoteCalls, 1);
  const text = result.map((message) => message.content).join('\n');
  assert.ok(items.every((item) => text.includes(item.name.replaceAll('|', '\\|'))));
  assert.match(text, /\*\*3\.78\*\*/);
  assert.doesNotMatch(text, /Choose the intended item/);
});

test('exact phase labels and source expiry metadata preserve identity and block outdated profit', async () => {
  const frozen = { ...catalogue, names: Object.freeze([...catalogue.names]), items: Object.freeze([...catalogue.items]) };
  const item = frozen.items[2];
  for (const query of [`${item.name} · ${item.phase}`, `${item.name} ${item.phase}`]) {
    assert.deepEqual((await resolveProfitRequest(query, frozen)).items, [item]);
  }
  const expired = formatProfitItem({ ...row, stale: true, expiresAt: new Date(now - 1000).toISOString() }, { vndPerUsd: 25800 }, undefined, now);
  assert.match(expired, /· outdated/);
  assert.doesNotMatch(expired, /🟢|🔴/);
});

test('profit output is compact while explicit 3.78 requests and freshness checks remain supported', async () => {
  const text = formatProfitItem(row, { vndPerUsd: 25800 }, undefined, now);
  assert.doesNotMatch(text, /Sources:|UTC|3\.78/);
  for (const rate of ['3.60', '3.65', '3.70', '3.75', '3.80']) assert.ok(text.includes(`**${rate}**`));
  assert.match(formatProfitItem(row, { vndPerUsd: 25800 }, [3.78], now), /\*\*3\.78\*\*/);
  assert.deepEqual((await resolveProfitRequest('ak redline ft', catalogue)).rates, [3.6, 3.65, 3.7, 3.75, 3.8]);
  assert.deepEqual((await resolveProfitRequest('ak redline ft rate 3.78', catalogue)).rates, [3.78]);
  assert.doesNotMatch(formatProfitItem({ ...row, updatedAt: new Date(now - 3 * 3600000).toISOString() }, { vndPerUsd: 25800 }, undefined, now), /🟢/);
});

test('profit resolution keeps exact Trade Desk wear and Doppler family/phase', async () => {
  assert.equal((await resolveProfitRequest('ak lotus fn', catalogue)).items[0].name, 'AK-47 | Wild Lotus (Factory New)');
  const assumed = await resolveProfitRequest('btf dopp p3', catalogue);
  assert.deepEqual(assumed.items, [catalogue.items[2]]);
  assert.equal(assumed.assumedFactoryNew.has(identityId(catalogue.items[2])), true);
  assert.deepEqual((await resolveProfitRequest('btf gamma dop p3', catalogue)).items, [catalogue.items[3]]);
  assert.equal((await resolveProfitRequest('btf dopp p4', catalogue)).items.length, 0);
  assert.equal((await resolveProfitRequest('ak redline mw', catalogue)).items.length, 0);
  await assert.rejects(resolveProfitRequest('ak redline float 0.15', catalogue), /float-range/);
});

test('catalogue version checks reuse the identities/index and never cache personal prices', async () => {
  let clock = 1, calls = [];
  const client = createTradeDeskClient({ url: config.tradeDeskUrl, apiKey: config.tradeDeskKey, guildId: config.guildId }, async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer test-integration-key');
    assert.doesNotMatch(url, /test-integration-key/);
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => body.version
      ? { version: 'same', unchanged: true, ttlMs: 60000 } : { version: 'same', items: catalogue.items, ttlMs: 60000 } };
    return { ok: true, json: async () => ({ items: [{ ...row, usdCents: body.discordUserId === 'first' ? 14500 : 14000 }], rate: { vndPerUsd: 26000 } }) };
  }, () => clock);
  const first = await client.catalogue('first');
  assert.equal(await client.catalogue('other'), first);
  clock += 61000;
  assert.equal(await client.catalogue('other'), first);
  assert.equal(calls[1].body.version, 'same');
  assert.equal((await client.quotes('first', [identity])).items[0].usdCents, 14500);
  assert.equal((await client.quotes('other', [identity])).items[0].usdCents, 14000);
  assert.equal(calls.filter((call) => call.url.endsWith('/quotes')).length, 2);
});

test('a warm lookup rechecks personal offer and shared conversion for each member and refresh', async () => {
  let currentUsd = 14500, currentFx = 26000, quoteCalls = 0;
  const service = createProfitService(config, async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ items: catalogue.items, version: 'v1' }) };
    if (url.endsWith('/quotes')) { quoteCalls++; return { ok: true, json: async () => ({ items: [{ ...row, usdCents: body.discordUserId === config.profitOwnerId ? currentUsd : 14000 }], rate: { vndPerUsd: currentFx, updatedAt: new Date().toISOString() } }) }; }
    throw new Error('unexpected API call');
  });
  const first = await service.lookup(config.profitOwnerId, 'ak redline ft rate 3.65');
  assert.match(first[0].content, /₫3,770,000/);
  assert.doesNotMatch(first[0].content, /Sources:|UTC|Estimated profit before extra fees|Reference prices; verify the final trade quote/);
  currentUsd = 15000; currentFx = 27000;
  const refreshed = await service.lookup(config.profitOwnerId, 'ak redline ft rate 3.65');
  assert.match(refreshed[0].content, /₫4,050,000/);
  const other = await service.lookup('123456789012345680', 'ak redline ft rate 3.65');
  assert.match(other[0].content, /\$140\.00/);
  assert.equal(quoteCalls, 3);
});

test('button context is accepted only from the app and preserves the request through restarts', () => {
  const content = 'Result' + queryFooter('ak redline ft rate 3.65');
  assert.equal(queryFromMessage({ author: { id: 'app', bot: true }, content }, 'app'), 'ak redline ft rate 3.65');
  assert.equal(queryFromMessage({ author: { id: 'other', bot: true }, content }, 'app'), '');
  assert.equal(queryFromMessage({ author: { id: 'app', bot: false }, content }, 'app'), '');
  assert.equal(identityId(identity), identityId({ ...identity }));
});

test('unlinked members cannot receive catalogue suggestions or prices', async () => {
  const service = createProfitService(config, async (url) => {
    assert.ok(url.endsWith('/status'));
    return { ok: true, json: async () => ({ linked: false }) };
  });
  const result = await service.lookup('123456789012345680', 'ak redline ft');
  assert.equal(result[0].components[0].components[0].custom_id, 'tdprofit:setup');
  assert.doesNotMatch(result[0].content, /\$/);
});

test('long requests keep every Discord page below its message limit and are never silently truncated', async () => {
  const service = createProfitService(config, async (url) => {
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ items: catalogue.items, version: 'v1' }) };
    if (url.endsWith('/quotes')) return { ok: true, json: async () => ({ items: [row], rate: { vndPerUsd: 26000 } }) };
    return { ok: true, json: async () => ({ linked: true }) };
  });
  const query = 'please '.repeat(140) + 'ak redline ft';
  const pages = await service.lookup(config.profitOwnerId, query);
  assert.ok(pages.length);
  assert.ok(pages.every((page) => page.content.length <= 1900));
  assert.ok(pages.every((page) => page.content.endsWith(queryFooter(query))));
  const userId = '12345678901234567890', mention = `<@${userId}>\n`;
  const automatic = await service.lookup(config.profitOwnerId, query, '', { messageLimit: 1900 - mention.length });
  assert.ok(automatic.every((page) => page.content.length <= 1900 - mention.length));
  assert.ok((mention + automatic[0].content).length <= 1900);
  assert.equal(queryFromMessage({ author: { id: 'app', bot: true }, content: mention + automatic[0].content }, 'app'), query);
  await assert.rejects(service.lookup(config.profitOwnerId, 'x'.repeat(1101)), /at most 1100/);
});
