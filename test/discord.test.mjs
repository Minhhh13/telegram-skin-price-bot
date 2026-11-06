import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDiscordHandler, customerQuoteComponents, customerQuotes, discordText, lookupDiscord, splitDiscord } from '../discord.mjs';

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

const pricedReply = `**BUFF163 base prices · CNY → VND**

**AWP | Crakow! (Field-Tested)**
**¥120.00 CNY** · [BUFF listing](https://buff.163.com/goods/10001)
\`3.60 → ₫432,000   |   3.65 → ₫438,000\`
Feed snapshot 2026-11-06 11:31 UTC (38 min old) ⚠️ May miss newer listings

**Desert Eagle | Kumicho Dragon (Field-Tested)**
**¥98.00 CNY** · [BUFF listing](https://buff.163.com/goods/34432)
\`3.60 → ₫352,800   |   3.65 → ₫357,700\`
Feed snapshot 2026-11-06 11:30 UTC (39 min old) ⚠️ May miss newer listings`;

test('only priced Discord replies offer a customer quote button', () => {
  const quotes = customerQuotes(pricedReply);
  assert.equal(quotes.length, 2);
  assert.deepEqual(quotes[1], {
    name: 'Desert Eagle | Kumicho Dragon (Field-Tested)', cny: '¥98.00 CNY',
    url: 'https://buff.163.com/goods/34432',
    rates: [{ rate: '3.60', vnd: '₫352,800' }, { rate: '3.65', vnd: '₫357,700' }],
  });
  assert.equal(customerQuoteComponents(pricedReply)[0].components[0].label, 'Customer quote');
  assert.equal(customerQuoteComponents(pricedReply)[0].components[1].label, 'Custom rate');
  assert.deepEqual(customerQuoteComponents('**AK Redline FT**: no matching item found.'), []);
});

test('multi-item replies keep each priced quote together across Discord chunks', () => {
  const block = pricedReply.split('\n\n')[1];
  const text = ['**BUFF163 base prices · CNY → VND**', ...Array.from({ length: 10 }, () => block)].join('\n\n');
  const chunks = splitDiscord(text, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.equal(chunks.reduce((total, chunk) => total + customerQuotes(chunk).length, 0), 10);
  assert.ok(chunks.every((chunk) => customerQuoteComponents(chunk).length));
});

test('customer quote modal copies one item and rate without another API call', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' },
    async () => { throw new Error('Quote selection must not fetch prices'); });
  const button = signed({ type: 3, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    data: { custom_id: 'buff:customer-quote' }, message: { content: pricedReply } });
  const modal = JSON.parse((await handler(button.headers, button.body)).body);
  assert.equal(modal.type, 9);
  assert.equal(modal.data.components[0].type, 18);
  assert.equal(modal.data.components[0].component.options.length, 2);
  assert.deepEqual(modal.data.components[1].component.options.map((option) => option.value), ['3.60', '3.65']);

  const submit = signed({ type: 5, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    data: { custom_id: modal.data.custom_id, components: [
      { type: 18, component: { type: 3, custom_id: 'item', values: ['1'] } },
      { type: 18, component: { type: 3, custom_id: 'rate', values: ['3.65'] } },
    ] }, message: { content: pricedReply } });
  const response = JSON.parse((await handler(submit.headers, submit.body)).body);
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, 64);
  assert.equal(response.data.content, 'Copy this quote:\n```text\nDesert Eagle | Kumicho Dragon (Field-Tested)\nBUFF: ¥98.00 CNY\n3.65 → ₫357,700\nhttps://buff.163.com/goods/34432\n```');
  assert.doesNotMatch(response.data.content, /AWP|Feed snapshot|May miss|<@/);
  assert.equal(response.data.components[0].components[0].custom_id, 'buff:copy-text');
});

test('mobile copy button opens a modal prefilled with selectable customer quote text', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' },
    async () => { throw new Error('Copying text must not fetch prices'); });
  const content = 'Copy this quote:\n```text\nDesert Eagle | Kumicho Dragon (Field-Tested)\nBUFF: ¥98.00 CNY\n3.65 → ₫357,700\nhttps://buff.163.com/goods/34432\n```';
  const button = signed({ type: 3, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    data: { custom_id: 'buff:copy-text' }, message: { content } });
  const modal = JSON.parse((await handler(button.headers, button.body)).body);
  assert.equal(modal.type, 9);
  assert.equal(modal.data.components[0].component.type, 4);
  assert.equal(modal.data.components[0].component.style, 2);
  assert.equal(modal.data.components[0].component.custom_id, 'quote_text');
  assert.equal(modal.data.components[0].component.value, 'Desert Eagle | Kumicho Dragon (Field-Tested)\nBUFF: ¥98.00 CNY\n3.65 → ₫357,700\nhttps://buff.163.com/goods/34432');
});

