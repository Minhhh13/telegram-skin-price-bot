import { Client, Utils } from 'meta-messenger.js';
import { lookupDiscord } from './discord.mjs';
import { imageFromBytes } from './supabase/functions/skin-price-webhook/gemini.mjs';
import { isLikelySkinRequest } from './supabase/functions/skin-price-webhook/skin-price.mjs';

const MAX_IMAGE_BYTES = 5_000_000;
const RETRY_MS = 15_000;
const SNAPSHOT_REFRESH_MS = 60_000;
const SOCKET_READY_GRACE_MS = 90_000;
const AUTH_RETRY_INITIAL_MS = 60_000;
const AUTH_RETRY_MAX_MS = 15 * 60_000;

function invalidSession(error) {
  return /access token is no longer valid|user id in initial data is zero/i.test(error instanceof Error ? error.message : String(error));
}

export function parseMessengerRequest(event, accountId, threadId) {
  if (!threadId || String(event?.threadId) !== String(threadId) ||
      String(event?.senderId) === String(accountId)) return null;
  const raw = String(event.text || '').trim();
  const command = raw.match(/^!buff\b\s*[:,-]?\s*/i);
  if (command) return { text: raw.slice(command[0].length).trim(), hasImage: Boolean(event.attachments?.length) };
  const mentioned = event.mentions?.some((mention) => String(mention.id ?? mention.userId) === String(accountId));
  const tag = raw.match(/@(?:Thang\s*Manh\s*Nguyen|BUFF\s*BOT\s*PRICE\s*CHECKER)\b/i);
  if (!mentioned && !tag) return null;
  const text = raw.replace(/@BUFF\s*BOT\s*PRICE\s*CHECKER\b/ig, '')
    .replace(/@Thang\s*Manh\s*Nguyen\b/ig, '').replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim();
  if (!event.attachments?.length && !isLikelySkinRequest(text)) return null;
  return { text, hasImage: Boolean(event.attachments?.length) };
}

