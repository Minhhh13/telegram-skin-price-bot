import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReply } from '../supabase/functions/skin-price-webhook/skin-price.mjs';

test('quotes the requested Doppler style from the price batch without a second lookup', async () => {
  const item = '★ Butterfly Knife | Doppler (Factory New)';
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push(url);
    assert.equal(url, 'https://api.openskin.dev/v1/prices/batch');
    assert.deepEqual(JSON.parse(options.body).items, [item]);
    return { ok: true, json: async () => ({ data: {
      [item]: {
        buff: {
          native_currency: { code: 'CNY', ask: 100 },
          updated_at: '2026-11-06T09:00:00Z',
          patterns: [{ pattern: 'Phase 4', native_currency: { code: 'CNY', ask: 17299 }, updated_at: '2026-11-06T10:00:00Z' }],
        },
        links: { buff: 'https://buff.163.com/goods/12345' },
      },
    } }) };
  };
  const reply = (await buildReply('btf dopp p4', '', fetchFn, Date.parse('2026-11-06T10:03:00Z'))).join('\n');
  assert.match(reply, /Phase 4/);
  assert.match(reply, /¥17,299\.00 CNY/);
  assert.match(reply, /Feed snapshot 2026-11-06 10:00 UTC \(3 min old\)/);
  assert.doesNotMatch(reply, /¥100\.00 CNY/);
  assert.equal(requests.length, 1);
});
