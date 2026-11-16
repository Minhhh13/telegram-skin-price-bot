import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfitService } from '../profit-discord.mjs';
import { aiItemSupportedByText, catalogHintsForText } from '../supabase/functions/skin-price-webhook/skin-price.mjs';

const actor = '123456789012345678';
const config = { guildId: '123456789012345679', tradeDeskUrl: 'https://tradedesk.test', tradeDeskKey: 'test-key', geminiKey: 'test-ai-key' };
const identity = (name, phase = null) => ({ game: '730', name, phase });
const ak = identity('AK-47 | Redline (Field-Tested)');
const awp = identity('AWP | Redline (Field-Tested)');
const future = identity('AK-47 | Aurora Bloom (Field-Tested)');
const chatter = (item) => `hey boss I'd like a valuation for this weapon ${item} sometime today thanks`;
const quote = (item) => ({ ...item, available: true, usdCents: 14500, updatedAt: new Date().toISOString(),
  buff: { available: true, cny: 1000, updatedAt: new Date().toISOString(), url: 'https://buff.163.com/goods/1' } });

function mockService(items, { ai = [], responseItems = null } = {}) {
  const calls = { ai: [], quotes: [], catalogues: [] };
  const service = createProfitService(config, async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ linked: true }) };
    if (url.endsWith('/catalogue')) {
      calls.catalogues.push(body);
      return { ok: true, json: async () => ({ items, version: 'snapshot-one' }) };
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      calls.ai.push(body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: ai }) }] } }] }) };
    }
    assert.ok(url.endsWith('/quotes'), 'Only the integration and interpretation endpoints are called');
    calls.quotes.push(body);
    return { ok: true, json: async () => ({ items: responseItems === null ? body.items.map(quote) : responseItems,
      rate: { vndPerUsd: 26000 } }) };
  });
  return { service, calls };
}

test('profit interpretation hints and collectible support use the supplied catalogue snapshot', () => {
  const names = Object.freeze([future.name, 'Sticker | Nova Rabbit (Holo)']);
  assert.deepEqual(catalogHintsForText('ak aurora bloom ft', 16, names), [future.name]);
  assert.ok(!catalogHintsForText('ak aurora bloom ft').includes(future.name));
  assert.equal(aiItemSupportedByText('ak aurora ft', future.name, names), true);
  assert.equal(aiItemSupportedByText('ak aurora ft', future.name), false);
  assert.equal(aiItemSupportedByText('sticker nova rabbit holo', names[1], names), true);
  assert.equal(aiItemSupportedByText('sticker nova rabbit holo', names[1]), false);
});

test('ambiguous weapons and Doppler styles remain explicit catalogue choices without model guesses', async () => {
  const name = '★ Butterfly Knife | Doppler (Factory New)';
  const styles = ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Ruby', 'Sapphire', 'Black Pearl'].map((phase) => identity(name, phase));
  const { service, calls } = mockService([ak, awp, ...styles], { ai: [ak.name, `${name} Phase 4`] });
  const weapon = await service.lookup(actor, 'redline ft');
  assert.equal(weapon[0].components[0].components[0].options.length, 2);
  const doppler = await service.lookup(actor, name);
  assert.deepEqual(doppler[0].components[0].components[0].options.map((option) => option.label.split(' · ').at(-1)), styles.map((item) => item.phase));
  assert.equal(calls.ai.length, 0);
  assert.equal(calls.quotes.length, 0);
});

test('missing exact phase and Doppler family cannot be replaced by a model base-item quote', async () => {
  const name = '★ Butterfly Knife | Doppler (Factory New)';
  for (const query of ['btf dop p4 fn', 'btf gamma dop p3 fn', 'btf p3 fn']) {
    const { service, calls } = mockService([identity(name), identity(name, 'Phase 3')], { ai: [name] });
    const messages = await service.lookup(actor, query);
    assert.equal(calls.quotes.length, 0, query);
    assert.ok(messages.length);
    assert.doesNotMatch(messages.map((message) => message.content).join('\n'), /\$145\.00/);
  }
});

