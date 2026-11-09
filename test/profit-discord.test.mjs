import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { answerProfitChannelMessage, createProfitDiscordHandler, createProfitService, registerProfitCommands } from '../profit-discord.mjs';
import { queryFooter } from '../profit.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const config = { publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
  applicationId: '123456789012345678', guildId: '123456789012345679', profitChannelId: '123456789012345680',
  profitOwnerId: '123456789012345681', tradeDeskUrl: 'https://tradedesk.test', tradeDeskKey: 'test-secret', botToken: 'test-token' };
const userId = '123456789012345682';
function signed(data) {
  const body = JSON.stringify({ application_id: config.applicationId, guild_id: config.guildId, channel_id: config.profitChannelId,
    member: { user: { id: userId } }, token: 'interaction-test-token', ...data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: new Headers({ 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex') }) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test('profit interactions require a valid signature, application and dedicated channel', async () => {
  const handler = createProfitDiscordHandler(config, async () => { throw new Error('unexpected fetch'); });
  assert.equal((await handler(new Headers(), '{}')).status, 401);
  const wrong = signed({ type: 2, channel_id: 'other', data: { name: 'profitsetup' } });
  const reply = JSON.parse((await handler(wrong.headers, wrong.body)).body);
  assert.equal(reply.type, 4); assert.equal(reply.data.flags, 68);
  const setup = signed({ type: 2, data: { name: 'profitsetup' } });
  const modal = JSON.parse((await handler(setup.headers, setup.body)).body);
  assert.equal(modal.type, 9); assert.equal(modal.data.custom_id, 'tdprofit:link-submit');
  assert.equal(modal.data.components[0].component.custom_id, 'identifier');
});

test('link submit sends the identifier privately and returns only the signed-in confirmation link', async () => {
  const sent = [];
  const handler = createProfitDiscordHandler(config, async (url, options) => {
    if (url.endsWith('/link-start')) {
      assert.equal(options.headers.authorization, 'Bearer test-secret');
      assert.equal(JSON.parse(options.body).identifier, 'member@example.test');
      return { ok: true, json: async () => ({ authorizationUrl: 'https://tradedesk.test/#discord-link=abc_123', expiresAt: new Date(Date.now() + 600000).toISOString() }) };
    }
    assert.match(url, /discord\.com\/api\/v10\/webhooks/);
    sent.push(JSON.parse(options.body)); return { ok: true };
  });
  const request = signed({ type: 5, data: { custom_id: 'tdprofit:link-submit', components: [{ type: 18, component: { type: 4, custom_id: 'identifier', value: 'member@example.test' } }] } });
  const initial = JSON.parse((await handler(request.headers, request.body)).body);
  assert.deepEqual(initial, { type: 5, data: { flags: 64 } });
  await flush();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].content, /member@example/);
  assert.equal(sent[0].components[0].components[0].url, 'https://tradedesk.test/#discord-link=abc_123');
});

test('only the configured owner can open or submit the weekly rate form', async () => {
  let calls = 0;
  const handler = createProfitDiscordHandler(config, async () => { calls++; throw new Error('unexpected fetch'); });
  for (const data of [{ type: 2, data: { name: 'ratechange' } }, { type: 5, data: { custom_id: 'tdprofit:rate-submit' } }]) {
    const request = signed(data), reply = JSON.parse((await handler(request.headers, request.body)).body);
    assert.match(reply.data.content, /Only the checker owner/); assert.equal(reply.data.flags, 68);
  }
  const owner = signed({ type: 2, member: { user: { id: config.profitOwnerId } }, data: { name: 'ratechange' } });
  assert.equal(JSON.parse((await handler(owner.headers, owner.body)).body).type, 9);
  assert.equal(calls, 0);
});

test('saving weekly rate survives through the Trade Desk backend and prefills the next form', async () => {
  const sent = [], service = createProfitService(config, async (url, options) => {
    assert.ok(url.endsWith('/rate'));
    assert.equal(JSON.parse(options.body).vndPerUsd, 26000);
    return { ok: true, json: async () => ({ rate: { vndPerUsd: 26000, updatedAt: new Date().toISOString() } }) };
  });
  const handler = createProfitDiscordHandler(config, async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; }, service);
  const request = signed({ type: 5, member: { user: { id: config.profitOwnerId } }, data: { custom_id: 'tdprofit:rate-submit', components: [{ type: 18, component: { custom_id: 'vnd_per_usd', value: '26,000' } }] } });
  assert.equal(JSON.parse((await handler(request.headers, request.body)).body).type, 5);
  await flush(); assert.match(sent[0].content, /₫26,000/);
  assert.equal(service.rateModal().data.components[0].component.value, '26000');
});

test('a restarted service preloads the durable shared rate once without polling', async () => {
  let calls = 0;
  const service = createProfitService(config, async (url) => {
    assert.ok(url.endsWith('/rate')); calls++;
    return { ok: true, json: async () => ({ rate: { vndPerUsd: 25800, updatedAt: new Date().toISOString() } }) };
  });
  await service.primeRate();
  assert.equal(service.rateModal().data.components[0].component.value, '25800');
  assert.equal(service.rateModal().data.components[0].component.value, '25800');
  assert.equal(calls, 1);
});

test('a private check uses the clicking member and rejects forged message context', async () => {
  const seen = [], sent = [];
  const service = { lookup: async (actor, query) => { seen.push({ actor, query }); return [{ content: 'Personal result', components: [] }]; },
    isOwner: () => false, errorResponse: () => ({ content: 'Unavailable', components: [] }) };
  const handler = createProfitDiscordHandler(config, async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; }, service);
  const data = { type: 3, data: { custom_id: 'tdprofit:check' }, message: { author: { id: config.applicationId, bot: true }, content: 'Public request' + queryFooter('ak redline ft') } };
  const check = signed(data);
  assert.equal(JSON.parse((await handler(check.headers, check.body)).body).data.flags, 64);
  await flush(); assert.deepEqual(seen, [{ actor: userId, query: 'ak redline ft' }]);
  assert.equal(sent[0].content, 'Personal result');
  const forged = signed({ ...data, message: { ...data.message, author: { id: 'other', bot: true } } });
  assert.equal(JSON.parse((await handler(forged.headers, forged.body)).body).type, 4);
  assert.equal(seen.length, 1);
});

test('plain profit-channel messages perform no API lookup and never expose account identifiers', async () => {
  const sent = [], message = { id: 'message', author: { id: userId, bot: false }, guildId: config.guildId,
    channelId: config.profitChannelId, content: 'ak redline ft', reply: async (value) => sent.push(value) };
  assert.equal(await answerProfitChannelMessage({ ...message, channelId: 'buff-channel' }, config), false);
  assert.equal(await answerProfitChannelMessage(message, config), true);
  assert.equal(sent[0].components[0].components[0].custom_id, 'tdprofit:check');
  assert.match(sent[0].content, /Search: `ak redline ft`/);
  await answerProfitChannelMessage({ ...message, content: 'member@example.test' }, config);
  assert.doesNotMatch(sent[1].content, /member@example/);
  assert.equal(sent[1].components[0].components[0].custom_id, 'tdprofit:link');
});

test('new command registration adds individual commands without overwriting the existing BUFF command', async () => {
  const names = [];
  await registerProfitCommands(config, async (_url, options) => {
    assert.equal(options.method, 'POST'); names.push(JSON.parse(options.body).name); return { ok: true };
  });
  assert.deepEqual(names, ['profit', 'profitsetup', 'ratechange']);
});
