import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { isProfitChannel, profitChannelIds } from '../profit-channels.mjs';
import { checkProfitChannelAccess } from '../discord-gateway.mjs';

const guildId = '123456789012345678', first = '123456789012345679', second = '123456789012345680';
test('explicit channel configuration merges legacy and plural IDs without wildcard or name matching', () => {
  const config = { guildId, profitChannelId: first, profitChannelIds: ` ${second},${first},*,trade-desk-profit-checker,,` };
  assert.deepEqual(profitChannelIds(config), [first, second]);
  assert.equal(isProfitChannel(config, guildId, first), true);
  assert.equal(isProfitChannel(config, guildId, second), true);
  assert.equal(isProfitChannel(config, '123456789012345681', second), false);
  assert.equal(isProfitChannel(config, guildId, '123456789012345681'), false);
  assert.equal(isProfitChannel(config, guildId, '*'), false);
  assert.deepEqual(profitChannelIds({ profitChannelId: first }), [first]);
  assert.deepEqual(profitChannelIds({ profitChannelIds: [second] }), [second]);
  assert.deepEqual(profitChannelIds({}), []);
});

test('startup diagnostics check both channels once without sending or altering access', async () => {
  const fetched = [], logged = [];
  const client = { user: { id: '123456789012345682' }, channels: { async fetch(id) {
    fetched.push(id);
    return { guildId, isTextBased: () => true, permissionsFor: () => ({ has: (permission) =>
      permission === PermissionFlagsBits.ViewChannel || id === first && [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory].includes(permission) }) };
  } } };
  const results = await checkProfitChannelAccess(client, { guildId, profitChannelId: first, profitChannelIds: `${first},${second}` },
    { log: (...args) => logged.push(args) });
  assert.deepEqual(fetched, [first, second]);
  assert.deepEqual(results, [{ channelId: first, status: 'ready' }, { channelId: second, status: 'missing access' }]);
  assert.equal(logged.length, 2);
});

test('startup diagnostics do not report ready without reply history permission', async () => {
  const results = await checkProfitChannelAccess({ user: {}, channels: { async fetch() { return {
    guildId, isTextBased: () => true, permissionsFor: () => ({ has: (permission) => permission !== PermissionFlagsBits.ReadMessageHistory }),
  }; } } }, { guildId, profitChannelId: first }, { log: () => {} });
  assert.equal(results[0].status, 'missing access');
});

test('unavailable or slow optional channel diagnostics fail safely within the bound', async () => {
  const results = await checkProfitChannelAccess({ user: {}, channels: { fetch: (id) => id === first ? Promise.reject(new Error('missing')) : new Promise(() => {}) } },
    { guildId, profitChannelIds: [first, second] }, { timeoutMs: 5, log: () => {} });
  assert.ok(results.every((result) => result.status === 'missing access'));
});