test('partially recognized batches recover only the unresolved member and retain direct identities and rates', async () => {
  const { service, calls } = mockService([awp, future], { ai: [future.name, awp.name] });
  const messages = await service.lookup(actor, `${awp.name}; ${chatter('ak aurora bloom ft')} rate 3.615`);
  assert.equal(calls.ai.length, 1);
  const prompt = calls.ai[0].contents[0].parts[0].text;
  assert.match(prompt, /Possible canonical catalog names/);
  assert.ok(prompt.includes(future.name));
  assert.deepEqual(calls.quotes.map((call) => call.items), [[awp, future]]);
  assert.ok(calls.quotes.every((call) => call.discordUserId === actor));
  const output = messages.map((message) => message.content).join('\n');
  assert.match(output, /\*\*3\.615\*\*/);
  assert.doesNotMatch(output, /No matching Trade Desk item/);
  assert.ok(output.indexOf(awp.name.replace('|', '\\|')) < output.indexOf(future.name.replace('|', '\\|')));
});

test('AI wear evidence is checked per unresolved batch member rather than shared across members', async () => {
  const fnAk = identity('AK-47 | Aurora Bloom (Factory New)');
  const ftAwp = identity('AWP | Silk Tiger (Field-Tested)');
  const ftAk = future, fnAwp = identity('AWP | Silk Tiger (Factory New)');
  const { service, calls } = mockService([fnAk, ftAwp, ftAk, fnAwp], { ai: [ftAk.name, fnAwp.name] });
  await service.lookup(actor, `${chatter('ak aurora bloom fn')}; ${chatter('awp silk tiger ft')}`);
  assert.equal(calls.ai.length, 1);
  assert.equal(calls.quotes.length, 0);
});

test('photo interpretation receives only names from the active Trade Desk catalogue', async () => {
  const { service, calls } = mockService([future], { ai: [future.name] });
  await service.lookup(actor, 'ak aurora bloom ft', '', { image: { mimeType: 'image/png', base64: 'test-photo' } });
  const prompt = calls.ai[0].contents[0].parts[0].text;
  const hints = prompt.split('Possible canonical catalog names (hints only; do not pick one without support in the request):\n')[1].split('\nFull user message:')[0];
  assert.deepEqual(hints.split('\n'), [future.name]);
  assert.deepEqual(calls.quotes[0].items, [future]);
});

test('verified quote rows keep the requested order and canonical labels', async () => {
  const { service, calls } = mockService([ak, awp], { responseItems: [quote(awp), quote(ak)] });
  const messages = await service.lookup(actor, `${ak.name}; ${awp.name}`);
  assert.deepEqual(calls.quotes[0].items, [ak, awp]);
  const text = messages.map((message) => message.content).join('\n');
  assert.ok(text.indexOf(ak.name.replace('|', '\\|')) < text.indexOf(awp.name.replace('|', '\\|')));
});

test('missing, duplicate, cross-phase, malformed and unrelated quote identities fail closed', async () => {
  const doppler = identity('★ Butterfly Knife | Doppler (Factory New)', 'Phase 3');
  for (const responseItems of [[], [quote(doppler), quote(doppler)], [quote({ ...doppler, phase: 'Phase 4' })],
    [quote({ ...doppler, game: undefined })], [quote({ ...doppler, game: '570' })], [null], [quote(doppler), quote(ak)]]) {
    const { service } = mockService([doppler], { responseItems });
    await assert.rejects(service.lookup(actor, `${doppler.name} · ${doppler.phase}`), /could not confirm every requested item/);
  }
});

test('oversized backtick context is rejected before a result can exceed Discord limits', async () => {
  const { service, calls } = mockService([ak]);
  await assert.rejects(service.lookup(actor, '`'.repeat(600)), /shorter skin request/);
  assert.equal(calls.catalogues.length, 0);
  assert.equal(calls.ai.length, 0);
  assert.equal(calls.quotes.length, 0);
});
