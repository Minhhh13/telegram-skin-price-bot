import test from 'node:test';
import assert from 'node:assert/strict';
import { aiItemSupportedByText, buildReply, catalogSuggestionsForText, resolveItem } from '../supabase/functions/skin-price-webhook/skin-price.mjs';
import { itemNames } from '../supabase/functions/skin-price-webhook/catalog.mjs';

test('every exact catalogue name resolves to itself', async () => {
  for (const name of itemNames) assert.deepEqual(await resolveItem(name), { name }, name);
});

test('case-only catalogue collisions require a choice when casing is lost', async () => {
  const upper = 'Sticker | Volt (Gold) | Shanghai 2024';
  const lower = 'Sticker | volt (Gold) | Shanghai 2024';
  assert.deepEqual(await resolveItem(upper), { name: upper });
  assert.deepEqual(await resolveItem(lower), { name: lower });
  const unresolved = await resolveItem('sticker | VOLT (gold) | shanghai 2024');
  assert.deepEqual(new Set(unresolved.ambiguous), new Set([upper, lower]));
});

test('exact catalogue items stay exact across cases, stickers, and bare knives', async () => {
  const names = [
    'Falchion Case',
    'Glove Case',
    'Sticker Capsule',
    'Sticker | Crown (Foil)',
    'Sticker | 00 Nation (Glitter) | Rio 2022',
    'Sticker Slab | 3DMAX (Gold) | Shanghai 2024',
    '★ Talon Knife',
  ];
  for (const name of names) assert.deepEqual(await resolveItem(name), { name }, name);
  assert.deepEqual(await resolveItem('falchion case'), { name: 'Falchion Case' });
  assert.deepEqual(await resolveItem('Falchion Case price'), { name: 'Falchion Case' });
  assert.deepEqual(await resolveItem('price for Falchion Case'), { name: 'Falchion Case' });
  assert.deepEqual(await resolveItem('Sticker Capsule price'), { name: 'Sticker Capsule' });
});

test('exact generic items price only their own catalogue row', async () => {
  for (const [request, name] of [
    ['Falchion Case price', 'Falchion Case'],
    ['price for Glove Case', 'Glove Case'],
    ['Sticker Capsule price', 'Sticker Capsule'],
    ['Sticker | Crown (Foil)', 'Sticker | Crown (Foil)'],
    ['Sticker | 00 Nation (Glitter) | Rio 2022', 'Sticker | 00 Nation (Glitter) | Rio 2022'],
  ]) {
    let calls = 0;
    const fetchFn = async (url, options) => {
      assert.ok(String(url).endsWith('/prices/batch'), request);
      calls++;
      assert.deepEqual(JSON.parse(options.body).items, [name], request);
      return { ok: true, json: async () => ({ data: {
        [name]: { buff: { native_currency: { code: 'CNY', ask: 12.5 }, updated_at: new Date().toISOString() } },
      } }) };
    };
    const reply = (await buildReply(request, '', fetchFn)).join('\n');
    assert.equal(calls, 1, request);
    assert.ok(reply.includes(name), request);
    assert.match(reply, /¥12\.50 CNY/, request);
    assert.doesNotMatch(reply, /possible catalogue matches|could mean:/i, request);
  }
});

test('shortened collectible names price only the identified variant', async () => {
  for (const [request, name] of [
    ['sticker crown foil', 'Sticker | Crown (Foil)'],
    ['00 Nation Glitter Rio 2022 sticker', 'Sticker | 00 Nation (Glitter) | Rio 2022'],
    ['souvenir charm austin 2025 highlight 1 bullet', 'Souvenir Charm | Austin 2025 Highlight | 1 Bullet'],
  ]) {
    let calls = 0;
    const fetchFn = async (url, options) => {
      assert.ok(String(url).endsWith('/prices/batch'), request);
      calls++;
      assert.deepEqual(JSON.parse(options.body).items, [name], request);
      return { ok: true, json: async () => ({ data: {
        [name]: { buff: { native_currency: { code: 'CNY', ask: 12.5 }, updated_at: new Date().toISOString() } },
      } }) };
    };
    const reply = (await buildReply(request, '', fetchFn)).join('\n');
    assert.equal(calls, 1, request);
    assert.ok(reply.includes(name), request);
    assert.match(reply, /¥12\.50 CNY/, request);
  }
});

test('a nonexistent collectible variant never suggests or AI-prices a different one', async () => {
  const request = 'sticker 00 nation gold boston 2018';
  assert.deepEqual(catalogSuggestionsForText(request), []);
  assert.equal(aiItemSupportedByText(request, 'Sticker | 00 Nation (Gold) | Rio 2022'), false);
  let calls = 0;
  const reply = (await buildReply(request, '', async () => { calls++; throw new Error('unexpected price fetch'); })).join('\n');
  assert.equal(calls, 0);
  assert.match(reply, /no matching item found/i);
  for (const category of ['case', 'sticker', 'graffiti', 'charm', 'patch', 'music kit']) {
    assert.deepEqual(await resolveItem(category), { missing: true }, category);
    assert.deepEqual(catalogSuggestionsForText(category), [], category);
  }
});
