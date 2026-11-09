import { verifyDiscord, splitDiscord } from './discord.mjs';
import { createTradeDeskClient, formatProfitItem, identityId, itemLabel, profitQuery, queryFooter, queryFromMessage, resolveProfitRequest, TradeDeskError } from './profit.mjs';
import { aiItemSupportedByText, catalogHintsForText, DEFAULT_RATES, parseRequest, requestsFloatFilter } from './supabase/functions/skin-price-webhook/skin-price.mjs';
import { interpretItems, requestedRates } from './supabase/functions/skin-price-webhook/gemini.mjs';
import { firstDiscordImage } from './discord-images.mjs';

const api = 'https://discord.com/api/v10';
const noMentions = { parse: [] };
const setupButton = { type: 1, components: [{ type: 2, style: 1, custom_id: 'tdprofit:setup', label: 'Set up Account ID' }] };
const privateReply = (content, components = []) => ({ type: 4, data: { content, components, flags: 68, allowed_mentions: noMentions } });
const input = (custom_id, label, placeholder, max_length = 254, value) => ({ type: 18, label, component: {
  type: 4, custom_id, style: 1, required: true, placeholder, max_length, ...(value ? { value } : {}),
} });
const setupModal = () => ({ type: 9, data: { custom_id: 'tdprofit:setup-submit', title: 'Set up your Trade Desk Account ID', components: [
  input('account_id', 'Trade Desk Account ID', 'Paste your team Account ID', 36),
] } });
const modalValue = (components, id) => {
  for (const outer of components || []) {
    if (outer.component?.custom_id === id) return outer.component.value || '';
    const found = outer.components?.find((item) => item.custom_id === id);
    if (found) return found.value || '';
  }
  return '';
};
const actorId = (interaction) => interaction.member?.user?.id || interaction.user?.id || '';
const safe = (value) => String(value).replace(/@/g, '@\u200b').replace(/([\\`*_~|])/g, '\\$1');
const resultControls = (owner) => [{ type: 1, components: [
  { type: 2, style: 2, custom_id: 'tdprofit:refresh', label: 'Refresh' },
  { type: 2, style: 2, custom_id: 'tdprofit:buy-rate', label: 'Custom buying rate' },
  { type: 2, style: 2, custom_id: 'tdprofit:share', label: 'Share result' },
  ...(owner ? [{ type: 2, style: 2, custom_id: 'tdprofit:rate-open', label: 'Change USD rate' }] : []),
] }];
const candidateControls = (items) => [{ type: 1, components: [{ type: 3, custom_id: 'tdprofit:choose',
  placeholder: 'Choose an item to check', min_values: 1, max_values: 1,
  options: items.slice(0, 5).map((item) => ({ label: itemLabel(item).slice(0, 100), value: identityId(item) })),
}] }];

export function createProfitService(config, fetchFn = fetch) {
  const client = createTradeDeskClient({ url: config.tradeDeskUrl, apiKey: config.tradeDeskKey, guildId: config.guildId }, fetchFn);
  let lastRate = null;
  const isOwner = (userId) => Boolean(config.profitOwnerId && userId === config.profitOwnerId);
  const setupRequired = () => ({ content: 'Set up your team Trade Desk Account ID once, then send skin names or photos here.', components: [setupButton] });
  async function lookup(userId, query = '', selectedId = '', { image = null, loadImage = null, rawText = query } = {}) {
    if (query.length > 1100) throw new TradeDeskError('Send a skin request of at most 1100 characters.', 400);
    const status = await client.status(userId);
    if (!status.linked) return [setupRequired()];
    lastRate = status.rate || lastRate;
    if (!query.trim() && !selectedId && !image && loadImage && !config.geminiKey) return [{ content: 'Photo recognition is unavailable. Please type the item name.', components: [] }];
    if (!image && loadImage && config.geminiKey) image = await loadImage();
    if (!query.trim() && !selectedId && !image) return [{ content: 'Send a supported photo (JPEG, PNG, WebP, HEIC or HEIF) or type the item name.', components: [] }];
    const catalogue = await client.catalogue(userId);
    let request;
    if (selectedId) {
      const item = catalogue.byId.get(selectedId);
      if (!item) throw new TradeDeskError('That choice is no longer available. Search again.', 400);
      request = { items: [item], rates: parseRequest(query).rates, unresolved: [] };
      query = itemLabel(item) + ` rates ${request.rates.join(', ')}`;
    } else {
      if (image) {
        if (requestsFloatFilter(query)) throw new TradeDeskError('Exact float-range prices are unavailable. Enter a wear such as FN, MW, FT, WW or BS.', 400);
        try { request = { items: [], rates: requestedRates(query, parseRequest), unresolved: [] }; }
        catch (error) { throw new TradeDeskError(error.message, 400); }
        if (request.rates.some((rate) => !/^\d+(?:\.\d{1,3})?$/.test(String(rate)))) throw new TradeDeskError('Use at most three decimal places for a CNY buying rate.', 400);
      } else request = query.trim() ? await resolveProfitRequest(query, catalogue) : { items: [], rates: DEFAULT_RATES, unresolved: [] };
      if (config.geminiKey && (image || !request.items.length)) {
        let aiItems = await interpretItems({ text: rawText, image, candidates: catalogHintsForText(query), apiKey: config.geminiKey, fetchFn })
          .catch(() => null);
        if (aiItems && !image) aiItems = aiItems.filter((candidate) => aiItemSupportedByText(query, candidate));
        if (aiItems?.length) {
          query = `${aiItems.join('; ')} rates ${request.rates.join(', ')}`;
          if (query.length > 1100) throw new TradeDeskError('That photo contains too many long item names. Send a smaller group of items.', 400);
          request = await resolveProfitRequest(query, catalogue);
        } else if (image && query.trim()) {
          try { request = await resolveProfitRequest(query, catalogue); }
          catch { return [{ content: 'I could not read an item from that photo. Please send a clear item title or type its name.', components: [] }]; }
        }
      }
      if (!query.trim() || !request.items.length && !request.unresolved.length) return [{ content: 'I could not read an item from that photo. Please send a clear item title or type its name.', components: [] }];
    }
    const messages = [];
    if (request.items.length) {
      const result = await client.quotes(userId, request.items);
      if (!result || !Array.isArray(result.items)) throw new TradeDeskError('Trade Desk prices are temporarily unavailable.');
      lastRate = result.rate;
      const requested = new Set(request.items.map(identityId));
      const quotes = result.items.filter((item) => requested.has(identityId(item)));
      if (quotes.length !== request.items.length || new Set(quotes.map(identityId)).size !== requested.size) throw new TradeDeskError('Trade Desk could not confirm every requested item. Please refresh.');
      const header = `**Your Trade Desk profit check**\n${Number(result.rate?.vndPerUsd) > 0
        ? `Weekly USD→VND: **${Number(result.rate.vndPerUsd).toLocaleString('en-US')}**${result.rate.updatedAt ? ` · set ${new Date(result.rate.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`
        : 'Weekly USD→VND: not set'}`;
      const blocks = quotes.map((item) => formatProfitItem({ ...item,
        assumedFactoryNew: request.assumedFactoryNew?.has(identityId(item)) === true }, result.rate, request.rates));
      for (const chunk of splitDiscord([header, ...blocks, 'Estimated profit before extra fees. Reference prices; verify the final trade quote.'].join('\n\n'), 1900 - queryFooter(query).length)) {
        messages.push({ content: chunk + queryFooter(query), components: resultControls(isOwner(userId)) });
      }
    }
    for (const entry of request.unresolved) {
      const content = `**${safe(entry.query)}**\n${entry.message}${entry.candidates.length ? '\n' + entry.candidates.map((item) => `• ${safe(itemLabel(item))}`).join('\n') : ''}`;
      for (const chunk of splitDiscord(content, 1900 - queryFooter(query).length)) messages.push({
        content: chunk + queryFooter(query), components: entry.candidates.length ? candidateControls(entry.candidates) : [],
      });
    }
    return messages;
  }
  const errorResponse = (error) => error instanceof TradeDeskError && error.status === 403
    ? setupRequired() : { content: error instanceof TradeDeskError ? error.message : 'The profit checker is temporarily unavailable. Please try again shortly.', components: [] };
  return { client, lookup, isOwner, errorResponse,
    async primeRate() { const result = await client.rate(config.profitOwnerId); lastRate = result.rate; return result; },
    async saveRate(actor, value) { const result = await client.rate(actor, value); lastRate = result.rate; return result; },
    rateModal: () => ({ type: 9, data: { custom_id: 'tdprofit:rate-submit', title: 'Weekly USD to VND rate', components: [
      input('vnd_per_usd', 'VND received for 1 USD/USDT payout unit', 'For example: 26000', 16, lastRate?.vndPerUsd ? String(lastRate.vndPerUsd) : undefined),
    ] } }),
  };
}

export function createProfitDiscordHandler(config, fetchFn = fetch, service = createProfitService(config, fetchFn)) {
  const response = (value) => ({ status: 200, body: JSON.stringify(value) });
  const send = async (interaction, messages) => {
    for (const [index, message] of messages.entries()) {
      const url = `${api}/webhooks/${config.applicationId}/${interaction.token}${index ? '' : '/messages/@original'}`;
      const result = await fetchFn(url, { method: index ? 'POST' : 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...message, flags: index ? 68 : 4, allowed_mentions: noMentions }), signal: AbortSignal.timeout(9000) });
      if (!result.ok) throw new Error('Discord profit response failed');
    }
  };
  const deferred = (interaction, task) => {
    void task().then((messages) => send(interaction, messages)).catch(async (error) => {
      console.warn('Discord profit check failed:', error instanceof TradeDeskError ? `Trade Desk HTTP ${error.status}` : 'request failed');
      try { await send(interaction, [service.errorResponse(error)]); } catch { console.error('Discord profit error response failed'); }
    });
    return response({ type: 5, data: { flags: 64 } });
  };
  return async (headers, body) => {
    if (!config.publicKey || !verifyDiscord(headers, body, config.publicKey)) return { status: 401, body: 'Invalid signature' };
    let interaction;
    try { interaction = JSON.parse(body); } catch { return { status: 400, body: 'Invalid JSON' }; }
    if (interaction.type === 1) return response({ type: 1 });
    if (interaction.application_id !== config.applicationId) return { status: 401, body: 'Wrong application' };
    if (!config.profitChannelId || interaction.guild_id !== config.guildId || interaction.channel_id !== config.profitChannelId)
      return response(privateReply('Use the Trade Desk profit checker channel for this command.'));
    const userId = actorId(interaction);
    if (!/^\d{17,20}$/.test(userId)) return response(privateReply('Your Discord account could not be confirmed.'));
    const name = interaction.data?.name, id = interaction.data?.custom_id;
    if (interaction.type === 2 && ['setup', 'profitsetup'].includes(name) || interaction.type === 3 && ['tdprofit:setup', 'tdprofit:link'].includes(id)) return response(setupModal());
    if (interaction.type === 2 && name === 'ratechange' || interaction.type === 3 && id === 'tdprofit:rate-open') {
      return response(service.isOwner(userId) ? service.rateModal() : privateReply('Only the checker owner can change the shared USD→VND rate.'));
    }
    if (interaction.type === 5 && ['tdprofit:setup-submit', 'tdprofit:link-submit'].includes(id)) return deferred(interaction, async () => {
      const accountId = modalValue(interaction.data.components, 'account_id').trim().toLowerCase();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(accountId)) return [{ content: 'Paste your team Trade Desk Account ID in UUID format.', components: [setupButton] }];
      const result = await service.client.setup(userId, accountId);
      return [{ content: result.linked === true ? 'Account ID saved. You can now send skin names or photos in this channel.' : 'That team Account ID could not be set up. Check it and try again.', components: result.linked === true ? [] : [setupButton] }];
    });
    if (interaction.type === 5 && id === 'tdprofit:rate-submit') {
      if (!service.isOwner(userId)) return response(privateReply('Only the checker owner can change the shared USD→VND rate.'));
      return deferred(interaction, async () => {
        const text = modalValue(interaction.data.components, 'vnd_per_usd').replace(/[,\s]/g, '');
        const value = /^\d+(?:\.\d{1,2})?$/.test(text) ? Number(text) : NaN;
        if (!Number.isFinite(value) || value < 1 || value > 1_000_000) return [{ content: 'Enter a VND rate such as 26000, with at most two decimal places.', components: [] }];
        const result = await service.saveRate(userId, value);
        return [{ content: `Shared weekly rate saved: **1 USD/USDT payout unit = ₫${Number(result.rate.vndPerUsd).toLocaleString('en-US')}**. New checks and Refresh use this rate.`, components: [] }];
      });
    }
    if (interaction.type === 2 && name === 'profit') {
      const query = profitQuery(interaction.data.options?.find((option) => option.name === 'items')?.value || '');
      if (!query) return response(privateReply('Enter a skin name, for example: /profit items: ak redline ft', [setupButton]));
      if (query.length > 1100) return response(privateReply('Send a skin request of at most 1100 characters.'));
      return deferred(interaction, () => service.lookup(userId, query));
    }
    if (interaction.type === 3 && ['tdprofit:check', 'tdprofit:refresh', 'tdprofit:choose', 'tdprofit:buy-rate', 'tdprofit:share'].includes(id)) {
      const query = queryFromMessage(interaction.message, config.applicationId);
      if (!query) return response(privateReply('Run a new /profit lookup to check this item.'));
      if (id === 'tdprofit:share') return response({ type: 4, data: {
        content: `Shared by <@${userId}>\n${interaction.message.content}`,
        components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Check my profit', custom_id: 'tdprofit:check' }] }],
        flags: 4, allowed_mentions: noMentions,
      } });
      if (id === 'tdprofit:buy-rate') return response({ type: 9, data: { custom_id: 'tdprofit:buy-rate-submit', title: 'Custom CNY buying rate', components: [input('buying_rate', 'CNY to VND buying rate', '3.65 or 3650', 16)] } });
      let selected = '';
      if (id === 'tdprofit:choose') {
        selected = interaction.data.values?.[0] || '';
        const options = interaction.message.components?.flatMap((row) => row.components || []).flatMap((component) => component.options || []);
        if (!options?.some((option) => option.value === selected)) return response(privateReply('Choose an item from this result.'));
      }
      return deferred(interaction, () => service.lookup(userId, query, selected));
    }
    if (interaction.type === 5 && id === 'tdprofit:buy-rate-submit') {
      const query = queryFromMessage(interaction.message, config.applicationId);
      const entered = modalValue(interaction.data.components, 'buying_rate').trim();
      const value = /^\d+(?:\.\d{1,3})?$/.test(entered) ? Number(entered) : NaN;
      const rate = value >= 100 ? value / 1000 : value;
      if (!query || !Number.isFinite(rate) || rate < 2 || rate > 6) return response(privateReply('Enter a buying rate such as 3.65 or 3650 (allowed: 2.00–6.00).'));
      const next = `${parseRequest(query).items.join('; ')} rate ${rate}`;
      return deferred(interaction, () => service.lookup(userId, next));
    }
    return response(privateReply('Use /setup to save your Account ID, then send skin names or photos. The owner can use /ratechange to set the shared rate.'));
  };
}

