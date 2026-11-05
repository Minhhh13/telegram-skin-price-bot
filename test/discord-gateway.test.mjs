import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { answerChannelMessage, shouldHandleChannelMessage, stripBotMention } from '../discord-gateway.mjs';

test('plain Discord messages are scoped to the dedicated channel and use the style filter', async () => {
  const config = { guildId: 'our-guild', channelId: 'buff-channel', applicationId: '1567887370886320190', geminiKey: '' };
  const sent = [];
  const message = {
    author: { bot: false, id: '123456789012345678' }, guildId: 'our-guild', channelId: 'buff-channel',
    content: '<@1567887370886320190> karmabit gamma dop phase 2', attachments: { size: 0 },
    channel: { sendTyping: async () => {}, send: async (value) => sent.push(value) },
    reply: async (value) => sent.push(value),
  };
  assert.equal(shouldHandleChannelMessage({ ...message, channelId: 'other' }, config), false);
  assert.equal(shouldHandleChannelMessage({ ...message, author: { bot: true } }, config), false);
  assert.equal(stripBotMention(message.content, config.applicationId), 'karmabit gamma dop phase 2');
  const fetchFn = async (url, options) => {
    if (url.includes('/items?')) return { ok: true, json: async () => ({ data: [
      { name: '★ Karambit | Gamma Doppler (Factory New)' },
      { name: '★ Karambit | Gamma Doppler (Minimal Wear)' },
    ] }) };
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: {
      '★ Karambit | Gamma Doppler (Factory New)': {
        buff: { native_currency: { code: 'CNY', ask: 8800 }, updated_at: new Date().toISOString() },
        links: { buff: 'https://buff.163.com/goods/43011' },
      },
    } }) };
    if (url.includes('/prices/buff/phases?')) return { ok: true, json: async () => ({ patterns: [
      { pattern: 'Phase 2', native_currency: { code: 'CNY', ask: 12849.5 }, updated_at: new Date().toISOString() },
    ] }) };
    throw new Error(`Unexpected URL ${url}`);
  };
  assert.equal(await answerChannelMessage(message, config, fetchFn), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^<@123456789012345678>/);
  assert.match(sent[0].content, /Style filter: \*\*Phase 2\*\*/);
  assert.match(sent[0].content, /¥12,849\.50 CNY/);
  assert.match(sent[0].content, /3\.78 → ₫48,571,110   \|   3\.80 → ₫48,828,100/);
  assert.equal(sent[0].flags, MessageFlags.SuppressEmbeds);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['123456789012345678'], repliedUser: true });
});
