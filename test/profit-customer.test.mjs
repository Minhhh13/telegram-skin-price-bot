import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createProfitDiscordHandler, createProfitService, answerProfitChannelMessage } from '../profit-discord.mjs';
import { formatProfitItem, queryFooter } from '../profit.mjs';
import { profitCustomerButton, profitCustomerButtonId, profitCustomerInteraction, profitCustomerQuotes } from '../profit-customer.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const app = '123456789012345678', guild = '123456789012345679', firstChannel = '123456789012345680', secondChannel = '123456789012345681';
const user = '123456789012345682', owner = '123456789012345683';
const config = { publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), applicationId: app,
  guildId: guild, profitChannelIds: [firstChannel, secondChannel], profitOwnerId: owner, tradeDeskUrl: 'https://tradedesk.test', tradeDeskKey: 'test-key' };
const at = new Date().toISOString();
const rows = [
  { game: '730', name: 'Desert Eagle | Kumicho Dragon (Field-Tested)', phase: null, usdCents: 14500, available: true, updatedAt: at,
    buff: { cny: 98, available: true, updatedAt: at, url: 'https://buff.163.com/goods/34432' } },
  { game: '730', name: '★ M9 Bayonet | Doppler (Factory New)', phase: 'Ruby', assumedFactoryNew: true, usdCents: 100000, available: true, updatedAt: at,
    buff: { cny: 5900, available: true, updatedAt: at, url: 'https://buff.163.com/goods/43091' } },
];
const content = '**Your Trade Desk profit check**\nWeekly USD→VND: **25,800**\nInternal account: secret-account-value\n\n' +
  rows.map((row) => formatProfitItem(row, { vndPerUsd: 25800 })).join('\n\n') + queryFooter('deagle kumicho dragon ft; m9 ruby');
