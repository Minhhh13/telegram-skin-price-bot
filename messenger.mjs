import { Client, Utils } from 'meta-messenger.js';
import { lookupDiscord } from './discord.mjs';
import { imageFromBytes } from './supabase/functions/skin-price-webhook/gemini.mjs';
import { isLikelySkinRequest } from './supabase/functions/skin-price-webhook/skin-price.mjs';

const MAX_IMAGE_BYTES = 5_000_000;
const RETRY_MS = 15_000;
const SNAPSHOT_REFRESH_MS = 30_000;

export function parseMessengerRequest(event, accountId, threadId) {
  if (!threadId || String(event?.threadId) !== String(threadId) ||
      String(event?.senderId) === String(accountId)) return null;
  const raw = String(event.text || '').trim();
  const command = raw.match(/^!buff\b\s*[:,-]?\s*/i);
  if (command) return { text: raw.slice(command[0].length).trim(), hasImage: Boolean(event.attachments?.length) };
  const mentioned = event.mentions?.some((mention) => String(mention.id ?? mention.userId) === String(accountId));
  const tag = raw.match(/@Thang\s*Manh\s*Nguyen\b/i);
  if (!mentioned && !tag) return null;
  const text = raw.replace(/@BUFF\s*BOT\s*PRICE\s*CHECKER\b/ig, '')
    .replace(/@Thang\s*Manh\s*Nguyen\b/ig, '').replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim();
  if (!event.attachments?.length && !isLikelySkinRequest(text)) return null;
  return { text, hasImage: Boolean(event.attachments?.length) };
}

export function messengerText(markdown) {
  return String(markdown).split('\n').map((line) => {
    if (/^\*\*BUFF163 base prices · CNY → VND\*\*$/.test(line)) return '🎯 BUFF163 PRICE CHECK';
    const heading = line.match(/^\*\*(.+)\*\*$/);
    if (heading) return `◆ ${heading[1]}`;
    const quote = line.match(/^\*\*(¥[\d,.]+ CNY)\*\* · BUFF163 (.+?) · \[BUFF (?:listing|item \(select [^)]+\))\]\(https:\/\/buff\.163\.com\/goods\/(\d+)\)$/);
    if (quote) return `💴 ${quote[1]} · BUFF ${quote[2]}\n🔗 https://buff.163.com/goods/${quote[3]}`;
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
  try {
    const image = request.hasImage && config.geminiKey ? await firstImage(event, fetchFn) : null;
    if (request.hasImage && !request.text && !image) {
      await client.sendMessage(config.threadId, 'Photo recognition is unavailable right now. Please type the skin names after !buff.', options);
      return true;
    }
    const chunks = await lookupDiscord(request.text, image, config.geminiKey, fetchFn, event.text);
    for (const content of chunks) await client.sendMessage(config.threadId, messengerText(content), options);
  } catch (error) {
    console.error('Messenger lookup failed:', error instanceof Error ? error.message : String(error));
    await client.sendMessage(config.threadId, 'Price lookup is temporarily unavailable. Please try again shortly.', options);
  }
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
  let accountId = '';
  let cookies = null;
  const startedAt = Number.isFinite(config.startedAt) ? config.startedAt : Date.now();
  const seenMessages = new Set((config.recentMessageIds || []).map(String));
  const inFlight = new Set();
  const pendingReplies = new Set();
  let diagnosticRawEvents = 0;
  let liveReadyLogged = false;

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
    if (connecting || stopped || pendingReplies.size || (client?.isConnected && !refresh)) return;
    connecting = true;
    try {
      if (!cookies) cookies = Utils.parseCookies(config.cookies);
      if (client) {
        try { cookies = client.getCookies(); } catch { /* Keep the last valid cookies. */ }
        await client.disconnect().catch(() => {});
      }
      const active = new ClientClass(cookies, {
        platform: 'messenger', enableE2EE: false, autoReconnect: true, logLevel: 'error',
      });
      client = active;
      active.on('raw', (event) => {
        if (diagnosticRawEvents++ < 12) console.log('Messenger raw event type', event.from, event.type);
      });
      active.once('fullyReady', () => {
        if (!liveReadyLogged) {
          liveReadyLogged = true;
          console.log('Messenger live event stream fully ready');
        }
      });
      active.on('message', (incoming) => handleIncoming(incoming, 'live'));
      active.on('error', (error) => console.error('Messenger connection error:', error?.message || String(error)));
      active.on('disconnected', () => console.warn('Messenger listener disconnected'));
      const { user, initialData } = await active.connect();
      if (stopped) { await active.disconnect(); return; }
      accountId = user.id;
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
      try { await client?.disconnect(); } catch { /* A failed handshake may not have a socket yet. */ }
      client = null;
    } finally { connecting = false; }
  };

  void connect();
  retryTimer = setInterval(() => {
    if (!client?.isConnected || Date.now() - lastConnectedAt >= (intervals.snapshotRefreshMs ?? SNAPSHOT_REFRESH_MS)) void connect(true);
  }, intervals.retryMs ?? RETRY_MS);
  return {
    status: () => ({ connected: Boolean(client?.isConnected), lastConnectedAt }),
    stop: async () => {
      stopped = true;
      clearInterval(retryTimer);
      await Promise.allSettled([...pendingReplies]);
      await client?.disconnect().catch(() => {});
    },
  };
}
