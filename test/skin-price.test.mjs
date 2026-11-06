import test from 'node:test';
import assert from 'node:assert/strict';
import { aiItemSupportedByText, buildReply, catalogHintsForText, escapeHtml, isLikelySkinRequest, parseRequest, resolveItem, shouldReply } from '../supabase/functions/skin-price-webhook/skin-price.mjs';
import { createHandler } from '../supabase/functions/skin-price-webhook/handler.mjs';
import { lookupDiscord } from '../discord.mjs';
import { itemNames } from '../supabase/functions/skin-price-webhook/catalog.mjs';

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
  assert.deepEqual(await resolveItem('Ak gold ft', noNetwork), { name: 'AK-47 | Gold Arabesque (Field-Tested)' });
  assert.deepEqual(await resolveItem('Occult glove ft', noNetwork), { name: '★ Sport Gloves | Occult (Field-Tested)' });
  assert.deepEqual(await resolveItem('ak nonsense ft', noNetwork), { missing: true });
  assert.equal(aiItemSupportedByText('Ak bthemonster ft', 'AK-47 | Inheritance (Field-Tested)'), false);
  assert.equal(aiItemSupportedByText('Ak bthemonster ft', 'AK-47 | B the Monster (Field-Tested)'), true);
});

test('local catalog resolves AWP The Prince with omitted article and typo', async () => {
  for (const query of ['AWP prince', 'AWP the price']) {
    const result = await resolveItem(query);
    assert.ok(result.names?.includes('AWP | The Prince (Field-Tested)'), query);
  }
  assert.deepEqual(await resolveItem('AWP price'), { needFinish: 'awp' });
  assert.equal(aiItemSupportedByText('AWP prince ft', 'AWP | The Prince (Field-Tested)'), true);
});

test('M9 weapon type stays fixed when the Slaughter finish is abbreviated', async () => {
  const expected = { name: '★ M9 Bayonet | Slaughter (Factory New)' };
  for (const query of ['M9 slau fn', 'M9 slaughter fn', 'M9 Bayonet slau FN']) {
    assert.deepEqual(await resolveItem(query), expected, query);
  }
  const otherKnife = await resolveItem('Bayonet slaughter fn');
  assert.deepEqual(otherKnife, { name: '★ Bayonet | Slaughter (Factory New)' });
});

test('unique finish words resolve within the named weapon and keep the requested wear', async () => {
  const base = 'AK-47 | Wild Lotus';
  assert.deepEqual(await resolveItem('ak lotus'), { names: [
    `${base} (Factory New)`, `${base} (Minimal Wear)`, `${base} (Field-Tested)`,
    `${base} (Well-Worn)`, `${base} (Battle-Scarred)`,
  ] });
  for (const [wear, full] of [
    ['fn', 'Factory New'], ['ft', 'Field-Tested'], ['ww', 'Well-Worn'], ['bs', 'Battle-Scarred'],
  ]) assert.deepEqual(await resolveItem(`ak lotus ${wear}`), { name: `${base} (${full})` });
  assert.equal(aiItemSupportedByText('ak lotus ft', `${base} (Field-Tested)`), true);
  assert.equal(aiItemSupportedByText('ak lotus ft', `${base} (Factory New)`), false);
  assert.equal(aiItemSupportedByText('ak lotus', `Souvenir ${base}`), false);
  assert.ok((await resolveItem('ak neon ft')).ambiguous?.length > 1);
});

test('catalog matches shorthand, reversed words, and StatTrak without guessing the weapon', async () => {
  assert.deepEqual(await resolveItem('redline awp ft'), { name: 'AWP | Redline (Field-Tested)' });
  assert.deepEqual(await resolveItem('chrome cannon ft'), { name: 'AWP | Chrome Cannon (Field-Tested)' });
  assert.deepEqual(await resolveItem('stt printstream usp mw'), { name: 'StatTrak™ USP-S | Printstream (Minimal Wear)' });
  const ambiguous = await resolveItem('stt printstream ft');
  assert.ok(ambiguous.ambiguous?.some((name) => name.includes('USP-S | Printstream')));
  assert.equal(isLikelySkinRequest('mẹ gia minh'), false);
  assert.equal(isLikelySkinRequest('stt printstream ft'), true);
  assert.equal(isLikelySkinRequest('redline awp ft'), true);
  assert.ok(catalogHintsForText('stt printstream usp mw').some((name) => name.includes('StatTrak™ USP-S | Printstream')));
});