export function messengerText(markdown) {
  return String(markdown).split('\n').map((line) => {
    if (/^\*\*BUFF163 base prices · CNY → VND\*\*$/.test(line)) return '🎯 BUFF163 PRICE CHECK';
    const quote = line.match(/^\*\*(¥[\d,.]+ CNY)\*\*(?: · BUFF163 .+?)?(?: · \[BUFF (?:listing|item \(select [^)]+\))\]\((https:\/\/buff\.163\.com\/goods\/\d+)\))?$/);
    if (quote) return `💴 ${quote[1]}${quote[2] ? `\n🔗 ${quote[2]}` : ''}`;
    const heading = line.match(/^\*\*(.+)\*\*$/);
    if (heading) return `◆ ${heading[1]}`;
    if (/^`[\d.]+ → ₫/.test(line)) return line.replace(/^`|`$/g, '').split(/\s+\|\s+/).map((rate) => `   ${rate.trim()}`).join('\n');
    const snapshot = line.match(/^Feed snapshot (\S+) (\S+) UTC \(([^)]+)\)(?: ⚠️ .*)?$/);
    if (snapshot) return `🕒 Feed ${snapshot[3]} · ${snapshot[2]} UTC${line.includes('⚠️') ? '\n⚠️ May miss newer listings' : ''}`;
    return line.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
      .replace(/\*\*/g, '').replace(/`/g, '').replaceAll('@\u200b', '@');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function firstImage(event, fetchFn) {
  const attachment = event.attachments?.find((item) =>
    (item.type === 'image' || item.type === 'photo') && item.url);
  if (!attachment) return null;
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !/(^|\.)(?:fbcdn\.net|fbsbx\.com)$/.test(url.hostname)) {
    throw new Error('Unsupported Messenger image host');
  }
  const response = await fetchFn(url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Messenger image HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error('Messenger image is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Messenger image is too large');
  return imageFromBytes(bytes);
}

export async function answerMessengerMessage(client, event, config, fetchFn = fetch) {
  const request = parseMessengerRequest(event, client.getUserId(), config.threadId);
  if (!request) return false;
  const options = { replyToMessageId: event.messageId, skipUrlPreview: true };
  if (!request.text && !request.hasImage) {
    await client.sendMessage(config.threadId, 'Send !buff followed by skin names, or attach a skin screenshot with !buff as the caption.', options);
    return true;
  }
  let chunks;
  let lookupMs = 0;
  try {
    const image = request.hasImage && config.geminiKey ? await firstImage(event, fetchFn) : null;
    if (request.hasImage && !request.text && !image) {
      chunks = ['Photo recognition is unavailable right now. Please type the skin names after !buff.'];
    } else {
      const lookupStartedAt = Date.now();
      chunks = await (config.lookup ?? lookupDiscord)(request.text, image, config.geminiKey, fetchFn, event.text);
      lookupMs = Date.now() - lookupStartedAt;
    }
  } catch (error) {
    console.error('Messenger lookup failed:', error instanceof Error ? error.message : String(error));
    chunks = ['Price lookup is temporarily unavailable. Please try again shortly.'];
  }
  const sendStartedAt = Date.now();
  for (const content of chunks) await client.sendMessage(config.threadId, messengerText(content), options);
  console.log('Messenger request answered', {
    lookupMs, sendMs: Date.now() - sendStartedAt, chunks: chunks.length,
  });
  return true;
}

export function startMessengerListener(config, ClientClass = Client, intervals = {}) {
  if (!config.cookies || !config.threadId) {
    console.log('Messenger listener not configured');
    return null;
  }
  let client = null;
  let connecting = false;
  let stopped = false;
  let retryTimer = null;
  let lastConnectedAt = 0;
  let nextConnectAt = 0;
  let authRetryDelayMs = intervals.authRetryInitialMs ?? AUTH_RETRY_INITIAL_MS;
  let accountId = '';
  let cookies = null;
  let lastPublishedCookies = '';
  const startedAt = Number.isFinite(config.startedAt) ? config.startedAt : Date.now();
  const seenMessages = new Set((config.recentMessageIds || []).map(String));
  const inFlight = new Set();
  const pendingReplies = new Set();
  let diagnosticRawEvents = 0;
  let diagnosticPublishes = 0;

  const refreshCookies = (active) => {
    try {
      const updated = active.getCookies();
      if (!Utils.validate(updated) || String(updated.c_user) !== String(accountId)) return;
      cookies = updated;
      const serialized = Utils.toCookieString(updated);
      if (serialized !== lastPublishedCookies) {
        config.onCookiesUpdated?.(serialized);
        lastPublishedCookies = serialized;
      }
    } catch { /* Keep the last valid session. */ }
  };

  const handleIncoming = (incoming, source) => {
    const event = { ...incoming, messageId: incoming.id, timestamp: Number(incoming.timestampMs) };
    const targetGroup = String(event.threadId) === String(config.threadId);
    if (!targetGroup || !Number.isFinite(event.timestamp) || event.timestamp < startedAt - 5_000) return;
    if (!parseMessengerRequest(event, accountId, config.threadId)) return;
    const messageId = event.messageId ? String(event.messageId) : '';
    if (messageId && (seenMessages.has(messageId) || inFlight.has(messageId))) return;
    if (messageId) inFlight.add(messageId);
    console.log('Messenger request received', {
      source, ageSeconds: Math.round((Date.now() - event.timestamp) / 1000),
      textLength: String(event.text || '').length,
    });
    const active = client;
    const bridge = {
      getUserId: () => accountId,
      sendMessage: (threadId, text, options) => active.sendMessage(BigInt(threadId), { text, replyToId: options?.replyToMessageId }),
    };
    const task = answerMessengerMessage(bridge, event, config).then((handled) => {
      if (handled && messageId) {
        seenMessages.add(messageId);
        if (seenMessages.size > 500) seenMessages.delete(seenMessages.values().next().value);
        try { config.onMessageHandled?.(messageId); }
        catch (error) { console.error('Messenger dedup sync failed:', error instanceof Error ? error.message : String(error)); }
      }
    }).catch((error) =>
      console.error('Messenger reply failed:', error instanceof Error ? error.message : String(error)))
      .finally(() => { if (messageId) inFlight.delete(messageId); pendingReplies.delete(task); });
    pendingReplies.add(task);
  };

  const connect = async (refresh = false) => {
    if (connecting || stopped || pendingReplies.size || Date.now() < nextConnectAt ||
        (client?.isConnected && !refresh)) return;
    connecting = true;
    try {
      if (!cookies) cookies = Utils.parseCookies(config.cookies);
      if (!accountId) accountId = String(cookies.c_user ?? '');
      if (client) {
        refreshCookies(client);
        await client.disconnect().catch(() => {});
      }
      const active = new ClientClass(cookies, {
        platform: 'facebook', enableE2EE: false, autoReconnect: true, logLevel: 'error',
      });
      client = active;
      active.on('raw', (event) => {
        if (diagnosticRawEvents++ < 12) console.log('Messenger raw event type', event.from, event.type);
        if (event?.from !== 'lightspeed' || event.type !== 'Event_PublishResponse') return;
        const table = event.data?.Table ?? event.data?.table;
        if (!table) {
          if (diagnosticPublishes++ < 3) console.log('Messenger publish table missing');
          return;
        }
        const inserts = table.LSInsertMessage ?? table.lsInsertMessage;
        const upserts = table.LSUpsertMessage ?? table.lsUpsertMessage;
        const targetRows = (rows) => rows.filter((row) => row &&
          String(row.ThreadKey ?? row.threadKey ?? row.thread_key) === String(config.threadId));
        const targetInserts = targetRows(Array.isArray(inserts) ? inserts : []);
        const targetUpserts = targetRows(Array.isArray(upserts) ? upserts : []);
        if (diagnosticPublishes++ < 3 || targetInserts.length || targetUpserts.length) {
          console.log('Messenger publish message counts', {
            totalInserts: Array.isArray(inserts) ? inserts.length : 0,
            totalUpserts: Array.isArray(upserts) ? upserts.length : 0,
            insertCount: targetInserts.length, upsertCount: targetUpserts.length,
          });
        }
        for (const row of [...targetInserts, ...targetUpserts]
          .sort((a, b) => Number(a.TimestampMs ?? a.timestampMs) - Number(b.TimestampMs ?? b.timestampMs))) {
          const incoming = {
            id: row.MessageId ?? row.messageId ?? row.message_id,
            threadId: row.ThreadKey ?? row.threadKey ?? row.thread_key,
            senderId: row.SenderId ?? row.senderId ?? row.sender_id,
            text: row.Text ?? row.text ?? '',
            timestampMs: row.TimestampMs ?? row.timestampMs ?? row.timestamp_ms,
          };
          // The raw table does not include image attachment data. Let the normal
          // message/snapshot path handle image-only requests instead.
          if (parseMessengerRequest(incoming, accountId, config.threadId)?.text) {
            handleIncoming(incoming, 'live-table');
          }
        }
      });
      active.on('fullyReady', () => console.log('Messenger live event stream fully ready'));
      active.on('message', (incoming) => handleIncoming(incoming, 'live'));
      active.on('error', (error) => console.error('Messenger connection error:', error?.message || String(error)));
      active.on('disconnected', () => console.warn('Messenger listener disconnected'));
      const { user, initialData } = await active.connect();
      if (stopped) { await active.disconnect(); return; }
      accountId = user.id;
      nextConnectAt = 0;
      authRetryDelayMs = intervals.authRetryInitialMs ?? AUTH_RETRY_INITIAL_MS;
      refreshCookies(active);
      lastConnectedAt = Date.now();
      for (const message of [...initialData.messages]
        .filter((item) => String(item.threadId) === String(config.threadId))
        .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs))) {
        handleIncoming(message, 'inbox');
      }
      console.log('Messenger listener connected to configured account', {
        targetThreadType: initialData.threads.find((thread) => String(thread.id) === String(config.threadId))?.type ?? null,
        initialTargetMessages: initialData.messages.filter((message) => String(message.threadId) === String(config.threadId)).length,
        initialMessageCount: initialData.messages.length,
      });
    } catch (error) {
      console.error('Messenger listener connection failed:', error instanceof Error ? error.message : String(error));
      if (invalidSession(error)) {
        const maxDelay = intervals.authRetryMaxMs ?? AUTH_RETRY_MAX_MS;
        const delayMs = Math.min(authRetryDelayMs, maxDelay);
        nextConnectAt = Date.now() + delayMs;
        authRetryDelayMs = Math.min(delayMs * 2, maxDelay);
        console.warn('Messenger session invalid; waiting before retry', { retryDelayMs: delayMs });
      }
      try { await client?.disconnect(); } catch { /* A failed handshake may not have a socket yet. */ }
      client = null;
    } finally { connecting = false; }
  };

  void connect();
  const socketReady = () => Boolean(client && (client.isFullyReady?.() ?? client.isConnected));
  retryTimer = setInterval(() => {
    // The native isConnected flag only checks that a client exists; fullyReady
    // reflects whether its live socket has actually received the ready event.
    // Give the socket time to finish its initial database sync before recycling it.
    const connectedForMs = Date.now() - lastConnectedAt;
    const readyGraceMs = intervals.socketReadyGraceMs ?? SOCKET_READY_GRACE_MS;
    // The socket can report ready after mailbox sync has timed out. Refresh the
    // HTTP inbox snapshot regularly until live delivery is reliable again.
    const forcedRefreshMs = intervals.snapshotRefreshMs ?? SNAPSHOT_REFRESH_MS;
    if (!client || (!socketReady() && connectedForMs >= readyGraceMs) ||
        (Number.isFinite(forcedRefreshMs) && forcedRefreshMs > 0 &&
          connectedForMs >= forcedRefreshMs)) void connect(true);
  }, intervals.retryMs ?? RETRY_MS);
  return {
    status: () => ({ connected: socketReady(), lastConnectedAt }),
    stop: async () => {
      stopped = true;
      clearInterval(retryTimer);
      await Promise.allSettled([...pendingReplies]);
      if (client) refreshCookies(client);
      await client?.disconnect().catch(() => {});
    },
  };
}