const original = { author: { id: app, bot: true }, content };
function signed(data) {
  const body = JSON.stringify({ application_id: app, guild_id: guild, channel_id: firstChannel, member: { user: { id: user } }, ...data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: new Headers({ 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex') }) };
}
const submit = (item = '1', rate = '3.65') => ({ type: 5, message: original, data: { custom_id: 'tdprofit:customer-quote-submit', components: [
  { type: 18, component: { type: 3, custom_id: 'item', values: [item] } },
  { type: 18, component: { type: 3, custom_id: 'selling_rate', values: [rate] } },
] } });
const quoteText = (response) => response.data.content.match(/^Copy this quote:\n```text\n([\s\S]+)\n```$/)?.[1];

test('customer quote snapshots preserve the exact item, phase, CNY ask and validated link', () => {
  const quotes = profitCustomerQuotes(content);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].name, rows[0].name);
  assert.equal(quotes[0].cnyCents, 9800n);
  assert.equal(quotes[1].name, `${rows[1].name} · Ruby`);
  assert.equal(quotes[1].cnyCents, 590000n);
  assert.equal(profitCustomerButton(content).custom_id, profitCustomerButtonId);
  assert.equal(profitCustomerButton(content.replaceAll('https://buff.163.com/goods/', 'https://other.test/goods/')), null);
  const noBuff = formatProfitItem({ ...rows[0], buff: { available: false } }, { vndPerUsd: 25800 });
  assert.equal(profitCustomerButton(noBuff), null);
});

test('customer quote button and submit work privately in both channels without another API or AI call', async () => {
  const handler = createProfitDiscordHandler(config, async () => { assert.fail('Customer copy must use the displayed snapshot, without network calls'); });
  for (const channel_id of [firstChannel, secondChannel]) {
    const button = signed({ type: 3, channel_id, message: original, data: { custom_id: profitCustomerButtonId } });
    const modal = JSON.parse((await handler(button.headers, button.body)).body);
    assert.equal(modal.type, 9);
    assert.equal(modal.data.components[0].component.options.length, 2);
    assert.equal(modal.data.components[1].component.custom_id, 'selling_rate');
    assert.equal(modal.data.components[1].component.type, 3);
    assert.deepEqual(modal.data.components[1].component.options.map(option => option.value), ['3.60', '3.65', '3.70', '3.75', '3.80']);
    assert.equal(modal.data.components[1].component.options.find(option => option.default).value, '3.65');
    const request = signed({ ...submit(), channel_id });
    const response = JSON.parse((await handler(request.headers, request.body)).body);
    assert.equal(response.type, 4); assert.equal(response.data.flags, 68);
    assert.deepEqual(response.data.allowed_mentions, { parse: [] });
    const text = quoteText(response);
    assert.equal(text, `${rows[1].name} · Ruby\nBUFF: ¥5,900.00 CNY\n3.65 → ₫21,535,000\nhttps://buff.163.com/goods/43091`);
    assert.doesNotMatch(text, /profit|Trade Desk|USD|25,800|secret-account|FN assumed|🔴|🟢|Search:/i);
    assert.equal(response.data.components[0].components[0].custom_id, 'tdprofit:customer-copy');
  }
});

test('BUFF-style quote labels preserve cents and a displayed three-decimal custom buying rate', () => {
  const response = profitCustomerInteraction(submit('0', '3650'), app);
  assert.equal(quoteText(response), `${rows[0].name}\nBUFF: ¥98.00 CNY\n3.65 → ₫357,700\nhttps://buff.163.com/goods/34432`);
  const custom = { ...original, content: '**Your Trade Desk profit check**\n\n' +
    formatProfitItem({ ...rows[0], buff: { ...rows[0].buff, cny: 98.75 } }, { vndPerUsd: 25800 }, [3.615]) + queryFooter('deagle kumicho dragon ft rate 3.615') };
  const customRequest = { ...submit('0', '3.615'), message: custom };
  assert.equal(quoteText(profitCustomerInteraction(customRequest, app)), `${rows[0].name}\nBUFF: ¥98.75 CNY\n3.615 → ₫356,981\nhttps://buff.163.com/goods/34432`);
  const customModal = profitCustomerInteraction({ type: 3, message: custom, data: { custom_id: profitCustomerButtonId } }, app);
  assert.deepEqual(customModal.data.components[1].component.options, [{ label: '3.615', value: '3.615', default: true }]);
  const changedInternals = { ...original, content: content.replace('25,800', '99,999').replace('secret-account-value', 'different-account') };
  assert.equal(quoteText(profitCustomerInteraction({ ...submit('0', '3650'), message: changedInternals }, app)), quoteText(response));
});

test('mobile copy exposes only selectable customer text and ignores edited submit content', () => {
  const response = profitCustomerInteraction(submit(), app), minimal = quoteText(response);
  const message = { author: { id: app, bot: true }, content: response.data.content };
  const phone = profitCustomerInteraction({ type: 3, message, data: { custom_id: 'tdprofit:customer-copy' } }, app);
  assert.equal(phone.type, 9);
  assert.equal(phone.data.components[0].component.style, 2);
  assert.equal(phone.data.components[0].component.value, minimal);
  const submitted = profitCustomerInteraction({ type: 5, message, data: { custom_id: 'tdprofit:customer-copy-submit', components: [
    { type: 18, component: { custom_id: 'quote_text', value: 'Unwanted internal profit or account information' } },
  ] } }, app);
  assert.equal(quoteText(submitted), minimal);
  const legacyText = `${rows[0].name}\n₫357,700\nhttps://buff.163.com/goods/34432`;
  const legacy = { ...message, content: `Copy this quote:\n\`\`\`text\n${legacyText}\n\`\`\`` };
  const legacyPhone = profitCustomerInteraction({ type: 3, message: legacy, data: { custom_id: 'tdprofit:customer-copy' } }, app);
  assert.equal(legacyPhone.data.components[0].component.value, legacyText);
});

test('forged messages, invalid item choices, malformed rates and unlisted channels cannot create a customer quote', async () => {
  for (const request of [
    { type: 3, message: { ...original, author: { id: user, bot: false } }, data: { custom_id: profitCustomerButtonId } },
    submit('99'), submit(''), submit('0', 'bad'), submit('0', '0'), submit('0', '3.6501'), submit('0', '999999999'), submit('0', '3.615'),
  ]) {
    const response = profitCustomerInteraction(request, app);
    assert.equal(response.type, 4); assert.equal(response.data.flags, 68);
    assert.equal(quoteText(response), undefined);
  }
  const handler = createProfitDiscordHandler(config, async () => { assert.fail('No request expected'); });
  for (const location of [{ channel_id: '123456789012345699' }, { guild_id: '123456789012345699' }]) {
    const request = signed({ type: 3, ...location, message: original, data: { custom_id: profitCustomerButtonId } });
    assert.match(JSON.parse((await handler(request.headers, request.body)).body).data.content, /profit checker channel/);
  }
});

test('actual automatic and private priced results offer Customer quote within Discord button limits', async () => {
  const identity = { game: rows[0].game, name: rows[0].name, phase: null };
  const service = createProfitService(config, async (url) => {
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
    if (url.endsWith('/catalogue')) return { ok: true, json: async () => ({ version: 'v1', items: [identity] }) };
    assert.ok(url.endsWith('/quotes'));
    return { ok: true, json: async () => ({ items: [rows[0]], rate: { vndPerUsd: 25800 } }) };
  });
  const privateResult = await service.lookup(owner, rows[0].name);
  assert.ok(privateResult[0].components[0].components.some((button) => button.custom_id === profitCustomerButtonId));
  assert.equal(privateResult[0].components[0].components.length, 5);
  const sent = [];
  await answerProfitChannelMessage({ id: '1234567890123456789', author: { id: user, bot: false }, guildId: guild, channelId: secondChannel,
    content: rows[0].name, reply: async (value) => sent.push(value), channel: { sendTyping: async () => {} } }, config, service);
  assert.ok(sent[0].components[0].components.some((button) => button.custom_id === profitCustomerButtonId));
  assert.ok(sent[0].components[0].components.length <= 5);
});
