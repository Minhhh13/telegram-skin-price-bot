import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReply, escapeHtml, parseRequest, resolveItem, shouldReply } from '../supabase/functions/skin-price-webhook/skin-price.mjs';
import { createHandler } from '../supabase/functions/skin-price-webhook/handler.mjs';

const catalog = [
  { name: 'AK-47 | Redline (Field-Tested)', is_stattrak: false, is_souvenir: false },
  { name: 'AK-47 | Redline (Minimal Wear)', is_stattrak: false, is_souvenir: false },
  { name: 'Souvenir AK-47 | Redline (Field-Tested)', is_stattrak: false, is_souvenir: false },
  { name: 'StatTrak™ AK-47 | Redline (Field-Tested)', is_stattrak: true, is_souvenir: false },
  { name: 'AWP | Redline (Field-Tested)', is_stattrak: false, is_souvenir: false },
  { name: 'AWP | Asiimov (Field-Tested)', is_stattrak: false, is_souvenir: false },
];
const observed = '2026-11-05T10:25:00Z';
const prices = Object.fromEntries(catalog.map(({ name }) => [name, {
  buff: { native_currency: { code: 'CNY', ask: name.startsWith('AWP') ? 617 : 160.99 }, updated_at: observed },
  links: { buff: 'https://buff.163.com/goods/33960' },
}]));

async function mockFetch(url, options) {
  if (url.includes('/items?')) {
    const term = new URL(url).searchParams.get('search').toLowerCase();
    return { ok: true, json: async () => ({ data: catalog.filter(({ name }) => name.toLowerCase().includes(term)) }) };
  }
  if (url.endsWith('/prices/batch')) {
    const names = JSON.parse(options.body).items;
    return { ok: true, json: async () => ({ data: Object.fromEntries(names.map((name) => [name, prices[name]])) }) };
  }
  throw new Error('Unexpected URL ' + url);
}

test('parses multiple skins and explicit CNY→VND rates', () => {
  assert.deepEqual(parseRequest('/price AK-47 | Redline (Field-Tested); AWP | Asiimov (Field-Tested) rates 3.6, 3.65'), {
    items: ['AK-47 | Redline (Field-Tested)', 'AWP | Asiimov (Field-Tested)'], rates: [3.6, 3.65],
  });
  assert.deepEqual(parseRequest('@SkinBot find me the base price for AK redline ft rate 3650', 'SkinBot'), {
    items: ['AK redline ft'], rates: [3.65],
  });
  assert.throws(() => parseRequest('/price AK redline ft rate 100'), /Rates must/);
});

test('resolves abbreviated base item without mixing Souvenir or StatTrak', async () => {
  assert.deepEqual(await resolveItem('AK redline ft', mockFetch), { name: 'AK-47 | Redline (Field-Tested)' });
  assert.deepEqual(await resolveItem('redline ft', mockFetch), {
    ambiguous: ['AK-47 | Redline (Field-Tested)', 'AWP | Redline (Field-Tested)'], more: false,
  });
});

test('calculates two item prices from one batch with source time', async () => {
  const replies = await buildReply('/price AK redline ft; AWP asiimov ft rate 3.65', '', mockFetch, Date.parse('2026-11-05T10:30:00Z'));
  assert.equal(replies.length, 1);
  assert.match(replies[0], /¥160\.99 CNY/);
  assert.match(replies[0], /3\.65 → 587,614 VND/);
  assert.match(replies[0], /¥617\.00 CNY/);
  assert.match(replies[0], /3\.65 → 2,252,050 VND/);
  assert.match(replies[0], /Observed: 2026-11-05 10:25 UTC/);
});

test('marks stale quotes and never turns a missing CNY price into a conversion', async () => {
  const stale = await buildReply('/price AK redline ft rate 3.65', '', mockFetch, Date.parse('2026-11-05T13:00:00Z'));
  assert.match(stale[0], /stale\/uncertain/);
  const noCny = async (url, options) => url.includes('/items?') ? mockFetch(url, options) : {
    ok: true, json: async () => ({ data: { 'AK-47 | Redline (Field-Tested)': { buff: { ask: 23.98, currency: 'USD' } } } }),
  };
  const missing = await buildReply('/price AK redline ft rate 3.65', '', noCny);
  assert.match(missing[0], /CNY listing unavailable/);
  assert.doesNotMatch(missing[0], /587,614/);
});

test('ignores unrelated group messages and other bots commands', () => {
  assert.equal(shouldReply({ text: '/price@OtherBot AK redline ft' }, 'SkinBot'), false);
  assert.equal(shouldReply({ text: '/price AK redline ft' }, 'SkinBot'), true);
  assert.equal(shouldReply({ text: 'hello everyone' }, 'SkinBot'), false);
  assert.equal(shouldReply({ text: '@SkinBot price for AK redline ft' }, 'SkinBot'), true);
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
});

test('webhook authenticates the Telegram header and replies in the same chat', async () => {
  const sent = [];
  const fakeFetch = async (url, options) => {
    if (url.includes('api.telegram.org')) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return mockFetch(url, options);
  };
  const handler = createHandler({ token: 'test-token', secret: 'test-secret', botUsername: 'SkinBot' }, fakeFetch);
  const payload = JSON.stringify({ message: { chat: { id: -100123 }, message_id: 42, text: '/price AK redline ft rate 3.65' } });
  const unauthorized = await handler(new Request('https://example.test/telegram', { method: 'POST', body: payload }));
  assert.equal(unauthorized.status, 401);
  assert.equal(sent.length, 0);
  const response = await handler(new Request('https://example.test/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' }, body: payload,
  }));
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, -100123);
  assert.equal(sent[0].reply_to_message_id, 42);
  assert.match(sent[0].text, /¥160\.99/);
});

