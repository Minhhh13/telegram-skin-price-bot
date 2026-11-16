import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfitService } from '../profit-discord.mjs';
import { profitQuery, queryFooter, queryFromMessage } from '../profit.mjs';

test('refresh context preserves literal backticks instead of changing an item name', () => {
  for (const query of ['Charm | `Special` Item', 'Music Kit | Double `` Tick, Exact!', 'AK-47 | Redline (Field-Tested) rate 3.615']) {
    const content = '**Result**' + queryFooter(query);
    assert.equal(profitQuery(query), query);
    assert.equal(queryFromMessage({ author: { id: 'app', bot: true }, content }, 'app'), query);
    assert.equal(queryFromMessage({ author: { id: 'other', bot: true }, content }, 'app'), '');
  }
  assert.equal(profitQuery('```text\nak redline ft\n```'), 'ak redline ft');
});

test('search normalization never changes literal Trade Desk quote identities on the wire', async () => {
  const composed = 'AUG | Flame Jörmungandr (Factory New)';
  const names = [composed, composed.normalize('NFD'), '  Exact Agent | Exact Unit  ', 'Charm | `Special` Item'];
  const items = names.map(name => ({ game: '730', name, phase: null }));
  let expected, calls = 0;
  const now = new Date().toISOString();
  const service = createProfitService({ tradeDeskUrl: 'https://tradedesk.test', tradeDeskKey: 'local-test', guildId: 'local-test' }, async (url, options) => {
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ items, version: 'literal-contract' }) };
    assert.ok(url.endsWith('/quotes'));
    const requested = JSON.parse(options.body).items;
    assert.deepEqual(requested, [expected]);
    calls++;
    return { ok: true, json: async () => ({ rate: { vndPerUsd: 25800 }, items: requested.map(item => ({ ...item,
      usdCents: 1000, available: true, updatedAt: now,
      buff: { cny: 100, available: true, updatedAt: now, url: 'https://buff.163.com/goods/1' },
    })) }) };
  });
  for (const item of items) {
    expected = item;
    const messages = await service.lookup('local-test', item.name);
    assert.ok(messages.some(message => message.content.includes('BUFF:')));
  }
  assert.equal(calls, items.length);
});
