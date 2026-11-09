import { convertCnyCentsToVnd, queryFromMessage } from './profit.mjs';

export const profitCustomerButtonId = 'tdprofit:customer-quote';
const submitId = 'tdprofit:customer-quote-submit';
const phoneId = 'tdprofit:customer-copy';
const phoneSubmitId = 'tdprofit:customer-copy-submit';
const listing = /^https:\/\/buff\.163\.com\/goods\/\d+$/;
const ownMessage = (message, applicationId) => message?.author?.id === applicationId && message.author.bot === true;
const error = () => ({ type: 4, data: { content: 'That customer quote is unavailable. Refresh the price and try again.', flags: 68, allowed_mentions: { parse: [] } } });
const unescapeName = (text) => text.replace(/\\([\\`*_~|])/g, '$1').replace(/\u200b/g, '').replace(/ \(FN assumed\)$/, '');

// Reuse the displayed BUFF snapshot. No account, feed or model request is needed.
export function profitCustomerQuotes(content) {
  const quotes = [];
  for (const block of String(content || '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const title = lines[0]?.match(/^\*\*(.+)\*\*$/)?.[1];
    const priceLine = lines.find((line) => /^BUFF: \*\*¥/.test(line));
    const price = priceLine?.match(/^BUFF: \*\*¥([\d,]+)\.(\d{2}) CNY\*\*/);
    const url = priceLine?.match(/\[BUFF listing\]\(<?(https:\/\/buff\.163\.com\/goods\/\d+)>?\)/)?.[1];
    if (!title || !price || !url || !listing.test(url)) continue;
    const cents = BigInt(price[1].replaceAll(',', '') + price[2]);
    if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const name = unescapeName(title);
    if (!name || name.length > 600 || /[\x00-\x1f\x7f]/.test(name)) continue;
    const rates = [...new Set(lines.flatMap((line) => line.match(/^\S+ \*\*(\d+\.\d{2,3})\*\* · ₫/)?.[1] || []))];
    quotes.push({ name, cnyCents: cents, url, rates });
  }
  return quotes.slice(0, 25);
}

export function profitCustomerButton(content) {
  return profitCustomerQuotes(content).length ? { type: 2, style: 2, custom_id: profitCustomerButtonId, label: 'Customer quote' } : null;
}

function value(components, id) {
  for (const row of components || []) {
    const component = row.component?.custom_id === id ? row.component : row.components?.find((part) => part.custom_id === id);
    if (component) return component.values?.[0] ?? component.value;
  }
}

function sellingRate(raw) {
  const text = String(raw ?? '').trim().replaceAll(' ', '');
  if (!/^(?:\d{1,2}(?:[.,]\d{1,3})?|\d{4,5})$/.test(text)) return null;
  const rate = /^\d{4,5}$/.test(text) ? Number(text) / 1000 : Number(text.replace(',', '.'));
  return Number.isFinite(rate) && rate >= 1 && rate <= 10 ? rate : null;
}

function customerModal(quotes) {
  const rates = [...new Set(quotes.flatMap((quote) => quote.rates))];
  const rate = rates.length === 1 ? rates[0] : rates.includes('3.65') ? '3.65' : rates[0] || '3.65';
  return { type: 9, data: { custom_id: submitId, title: 'Customer quote', components: [
    { type: 18, label: 'Item', component: { type: 3, custom_id: 'item', required: true, placeholder: 'Choose one item',
      options: quotes.map((quote, index) => ({ label: quote.name.slice(0, 100), value: String(index), default: quotes.length === 1 })) } },
    { type: 18, label: 'CNY to VND selling rate (private)', component: { type: 4, custom_id: 'selling_rate', style: 1, required: true,
      max_length: 16, value: rate, placeholder: '3.65 or 3650 VND per CNY' } },
  ] } };
}

function copyReady(text) {
  return { type: 4, data: { content: `Copy this quote:\n\`\`\`text\n${text}\n\`\`\``, flags: 68, allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [{ type: 2, style: 2, custom_id: phoneId, label: 'Copy on phone' }] }] } };
}

function copiedText(message, applicationId) {
  if (!ownMessage(message, applicationId)) return '';
  const text = String(message.content || '').match(/^Copy this quote:\n```text\n([\s\S]{1,1800})\n```$/)?.[1] || '';
  const lines = text.split('\n');
  return lines.length === 3 && lines[0] && /^₫[\d,]+$/.test(lines[1]) && listing.test(lines[2]) ? text : '';
}

export function profitCustomerInteraction(interaction, applicationId) {
  const id = interaction.data?.custom_id;
  if (interaction.type === 3 && id === profitCustomerButtonId) {
    if (!queryFromMessage(interaction.message, applicationId)) return error();
    const quotes = profitCustomerQuotes(interaction.message.content);
    return quotes.length ? customerModal(quotes) : error();
  }
  if (interaction.type === 5 && id === submitId) {
    if (!queryFromMessage(interaction.message, applicationId)) return error();
    const quotes = profitCustomerQuotes(interaction.message.content), selected = value(interaction.data.components, 'item');
    const quote = /^\d{1,2}$/.test(String(selected ?? '')) ? quotes[Number(selected)] : null;
    const rate = sellingRate(value(interaction.data.components, 'selling_rate'));
    if (!quote || rate === null) return { type: 4, data: { content: 'Choose an item and enter a selling rate such as 3.65 or 3650 (allowed: 1.00–10.00).', flags: 68, allowed_mentions: { parse: [] } } };
    const amount = convertCnyCentsToVnd(quote.cnyCents, rate);
    return amount === null ? error() : copyReady(`${quote.name}\n₫${amount.toLocaleString('en-US')}\n${quote.url}`);
  }
  if (interaction.type === 3 && id === phoneId) {
    const text = copiedText(interaction.message, applicationId);
    return text ? { type: 9, data: { custom_id: phoneSubmitId, title: 'Copy quote on phone', components: [
      { type: 18, label: 'Tap, Select All, then Copy', component: { type: 4, custom_id: 'quote_text', style: 2, required: false, max_length: 1800, value: text } },
    ] } } : error();
  }
  if (interaction.type === 5 && id === phoneSubmitId) {
    const text = copiedText(interaction.message, applicationId);
    return text ? copyReady(text) : error();
  }
  return null;
}
