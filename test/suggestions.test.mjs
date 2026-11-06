import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReply, catalogSuggestionsForText } from '../supabase/functions/skin-price-webhook/skin-price.mjs';
import { lookupDiscord } from '../discord.mjs';

test('unmatched names suggest real catalogue items with explicit variants intact', () => {
  assert.deepEqual(catalogSuggestionsForText('glock twilght'),
    ['Glock-18 | Twilight Galaxy (Factory New)']);
  assert.deepEqual(catalogSuggestionsForText('stt a1 printstreem mw'),
    ['StatTrak™ M4A1-S | Printstream (Minimal Wear)']);
  assert.deepEqual(catalogSuggestionsForText('ak nonsense ft'), []);
  assert.deepEqual(catalogSuggestionsForText('redline ft'), [
    'AK-47 | Redline (Field-Tested)', 'AWP | Redline (Field-Tested)',
  ]);
  assert.deepEqual(catalogSuggestionsForText('glove occult'),
    ['★ Sport Gloves | Occult (Factory New)']);
});

test('unmatched request shows candidates without making up a price', async () => {
  const noPriceFetch = () => { throw new Error('Uncertain item must not fetch a price'); };
  const reply = (await buildReply('glock twilight galxy maybe', '', noPriceFetch)).join('\n');
  assert.match(reply, /possible catalogue matches/);
  assert.match(reply, /Glock-18 \| Twilight Galaxy \(Factory New\)/);
  assert.doesNotMatch(reply, /¥\d|CNY listing unavailable/);
});

test('Discord still lets Gemini interpret an uncertain name before showing candidates', async () => {
  let geminiCalls = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [
        { text: '{"items":["AK-47 | Redline (Factory New)"]}' },
      ] } }] }) };
    }
    throw new Error(`Uncertain item must not fetch a price: ${url}`);
  };
  const reply = (await lookupDiscord('glock twilight galxy maybe', null, 'test-key', fetchFn)).join('\n');
  assert.equal(geminiCalls, 1);
  assert.match(reply, /Glock-18 \| Twilight Galaxy \(Factory New\)/);
  assert.doesNotMatch(reply, /AK-47 \| Redline|¥\d/);
});
