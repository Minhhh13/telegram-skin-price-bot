import { Client, Events, GatewayIntentBits, MessageFlags, Options } from 'discord.js';
import { discordReplyComponents, lookupDiscord } from './discord.mjs';
import { firstDiscordImage } from './discord-images.mjs';
import { answerProfitChannelMessage } from './profit-discord.mjs';

export function shouldHandleChannelMessage(message, { guildId, channelId }) {
  return Boolean(message && !message.author?.bot && message.guildId === guildId &&
    message.channelId === channelId &&
    (String(message.content || '').trim() || message.attachments?.size));
}

export function stripBotMention(text, botId) {
  return String(text || '').replace(new RegExp(`<@!?${String(botId || '').replace(/\D/g, '')}>`, 'g'), '').trim();
}

export async function answerChannelMessage(message, config, fetchFn = fetch) {
  if (!shouldHandleChannelMessage(message, config)) return false;
  const text = stripBotMention(message.content, config.applicationId);
  if (text.startsWith('/')) return false;
  try {
    await message.channel.sendTyping();
    const image = config.geminiKey ? await firstDiscordImage(message, fetchFn) : null;
    const chunks = await lookupDiscord(text, image, config.geminiKey, fetchFn, message.content);
    for (const [index, content] of chunks.entries()) {
      const userId = message.author?.id;
      const components = discordReplyComponents(content);
      const options = {
        content: index === 0 && userId ? `<@${userId}>\n${content}` : content,
        allowedMentions: userId ? { parse: [], users: [userId], repliedUser: true } : { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
        ...(components.length ? { components } : {}),
        ...(message.id ? { nonce: `${message.id}:${index}`, enforceNonce: true } : {}),
      };
      if (index === 0) await message.reply(options);
      else await message.channel.send(options);
    }
  } catch (error) {
    console.error('Discord channel lookup failed:', error instanceof Error ? error.message : String(error));
    await message.reply({ content: 'Price lookup is temporarily unavailable. Please try again shortly.', allowedMentions: { parse: [] } });
  }
  return true;
}

export async function startDiscordGateway(config, profitService) {
  if (!config.botToken || !config.guildId || !config.channelId) return null;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
  });
  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (await answerProfitChannelMessage(message, config, profitService)) return;
      await answerChannelMessage(message, config);
    })().catch((error) =>
      console.error('Discord channel reply failed:', error instanceof Error ? error.message : String(error)));
  });
  client.once(Events.ClientReady, () => console.log('Discord channel listener connected'));
  client.on(Events.Error, (error) => console.error('Discord gateway error:', error.message));
  await client.login(config.botToken);
  return client;
}
