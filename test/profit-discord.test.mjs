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
  const setup = signed({ type: 2, data: { name: 'setup' } });
  const modal = JSON.parse((await handler(setup.headers, setup.body)).body);
  assert.equal(modal.type, 9); assert.equal(modal.data.custom_id, 'tdprofit:setup-submit');
  assert.equal(modal.data.components[0].component.custom_id, 'account_id');
  assert.equal(modal.data.components[0].component.max_length, 36);
});

test('setup submit sends only the Account ID privately and succeeds without a website step', async () => {
  const sent = [];
  const handler = createProfitDiscordHandler(config, async (url, options) => {
    if (url.endsWith('/setup')) {
      assert.equal(options.headers.authorization, 'Bearer test-secret');
      const body = JSON.parse(options.body);
      assert.equal(body.accountId, '11111111-1111-4111-8111-111111111111');
      assert.equal(body.discordUserId, userId);
      assert.equal(body.identifier, undefined);
      return { ok: true, json: async () => ({ linked: true }) };
    }
    assert.match(url, /discord\.com\/api\/v10\/webhooks/);
    sent.push(JSON.parse(options.body)); return { ok: true };
  });
  const request = signed({ type: 5, data: { custom_id: 'tdprofit:setup-submit', components: [{ type: 18, component: { type: 4, custom_id: 'account_id', value: '11111111-1111-4111-8111-111111111111' } }] } });
  const initial = JSON.parse((await handler(request.headers, request.body)).body);
  assert.deepEqual(initial, { type: 5, data: { flags: 64 } });
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Account ID saved/);
  assert.doesNotMatch(sent[0].content, /https:|confirm|sign in|11111111/);
  assert.deepEqual(sent[0].components, []);
});

test('setup rejects email addresses and malformed IDs before any backend call', async () => {
  let calls = 0;
  const handler = createProfitDiscordHandler(config, async (_url, options) => { calls++; assert.match(JSON.parse(options.body).content, /UUID format/); return { ok: true }; });
  for (const value of ['member@example.test', 'not-a-uuid']) {
    const request = signed({ type: 5, data: { custom_id: 'tdprofit:setup-submit', components: [{ type: 18, component: { custom_id: 'account_id', value } }] } });
    assert.equal(JSON.parse((await handler(request.headers, request.body)).body).type, 5);
    await flush();
  }
  assert.equal(calls, 2); // Discord private feedback only; no Trade Desk request.
});

test('setup enables automatic text and photo checks while unconfigured photos spend no price or AI call', async () => {
  const state = { linked: false, quotes: 0, gemini: 0, images: 0 }, replies = [];
  const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const identity = { game: '730', name: 'AK-47 | Redline (Field-Tested)', phase: null };
  const photoConfig = { ...config, geminiKey: 'test-photo-key' };
  const fetchFn = async (url, options) => {
    url = String(url);
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: state.linked, rate: { vndPerUsd: 25800 } }) };
    if (url.endsWith('/setup')) {
      assert.equal(JSON.parse(options.body).discordUserId, userId); state.linked = true;
      return { ok: true, json: async () => ({ linked: true }) };
    }
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ version: 'one', items: [identity], ttlMs: 60000 }) };
    if (url.endsWith('/quotes')) {
      state.quotes++; const body = JSON.parse(options.body);
      assert.equal(body.discordUserId, userId); assert.deepEqual(body.items, [identity]);
      return { ok: true, json: async () => ({ items: [{ ...identity, available: true, usdCents: 14500, updatedAt: new Date().toISOString(),
        buff: { available: true, cny: 1000, updatedAt: new Date().toISOString() } }], rate: { vndPerUsd: 25800 } }) };
    }
    if (String(url).includes('cdn.discordapp.com')) { state.images++; return { ok: true, arrayBuffer: async () => imageBytes.buffer }; }
    if (String(url).includes('generativelanguage.googleapis.com')) {
      state.gemini++; const body = JSON.parse(options.body);
      assert.match(body.contents[0].parts[0].text, /这个多少钱|rate 3\.65/);
      assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/png');
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [identity.name] }) }] } }] }) };
    }
    assert.match(String(url), /discord\.com\/api/); return { ok: true };
  };
  const service = createProfitService(photoConfig, fetchFn);
  const attachments = [{ name: 'screenshot.png', contentType: null, size: imageBytes.length, url: 'https://cdn.discordapp.com/attachments/test/photo.png' }]; attachments.size = 1;
  const message = { id: 'message', author: { id: userId, bot: false }, guildId: config.guildId, channelId: config.profitChannelId,
    content: '这个多少钱', attachments, reply: async (value) => replies.push(value),
    channel: { sendTyping: async () => {}, send: async (value) => replies.push(value) } };
  await answerProfitChannelMessage(message, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /Set up your team/);
  assert.deepEqual([state.quotes, state.gemini, state.images], [0, 0, 0]);
  const handler = createProfitDiscordHandler(photoConfig, fetchFn, service);
  const setup = signed({ type: 5, data: { custom_id: 'tdprofit:setup-submit', components: [{ type: 18, component: { custom_id: 'account_id', value: '11111111-1111-4111-8111-111111111111' } }] } });
  await handler(setup.headers, setup.body); await flush();
  await answerProfitChannelMessage({ ...message, content: 'ak redline ft', attachments: { size: 0 } }, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /\$145\.00.*₫3,741,000/);
  assert.equal(state.gemini, 0);
  await answerProfitChannelMessage(message, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /AK-47.*Redline.*Field-Tested/);
  assert.deepEqual([state.quotes, state.gemini, state.images], [2, 1, 1]);
  assert.equal(replies.at(-1).flags, 4);
  assert.ok(replies.at(-1).components.every((row) => row.components.every((component) => component.custom_id !== 'tdprofit:share')));
  await answerProfitChannelMessage({ ...message, content: 'rate 3.65' }, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /\*\*3\.65\*\*/);
  assert.doesNotMatch(replies.at(-1).content, /\*\*3\.60\*\*/);
  assert.deepEqual([state.quotes, state.gemini], [3, 2]);
  await answerProfitChannelMessage({ ...message, content: 'rate 9' }, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /Rates must be 2\.00/);
  assert.deepEqual([state.quotes, state.gemini], [3, 2]);
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

