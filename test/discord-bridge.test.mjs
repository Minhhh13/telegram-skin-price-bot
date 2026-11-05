import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { handleDiscordBridge } from '../supabase/functions/discord-bridge/index.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const config = {
  publicKey: rawPublicKey,
  applicationId: '123', guildId: '456', channelId: '789',
  renderUrl: 'https://telegram-skin-price-bot.onrender.com/discord',
};

function signedRequest(interaction) {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  return new Request('https://example.supabase.co/functions/v1/discord-bridge', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, body,
  });
}

test('valid Discord ping is acknowledged without forwarding', async () => {
  const response = await handleDiscordBridge(signedRequest({ type: 1, application_id: '123' }), config, () => { throw new Error('unexpected forward'); });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});

test('valid /buff is deferred and forwarded with its original signature', async () => {
  const jobs = [];
  let forwarded;
  const request = signedRequest({ type: 2, application_id: '123', guild_id: '456', channel_id: '789', data: { name: 'buff' }, token: 'test-token' });
  const response = await handleDiscordBridge(request, config, (job) => jobs.push(job), async (url, options) => {
    forwarded = { url, options };
    return new Response('{"type":5}', { status: 200 });
  });
  assert.deepEqual(await response.json(), { type: 5 });
  await Promise.all(jobs);
  assert.equal(forwarded.url, config.renderUrl);
  assert.equal(forwarded.options.headers['x-signature-ed25519'], request.headers.get('x-signature-ed25519'));
});

test('other channels are rejected before forwarding', async () => {
  const response = await handleDiscordBridge(signedRequest({ type: 2, application_id: '123', guild_id: '456', channel_id: 'other', data: { name: 'buff' } }), config, () => { throw new Error('unexpected forward'); });
  assert.equal((await response.json()).data.flags, 64);
});

test('tampered payload is rejected', async () => {
  const request = signedRequest({ type: 1, application_id: '123' });
  const response = await handleDiscordBridge(new Request(request.url, { method: 'POST', headers: request.headers, body: '{"type":2}' }), config, () => {});
  assert.equal(response.status, 401);
});
