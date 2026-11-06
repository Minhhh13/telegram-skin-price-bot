import { startMessengerListener } from './messenger.mjs';

let listener = null;
let readyTimer = null;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (readyTimer) clearInterval(readyTimer);
  await listener?.stop();
  if (process.connected && process.send) process.send({ type: 'stopped' }, () => process.exit(0));
  else process.exit(0);
}

process.on('message', (message) => {
  if (message?.type === 'stop') {
    void stop();
    return;
  }
  if (message?.type !== 'start' || listener || stopping) return;
  listener = startMessengerListener({
    cookies: process.env.MESSENGER_COOKIES || '',
    threadId: process.env.MESSENGER_THREAD_ID || '',
    geminiKey: process.env.GEMINI_API_KEY || '',
    startedAt: Number(message.startedAt),
    recentMessageIds: Array.isArray(message.recentMessageIds) ? message.recentMessageIds : [],
    onMessageHandled: (id) => {
      if (process.connected && process.send && id) process.send({ type: 'handled', id: String(id) });
    },
    onCookiesUpdated: (cookies) => {
      if (process.connected && process.send) process.send({ type: 'cookies', cookies });
    },
  });
  readyTimer = setInterval(() => {
    if (!listener?.status().connected) return;
    clearInterval(readyTimer);
    readyTimer = null;
    if (process.connected) process.send?.({ type: 'ready' });
  }, 2_000);
  readyTimer.unref();
});

process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('disconnect', () => { void stop(); });
