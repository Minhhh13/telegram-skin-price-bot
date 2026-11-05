import test from 'node:test';
import assert from 'node:assert/strict';
import { aiItemSupportedByText, buildReply, escapeHtml, parseRequest, resolveItem, shouldReply } from '../supabase/functions/skin-price-webhook/skin-price.mjs';
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
  const defaults = parseRequest('/price AK-47 | Redline (Field-Tested)').rates;
  assert.deepEqual(defaults, [3.6, 3.65, 3.7, 3.75, 3.78, 3.8]);
  assert.deepEqual(parseRequest('/price AK-47 | Redline (Field-Tested); AWP | Asiimov (Field-Tested) rates 3.6, 3.65'), {
    items: ['AK-47 | Redline (Field-Tested)', 'AWP | Asiimov (Field-Tested)'], rates: [3.6, 3.65],
  });
  assert.deepEqual(parseRequest('@SkinBot find me the base price for AK redline ft rate 3650', 'SkinBot'), {
    items: ['AK redline ft'], rates: [3.65],
  });
  assert.deepEqual(parseRequest('@SkinBot find me the base price for AK redline ft and AWP asiimov ft at 3.7.', 'SkinBot'), {
    items: ['AK redline ft', 'AWP asiimov ft'], rates: [3.7],
  });
  assert.throws(() => parseRequest('/price AK redline ft rate 100'), /Rates must/);
});

test('resolves abbreviated base item without mixing Souvenir or StatTrak', async () => {
  assert.deepEqual(await resolveItem('AK redline ft', mockFetch), { name: 'AK-47 | Redline (Field-Tested)' });
  assert.deepEqual(await resolveItem('AK redline', mockFetch), {
    names: ['AK-47 | Redline (Minimal Wear)', 'AK-47 | Redline (Field-Tested)', 'AK-47 | Redline (Well-Worn)', 'AK-47 | Redline (Battle-Scarred)'],
  });
  assert.deepEqual(await resolveItem('redline ft', mockFetch), {
    ambiguous: ['AK-47 | Redline (Field-Tested)', 'AWP | Redline (Field-Tested)'], more: false,
  });
});

test('local catalog resolves B the Monster without a catalog request or unrelated AI guess', async () => {
  const noNetwork = () => { throw new Error('Catalog lookup should be local'); };
  assert.deepEqual(await resolveItem('Ak bthemonster ft', noNetwork), { name: 'AK-47 | B the Monster (Field-Tested)' });
  assert.deepEqual(await resolveItem('Ak b the monster ft', noNetwork), { name: 'AK-47 | B the Monster (Field-Tested)' });
  assert.deepEqual(await resolveItem('ak nonsense ft', noNetwork), { missing: true });
  assert.equal(aiItemSupportedByText('Ak bthemonster ft', 'AK-47 | Inheritance (Field-Tested)'), false);
  assert.equal(aiItemSupportedByText('Ak bthemonster ft', 'AK-47 | B the Monster (Field-Tested)'), true);
});