test('customer quote rejects a rate that was not in the original price reply', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' });
  const submit = signed({ type: 5, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    data: { custom_id: 'buff:customer-quote:submit', components: [
      { type: 18, component: { type: 3, custom_id: 'item', values: ['1'] } },
      { type: 18, component: { type: 3, custom_id: 'rate', values: ['3.80'] } },
    ] }, message: { content: pricedReply } });
  const response = JSON.parse((await handler(submit.headers, submit.body)).body);
  assert.match(response.data.content, /no longer available/);
});

test('custom rate modal quotes the selected item at a rate absent from the displayed table', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' },
    async () => { throw new Error('Custom quote must not fetch prices'); });
  const button = signed({ type: 3, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    data: { custom_id: 'buff:custom-rate' }, message: { content: pricedReply } });
  const modal = JSON.parse((await handler(button.headers, button.body)).body);
  assert.equal(modal.type, 9);
  assert.equal(modal.data.components[0].component.custom_id, 'item');
  assert.equal(modal.data.components[0].component.options.length, 2);
  assert.equal(modal.data.components[1].component.type, 4);
  assert.equal(modal.data.components[1].component.custom_id, 'custom_rate');

  const submit = signed({ type: 5, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    data: { custom_id: modal.data.custom_id, components: [
      { type: 18, component: { type: 3, custom_id: 'item', values: ['1'] } },
      { type: 18, component: { type: 4, custom_id: 'custom_rate', value: '3.72' } },
    ] }, message: { content: pricedReply } });
  const response = JSON.parse((await handler(submit.headers, submit.body)).body);
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, 64);
  assert.equal(response.data.content, 'Copy this quote:\n```text\nDesert Eagle | Kumicho Dragon (Field-Tested)\nBUFF: ¥98.00 CNY\n3.72 → ₫364,560\nhttps://buff.163.com/goods/34432\n```');
  assert.doesNotMatch(response.data.content, /AWP|Feed snapshot|May miss|<@/);
  assert.equal(response.data.components[0].components[0].custom_id, 'buff:copy-text');
});

test('custom rate rejects malformed or unsafe values without posting a quote', async () => {
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel' });
  for (const value of ['abc', '0', '-3.72', '999999', '3.72<script>']) {
    const submit = signed({ type: 5, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
      data: { custom_id: 'buff:custom-rate:submit', components: [
        { type: 18, component: { type: 3, custom_id: 'item', values: ['1'] } },
        { type: 18, component: { type: 4, custom_id: 'custom_rate', value } },
      ] }, message: { content: pricedReply } });
    const response = JSON.parse((await handler(submit.headers, submit.body)).body);
    assert.equal(response.type, 4, value);
    assert.equal(response.data.flags, 64, value);
    assert.doesNotMatch(response.data.content, /Copy this quote|```/, value);
  }
});

test('phase-filtered quote remains identifiable in the customer copy', () => {
  const quote = customerQuotes(`**BUFF163 base prices · CNY → VND**\n\n**★ Butterfly Knife | Doppler (Factory New) · Phase 4 (FN assumed)**\nStyle filter: **Phase 4**\n**¥17,299.00 CNY** · [BUFF item (select Phase 4)](https://buff.163.com/goods/12345)\n\`3.75 → ₫64,871,250\`\nFeed snapshot 2026-11-06 06:34 UTC`)[0];
  assert.equal(quote.name, '★ Butterfly Knife | Doppler (Factory New) · Phase 4 (FN assumed)');
  assert.equal(quote.url, 'https://buff.163.com/goods/12345');
  assert.deepEqual(quote.rates, [{ rate: '3.75', vnd: '₫64,871,250' }]);
});

test('a clear catalog match returns a price without spending a Gemini request', async () => {
  let geminiCalls = 0;
  let priceCalls = 0;
  const fetchFn = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      throw new Error('A clear match should not call Gemini');
    }
    if (url.endsWith('/prices/batch')) {
      priceCalls++;
      assert.deepEqual(JSON.parse(options.body).items, ['AK-47 | Redline (Field-Tested)']);
      return { ok: true, json: async () => ({ data: {
        'AK-47 | Redline (Field-Tested)': {
          buff: { native_currency: { code: 'CNY', ask: 160 }, updated_at: new Date().toISOString() },
        },
      } }) };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await lookupDiscord('AK redline ft', null, 'fake-key', fetchFn,
    '@Thang Manh Nguyen AK redline ft')).join('\n');
  assert.equal(geminiCalls, 0);
  assert.equal(priceCalls, 1);
  assert.match(reply, /AK-47 \| Redline \(Field-Tested\)/);
  assert.match(reply, /¥160\.00 CNY/);
});

test('a photo reaches Gemini with the original message and image', async () => {
  let prompt = '';
  let imageData;
  const fetchFn = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      const parts = JSON.parse(options.body).contents[0].parts;
      prompt = parts[0].text;
      imageData = parts[1].inline_data;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { text: '{"items":["AK-47 | Redline (Field-Tested)"]}' },
      ] } }] }) };
    }
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: {
      'AK-47 | Redline (Field-Tested)': {
        buff: { native_currency: { code: 'CNY', ask: 160 }, updated_at: new Date().toISOString() },
      },
    } }) };
    throw new Error(`Unexpected URL ${url}`);
  };
  const reply = (await lookupDiscord('', { mimeType: 'image/png', base64: 'photo-data' }, 'fake-key', fetchFn,
    '@BUFF163 Price Checker please price the attached skin')).join('\n');
  assert.match(prompt, /Full user message: @BUFF163 Price Checker please price the attached skin/);
  assert.deepEqual(imageData, { mime_type: 'image/png', data: 'photo-data' });
  assert.match(reply, /AK-47 \| Redline \(Field-Tested\)/);
});

