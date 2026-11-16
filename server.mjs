import { createServer } from 'node:http';
import { createDiscordHandler, registerDiscordCommand } from './discord.mjs';
import { startDiscordGateway } from './discord-gateway.mjs';
import { createProfitDiscordHandler, createProfitService, registerProfitCommands } from './profit-discord.mjs';
import { isProfitChannel, profitChannelIds } from './profit-channels.mjs';

const port = Number(process.env.PORT || 10000);
const discordConfig = {
  publicKey: process.env.DISCORD_PUBLIC_KEY || '',
  applicationId: process.env.DISCORD_APPLICATION_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  channelId: process.env.DISCORD_CHANNEL_ID || '',
  botToken: process.env.DISCORD_BOT_TOKEN || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  profitChannelId: process.env.DISCORD_PROFIT_CHANNEL_ID || '',
  profitChannelIds: process.env.DISCORD_PROFIT_CHANNEL_IDS || '',
  profitOwnerId: process.env.DISCORD_PROFIT_OWNER_ID || '',
  tradeDeskUrl: process.env.TRADE_DESK_URL || 'https://tradedesk.click',
  tradeDeskKey: process.env.TRADE_DESK_DISCORD_API_KEY || '',
};
const discordHandler = createDiscordHandler(discordConfig);
const profitService = profitChannelIds(discordConfig).length ? createProfitService(discordConfig) : null;
const profitHandler = profitService ? createProfitDiscordHandler(discordConfig, fetch, profitService) : null;
let discordClient = null;

async function connectIntegrations() {
  if (profitService && discordConfig.tradeDeskKey) {
    void profitService.primeRate().catch(() => console.warn('Shared profit conversion rate will load on the next check'));
  }
  try {
    await registerDiscordCommand(discordConfig);
    if (discordConfig.botToken) console.log('Discord /buff command registered');
  } catch (error) { console.error('Discord command setup failed:', error instanceof Error ? error.message : String(error)); }
  try {
    await registerProfitCommands(discordConfig);
    if (discordConfig.botToken && profitChannelIds(discordConfig).length) console.log('Discord profit commands registered');
  } catch { console.error('Discord profit command setup failed'); }
  try { discordClient = await startDiscordGateway(discordConfig, profitService); }
  catch (error) { console.error('Discord channel listener setup failed:', error instanceof Error ? error.message : String(error)); }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url !== '/discord') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) {
      res.writeHead(413);
      res.end('Too large');
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  let profitTarget = false;
  try { const interaction = JSON.parse(body); profitTarget = isProfitChannel(discordConfig, interaction.guild_id, interaction.channel_id); } catch {}
  const result = await (profitTarget ? profitHandler : discordHandler)(new Headers(req.headers), body);
  res.writeHead(result.status, { 'content-type': result.status === 200 ? 'application/json' : 'text/plain' });
  res.end(result.body);
}).listen(port, '0.0.0.0', () => {
  console.log(`Discord skin price bot listening on ${port}`);
  void connectIntegrations();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down Discord listener');
  discordClient?.destroy();
  const timeout = setTimeout(() => process.exit(1), 15_000);
  timeout.unref();
  const httpClosed = new Promise((resolve) => server.close(resolve));
  await httpClosed;
  clearTimeout(timeout);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