test('unspecified wear quotes every available base wear', async () => {
  const reply = (await buildReply('/price AK redline rate 3.65', '', mockFetch, Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /AK-47 \| Redline \(Minimal Wear\)/);
  assert.match(reply, /AK-47 \| Redline \(Field-Tested\)/);
  assert.doesNotMatch(reply, /StatTrak™|Souvenir AK-47/);
});

test('does not present an unfiltered base quote as a float-filtered quote', async () => {
  const reply = (await buildReply('/price AK redline ft float 0.15–0.18', '', mockFetch)).join('\n');
  assert.match(reply, /cannot verify the requested float range/);
  assert.doesNotMatch(reply, /¥160\.99/);
});

test('calculates two item prices from one batch with source time', async () => {
  const replies = await buildReply('/price AK redline ft; AWP asiimov ft rate 3.65', '', mockFetch, Date.parse('2026-11-05T10:30:00Z'));
  assert.equal(replies.length, 1);
  assert.match(replies[0], /¥160\.99 CNY/);
  assert.match(replies[0], /3\.65 → ₫587,614/);
  assert.match(replies[0], /¥617\.00 CNY/);
  assert.match(replies[0], /3\.65 → ₫2,252,050/);
  assert.match(replies[0], /Checked 2026-11-05 10:25 UTC/);
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

test('natural request resolves three skins and quotes the specified Doppler phase', async () => {
  const names = [
    'M4A4 | Howl (Field-Tested)',
    'AWP | Dragon Lore (Factory New)',
    '★ Karambit | Doppler (Factory New)',
    '★ Karambit | Gamma Doppler (Factory New)',
  ];
  const requests = [];
  const fetchItems = async (url, options) => {
    requests.push(url);
    if (url.includes('/items?')) {
      const term = new URL(url).searchParams.get('search').toLowerCase();
      return { ok: true, json: async () => ({ data: names.filter((name) => name.toLowerCase().includes(term)).map((name) => ({ name })) }) };
    }
    if (url.endsWith('/prices/batch')) {
      const items = JSON.parse(options.body).items;
      return { ok: true, json: async () => ({ data: Object.fromEntries(items.map((name) => [name, {
        buff: { native_currency: { code: 'CNY', ask: 100 }, updated_at: observed },
      }])) }) };
    }
    if (url.includes('/prices/buff/phases?')) return { ok: true, json: async () => ({ patterns: [
      { pattern: 'Phase 1', native_currency: { code: 'CNY', ask: 7000 }, updated_at: observed },
      { pattern: 'Phase 2', native_currency: { code: 'CNY', ask: 10200 }, updated_at: observed },
    ] }) };
    throw new Error('Unexpected URL ' + url);
  };
  const reply = (await buildReply('find price for m4 howl ft, awp dragonlore factory new and karambit doppler phase 2', '', fetchItems, Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /M4A4 \| Howl \(Field-Tested\)/);
  assert.match(reply, /AWP \| Dragon Lore \(Factory New\)/);
  assert.match(reply, /Karambit \| Doppler \(Factory New\) · Phase 2 \(FN assumed\)/);
  assert.match(reply, /¥10,200\.00 CNY/);
  assert.match(reply, /3\.78 → ₫38,556,000   \|   3\.80 → ₫38,760,000/);
  assert.equal(requests.filter((url) => url.includes('/prices/buff/phases?')).length, 1);
});

test('Gamma Doppler Phase 2 uses the filtered phase listing, including abbreviated request', async () => {
  const item = '★ Karambit | Gamma Doppler (Factory New)';
  const otherWear = '★ Karambit | Gamma Doppler (Minimal Wear)';
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push(url);
    if (url.includes('/items?')) {
      const term = new URL(url).searchParams.get('search');
      assert.equal(term, 'doppler');
      return { ok: true, json: async () => ({ data: [{ name: item }, { name: otherWear }] }) };
    }
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: { [item]: {
      buff: { native_currency: { code: 'CNY', ask: 8800 }, updated_at: observed },
    } } }) };
    if (url.includes('/prices/buff/phases?')) {
      assert.equal(new URL(url).searchParams.get('item'), item);
      return { ok: true, json: async () => ({ patterns: [
        { pattern: 'Phase 1', native_currency: { code: 'CNY', ask: 10800 }, updated_at: observed },
        { pattern: 'Phase 2', native_currency: { code: 'CNY', ask: 12849.5 }, updated_at: observed },
      ] }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await buildReply('karmabit gamma dop phase 2', '', fetchFn, Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /Karambit \| Gamma Doppler \(Factory New\) · Phase 2/);
  assert.match(reply, /¥12,849\.50 CNY/);
  assert.match(reply, /Phase 2 lowest ask/);
  assert.doesNotMatch(reply, /Minimal Wear/);
  assert.match(reply, /3\.78 → ₫48,571,110   \|   3\.80 → ₫48,828,100/);
  assert.doesNotMatch(reply, /¥8,800\.00 CNY|no matching item found/);
  assert.equal(calls.filter((url) => url.includes('/prices/buff/phases?')).length, 1);
});

test('misspelled Souvenir AWP LongDog does not become AWP Duality', async () => {
  const longDog = 'Souvenir AWP | LongDog (Field-Tested)';
  const fetchFn = async (url, options) => {
    if (url.includes('/items?')) {
      assert.equal(new URL(url).searchParams.get('search'), 'longdog');
      return { ok: true, json: async () => ({ data: [{ name: longDog }, { name: 'Souvenir AWP | Duality (Field-Tested)' }] }) };
    }
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: {
      [longDog]: { buff: { native_currency: { code: 'CNY', ask: 648.9 }, updated_at: observed } },
    } }) };
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await buildReply('awl long dog ouvenir ft', '', fetchFn, Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /Souvenir AWP \| LongDog \(Field-Tested\)/);
  assert.match(reply, /¥648\.90 CNY/);
  assert.doesNotMatch(reply, /Duality/);
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



