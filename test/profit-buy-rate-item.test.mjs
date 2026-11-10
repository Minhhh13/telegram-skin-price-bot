import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createProfitDiscordHandler, createProfitService } from '../profit-discord.mjs';
import { formatProfitItem, queryFooter } from '../profit.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const app = '123456789012345678', guild = '123456789012345679', first = '123456789012345680', second = '123456789012345681';
const actor = '123456789012345682';
const config = { publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), applicationId: app,
  guildId: guild, profitChannelIds: [first, second], tradeDeskUrl: 'https://tradedesk.test', tradeDeskKey: 'test-key', geminiKey: 'must-not-be-used' };
const row = (name, phase = null, goods = 1) => ({ game: '730', name, phase, available: true, usdCents: 18000, updatedAt: new Date().toISOString(),
  buff: { cny: 1000, available: true, updatedAt: new Date().toISOString(), url: `https://buff.163.com/goods/${goods}` } });
const nomads = [row('★ Nomad Knife | Marble Fade (Factory New)'), row('★ StatTrak™ Nomad Knife | Marble Fade (Factory New)', null, 2)];
const phases = [row('★ M9 Bayonet | Doppler (Factory New)', 'Phase 2', 3), row('★ M9 Bayonet | Doppler (Factory New)', 'Phase 4', 4)];
const source = (items) => ({ author: { id: app, bot: true },
  content: '**Your Trade Desk profit check**\n\n' + items.map((item) => formatProfitItem(item, { vndPerUsd: 25800 })).join('\n\n') + queryFooter('original multi item lookup') });
function signed(data) {
  const body = JSON.stringify({ application_id: app, guild_id: guild, channel_id: first, token: 'test-token', member: { user: { id: actor } }, ...data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: new Headers({ 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex') }) };
}
const submit = (items, item = '1', rate = '3.615') => ({ type: 5, message: source(items), data: { custom_id: 'tdprofit:buy-rate-submit', components: [
  ...(item === undefined ? [] : [{ type: 18, component: { type: 3, custom_id: 'item', values: [item] } }]),
  { type: 18, component: { type: 4, custom_id: 'buying_rate', value: rate } },
] } });

test('custom buying rate opens an item picker in both channels and preselects only a sole item', async () => {
  const handler = createProfitDiscordHandler(config, async () => assert.fail('Opening a buying rate form must make no requests'));
  for (const channel_id of [first, second]) for (const items of [nomads, phases, [nomads[0]]]) {
    const request = signed({ type: 3, channel_id, message: source(items), data: { custom_id: 'tdprofit:buy-rate' } });
    const modal = JSON.parse((await handler(request.headers, request.body)).body);
    assert.equal(modal.type, 9);
    const picker = modal.data.components[0].component;
    assert.equal(picker.custom_id, 'item'); assert.equal(picker.type, 3);
    assert.deepEqual(picker.options.map((option) => option.value), items.map((_, index) => String(index)));
    assert.equal(picker.options.length, items.length);
    assert.ok(picker.options.every((option) => option.default === (items.length === 1)));
    assert.equal(modal.data.components[1].component.custom_id, 'buying_rate');
    assert.equal(modal.data.components[1].component.type, 4);
    if (items.length === 2) assert.notEqual(picker.options[0].label, picker.options[1].label);
  }
});

test('custom buying rate fetches and recalculates only the selected exact StatTrak or phase identity', { timeout: 5000 }, async () => {
  for (const [items, channel_id, itemIndex, rate] of [[nomads, first, 1, '3650'], [nomads, second, 0, '3.615'], [phases, second, 1, '3,615']]) {
    const selected = items[itemIndex], identity = ({ game, name, phase }) => ({ game, name, phase });
    const requested = [], delivered = [];
    let finish;
    const sent = new Promise((resolve) => { finish = resolve; });
    const fetchMock = async (url, options = {}) => {
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
      if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ version: 'one', items: items.map(identity) }) };
      if (url.endsWith('/quotes')) {
        requested.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ items: [selected], rate: { vndPerUsd: 25800 } }) };
      }
      assert.ok(url.startsWith('https://discord.com/api/v10/webhooks/'), 'No Gemini or unrelated request is needed');
      delivered.push(JSON.parse(options.body)); finish(); return { ok: true };
    };
    const service = createProfitService(config, fetchMock), handler = createProfitDiscordHandler(config, fetchMock, service);
    const request = signed({ ...submit(items, String(itemIndex), rate), channel_id });
    const deferred = JSON.parse((await handler(request.headers, request.body)).body);
    assert.equal(deferred.type, 5); assert.equal(deferred.data.flags, 64);
    await sent;
    assert.equal(requested.length, 1); assert.equal(requested[0].discordUserId, actor);
    assert.deepEqual(requested[0].items, [identity(selected)]);
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0].content.includes(selected.name));
    assert.match(delivered[0].content, rate === '3650' ? /\*\*3\.65\*\*/ : /\*\*3\.615\*\*/);
    assert.doesNotMatch(delivered[0].content, /\*\*3\.60\*\*/);
    assert.deepEqual(delivered[0].allowed_mentions, { parse: [] });
  }
});

test('missing or forged multi-item choices and malformed rates fail before any lookup', async () => {
  let calls = 0;
  const service = { lookup: async () => { calls++; assert.fail('Invalid selection must not look up prices'); } };
  const handler = createProfitDiscordHandler(config, async () => { calls++; assert.fail('No external request expected'); }, service);
  for (const data of [
    submit(nomads, ''), submit(nomads, '99'), submit(nomads, '1.0'), submit(nomads, 'named item'),
    submit(nomads, '1', '3650.5'), submit(nomads, '1', '3.6151'), submit(nomads, '1', '1.99'), submit(nomads, '1', '6.01'),
    { ...submit(nomads), message: { ...source(nomads), author: { id: actor, bot: false } } },
    { type: 3, message: { ...source(nomads), author: { id: actor, bot: false } }, data: { custom_id: 'tdprofit:buy-rate' } },
  ]) {
    const request = signed(data), response = JSON.parse((await handler(request.headers, request.body)).body);
    assert.equal(response.type, 4); assert.equal(response.data.flags, 68);
    assert.match(response.data.content, /Choose an item|Enter a buying rate|Run a new/);
  }
  assert.equal(calls, 0);
});

test('legacy single-item form without item selection remains compatible; old multi-item form never guesses', { timeout: 5000 }, async () => {
  const seen = [];
  let finish;
  const sent = new Promise((resolve) => { finish = resolve; });
  const service = { lookup: async (userId, query) => { seen.push({ userId, query }); return [{ content: 'Selected result', components: [] }]; } };
  const handler = createProfitDiscordHandler(config, async () => { finish(); return { ok: true }; }, service);
  const legacySingle = submit([nomads[1]], ''), legacyMulti = submit(nomads, '');
  for (const data of [legacySingle, legacyMulti]) data.data.components.shift();
  let request = signed(legacyMulti);
  assert.equal(JSON.parse((await handler(request.headers, request.body)).body).type, 4);
  assert.equal(seen.length, 0);
  request = signed(legacySingle);
  assert.equal(JSON.parse((await handler(request.headers, request.body)).body).type, 5);
  await sent;
  assert.deepEqual(seen, [{ userId: actor, query: `${nomads[1].name} rate 3.615` }]);
});
