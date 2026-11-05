import { Client, Utils } from 'meta-messenger.js';
import { lookupDiscord } from './discord.mjs';
import { imageFromBytes } from './supabase/functions/skin-price-webhook/gemini.mjs';

const MAX_IMAGE_BYTES = 5_000_000;
const RETRY_MS = 30_000;

export function parseMessengerRequest(event, accountId, threadId) {
  if (!threadId || String(event?.threadId) !== String(threadId) ||
      String(event?.senderId) === String(accountId)) return null;
  const raw = String(event.text || '').trim();
  const command = raw.match(/^!buff\b\s*[:,-]?\s*/i);
  if (command) return { text: raw.slice(command[0].length).trim(), hasImage: Boolean(event.attachments?.length) };
  const mentioned = event.mentions?.some((mention) => String(mention.id ?? mention.userId) === String(accountId));
  const tag = raw.match(/^@Thang\s*Manh\s*Nguyen\b[\s,:-]*/i);
  if (!mentioned && !tag) return null;
  const text = raw.replace(/^@?BUFF\s*BOT\s*PRICE\s*CHECKER\b[\s,:-]*/i, '')
    .replace(/^@?Thang\s*Manh\s*Nguyen\b[\s,:-]*/i, '').trim();
  return { text, hasImage: Boolean(event.attachments?.length) };
}

export function messengerText(markdown) {
  return String(markdown).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2')
    .replace(/\*\*/g, '').replace(/`/g, '').replaceAll('@\u200b', '@');
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
    const chunks = await lookupDiscord(request.text, image, config.geminiKey, fetchFn);
    for (const content of chunks) await client.sendMessage(config.threadId, messengerText(content), options);
  } catch (error) {
    console.error('Messenger lookup failed:', error instanceof Error ? error.message : String(error));
    await client.sendMessage(config.threadId, 'Price lookup is temporarily unavailable. Please try again shortly.', options);
  }
  return true;
}

export function startMessengerListener(config, ClientClass = Client) {
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
  const startedAt = Date.now();
  const seenMessages = new Set();
  let diagnosticEvents = 0;
  let diagnosticRawEvents = 0;

  const connect = async () => {
    if (connecting || stopped || client?.isConnected) return;
    connecting = true;
    try {
      if (client) await client.disconnect().catch(() => {});
      const active = new ClientClass(Utils.parseCookies(config.cookies), {
        platform: 'facebook', enableE2EE: false, autoReconnect: true, logLevel: 'error',
      });
      client = active;
      active.on('raw', (event) => {
        if (diagnosticRawEvents++ < 12) console.log('Messenger raw event type', event.from, event.type);
      });
      active.on('message', (incoming) => {
        const event = { ...incoming, messageId: incoming.id, timestamp: Number(incoming.timestampMs) };
        const targetGroup = String(event.threadId) === String(config.threadId);
        if (targetGroup || diagnosticEvents++ < 5) {
          console.log('Messenger message event', {
            targetGroup,
            ownMessage: String(event.senderId) === String(accountId),
            ageSeconds: Number.isFinite(event.timestamp) ? Math.round((Date.now() - event.timestamp) / 1000) : null,
            textLength: String(event.text || '').length,
          });
        }
        if (Number.isFinite(event.timestamp) && event.timestamp < startedAt - 5_000) return;
        if (event.messageId && seenMessages.has(event.messageId)) return;
        if (event.messageId) {
          seenMessages.add(event.messageId);
          if (seenMessages.size > 500) seenMessages.delete(seenMessages.values().next().value);
        }
        const bridge = {
          getUserId: () => accountId,
          sendMessage: (threadId, text, options) => active.sendMessage(BigInt(threadId), { text, replyToId: options?.replyToMessageId }),
        };
        void answerMessengerMessage(bridge, event, config).catch((error) =>
          console.error('Messenger reply failed:', error instanceof Error ? error.message : String(error)));
      });
      active.on('error', (error) => console.error('Messenger connection error:', error?.message || String(error)));
      active.on('disconnected', () => console.warn('Messenger listener disconnected'));
      const { user, initialData } = await active.connect();
      accountId = user.id;
      lastConnectedAt = Date.now();
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
  retryTimer = setInterval(() => { if (!client?.isConnected) void connect(); }, RETRY_MS);
  return {
    status: () => ({ connected: Boolean(client?.isConnected), lastConnectedAt }),
    stop: () => { stopped = true; clearInterval(retryTimer); void client?.disconnect(); },
  };
}
