import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { answerChannelMessage, shouldHandleChannelMessage, stripBotMention } from '../discord-gateway.mjs';

test('plain Discord messages are scoped to the dedicated channel and use the style filter', async () => {
  const config = { guildId: 'our-guild', channelId: 'buff-channel', applicationId: '1567887370886320190', geminiKey: '' };
  const sent = [];
  const message = {
    id: '123456789012345679',
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
  assert.equal(sent[0].nonce, '123456789012345679:0');
  assert.equal(sent[0].enforceNonce, true);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['123456789012345678'], repliedUser: true });
  assert.equal(sent[0].components[0].components[0].custom_id, 'buff:customer-quote');
  assert.equal(sent[0].components[0].components[1].custom_id, 'buff:custom-rate');
});

test('a Chinese BUFF screenshot follows the Discord photo path to the canonical item price', async () => {
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const attachments = [{ url: 'https://cdn.discordapp.com/attachments/test/photo.webp', contentType: 'image/webp', size: webp.length }];
  attachments.size = 1;
  const sent = [];
  const message = {
    id: '123456789012345680', author: { bot: false, id: '123456789012345678' },
    guildId: 'our-guild', channelId: 'buff-channel', content: '', attachments,
    channel: { sendTyping: async () => {}, send: async (value) => sent.push(value) },
    reply: async (value) => sent.push(value),
  };
  const config = { guildId: 'our-guild', channelId: 'buff-channel', applicationId: '1567887370886320190', geminiKey: 'test-key' };
  const fetchFn = async (url, options) => {
    const target = String(url);
    if (target.includes('cdn.discordapp.com')) return { ok: true, arrayBuffer: async () => webp.buffer };
    if (target.includes('generativelanguage.googleapis.com')) {
      const request = JSON.parse(options.body);
      assert.equal(request.contents[0].parts[1].inline_data.mime_type, 'image/webp');
      assert.match(request.contents[0].parts[0].text, /Simplified Chinese BUFF163/);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { text: JSON.stringify({ items: ['★ Flip Knife | Damascus Steel (Factory New)'] }) },
      ] } }] }) };
    }
    if (target.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: {
      '★ Flip Knife | Damascus Steel (Factory New)': {
        buff: { native_currency: { code: 'CNY', ask: 777 }, updated_at: new Date().toISOString() },
        links: { buff: 'https://buff.163.com/goods/12345' },
      },
    } }) };
    throw new Error(`Unexpected URL ${target}`);
  };
  assert.equal(await answerChannelMessage(message, config, fetchFn), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /★ Flip Knife \| Damascus Steel \(Factory New\)/);
  assert.match(sent[0].content, /¥777\.00 CNY/);
});

test('a Discord PNG without contentType is downloaded and recognized', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachments = [{ url: 'https://cdn.discordapp.com/attachments/test/screenshot.png',
    name: 'screenshot.png', contentType: null, size: png.length, width: 900, height: 600 }];
  attachments.size = 1;
  const sent = [];
  const message = {
    id: '123456789012345681', author: { bot: false, id: '123456789012345678' },
    guildId: 'our-guild', channelId: 'buff-channel', content: '', attachments,
    channel: { sendTyping: async () => {} }, reply: async (value) => sent.push(value),
  };
  const seen = [];
  const fetchFn = async (url, options) => {
    const target = String(url);
    if (target.includes('cdn.discordapp.com')) {
      seen.push('cdn');
      return { ok: true, arrayBuffer: async () => png.buffer };
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      seen.push('gemini');
      assert.equal(JSON.parse(options.body).contents[0].parts[1].inline_data.mime_type, 'image/png');
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { text: JSON.stringify({ items: ['AK-47 | Redline (Field-Tested)'] }) },
      ] } }] }) };
    }
    if (target.endsWith('/prices/batch')) {
      seen.push('price');
      return { ok: true, json: async () => ({ data: {
        'AK-47 | Redline (Field-Tested)': {
          buff: { native_currency: { code: 'CNY', ask: 120 }, updated_at: new Date().toISOString() },
        },
      } }) };
    }
    throw new Error(`Unexpected URL ${target}`);
  };
  assert.equal(await answerChannelMessage(message, {
    guildId: 'our-guild', channelId: 'buff-channel', applicationId: '1567887370886320190', geminiKey: 'test-key',
  }, fetchFn), true);
  assert.deepEqual(seen, ['cdn', 'gemini', 'price']);
  assert.match(sent[0].content, /AK-47 \| Redline \(Field-Tested\)/);
});

