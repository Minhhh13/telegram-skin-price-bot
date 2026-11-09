// Explicit IDs only. Legacy singular and newer plural settings form one list.
export function profitChannelIds(config) {
  const plural = Array.isArray(config.profitChannelIds) ? config.profitChannelIds : String(config.profitChannelIds || '').split(',');
  return [...new Set([config.profitChannelId, ...plural].filter((value) => typeof value === 'string')
    .map((value) => value.trim()).filter((value) => /^\d{17,20}$/.test(value)))];
}

export function isProfitChannel(config, guildId, channelId) {
  return Boolean(config.guildId && guildId === config.guildId && typeof channelId === 'string' && profitChannelIds(config).includes(channelId));
}
