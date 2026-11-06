import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { answerMessengerMessage, parseMessengerRequest } from './messenger.mjs';

const SIDECAR = fileURLToPath(new URL('./bin/messenger-sidecar', import.meta.url));
const MAX_HANDLED_IDS = 2_000;
const MAX_INFLIGHT = 12;

// The Go process owns the one Facebook session and socket. Node owns the
// existing command parser, Gemini/price lookup, and reply formatting.
export function startGoMessengerListener(config, dependencies = {}) {
  if (!config.cookies || !config.threadId) return null;
  const spawnChild = dependencies.spawn ?? spawn;
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancel = dependencies.clearTimeout ?? clearTimeout;
  const binary = dependencies.binary ?? SIDECAR;
  const lookup = dependencies.lookup;
  const handled = new Set();
  const inFlight = new Set();
  const pendingSends = new Map();
  const activeTasks = new Set();
  const pendingEvents = [];
  const startedAt = Date.now() - 5_000;
  const accountId = String(config.cookies.match(/(?:^|;\s*)c_user=(\d+)(?:;|$)/)?.[1] || '');
  if (!accountId) throw new Error('Messenger clone account ID is missing');
  let child = null;
  let restartTimer = null;
  let stopping = false;
  let failures = 0;
  let nextRequestId = 0;
  let state = 'starting';

  const send = (target, content, options = {}) => {
    if (String(target) !== String(config.threadId)) return Promise.reject(new Error('Unapproved Messenger thread'));
    if (!child?.stdin?.writable) return Promise.reject(new Error('Messenger sidecar is offline'));
    const requestId = String(++nextRequestId);
    return new Promise((resolve, reject) => {
      const timer = schedule(() => {
        pendingSends.delete(requestId);
        reject(new Error('Messenger send timed out'));
      }, 40_000);
      pendingSends.set(requestId, { resolve, reject, timer });
      const payload = {
        type: 'send', request_id: requestId, thread_id: String(target), text: String(content),
        reply_to: options.replyToMessageId || '',
      };
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const pending = pendingSends.get(requestId);
        if (!pending) return;
        pendingSends.delete(requestId);
        cancel(pending.timer);
        reject(error);
      });
    });
  };

  const bridge = { getUserId: () => accountId, sendMessage: send };
  const drain = () => {
    while (activeTasks.size < MAX_INFLIGHT && pendingEvents.length) {
      const incoming = pendingEvents.shift();
      const messageId = incoming.messageId;
      const task = answerMessengerMessage(bridge, incoming,
        { ...config, lookup }).then((answered) => {
        if (!answered) return;
        handled.add(messageId);
        if (handled.size > MAX_HANDLED_IDS) handled.delete(handled.values().next().value);
      }).catch((error) => {
        console.error('Messenger sidecar reply failed:', error instanceof Error ? error.message : String(error));
      }).finally(() => {
        inFlight.delete(messageId);
        activeTasks.delete(task);
        drain();
      });
      activeTasks.add(task);
    }
  };
  const onEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'status') {
      state = String(event.state || 'unknown');
      console.log('Messenger sidecar status', {
        state,
        inserted: Number(event.inserted || 0),
        upserted: Number(event.upserted || 0),
        replaced: Number(event.replaced || 0),
        targetCount: Number(event.target_count || 0),
        newestTargetMs: Number(event.newest_target_ms || 0),
      });
      if (state === 'socket_connected' || state === 'poll_ok') failures = 0;
      return;
    }
    if (event.type === 'sent') {
      const pending = pendingSends.get(String(event.request_id));
      if (!pending) return;
      pendingSends.delete(String(event.request_id));
      cancel(pending.timer);
      if (event.ok) pending.resolve();
      else pending.reject(new Error(String(event.error || 'Messenger rejected the message')));
      return;
    }
    if (event.type !== 'message') return;
    const messageId = String(event.message_id || '');
    if (!messageId || handled.has(messageId) || inFlight.has(messageId)) return;
    const incoming = {
      id: messageId,
      messageId,
      threadId: event.thread_id,
      senderId: event.sender_id,
      timestampMs: Number(event.timestamp_ms),
      text: String(event.text || ''),
      mentions: Array.isArray(event.mentions) ? event.mentions : [],
      attachments: Array.isArray(event.attachments) ? event.attachments : [],
    };
    if (!Number.isFinite(incoming.timestampMs) || incoming.timestampMs < startedAt ||
        String(incoming.threadId) !== String(config.threadId) ||
        !parseMessengerRequest(incoming, accountId, config.threadId)) return;
    inFlight.add(messageId);
    pendingEvents.push(incoming);
    drain();
  };

  const launch = () => {
    if (stopping || child) return;
    state = 'starting';
    try {
      const process = spawnChild(binary, [], {
        env: {
          ...globalThis.process.env,
          MESSENGER_COOKIES: config.cookies,
          MESSENGER_THREAD_ID: String(config.threadId),
          MESSENGER_EXPECTED_USER_ID: accountId,
          MESSENGER_ACCEPT_AFTER_MS: String(startedAt),
          GOMEMLIMIT: '128MiB',
        },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      child = process;
      const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (line.length > 100_000) return;
        try { onEvent(JSON.parse(line)); }
        catch { console.warn('Messenger sidecar emitted invalid JSON'); }
      });
      process.on('error', (error) => console.error('Messenger sidecar process error:', error.message));
      process.on('exit', (code, signal) => {
        if (child !== process) return;
        child = null;
        state = 'stopped';
        lines.close();
        for (const pending of pendingSends.values()) {
          cancel(pending.timer);
          pending.reject(new Error('Messenger sidecar exited'));
        }
        pendingSends.clear();
        if (stopping) return;
        failures += 1;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6));
        console.warn('Messenger sidecar exited; restarting', { code, signal, delayMs: delay });
        restartTimer = schedule(launch, delay);
        restartTimer?.unref?.();
      });
    } catch (error) {
      child = null;
      console.error('Messenger sidecar launch failed:', error instanceof Error ? error.message : String(error));
      restartTimer = schedule(launch, 10_000);
      restartTimer?.unref?.();
    }
  };

  launch();
  return {
    status: () => ({ running: Boolean(child), state, handledMessageCount: handled.size, queuedMessageCount: pendingEvents.length }),
    stop: async () => {
      stopping = true;
      if (restartTimer) cancel(restartTimer);
      const active = child;
      if (active) {
        active.stdin.end();
        active.kill('SIGTERM');
      }
      await Promise.allSettled([...activeTasks]);
    },
  };
}
