const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_IMAGE_BYTES = 5_000_000;

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16_384) binary += String.fromCharCode(...bytes.subarray(i, i + 16_384));
  return btoa(binary);
}

export async function telegramPhoto(photo, token, fetchFn = fetch) {
  if (!Array.isArray(photo) || !photo.length) return null;
  const chosen = [...photo].filter((p) => p.file_size === undefined || p.file_size <= MAX_IMAGE_BYTES).at(-1);
  if (!chosen?.file_id) throw new Error('Photo is too large. Send an image under 5 MB.');
  const infoResponse = await fetchFn(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: chosen.file_id }), signal: AbortSignal.timeout(9000),
  });
  if (!infoResponse.ok) throw new Error(`Telegram getFile HTTP ${infoResponse.status}`);
  const info = await infoResponse.json();
  if (!info.ok || !/^[A-Za-z0-9_./-]+$/.test(info.result?.file_path || '')) throw new Error('Telegram photo unavailable.');
  const photoResponse = await fetchFn(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`, { signal: AbortSignal.timeout(9000) });
  if (!photoResponse.ok) throw new Error(`Telegram photo HTTP ${photoResponse.status}`);
  const bytes = new Uint8Array(await photoResponse.arrayBuffer());
  return imageFromBytes(bytes);
}

export function imageFromBytes(bytes) {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Photo is too large. Send an image under 5 MB.');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!jpeg && !png && !webp) throw new Error('Send a JPEG, PNG, or WebP image.');
  return { mimeType: jpeg ? 'image/jpeg' : png ? 'image/png' : 'image/webp', base64: toBase64(bytes) };
}

export async function interpretItems({ text = '', image = null, candidates = [], apiKey, fetchFn = fetch }) {
  if (!apiKey) return null;
  const hints = candidates.length ? `\nPossible canonical catalog names (hints only; do not pick one without support in the request):\n${candidates.slice(0, 16).join('\n')}` : '';
  const imageGuidance = image ? `\nRead any visible CS2 item title in the attached image, including Simplified Chinese BUFF163 screenshots. Translate the item title into its official English Steam market name: identify item type or weapon, finish or agent name, and wear from the visible title. For example, only when the title actually shows "折叠刀 (★) | 大马士革钢 (崭新出厂)", use "★ Flip Knife | Damascus Steel (Factory New)". The item title is stronger evidence than artwork; ignore prices, float values, paint seeds, QR codes, seller descriptions, and unrelated text. A float number in a screenshot is not a requested float-price filter. If a title is cropped, unreadable, or leaves multiple plausible items, return no item for it rather than inventing one.\n` : '';
  const parts = [{ text: `Extract Counter-Strike 2 market item names the user wants a BUFF163 base price for from the full message and image, if any. This includes weapon skins, bare knives, agents, and other catalog items. Ignore surrounding conversation and bot mentions. Understand abbreviations and typos: "stt" means StatTrak, "butter" or "btf" means Butterfly Knife, "m9" means M9 Bayonet, "a1", "m1", or "m4a1" means M4A1-S, "a4" means M4A4, and "m4" may mean M4A1-S or M4A4; use the finish to disambiguate and never assume one. "print" means Printstream, "dop" or "dopp" means standard Doppler, "gamma dop" means Gamma Doppler, "p1" means Phase 1, "fn" means Factory New, "mw" means Minimal Wear, "ft" means Field-Tested, "ww" means Well-Worn, and "bs" means Battle-Scarred. Weapon and finish may appear in either order, such as "redline awp ft". A unique finish word can identify the full finish for an explicit weapon, such as "ak lotus" meaning AK-47 | Wild Lotus. Return JSON with only an "items" array of up to 10 canonical item names. Preserve explicitly requested Doppler styles at the end of each name: Phase 1–4, Ruby, Sapphire, Black Pearl, or Emerald. If no wear is given, omit wear so every available wear can be quoted. Bare knives and agents do not have a wear to infer. If a finish matches multiple weapons and none is specified, return an empty array rather than guess. Do not invent wear, style, StatTrak, Souvenir status, or item names. Never supply prices.${imageGuidance}${hints}\nFull user message: ${String(text).slice(0, 1800)}` }];
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const output = await response.json();
  const raw = output?.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === 'string')?.text;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Gemini returned invalid JSON'); }
  if (!Array.isArray(parsed.items)) throw new Error('Gemini returned no item list');
  return parsed.items.filter((item) => typeof item === 'string' && item.length <= 160 && item.trim()).slice(0, 10);
}

export function requestedRates(text, parseRequest) {
  const suffix = String(text || '').match(/\b(?:rates?|at)\s*[:=]?\s*\d[\d.\s,/&a-z]*$/i)?.[0] || '';
  return parseRequest(`/price placeholder ${suffix}`).rates;
}
