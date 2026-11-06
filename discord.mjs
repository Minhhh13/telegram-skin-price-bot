import { createPublicKey, verify } from 'node:crypto';
import { aiItemSupportedByText, buildParsedReply, buildReply, catalogHintsForText, floatFilterUnavailable, parseRequest, requestsFloatFilter } from './supabase/functions/skin-price-webhook/skin-price.mjs';
import { imageFromBytes, interpretItems, requestedRates } from './supabase/functions/skin-price-webhook/gemini.mjs';
import { candidateComponents, candidateSelectId, selectedCandidate } from './discord-candidates.mjs';

const discordApi = 'https://discord.com/api/v10';
const customerQuoteButtonId = 'buff:customer-quote';
const customerQuoteModalId = 'buff:customer-quote:submit';
const customRateButtonId = 'buff:custom-rate';
const customRateModalId = 'buff:custom-rate:submit';
const copyTextButtonId = 'buff:copy-text';
const copyTextModalId = 'buff:copy-text:submit';

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
    { type: 2, style: 2, label: 'Custom rate', custom_id: customRateButtonId },
  ] }] : [];
}

export function discordReplyComponents(content) {
  return [...customerQuoteComponents(content), ...candidateComponents(content)];
}

function quoteModal(quotes, customRate = false) {
  const rates = [...new Set(quotes.flatMap((quote) => quote.rates.map(({ rate }) => rate)))];
  return { type: 9, data: {
    custom_id: customRate ? customRateModalId : customerQuoteModalId,
    title: customRate ? 'Custom customer rate' : 'Copy customer quote',
    components: [
      { type: 18, label: 'Item', component: {
        type: 3, custom_id: 'item', placeholder: 'Choose one item', required: true,
        options: quotes.slice(0, 25).map((quote, index) => ({
          label: quote.name.slice(0, 100), value: String(index), default: quotes.length === 1,
        })),
      } },
      customRate ? { type: 18, label: 'CNY to VND rate', component: {
        type: 4, custom_id: 'custom_rate', style: 1, required: true,
        min_length: 1, max_length: 12, placeholder: '3.72 or 3720 VND per CNY',
      } } : { type: 18, label: 'CNY to VND rate', component: {
        type: 3, custom_id: 'rate', placeholder: 'Choose one rate', required: true,
        options: rates.slice(0, 25).map((rate) => ({
          label: rate, value: rate, default: rate === '3.65',
        })),
      } },
    ],
  } };
}

function modalValue(components, customId) {
  const component = components?.find((item) => item?.component?.custom_id === customId)?.component;
  return component?.values?.[0] ?? component?.value;
}

function quoteResponse(quote, rate, vnd) {
  const lines = [quote.name, `BUFF: ${quote.cny}`, `${rate} → ${vnd}`];
  if (quote.url) lines.push(quote.url);
  return copyReadyQuote(lines.join('\n'));
}

function copyReadyQuote(quoteText) {
  return { type: 4, data: {
    content: `Copy this quote:\n\`\`\`text\n${quoteText.replaceAll('```', "'''")}\n\`\`\``,
    flags: 64, allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [
      { type: 2, style: 2, label: 'Copy on phone', custom_id: copyTextButtonId },
    ] }],
  } };
}

function quoteTextFromMessage(content) {
  return String(content || '').match(/^Copy this quote:\n```text\n([\s\S]{1,4000})\n```$/)?.[1] || '';
}

function copyTextModal(content) {
  const quoteText = quoteTextFromMessage(content);
  return quoteText ? { type: 9, data: {
    custom_id: copyTextModalId, title: 'Copy quote on phone',
    components: [{ type: 18, label: 'Tap, Select All, then Copy', component: {
      type: 4, custom_id: 'quote_text', style: 2, value: quoteText,
      required: false, max_length: 4000,
    } }],
  } } : quoteError('That quote is no longer available. Run the price lookup again.');
}