test('unresolved lookup sends the full original request and catalog hints to Gemini', async () => {
  let prompt = '';
  const fetchFn = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      prompt = JSON.parse(options.body).contents[0].parts[0].text;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":["AWP | Redline (Field-Tested)"]}' }] } }] }) };
    }
    return mockFetch(url, options);
  };
  const reply = (await lookupDiscord('redline awp ft plz', null, 'test-key', fetchFn,
    '@Thang Manh Nguyen please find redline awp ft plz for me')).join('\n');
  assert.match(reply, /AWP \| Redline \(Field-Tested\)/);
  assert.match(reply, /¥617\.00 CNY/);
  assert.match(prompt, /Full user message: @Thang Manh Nguyen please find redline awp ft plz for me/);
  assert.match(prompt, /AWP \| Redline/);
});

test('an ambiguous finish does not become an AI-guessed weapon price', async () => {
  const fetchFn = async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) return {
      ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":["AWP | Printstream (Field-Tested)"]}' }] } }] }),
    };
    throw new Error(`Unexpected price lookup: ${url}`);
  };
  const reply = (await lookupDiscord('stt printstream ft', null, 'test-key', fetchFn)).join('\n');
  assert.match(reply, /could mean:/);
  assert.match(reply, /StatTrak™ USP-S \| Printstream/);
  assert.doesNotMatch(reply, /¥\d/);
});

