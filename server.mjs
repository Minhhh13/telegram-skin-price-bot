import { createServer } from 'node:http';
import { createHandler } from './supabase/functions/skin-price-webhook/handler.mjs';
import { createDiscordHandler, registerDiscordCommand } from './discord.mjs';
import { startDiscordGateway } from './discord-gateway.mjs';
import { startMessengerSupervisor } from './messenger-supervisor.mjs';
import { startGoMessengerListener } from './messenger-go.mjs';
import { createProfitDiscordHandler, createProfitService, registerProfitCommands } from './profit-discord.mjs';

const handler = createHandler({
  token: process.env.TELEGRAM_SKIN_BOT_TOKEN || '',
  secret: process.env.TELEGRAM_SKIN_WEBHOOK_SECRET || '',
  botUsername: process.env.TELEGRAM_SKIN_BOT_USERNAME || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
});
const port = Number(process.env.PORT || 10000);
const discordConfig = {
  publicKey: process.env.DISCORD_PUBLIC_KEY || '',
  applicationId: process.env.DISCORD_APPLICATION_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  channelId: process.env.DISCORD_CHANNEL_ID || '',
  botToken: process.env.DISCORD_BOT_TOKEN || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  profitChannelId: process.env.DISCORD_PROFIT_CHANNEL_ID || '',
  profitOwnerId: process.env.DISCORD_PROFIT_OWNER_ID || '',
  tradeDeskUrl: process.env.TRADE_DESK_URL || 'https://tradedesk.click',
  tradeDeskKey: process.env.TRADE_DESK_DISCORD_API_KEY || '',
};
const discordHandler = createDiscordHandler(discordConfig);
const profitService = createProfitService(discordConfig);
const profitHandler = createProfitDiscordHandler(discordConfig, fetch, profitService);
const messengerConfig = {
  cookies: process.env.MESSENGER_COOKIES || '',
  threadId: process.env.MESSENGER_THREAD_ID || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
};
let discordClient = null;
let messengerListener = null;

async function connectIntegrations() {
  if (discordConfig.profitChannelId && discordConfig.tradeDeskKey) {
    void profitService.primeRate().catch(() => console.warn('Shared profit conversion rate will load on the next check'));
  }
  const token = process.env.TELEGRAM_SKIN_BOT_TOKEN;
  const secret = process.env.TELEGRAM_SKIN_WEBHOOK_SECRET;
  const webhook = process.env.TELEGRAM_SKIN_WEBHOOK_URL;
  if (token && secret && webhook) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: webhook, secret_token: secret, allowed_updates: ['message'] }),
        signal: AbortSignal.timeout(9000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.description || `HTTP ${response.status}`);
      console.log('Telegram webhook connected');
    } catch (error) { console.error('Telegram webhook setup failed:', error instanceof Error ? error.message : String(error)); }
  }
  try {
    await registerDiscordCommand(discordConfig);
    if (discordConfig.botToken) console.log('Discord /buff command registered');
  } catch (error) { console.error('Discord command setup failed:', error instanceof Error ? error.message : String(error)); }
  try {
    await registerProfitCommands(discordConfig);
    if (discordConfig.botToken && discordConfig.profitChannelId) console.log('Discord profit commands registered');
  } catch { console.error('Discord profit command setup failed'); }
  try { discordClient = await startDiscordGateway(discordConfig); }
  catch (error) { console.error('Discord channel listener setup failed:', error instanceof Error ? error.message : String(error)); }
  if (process.env.MESSENGER_ENABLED === 'false') {
    console.log('Messenger listener paused');
  } else {
    messengerListener = process.env.MESSENGER_BACKEND === 'go'
      ? startGoMessengerListener(messengerConfig)
      : startMessengerSupervisor(messengerConfig);
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url !== '/telegram' && req.url !== '/discord') {
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
  if (req.url === '/discord') {
    const body = Buffer.concat(chunks).toString('utf8');
    let profitTarget = false;
    try { profitTarget = Boolean(discordConfig.profitChannelId && JSON.parse(body).channel_id === discordConfig.profitChannelId); } catch {}
    const result = await (profitTarget ? profitHandler : discordHandler)(new Headers(req.headers), body);
    res.writeHead(result.status, { 'content-type': result.status === 200 ? 'application/json' : 'text/plain' });
    res.end(result.body);
    return;
  }
  const request = new Request(`http://localhost:${port}/telegram`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(port, '0.0.0.0', () => {
  console.log(`Skin price webhook listening on ${port}`);
  void connectIntegrations();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down chat listeners');
  discordClient?.destroy();
  const timeout = setTimeout(() => process.exit(1), 15_000);
  timeout.unref();
  const httpClosed = new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([httpClosed, messengerListener?.stop()]);
  clearTimeout(timeout);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