function quoteError(content) {
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

function customRate(raw) {
  const input = String(raw ?? '').trim().replaceAll(' ', '');
  if (!/^(?:\d{1,2}(?:[.,]\d{1,3})?|\d{4,5})$/.test(input)) return null;
  const perCny = /^\d{4,5}$/.test(input) ? Number(input) : Math.round(Number(input.replace(',', '.')) * 1000);
  if (perCny < 1000 || perCny > 10000) return null;
  return { perCny, label: (perCny / 1000).toFixed(perCny % 10 === 0 ? 2 : 3) };
}

function customerQuoteResponse(interaction, isCustomRate = false) {
  const quotes = customerQuotes(interaction.message?.content);
  const itemIndex = Number(modalValue(interaction.data?.components, 'item'));
  const rate = modalValue(interaction.data?.components, 'rate');
  const quote = Number.isInteger(itemIndex) && itemIndex >= 0 ? quotes[itemIndex] : null;
  if (!quote) return quoteError('That quote is no longer available. Run the price lookup again.');
  if (isCustomRate) {
    const entered = customRate(modalValue(interaction.data?.components, 'custom_rate'));
    if (!entered) return quoteError('Enter a rate like 3.72 or 3720 VND per CNY (allowed range: 1.00–10.00).');
    const price = quote.cny.match(/^¥([\d,]+)\.(\d{2}) CNY$/);
    if (!price) return quoteError('That quote is no longer available. Run the price lookup again.');
    const cents = Number(price[1].replaceAll(',', '')) * 100 + Number(price[2]);
    const vnd = `₫${Math.round(cents * entered.perCny / 100).toLocaleString('en-US')}`;
    return quoteResponse(quote, entered.label, vnd);
  }
  const conversion = quote?.rates.find((entry) => entry.rate === rate);
  if (!conversion) return quoteError('That quote is no longer available. Run the price lookup again.');
  return quoteResponse(quote, rate, conversion.vnd);
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
    if (interaction.type === 3 && interaction.data?.custom_id === candidateSelectId) {
      const selected = selectedCandidate(interaction);
      if (!selected) return { status: 200, body: JSON.stringify(quoteError('Choose an item from this price result.')) };
      const token = interaction.token;
      void (async () => {
        const messages = await lookupDiscord(selected, null, '', fetchFn, selected);
        for (const [index, content] of messages.entries()) {
          const url = index === 0 ? `${discordApi}/webhooks/${applicationId}/${token}/messages/@original`
            : `${discordApi}/webhooks/${applicationId}/${token}`;
          const components = discordReplyComponents(content);
          const response = await fetchFn(url, {
            method: index === 0 ? 'PATCH' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content, allowed_mentions: { parse: [] },
              ...(components.length ? { components } : {}), ...(index ? { flags: 64 } : {}) }),
            signal: AbortSignal.timeout(9000),
          });
          if (!response.ok) throw new Error(`Discord selected item response HTTP ${response.status}`);
        }
      })().catch(async (error) => {
        console.error('Discord selected item failed:', error instanceof Error ? error.message : String(error));
        try {
          await fetchFn(`${discordApi}/webhooks/${applicationId}/${token}/messages/@original`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: 'Price lookup is temporarily unavailable. Please try again shortly.', allowed_mentions: { parse: [] } }),
            signal: AbortSignal.timeout(9000),
          });
        } catch (sendError) {
          console.error('Discord selected item error reply failed:', sendError instanceof Error ? sendError.message : String(sendError));
        }
      });
      return { status: 200, body: JSON.stringify({ type: 5, data: { flags: 64 } }) };
    }
    if (interaction.type === 3 && [customerQuoteButtonId, customRateButtonId].includes(interaction.data?.custom_id)) {
      const quotes = customerQuotes(interaction.message?.content);
      const response = quotes.length ? quoteModal(quotes, interaction.data.custom_id === customRateButtonId)
        : quoteError('No priced item is available in this message.');
      return { status: 200, body: JSON.stringify(response) };
    }
    if (interaction.type === 3 && interaction.data?.custom_id === copyTextButtonId) {
      return { status: 200, body: JSON.stringify(copyTextModal(interaction.message?.content)) };
    }
    if (interaction.type === 5 && [customerQuoteModalId, customRateModalId].includes(interaction.data?.custom_id)) {
      return { status: 200, body: JSON.stringify(customerQuoteResponse(interaction,
        interaction.data.custom_id === customRateModalId)) };
    }
    if (interaction.type === 5 && interaction.data?.custom_id === copyTextModalId) {
      const text = quoteTextFromMessage(interaction.message?.content);
      return { status: 200, body: JSON.stringify(text ? copyReadyQuote(text)
        : quoteError('That quote is no longer available. Run the price lookup again.')) };
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
        const components = discordReplyComponents(messages[i]);
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