test('unspecified wear quotes every available base wear', async () => {
  const reply = (await buildReply('/price AK redline rate 3.65', '', mockFetch, Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /AK-47 \| Redline \(Minimal Wear\)/);
  assert.match(reply, /AK-47 \| Redline \(Field-Tested\)/);
  assert.doesNotMatch(reply, /StatTrak™|Souvenir AK-47/);
});

test('does not present an unfiltered base quote as a float-filtered quote', async () => {
  const reply = (await buildReply('/price AK redline ft float 0.15–0.18', '', mockFetch)).join('\n');
  assert.match(reply, /cannot verify a BUFF163 float-range price/);
  assert.doesNotMatch(reply, /¥160\.99/);
  const bareFloat = (await buildReply('/price Occult glove 0.22', '', mockFetch)).join('\n');
  assert.match(bareFloat, /recognized the float filter/);
  assert.doesNotMatch(bareFloat, /no matching item found/);
});

test('calculates two item prices from one batch with source time', async () => {
  const replies = await buildReply('/price AK redline ft; AWP asiimov ft rate 3.65', '', mockFetch, Date.parse('2026-11-05T10:30:00Z'));
  assert.equal(replies.length, 1);
  assert.match(replies[0], /¥160\.99 CNY/);
  assert.match(replies[0], /3\.65 → ₫587,614/);
  assert.match(replies[0], /¥617\.00 CNY/);
  assert.match(replies[0], /3\.65 → ₫2,252,050/);
  assert.match(replies[0], /Feed snapshot 2026-11-05 10:25 UTC \(5 min old\)/);
});

test('marks stale quotes and never turns a missing CNY price into a conversion', async () => {
  const stale = await buildReply('/price AK redline ft rate 3.65', '', mockFetch, Date.parse('2026-11-05T13:00:00Z'));
  assert.match(stale[0], /May miss newer listings/);
  const noCny = async (url, options) => url.includes('/items?') ? mockFetch(url, options) : {
    ok: true, json: async () => ({ data: { 'AK-47 | Redline (Field-Tested)': { buff: { ask: 23.98, currency: 'USD' } } } }),
  };
  const missing = await buildReply('/price AK redline ft rate 3.65', '', noCny);
  assert.match(missing[0], /CNY listing unavailable/);
  assert.doesNotMatch(missing[0], /587,614/);
});

test('one transient OpenSkin network failure is retried', async () => {
  let attempts = 0;
  const flakyFetch = async (url, options) => {
    if (url.endsWith('/prices/batch') && attempts++ === 0) throw new TypeError('fetch failed');
    return mockFetch(url, options);
  };
  const reply = (await buildReply('awp redline ft', '', flakyFetch)).join('\n');
  assert.match(reply, /AWP \| Redline \(Field-Tested\)/);
  assert.equal(attempts, 2);
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
  assert.match(reply, /Style filter: <b>Phase 2<\/b>/);
  assert.doesNotMatch(reply, /feed ask/);
  assert.doesNotMatch(reply, /Minimal Wear/);
  assert.match(reply, /3\.78 → ₫48,571,110   \|   3\.80 → ₫48,828,100/);
  assert.doesNotMatch(reply, /¥8,800\.00 CNY|no matching item found/);
  assert.equal(calls.filter((url) => url.includes('/prices/buff/phases?')).length, 1);
});

test('butter gamma p1 fn resolves Butterfly Knife Gamma Doppler Phase 1', async () => {
  const item = '★ Butterfly Knife | Gamma Doppler (Factory New)';
  const fetchFn = async (url, options) => {
    if (url.endsWith('/prices/batch')) {
      assert.deepEqual(JSON.parse(options.body).items, [item]);
      return { ok: true, json: async () => ({ data: { [item]: {
        buff: { native_currency: { code: 'CNY', ask: 9000 }, updated_at: observed },
      } } }) };
    }
    if (url.includes('/prices/buff/phases?')) {
      assert.equal(new URL(url).searchParams.get('item'), item);
      return { ok: true, json: async () => ({ patterns: [
        { pattern: 'Phase 1', native_currency: { code: 'CNY', ask: 12000 }, updated_at: observed },
      ] }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  for (const query of ['butter gamma p1 fn', 'butter gamma phase 1 fn', 'btf gamma p1 fn']) {
    const reply = (await buildReply(query, '', fetchFn, Date.parse('2026-11-05T10:30:00Z'))).join('\n');
    assert.match(reply, /Butterfly Knife \| Gamma Doppler \(Factory New\) · Phase 1/, query);
    assert.match(reply, /¥12,000\.00 CNY/, query);
    assert.doesNotMatch(reply, /¥9,000\.00 CNY|no matching item found/, query);
  }
});

test('every catalogued knife Doppler family resolves from its short model name', async () => {
  const variants = itemNames.filter((name) => /^★ (?!StatTrak).* \| (?:Gamma )?Doppler \(Factory New\)$/.test(name));
  assert.ok(variants.length >= 25);
  for (const name of variants) {
    const [model, finish] = name.slice(2).split(' | ');
    const shortModel = model === 'M9 Bayonet' ? 'M9' : model.replace(/ Knife$/, '');
    const query = `${shortModel} ${finish.replace(/ \(Factory New\)$/, '')} fn`;
    assert.deepEqual(await resolveItem(query, undefined, [name]), { name }, query);
  }
});

test('Butterfly, Flip and Nomad phase requests use the requested Doppler family', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    if (url.endsWith('/prices/batch')) {
      const names = JSON.parse(options.body).items;
      return { ok: true, json: async () => ({ data: Object.fromEntries(names.map((name) => [name, {
        buff: { native_currency: { code: 'CNY', ask: 100 }, updated_at: observed },
      }])) }) };
    }
    if (url.includes('/prices/buff/phases?')) {
      const name = new URL(url).searchParams.get('item');
      calls.push(name);
      return { ok: true, json: async () => ({ patterns: [{ pattern: 'Phase 3',
        native_currency: { code: 'CNY', ask: name.includes('Gamma') ? 300 : 200 }, updated_at: observed,
      }] }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await buildReply(
    'Butterfly doppler phase 3; Butterfly gamma doppler phase 3; Flip doppler phase 3; Nomad phase 3',
    '', fetchFn, Date.parse('2026-11-05T10:30:00Z'),
  )).join('\n');
  for (const label of ['Butterfly Knife | Doppler', 'Butterfly Knife | Gamma Doppler',
    'Flip Knife | Doppler', 'Nomad Knife | Doppler']) {
    assert.match(reply, new RegExp(`${label.replace('|', '\\|')} \\(Factory New\\) · Phase 3`));
  }
  assert.equal(calls.length, 4);
  assert.match(reply, /¥200\.00 CNY/);
  assert.match(reply, /¥300\.00 CNY/);
  const ambiguous = (await buildReply('Butterfly phase 3', '',
    () => { throw new Error('No price request is needed for an ambiguous family'); })).join('\n');
  assert.match(ambiguous, /choose Doppler or Gamma Doppler for Phase 3/);
});

test('Doppler shorthand selects standard Doppler and preserves every requested phase', async () => {
  const phaseCalls = [];
  const fetchFn = async (url, options) => {
    if (url.endsWith('/prices/batch')) {
      const names = JSON.parse(options.body).items;
      return { ok: true, json: async () => ({ data: Object.fromEntries(names.map((name) => [name, {
        buff: { native_currency: { code: 'CNY', ask: 99 }, updated_at: observed },
      }])) }) };
    }
    if (url.includes('/prices/buff/phases?')) {
      const name = new URL(url).searchParams.get('item');
      phaseCalls.push(name);
      return { ok: true, json: async () => ({ patterns: [1, 2, 3, 4].map((n) => ({
        pattern: `Phase ${n}`, native_currency: { code: 'CNY', ask: 1000 + n }, updated_at: observed,
      })) }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const now = Date.parse('2026-11-05T10:30:00Z');
  const multi = (await buildReply('btf doppler p4\nbtf dopp p3', '', fetchFn, now)).join('\n');
  assert.match(multi, /Butterfly Knife \| Doppler \(Factory New\) · Phase 4/);
  assert.match(multi, /Butterfly Knife \| Doppler \(Factory New\) · Phase 3/);
  assert.match(multi, /¥1,004\.00 CNY/);
  assert.match(multi, /¥1,003\.00 CNY/);
  assert.doesNotMatch(multi, /Gamma Doppler|choose Doppler or Gamma Doppler/);
  assert.deepEqual(phaseCalls, ['★ Butterfly Knife | Doppler (Factory New)']);

  for (const [query, model, phase] of [
    ['btf dop p3', 'Butterfly Knife', 3],
    ['butter doppler p4', 'Butterfly Knife', 4],
    ['flip dop p2', 'Flip Knife', 2],
    ['m9 dop p1', 'M9 Bayonet', 1],
    ['btf gamma dop p2', 'Butterfly Knife', 2],
  ]) {
    const reply = (await buildReply(query, '', fetchFn, now)).join('\n');
    const family = query.includes('gamma') ? 'Gamma Doppler' : 'Doppler';
    assert.ok(reply.includes(`${model} | ${family} (Factory New) · Phase ${phase}`), query);
    assert.doesNotMatch(reply, /choose Doppler or Gamma Doppler|no matching item found/, query);
  }
  const unavailable = (await buildReply('nomad gamma p2', '', fetchFn, now)).join('\n');
  assert.match(unavailable, /no matching item found/);
  assert.doesNotMatch(unavailable, /Nomad Knife \| Doppler|¥[\d,]+\.\d{2} CNY/);
});

test('weapon and finish aliases stay tied to catalog items', async () => {
  assert.deepEqual(await resolveItem('m1 print ft'), { name: 'M4A1-S | Printstream (Field-Tested)' });
  assert.deepEqual(await resolveItem('m4 howl ft'), { name: 'M4A4 | Howl (Field-Tested)' });
  assert.deepEqual(await resolveItem('m9 dop fn'), { name: '★ M9 Bayonet | Doppler (Factory New)' });
  assert.ok((await resolveItem('print ft')).ambiguous?.length > 1);
});

test('gemstone style shorthand works for knives beyond M9', async () => {
  const fetchFn = async (url, options) => {
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: {} }) };
    if (url.includes('/prices/buff/phases?')) {
      const name = new URL(url).searchParams.get('item');
      return { ok: true, json: async () => ({ patterns: [{
        pattern: name.includes('Gamma') ? 'Emerald' : 'Ruby',
        native_currency: { code: 'CNY', ask: 1000 }, updated_at: observed,
      }] }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await buildReply('Butterfly ruby; Flip emerald', '', fetchFn,
    Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /Butterfly Knife \| Doppler \(Factory New\) · Ruby/);
  assert.match(reply, /Flip Knife \| Gamma Doppler \(Factory New\) · Emerald/);
  assert.doesNotMatch(reply, /no matching item found|listing unavailable/);
});

test('Talon shorthand and min wear preserve the Ruby style and wear', async () => {
  assert.deepEqual(await resolveItem('talon doppler min'), { name: '★ Talon Knife | Doppler (Minimal Wear)' });
});

test('M9 gemstone names resolve to the correct BUFF Doppler style filters', async () => {
  const doppler = '★ M9 Bayonet | Doppler (Factory New)';
  const gamma = '★ M9 Bayonet | Gamma Doppler (Factory New)';
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: Object.fromEntries(
      JSON.parse(options.body).items.map((name) => [name, { buff: { native_currency: { code: 'CNY', ask: 100 }, updated_at: observed } }]),
    ) }) };
    if (url.includes('/prices/buff/phases?')) {
      const item = new URL(url).searchParams.get('item');
      return { ok: true, json: async () => ({ patterns: item === gamma
        ? [{ pattern: 'Emerald', native_currency: { code: 'CNY', ask: 10000 }, updated_at: observed }]
        : [{ pattern: 'Ruby', native_currency: { code: 'CNY', ask: 9000 }, updated_at: observed }],
      }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await buildReply('/price M9 ruby; M9 emerald; M9 gamma emerald; M9 Bayonet Ruby', '', fetchFn,
    Date.parse('2026-11-05T10:30:00Z'))).join('\n');
  assert.match(reply, /M9 Bayonet \| Doppler \(Factory New\) · Ruby/);
  assert.match(reply, /M9 Bayonet \| Gamma Doppler \(Factory New\) · Emerald/);
  assert.match(reply, /¥9,000\.00 CNY/);
  assert.match(reply, /¥10,000\.00 CNY/);
  assert.doesNotMatch(reply, /which skin finish|no matching item found|¥100\.00 CNY/);
  assert.equal(calls.filter((url) => url.includes('/prices/buff/phases?')).length, 2);
});

test('distinct style lookups overlap with a limit of three and repeated items reuse one fetch', async () => {
  const patterns = new Map([
    ['★ M9 Bayonet | Doppler (Factory New)', 'Ruby'],
    ['★ M9 Bayonet | Gamma Doppler (Factory New)', 'Emerald'],
    ['★ Butterfly Knife | Gamma Doppler (Factory New)', 'Phase 1'],
    ['★ Karambit | Gamma Doppler (Factory New)', 'Phase 2'],
  ]);
  const phaseCalls = [];
  let batchCalls = 0;
  let active = 0;
  let peak = 0;
  const fetchFn = async (url, options) => {
    if (url.endsWith('/prices/batch')) {
      batchCalls++;
      return { ok: true, json: async () => ({ data: Object.fromEntries(
        JSON.parse(options.body).items.map((name) => [name, {
          buff: { native_currency: { code: 'CNY', ask: 100 }, updated_at: observed },
        }]),
      ) }) };
    }
    if (url.includes('/prices/buff/phases?')) {
      const name = new URL(url).searchParams.get('item');
      phaseCalls.push(name);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return { ok: true, json: async () => ({ patterns: [{
        pattern: patterns.get(name), native_currency: { code: 'CNY', ask: 1000 }, updated_at: observed,
      }] }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await buildReply(
    '/price M9 ruby; M9 emerald; butter gamma p1 fn; karambit gamma p2 fn; M9 Bayonet Ruby',
    '', fetchFn, Date.parse('2026-11-05T10:30:00Z'),
  )).join('\n');
  const labels = [
    'M9 Bayonet | Doppler (Factory New) · Ruby',
    'M9 Bayonet | Gamma Doppler (Factory New) · Emerald',
    'Butterfly Knife | Gamma Doppler (Factory New) · Phase 1',
    'Karambit | Gamma Doppler (Factory New) · Phase 2',
  ];
  const positions = labels.map((label) => reply.indexOf(label));
  positions.push(reply.lastIndexOf(labels[0]));
  assert.ok(positions.every((position) => position >= 0));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.equal(batchCalls, 1);
  assert.deepEqual(new Set(phaseCalls), new Set(patterns.keys()));
  assert.equal(phaseCalls.length, patterns.size);
  assert.equal(peak, 3);
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

test('Telegram sends a clear catalog answer without spending a Gemini request', async () => {
  let geminiCalls = 0;
  const sent = [];
  const fakeFetch = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      throw new Error('A clear catalog match should not call Gemini');
    }
    if (url.includes('api.telegram.org')) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return mockFetch(url, options);
  };
  const handler = createHandler({ token: 'test-token', secret: 'test-secret', botUsername: 'SkinBot', geminiKey: 'test-key' }, fakeFetch);
  const response = await handler(new Request('https://example.test/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify({ message: { chat: { id: -100123 }, message_id: 7, text: '/price@SkinBot redline awp ft' } }),
  }));
  assert.equal(response.status, 200);
  assert.equal(geminiCalls, 0);
  assert.match(sent[0].text, /AWP \| Redline \(Field-Tested\)/);
});

test('Telegram sends an unresolved full request and catalog hints to Gemini', async () => {
  let prompt = '';
  const sent = [];
  const fakeFetch = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      prompt = JSON.parse(options.body).contents[0].parts[0].text;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { text: '{"items":["AWP | Redline (Field-Tested)"]}' },
      ] } }] }) };
    }
    if (url.includes('api.telegram.org')) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return mockFetch(url, options);
  };
  const handler = createHandler({ token: 'test-token', secret: 'test-secret', botUsername: 'SkinBot', geminiKey: 'test-key' }, fakeFetch);
  const response = await handler(new Request('https://example.test/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify({ message: { chat: { id: -100123 }, message_id: 8,
      text: '/price@SkinBot please find redline awp ft plz for me' } }),
  }));
  assert.equal(response.status, 200);
  assert.match(prompt, /Full user message: \/price@SkinBot please find redline awp ft plz for me/);
  assert.match(prompt, /AWP \| Redline/);
  assert.match(sent[0].text, /AWP \| Redline \(Field-Tested\)/);
  assert.match(sent[0].text, /¥617\.00 CNY/);
  assert.equal(sent[0].reply_to_message_id, 8);
});