test('plain profit-channel messages automatically check the author without an extra button', async () => {
  const sent = [], message = { id: 'message', author: { id: userId, bot: false }, guildId: config.guildId,
    channelId: config.profitChannelId, content: 'ak redline ft', reply: async (value) => sent.push(value) };
  const seen = [], service = { async lookup(actor, query, selected, extra) { seen.push({ actor, query, selected, rawText: extra.rawText }); return [{ content: 'Personal priced result', components: [] }]; } };
  assert.equal(await answerProfitChannelMessage({ ...message, channelId: 'buff-channel' }, config, service), false);
  assert.equal(await answerProfitChannelMessage(message, config, service), true);
  assert.equal(sent[0].content, 'Personal priced result');
  assert.deepEqual(seen, [{ actor: userId, query: 'ak redline ft', selected: '', rawText: 'ak redline ft' }]);
  await answerProfitChannelMessage({ ...message, content: 'member@example.test' }, config, service);
  assert.doesNotMatch(sent[1].content, /member@example/);
  assert.equal(sent[1].components[0].components[0].custom_id, 'tdprofit:setup');
  assert.equal(seen.length, 1);
});

test('automatic profit reply nonces fit real Discord snowflakes and remain unique per chunk', async () => {
  const sent = [], service = { async lookup() { return [0, 1, 2].map((n) => ({ content: `Result ${n}`, components: [] })); } };
  for (const id of ['1234567890123456789', '12345678901234567890']) {
    const message = { id, author: { id: userId, bot: false }, guildId: config.guildId, channelId: config.profitChannelId,
      content: 'ak redline ft', reply: async (value) => sent.push(value), channel: { send: async (value) => sent.push(value) } };
    await answerProfitChannelMessage(message, config, service);
  }
  assert.equal(sent.length, 6);
  assert.ok(sent.every((payload) => payload.nonce.length <= 25 && payload.enforceNonce === true));
  assert.equal(new Set(sent.map((payload) => payload.nonce)).size, 6);
});

test('unsupported attachment-only posts spend no Gemini or catalogue call and typed text still works', async () => {
  const calls = [], replies = [], identity = { game: '730', name: 'AK-47 | Redline (Field-Tested)', phase: null };
  const photoConfig = { ...config, geminiKey: 'test-photo-key' };
  const fetchFn = async (url) => {
    url = String(url); calls.push(url);
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ version: 'one', items: [identity] }) };
    if (url.endsWith('/quotes')) return { ok: true, json: async () => ({ rate: { vndPerUsd: 25800 }, items: [{ ...identity, available: true, usdCents: 14500,
      updatedAt: new Date().toISOString(), buff: { cny: 1000, available: true, updatedAt: new Date().toISOString() } }] }) };
    throw new Error('unexpected image or Gemini request');
  };
  const service = createProfitService(photoConfig, fetchFn);
  const attachments = [{ name: 'document.pdf', contentType: 'application/pdf', size: 500, url: 'https://cdn.discordapp.com/attachments/test/document.pdf' }]; attachments.size = 1;
  const message = { id: '1234567890123456789', author: { id: userId, bot: false }, guildId: config.guildId, channelId: config.profitChannelId,
    content: '', attachments, reply: async (value) => replies.push(value), channel: { sendTyping: async () => {} } };
  await answerProfitChannelMessage(message, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /supported photo/);
  assert.deepEqual(calls.map((url) => url.split('/').at(-1)), ['status']);
  await answerProfitChannelMessage({ ...message, content: 'ak redline ft' }, photoConfig, service, fetchFn);
  assert.match(replies.at(-1).content, /\$145\.00/);
  assert.deepEqual(calls.map((url) => url.split('/').at(-1)), ['status', 'status', 'catalogue', 'quotes']);
});

test('new command registration adds individual commands without overwriting the existing BUFF command', async () => {
  const names = [];
  await registerProfitCommands(config, async (_url, options) => {
    assert.equal(options.method, 'POST'); names.push(JSON.parse(options.body).name); return { ok: true };
  });
  assert.deepEqual(names, ['profit', 'setup', 'profitsetup', 'ratechange']);
});