export async function answerProfitChannelMessage(message, config, service = null, fetchFn = fetch) {
  if (!config.profitChannelId || !message || message.author?.bot || message.guildId !== config.guildId || message.channelId !== config.profitChannelId) return false;
  const content = String(message.content || '').trim();
  if ((!content && !message.attachments?.size) || content.startsWith('/')) return false;
  if (/^!ratechange\b/i.test(content)) {
    await message.reply({ content: message.author.id === config.profitOwnerId ? 'Change the shared weekly USD→VND rate:' : 'Only the checker owner can change the shared USD→VND rate.',
      components: message.author.id === config.profitOwnerId ? [{ type: 1, components: [{ type: 2, style: 2, label: 'Change USD rate', custom_id: 'tdprofit:rate-open' }] }] : [], allowedMentions: noMentions });
    return true;
  }
  if (/^(?:!setup|!profitsetup|!link)\b/i.test(content)) {
    await message.reply({ content: 'Set up your team Trade Desk Account ID privately:', components: [setupButton], allowedMentions: noMentions });
    return true;
  }
  // Account identifiers belong in the private setup modal, never echoed into a result.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$|^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(content)) {
    await message.reply({ content: 'Use Set up Account ID to enter your team Trade Desk Account ID privately.', components: [setupButton], allowedMentions: noMentions });
    return true;
  }
  const query = profitQuery(content.replace(/^!profit\b/i, '').replace(new RegExp(`<@!?${config.applicationId}>`, 'g'), '').trim());
  if (!query && !message.attachments?.size) return false;
  if (query.length > 1100) {
    await message.reply({ content: 'Send a skin request of at most 1100 characters.', allowedMentions: noMentions });
    return true;
  }
  service ||= createProfitService(config, fetchFn);
  let messages;
  try {
    await message.channel?.sendTyping?.();
    messages = await service.lookup(message.author.id, query, '', {
      rawText: message.content || '', loadImage: message.attachments?.size ? () => firstDiscordImage(message, fetchFn) : null,
    });
  } catch (error) { messages = [service.errorResponse(error)]; }
  for (const [index, result] of messages.entries()) {
    const components = result.components?.map((row) => ({ ...row,
      components: row.components.filter((component) => component.custom_id !== 'tdprofit:share') })).filter((row) => row.components.length) || [];
    const payload = { content: result.content, components, allowedMentions: noMentions, flags: 4,
      ...(message.id ? { nonce: `${message.id}:p${index}`, enforceNonce: true } : {}) };
    if (index === 0) await message.reply(payload);
    else await message.channel.send(payload);
  }
  return true;
}

export async function registerProfitCommands(config, fetchFn = fetch) {
  if (!config.profitChannelId || !config.applicationId || !config.guildId || !config.botToken) return;
  for (const command of [
    { name: 'profit', description: 'Check your Trade Desk offer and estimated VND profit', options: [{ name: 'items', description: 'Skin names (up to 10), optionally rate 3.65', type: 3, required: true }] },
    { name: 'setup', description: 'Set up your team Trade Desk Account ID privately' },
    { name: 'profitsetup', description: 'Set up your team Trade Desk Account ID privately' },
    { name: 'ratechange', description: 'Owner: set the shared weekly USD to VND conversion rate' },
  ]) {
    const result = await fetchFn(`${api}/applications/${config.applicationId}/guilds/${config.guildId}/commands`, {
      method: 'POST', headers: { authorization: `Bot ${config.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...command, type: 1 }), signal: AbortSignal.timeout(9000),
    });
    if (!result.ok) throw new Error(`Discord profit command registration HTTP ${result.status}`);
  }
}
