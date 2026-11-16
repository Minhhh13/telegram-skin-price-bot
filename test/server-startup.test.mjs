import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const clearKeys = ['TELEGRAM_SKIN_BOT_TOKEN', 'TELEGRAM_SKIN_WEBHOOK_SECRET', 'TELEGRAM_SKIN_WEBHOOK_URL',
  'TELEGRAM_SKIN_BOT_USERNAME', 'GEMINI_API_KEY', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_PROFIT_CHANNEL_ID',
  'DISCORD_PROFIT_CHANNEL_IDS', 'DISCORD_PROFIT_OWNER_ID', 'TRADE_DESK_DISCORD_API_KEY', 'NODE_OPTIONS'];
const app = '123456789012345678', guild = '123456789012345679', buff = '123456789012345680';
const privateChannel = '123456789012345681', teamChannel = '123456789012345682', actor = '123456789012345683';

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function boot(t, { configured = false, legacyBackend = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'discord-bot-startup-'));
  const hook = join(directory, 'discord-runtime-hook.mjs');
  const gateway = `export async function startDiscordGateway(config, profitService) {
    if (${configured} && (config.channelId !== '${buff}' || config.profitChannelIds !== '${privateChannel},${teamChannel}' || !profitService)) throw new Error('Discord channel configuration changed');
    console.log('DISCORD_GATEWAY_STARTED');
    return { destroy() { console.log('DISCORD_GATEWAY_DESTROYED'); } };
  }`;
  await writeFile(hook, `
    import { registerHooks } from 'node:module';
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (${configured} && value.startsWith('https://discord.com/api/v10/applications/')) {
        console.log('REGISTERED_COMMAND:' + JSON.parse(options.body).name);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (${configured} && value === 'https://tradedesk.test/api/integrations/discord/rate') {
        console.log('SHARED_RATE_PRIMED');
        return new Response(JSON.stringify({ rate: { vndPerUsd: 26000 } }), { status: 200 });
      }
      console.error('UNEXPECTED_EXTERNAL_FETCH'); throw new Error('External fetch forbidden');
    };
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'meta-messenger.js' || /messenger[^/]*\\.mjs$/.test(specifier) || /skin-price-webhook\\/(?:handler\\.mjs|index\\.js)$/.test(specifier)) throw new Error('RETIRED_IMPORT_FORBIDDEN');
      if (specifier === './discord-gateway.mjs' && context.parentURL?.endsWith('/server.mjs')) return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(gateway)}), shortCircuit: true };
      return nextResolve(specifier, context);
    } });
  `);
  const port = await freePort();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const env = { ...process.env, ...Object.fromEntries(clearKeys.map((key) => [key, ''])), PORT: String(port),
    // Retired settings must remain inert even when still present on a host.
    TELEGRAM_SKIN_BOT_TOKEN: 'synthetic-retired-token', TELEGRAM_SKIN_WEBHOOK_SECRET: 'synthetic-retired-secret',
    TELEGRAM_SKIN_WEBHOOK_URL: 'https://retired.telegram.test/telegram', TELEGRAM_SKIN_BOT_USERNAME: 'retired_bot',
    MESSENGER_ENABLED: 'true', MESSENGER_BACKEND: legacyBackend, MESSENGER_COOKIES: 'synthetic-retired-cookie', MESSENGER_THREAD_ID: 'synthetic-retired-thread',
    ...(configured ? { DISCORD_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
      DISCORD_APPLICATION_ID: app, DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_ID: buff, DISCORD_BOT_TOKEN: 'synthetic-discord-token',
      DISCORD_PROFIT_CHANNEL_IDS: `${privateChannel},${teamChannel}`, DISCORD_PROFIT_OWNER_ID: actor,
      TRADE_DESK_URL: 'https://tradedesk.test', TRADE_DESK_DISCORD_API_KEY: 'synthetic-integration-key' } : {}),
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, 'server.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exit = null;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => { exit = code; resolve(); }));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(exit, null, output);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      ready = response.ok && (await response.text()) === 'ok' && output.includes('DISCORD_GATEWAY_STARTED');
      if (ready) break;
    } catch { /* The child has not bound its HTTP port yet. */ }
    await delay(25);
  }
  assert.equal(ready, true, output);
  assert.doesNotMatch(output, /RETIRED_IMPORT_FORBIDDEN|UNEXPECTED_EXTERNAL_FETCH|setup failed/);
  const signed = (channel_id, data) => {
    const body = JSON.stringify({ type: 2, application_id: app, guild_id: guild, channel_id, member: { user: { id: actor } }, data });
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex') } };
  };
  return { base, signed, output: () => output };
}

test('Discord-only startup ignores retired settings and no longer serves Telegram', async (t) => {
  for (const legacyBackend of ['', 'go']) {
    const server = await boot(t, { legacyBackend });
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${server.base}/telegram`, { method });
      assert.equal(response.status, 404);
    }
    assert.equal((await fetch(`${server.base}/health`)).status, 200);
    assert.equal((await fetch(`${server.base}/missing`)).status, 404);
    const discord = await fetch(`${server.base}/discord`, { method: 'POST', body: '{}' });
    assert.equal(discord.status, 503);
    const large = await fetch(`${server.base}/discord`, { method: 'POST', body: 'x'.repeat(100_001) });
    assert.equal(large.status, 413);
    assert.doesNotMatch(server.output(), /UNEXPECTED_EXTERNAL_FETCH|RETIRED_IMPORT_FORBIDDEN/);
  }
});

test('startup retains BUFF and both profit channel interaction routes on one Discord listener', async (t) => {
  const server = await boot(t, { configured: true, legacyBackend: 'go' });
  for (const channel of [privateChannel, teamChannel]) {
    const response = await fetch(`${server.base}/discord`, server.signed(channel, { name: 'setup' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).type, 9);
  }
  const buffResponse = await fetch(`${server.base}/discord`, server.signed(buff, { name: 'buff' }));
  assert.equal(buffResponse.status, 200);
  assert.match((await buffResponse.json()).data.content, /Enter skin names or attach a photo/);
  assert.equal(server.output().match(/DISCORD_GATEWAY_STARTED/g)?.length, 1);
  for (const command of ['buff', 'profit', 'setup', 'profitsetup', 'ratechange']) assert.ok(server.output().includes(`REGISTERED_COMMAND:${command}`));
  assert.match(server.output(), /SHARED_RATE_PRIMED/);
  assert.doesNotMatch(server.output(), /UNEXPECTED_EXTERNAL_FETCH|RETIRED_IMPORT_FORBIDDEN/);
});