test('Gemini 503 falls back to OpenSkin text lookup and completes the Discord reply', async () => {
  let complete;
  const posted = new Promise((resolve) => { complete = resolve; });
  const fetchFn = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) return { ok: false, status: 503 };
    if (url.includes('/items?')) return { ok: true, json: async () => ({ data: [
      { name: 'AK-47 | Redline (Field-Tested)' },
      { name: 'AK-47 | Redline (Minimal Wear)' },
    ] }) };
    if (url.endsWith('/prices/batch')) return { ok: true, json: async () => ({ data: Object.fromEntries(JSON.parse(options.body).items.map((name) => [name, {
      buff: { native_currency: { code: 'CNY', ask: 160 }, updated_at: new Date().toISOString() },
    }])) }) };
    if (url.includes('discord.com/api/v10/webhooks/')) {
      complete(JSON.parse(options.body));
      return { ok: true };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild', channelId: 'channel', geminiKey: 'fake-key' }, fetchFn);
  const { headers, body } = signed({ type: 2, application_id: 'app', guild_id: 'guild', channel_id: 'channel', token: 'test-token', data: { name: 'buff', options: [{ name: 'items', value: 'AK Redline' }] } });
  assert.equal(JSON.parse((await handler(headers, body)).body).type, 5);
  const message = await posted;
  assert.match(message.content, /Redline \(Minimal Wear\)/);
  assert.match(message.content, /Redline \(Field-Tested\)/);
  assert.equal(message.components[0].components[0].custom_id, 'buff:customer-quote');
  assert.equal(message.components[0].components[1].custom_id, 'buff:custom-rate');
});

test('selecting an ambiguous catalog candidate prices only that item without Gemini', async () => {
  let resolvePosted;
  const posted = new Promise((resolve) => { resolvePosted = resolve; });
  let priceCalls = 0;
  let geminiCalls = 0;
  const fetchFn = async (url, options) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      throw new Error('Candidate selection should not call Gemini');
    }
    if (String(url).endsWith('/prices/batch')) {
      priceCalls++;
      assert.deepEqual(JSON.parse(options.body).items, ['AK-47 | Redline (Field-Tested)']);
      return { ok: true, json: async () => ({ data: {
        'AK-47 | Redline (Field-Tested)': {
          buff: { native_currency: { code: 'CNY', ask: 160 }, updated_at: new Date().toISOString() },
          links: { buff: 'https://buff.163.com/goods/12345' },
        },
      } }) };
    }
    if (String(url).includes('discord.com/api/v10/webhooks/')) {
      assert.equal(options.method, 'PATCH');
      resolvePosted(JSON.parse(options.body));
      return { ok: true };
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const handler = createDiscordHandler({ publicKey: publicHex, applicationId: 'app', guildId: 'guild',
    channelId: 'channel', geminiKey: 'fake-key' }, fetchFn);
  const content = '**BUFF163 base prices · CNY → VND**\n\n**AK red**: possible catalogue matches (price not quoted):\n• AK-47 | Redline (Field-Tested)\nSend the intended item to get its price.';
  const selection = signed({ type: 3, application_id: 'app', guild_id: 'guild', channel_id: 'channel',
    token: 'test-token', data: { custom_id: 'buff:candidate', values: ['0'] }, message: { content } });
  const acknowledgement = JSON.parse((await handler(selection.headers, selection.body)).body);
  assert.equal(acknowledgement.type, 5);
  assert.equal(acknowledgement.data.flags, 64);
  const message = await posted;
  assert.equal(priceCalls, 1);
  assert.equal(geminiCalls, 0);
  assert.match(message.content, /AK-47 \| Redline \(Field-Tested\)/);
  assert.match(message.content, /¥160\.00 CNY/);
  assert.match(message.content, /\[BUFF listing\]\(https:\/\/buff\.163\.com\/goods\/12345\)/);
  assert.equal(message.flags, 4);
  assert.equal(message.components[0].components[0].custom_id, 'buff:customer-quote');
  assert.equal(message.components[0].components[1].custom_id, 'buff:custom-rate');
});
