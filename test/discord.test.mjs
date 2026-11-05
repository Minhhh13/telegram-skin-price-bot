import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDiscordHandler, discordText, splitDiscord } from '../discord.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function signed(payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  return { headers: new Headers({ 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }), body };
}

test('Discord rejects unsigned requests and accepts a signed PING', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' });
  const { headers, body } = signed({ type: 1 });
  assert.deepEqual(await handler(headers, body), { status: 200, body: '{"type":1}' });
  assert.equal((await handler(new Headers(), body)).status, 401);
  assert.equal((await handler(headers, body + ' ')).status, 401);
});

test('Discord blocks a valid command from the wrong channel', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' });
  const { headers, body } = signed({ type: 2, application_id: 'app', guild_id: 'guild', channel_id: 'other', data: { name: 'buff', options: [{ name: 'items', value: 'AK redline ft' }] } });
  const response = await handler(headers, body);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).data.flags, 64);
});

test('Discord prices retain formatting and fit message limits', () => {
  assert.equal(discordText('<b>AK-47</b> <code>3.65 → 587,614 VND</code>'), '**AK-47** `3.65 → 587,614 VND`');
  const chunks = splitDiscord(Array.from({ length: 30 }, () => '3.65 → 587,614 VND').join('\n'), 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});