test('a fake PNG without contentType is rejected before Gemini', async () => {
  const fake = Uint8Array.from([1, 2, 3, 4]);
  const attachments = [{ url: 'https://cdn.discordapp.com/attachments/test/fake.png',
    name: 'fake.png', contentType: null, size: fake.length, width: 900, height: 600 }];
  attachments.size = 1;
  const sent = [];
  const message = {
    id: '123456789012345682', author: { bot: false, id: '123456789012345678' },
    guildId: 'our-guild', channelId: 'buff-channel', content: '', attachments,
    channel: { sendTyping: async () => {} }, reply: async (value) => sent.push(value),
  };
  const seen = [];
  const fetchFn = async (url) => {
    seen.push(String(url));
    if (String(url).includes('cdn.discordapp.com')) return { ok: true, arrayBuffer: async () => fake.buffer };
    throw new Error('Invalid image must not reach Gemini or the price API');
  };
  assert.equal(await answerChannelMessage(message, {
    guildId: 'our-guild', channelId: 'buff-channel', applicationId: '1567887370886320190', geminiKey: 'test-key',
  }, fetchFn), true);
  assert.equal(seen.length, 1);
  assert.match(sent[0].content, /Price lookup is temporarily unavailable/);
});

test('iPhone HEIC attachments reach Gemini with the MIME detected from their bytes', async () => {
  const heic = new Uint8Array(20);
  new DataView(heic.buffer).setUint32(0, heic.length);
  heic.set(Buffer.from('ftypheic'), 4);
  heic.set(Buffer.from('mif1'), 16);
  for (const contentType of ['image/heic', null]) {
    const attachments = [{ url: 'https://cdn.discordapp.com/attachments/test/photo.heic',
      name: 'photo.heic', contentType, size: heic.length }];
    attachments.size = 1;
    const sent = [];
    const message = {
      id: '123456789012345683', author: { bot: false, id: '123456789012345678' },
      guildId: 'our-guild', channelId: 'buff-channel', content: '', attachments,
      channel: { sendTyping: async () => {} }, reply: async (value) => sent.push(value),
    };
    const seen = [];
    const fetchFn = async (url, options) => {
      const target = String(url);
      if (target.includes('cdn.discordapp.com')) {
        seen.push('cdn');
        return { ok: true, arrayBuffer: async () => heic.buffer };
      }
      if (target.includes('generativelanguage.googleapis.com')) {
        seen.push('gemini');
        assert.equal(JSON.parse(options.body).contents[0].parts[1].inline_data.mime_type, 'image/heic');
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
          { text: JSON.stringify({ items: ['AK-47 | Redline (Field-Tested)'] }) },
        ] } }] }) };
      }
      if (target.endsWith('/prices/batch')) {
        seen.push('price');
        return { ok: true, json: async () => ({ data: {
          'AK-47 | Redline (Field-Tested)': {
            buff: { native_currency: { code: 'CNY', ask: 120 }, updated_at: new Date().toISOString() },
          },
        } }) };
      }
      throw new Error(`Unexpected URL ${target}`);
    };
    assert.equal(await answerChannelMessage(message, {
      guildId: 'our-guild', channelId: 'buff-channel', applicationId: '1567887370886320190', geminiKey: 'test-key',
    }, fetchFn), true);
    assert.deepEqual(seen, ['cdn', 'gemini', 'price']);
    assert.match(sent[0].content, /AK-47 \| Redline \(Field-Tested\)/);
  }
});
