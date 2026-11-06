import { createPublicKey, verify } from 'node:crypto';
import { aiItemSupportedByText, buildParsedReply, buildReply, catalogHintsForText, floatFilterUnavailable, parseRequest, requestsFloatFilter } from './supabase/functions/skin-price-webhook/skin-price.mjs';
import { imageFromBytes, interpretItems, requestedRates } from './supabase/functions/skin-price-webhook/gemini.mjs';

const discordApi = 'https://discord.com/api/v10';
const customerQuoteButtonId = 'buff:customer-quote';
const customerQuoteModalId = 'buff:customer-quote:submit';

export function verifyDiscord(headers, body, publicKey) {
  const signature = headers.get('x-signature-ed25519') || '';
  const timestamp = headers.get('x-signature-timestamp') || '';
  if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(publicKey)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}

export function discordText(html) {
  return String(html).replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '[$2]($1)')
    .replace(/<b>(.*?)<\/b>/gs, '**$1**').replace(/<code>(.*?)<\/code>/gs, '`$1`')
    .replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('@', '@\u200b');
}

export function splitDiscord(text, max = 1900) {
  const chunks = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    if (block.length <= max) {
      if (current && current.length + block.length + 2 > max) { chunks.push(current); current = ''; }
      current += (current ? '\n\n' : '') + block;
    } else {
      if (current) { chunks.push(current); current = ''; }
      for (const line of block.split('\n')) {
        if (line.length > max) {
          if (current) { chunks.push(current); current = ''; }
          for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
        } else {
          if (current && current.length + line.length + 1 > max) { chunks.push(current); current = ''; }
          current += (current ? '\n' : '') + line;
        }
      }
      if (current) { chunks.push(current); current = ''; }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// The bot's own priced reply is the quote snapshot. Component interactions carry
// that message back to us, so making a customer copy needs no second price fetch.
export function customerQuotes(content) {
  const quotes = [];
  for (const block of String(content || '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const name = lines[0]?.match(/^\*\*(.+)\*\*$/)?.[1];
    const priceLine = lines.find((line) => /^\*\*¥[\d,]+\.\d{2} CNY\*\*/.test(line));
    const cny = priceLine?.match(/^\*\*(¥[\d,]+\.\d{2} CNY)\*\*/)?.[1];
    if (!name || !cny) continue;
    const rates = [];
    for (const line of lines) {
      for (const match of line.matchAll(/(\d+\.\d{2}) → (₫[\d,]+)/g)) {
        rates.push({ rate: match[1], vnd: match[2] });
      }
    }
    if (!rates.length) continue;
    const url = priceLine.match(/\[[^\]]+\]\((https:\/\/buff\.163\.com\/goods\/\d+)\)/)?.[1] || '';
    quotes.push({ name, cny, url, rates });
  }
  return quotes;
}

export function customerQuoteComponents(content) {
  return customerQuotes(content).length ? [{ type: 1, components: [
    { type: 2, style: 2, label: 'Customer quote', custom_id: customerQuoteButtonId },
  ] }] : [];
}

function quoteModal(quotes) {
  const rates = [...new Set(quotes.flatMap((quote) => quote.rates.map(({ rate }) => rate)))];
  return { type: 9, data: {
    custom_id: customerQuoteModalId,
    title: 'Copy customer quote',
    components: [
      { type: 18, label: 'Item', component: {
        type: 3, custom_id: 'item', placeholder: 'Choose one item', required: true,
        options: quotes.slice(0, 25).map((quote, index) => ({
          label: quote.name.slice(0, 100), value: String(index), default: quotes.length === 1,
        })),
      } },
      { type: 18, label: 'CNY to VND rate', component: {
        type: 3, custom_id: 'rate', placeholder: 'Choose one rate', required: true,
        options: rates.slice(0, 25).map((rate) => ({
          label: rate, value: rate, default: rate === '3.65',
        })),
      } },
    ],
  } };
}

function modalValue(components, customId) {
  return components?.find((item) => item?.component?.custom_id === customId)?.component?.values?.[0];
}

function customerQuoteResponse(interaction) {
  const quotes = customerQuotes(interaction.message?.content);
  const itemIndex = Number(modalValue(interaction.data?.components, 'item'));
  const rate = modalValue(interaction.data?.components, 'rate');
  const quote = Number.isInteger(itemIndex) && itemIndex >= 0 ? quotes[itemIndex] : null;
  const conversion = quote?.rates.find((entry) => entry.rate === rate);
  if (!conversion) return { type: 4, data: {
    content: 'That quote is no longer available. Run the price lookup again.',
    flags: 64, allowed_mentions: { parse: [] },
  } };
  const lines = [quote.name, `BUFF: ${quote.cny}`, `${rate} → ${conversion.vnd}`];
  if (quote.url) lines.push(quote.url);
  return { type: 4, data: {
    content: `Copy this quote:\n\`\`\`text\n${lines.join('\n').replaceAll('```', "'''")}\n\`\`\``,
    flags: 64, allowed_mentions: { parse: [] },
  } };
}

export async function lookupDiscord(item, image, geminiKey = '', fetchFn = fetch, rawText = item) {
  if (requestsFloatFilter(item)) return [discordText(floatFilterUnavailable)];
  let direct = null;
  if (item.trim() && !image) {
    direct = await buildReply(item, '', fetchFn);
    if (direct.some((part) => /could mean:/i.test(part))) return splitDiscord(direct.map(discordText).join('\n\n'));
    const unresolved = direct.some((part) => /no matching item found|possible catalogue matches|could mean:|Send \/price followed by/i.test(part));
    if (!unresolved) return splitDiscord(direct.map(discordText).join('\n\n'));
  }
  let aiItems = geminiKey ? await interpretItems({ text: rawText, image, candidates: catalogHintsForText(item), apiKey: geminiKey, fetchFn })
    .catch((error) => { console.warn('AI item recognition unavailable:', error instanceof Error ? error.message : String(error)); return null; }) : null;
  if (aiItems && !image) aiItems = aiItems.filter((candidate) => aiItemSupportedByText(item, candidate));
  const html = aiItems?.length
    ? await buildParsedReply({ items: aiItems, rates: requestedRates(item, parseRequest) }, fetchFn)
    : image && !item.trim() ? ['Photo recognition is temporarily unavailable. Please type the skin names.']
    : direct || await buildReply(item, '', fetchFn);
  return splitDiscord(html.map(discordText).join('\n\n'));
}

export function createDiscordHandler({ publicKey, applicationId, guildId, channelId, geminiKey = '' }, fetchFn = fetch) {
  return async (headers, body) => {
    if (!publicKey) return { status: 503, body: 'Discord not configured' };
    if (!verifyDiscord(headers, body, publicKey)) return { status: 401, body: 'Invalid signature' };
    let interaction;
    try { interaction = JSON.parse(body); } catch { return { status: 400, body: 'Invalid JSON' }; }
    if (interaction.type === 1) return { status: 200, body: JSON.stringify({ type: 1 }) };
    if (![2, 3, 5].includes(interaction.type)) return { status: 400, body: 'Unsupported interaction' };
    if (interaction.guild_id !== guildId || interaction.channel_id !== channelId) {
      return { status: 200, body: JSON.stringify({ type: 4, data: { content: 'Use /buff in #buff-botpricer.', flags: 64, allowed_mentions: { parse: [] } } }) };
    }
    if (!applicationId || interaction.application_id !== applicationId) return { status: 401, body: 'Wrong application' };
    if (interaction.type === 3 && interaction.data?.custom_id === customerQuoteButtonId) {
      const quotes = customerQuotes(interaction.message?.content);
      const response = quotes.length ? quoteModal(quotes) : { type: 4, data: {
        content: 'No priced item is available in this message.', flags: 64, allowed_mentions: { parse: [] },
      } };
      return { status: 200, body: JSON.stringify(response) };
    }
    if (interaction.type === 5 && interaction.data?.custom_id === customerQuoteModalId) {
      return { status: 200, body: JSON.stringify(customerQuoteResponse(interaction)) };
    }
    if (interaction.type !== 2 || interaction.data?.name !== 'buff') return { status: 400, body: 'Unsupported interaction' };
    const item = interaction.data?.options?.find((option) => option.name === 'items')?.value || '';
    const imageId = interaction.data?.options?.find((option) => option.name === 'image')?.value;
    const attachment = imageId && interaction.data?.resolved?.attachments?.[imageId];
    if (!item.trim() && !attachment) return { status: 200, body: JSON.stringify({ type: 4, data: { content: 'Enter skin names or attach a photo.', flags: 64 } }) };
    const token = interaction.token;
    void (async () => {
      let messages;
      try {
        let image = null;
        if (attachment && geminiKey) {
          const url = new URL(attachment.url);
          if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || attachment.size > 5_000_000) throw new Error('Invalid Discord image');
          const response = await fetchFn(url, { signal: AbortSignal.timeout(9000) });
          if (!response.ok) throw new Error(`Discord image HTTP ${response.status}`);
          image = imageFromBytes(new Uint8Array(await response.arrayBuffer()));
        }
        messages = await lookupDiscord(item, image, geminiKey, fetchFn);
      } catch (error) {
        console.error('Discord lookup failed:', error instanceof Error ? error.message : String(error));
        messages = ['Price lookup is temporarily unavailable. Please try again shortly.'];
      }
      for (let i = 0; i < messages.length; i++) {
        const url = i === 0 ? `${discordApi}/webhooks/${applicationId}/${token}/messages/@original` : `${discordApi}/webhooks/${applicationId}/${token}`;
        const components = customerQuoteComponents(messages[i]);
        const response = await fetchFn(url, { method: i === 0 ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: messages[i], flags: 4, allowed_mentions: { parse: [] }, ...(components.length ? { components } : {}) }), signal: AbortSignal.timeout(9000) });
        if (!response.ok) throw new Error(`Discord response HTTP ${response.status}`);
      }
    })().catch((error) => console.error('Discord response failed:', error instanceof Error ? error.message : String(error)));
    return { status: 200, body: JSON.stringify({ type: 5 }) };
  };
}

export async function registerDiscordCommand({ applicationId, guildId, botToken }, fetchFn = fetch) {
  if (!applicationId || !guildId || !botToken) return;
  const response = await fetchFn(`${discordApi}/applications/${applicationId}/guilds/${guildId}/commands`, {
    method: 'POST', headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'buff', description: 'Get BUFF163 base prices and CNY to VND rates', type: 1,
      options: [
        { name: 'items', description: 'Skin names or a natural language request (up to 10)', type: 3, required: false },
        { name: 'image', description: 'Optional screenshot of CS2 skins', type: 11, required: false },
      ] }),
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`Discord command registration HTTP ${response.status}`);
}
