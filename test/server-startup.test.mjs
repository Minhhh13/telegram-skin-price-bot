import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const emptyKeys = ['TELEGRAM_SKIN_BOT_TOKEN', 'TELEGRAM_SKIN_WEBHOOK_SECRET', 'TELEGRAM_SKIN_WEBHOOK_URL',
  'TELEGRAM_SKIN_BOT_USERNAME', 'GEMINI_API_KEY', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_PROFIT_CHANNEL_ID',
  'DISCORD_PROFIT_CHANNEL_IDS', 'DISCORD_PROFIT_OWNER_ID', 'TRADE_DESK_DISCORD_API_KEY', 'NODE_OPTIONS'];

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function boot(t, backend, enabled) {
  const directory = await mkdtemp(join(tmpdir(), 'skin-bot-startup-'));
  const hook = join(directory, 'messenger-import-hook.mjs');
  // Reject every Messenger module while paused, as if its optional dependency
  // were absent. Enabled cases substitute only the chosen listener entry point.
  await writeFile(hook, `
    import { registerHooks } from 'node:module';
    globalThis.fetch = async () => { console.error('UNEXPECTED_EXTERNAL_FETCH'); throw new Error('External fetch forbidden'); };
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'meta-messenger.js' || /messenger[^/]*\\.mjs$/.test(specifier)) {
        const chosen = ${JSON.stringify(enabled ? backend === 'go' ? './messenger-go.mjs' : './messenger-supervisor.mjs' : '')};
        if (specifier !== chosen) throw new Error('MESSENGER_IMPORT_FORBIDDEN:' + specifier);
        const name = ${JSON.stringify(backend === 'go' ? 'startGoMessengerListener' : 'startMessengerSupervisor')};
        const source = 'export function ' + name + '(config) {' +
          'if(config.cookies!=="synthetic-cookie"||config.threadId!=="synthetic-thread")throw new Error("Listener config changed");' +
          'console.log("SELECTED_MESSENGER_STARTED");return {stop:async()=>{}};}';
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    } });
  `);
  const port = await freePort();
  const env = { ...process.env, ...Object.fromEntries(emptyKeys.map((key) => [key, ''])),
    PORT: String(port), MESSENGER_ENABLED: enabled ? 'true' : 'false', MESSENGER_BACKEND: backend,
    MESSENGER_COOKIES: 'synthetic-cookie', MESSENGER_THREAD_ID: 'synthetic-thread' };
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assert.equal(exit, null, output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.text()) === 'ok' && output.includes(enabled ? 'SELECTED_MESSENGER_STARTED' : 'Messenger listener paused')) break;
    } catch { /* Startup has not bound its HTTP port yet. */ }
    await delay(25);
  }
  assert.match(output, enabled ? /SELECTED_MESSENGER_STARTED/ : /Messenger listener paused/, output);
  assert.doesNotMatch(output, /MESSENGER_IMPORT_FORBIDDEN|UNEXPECTED_EXTERNAL_FETCH/);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
}

test('paused Messenger serves real HTTP health with all Messenger imports unavailable', async (t) => {
  await boot(t, 'go', false);
});

test('enabled Go Messenger loads only the selected listener with the existing config', async (t) => {
  await boot(t, 'go', true);
});

test('enabled default Messenger loads only the supervisor with the existing config', async (t) => {
  await boot(t, '', true);
});
