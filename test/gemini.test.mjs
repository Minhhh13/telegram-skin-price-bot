import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFromBytes, interpretItems, requestedRates } from '../supabase/functions/skin-price-webhook/gemini.mjs';
import { parseRequest } from '../supabase/functions/skin-price-webhook/skin-price.mjs';

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
  assert.deepEqual(requestedRates('buff price ak redline ft', parseRequest), [3.6, 3.65, 3.7, 3.75, 3.78, 3.8]);
});

test('HEIC and HEIF ftyp major brands are sent with Gemini-supported MIME types', () => {
  const ftyp = (brand, compatible = 'mif1') => {
    const bytes = new Uint8Array(20);
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(Buffer.from(`ftyp${brand}`), 4);
    bytes.set(Buffer.from(compatible), 16);
    return bytes;
  };
  assert.equal(imageFromBytes(ftyp('heic')).mimeType, 'image/heic');
  assert.equal(imageFromBytes(ftyp('heix')).mimeType, 'image/heic');
  assert.equal(imageFromBytes(ftyp('heif')).mimeType, 'image/heif');
  assert.equal(imageFromBytes(ftyp('mif1')).mimeType, 'image/heif');
  assert.throws(() => imageFromBytes(ftyp('avif')), /Send a JPEG/);
  assert.throws(() => imageFromBytes(ftyp('isom')), /Send a JPEG/);
  assert.throws(() => imageFromBytes(ftyp('mif1', 'avif')), /Send a JPEG/);
  assert.throws(() => imageFromBytes(Uint8Array.from(Buffer.from('0000ftypheic'))), /Send a JPEG/);
});