test('Telegram photo lookup sends its caption, catalog hints, and image to Gemini', async () => {
  let prompt = '';
  let inlineImage;
  const sent = [];
  const fakeFetch = async (url, options) => {
    if (url.endsWith('/getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/test.jpg' } }) };
    if (url.includes('/file/bottest-token/')) return { ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer };
    if (url.includes('generativelanguage.googleapis.com')) {
      const parts = JSON.parse(options.body).contents[0].parts;
      prompt = parts[0].text;
      inlineImage = parts[1].inline_data;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { text: '{"items":["AWP | Redline (Field-Tested)"]}' },
      ] } }] }) };
    }
    if (url.endsWith('/sendMessage')) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return mockFetch(url, options);
  };
  const handler = createHandler({ token: 'test-token', secret: 'test-secret', botUsername: 'SkinBot', geminiKey: 'test-key' }, fakeFetch);
  const response = await handler(new Request('https://example.test/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify({ message: { chat: { id: -100123 }, message_id: 9,
      caption: '/price@SkinBot redline awp ft', photo: [{ file_id: 'photo-id', file_size: 3 }] } }),
  }));
  assert.equal(response.status, 200);
  assert.match(prompt, /Full user message: \/price@SkinBot redline awp ft/);
  assert.match(prompt, /AWP \| Redline/);
  assert.equal(inlineImage.mime_type, 'image/jpeg');
  assert.ok(inlineImage.data);
  assert.match(sent[0].text, /AWP \| Redline \(Field-Tested\)/);
});



