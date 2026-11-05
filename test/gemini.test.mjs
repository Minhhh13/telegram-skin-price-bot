import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretItems, requestedRates, telegramPhoto } from '../supabase/functions/skin-price-webhook/gemini.mjs';
import { parseRequest, shouldReply } from '../supabase/functions/skin-price-webhook/skin-price.mjs';

test('AI extracts names only; the price still comes from OpenSkin', async () => {
  let sent;
  const fakeFetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":["AK-47 | Redline (Field-Tested)","AWP | Dragon Lore (Field-Tested)"]}' }] } }] }) };
  };
  const items = await interpretItems({ text: 'buff price for ak redline ft, dlore ft', apiKey: 'test-key', fetchFn: fakeFetch });
  assert.deepEqual(items, ['AK-47 | Redline (Field-Tested)', 'AWP | Dragon Lore (Field-Tested)']);
  assert.ok(sent.contents[0].parts[0].text.includes('Never supply prices'));
  assert.equal(requestedRates('buff price ak redline ft rate 3.65', parseRequest)[0], 3.65);
  assert.equal(requestedRates('buff price ak redline ft', parseRequest).length, 27);
});

test('only a photo addressed to the bot is processed', async () => {
  assert.equal(shouldReply({ photo: [{ file_id: 'a' }] }, 'SkinBot'), false);
  assert.equal(shouldReply({ photo: [{ file_id: 'a' }], caption: '@SkinBot what is this?' }, 'SkinBot'), true);
  assert.equal(shouldReply({ photo: [{ file_id: 'a' }], reply_to_message: { from: { username: 'SkinBot' } } }, 'SkinBot'), true);
  const fakeFetch = async (url) => url.endsWith('/getFile')
    ? { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/file.jpg' } }) }
    : { ok: true, arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer };
  const image = await telegramPhoto([{ file_id: 'a', file_size: 4 }], 'test-token', fakeFetch);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(image.base64, '/9j/2Q==');
});
