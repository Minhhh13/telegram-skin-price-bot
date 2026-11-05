import { buildReply, helpText, shouldReply } from './skin-price.mjs';

export function createHandler({ token, secret, botUsername }, fetchFn = fetch) {
  async function telegramSend(message, html) {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: message.chat.id,
        message_thread_id: message.message_thread_id,
        reply_to_message_id: message.message_id,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram sendMessage: ${result.description || 'failed'}`);
  }

  return async function handle(request) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!token || !secret || !botUsername) return new Response('Not configured', { status: 503 });
    if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('Unauthorized', { status: 401 });
    if (Number(request.headers.get('content-length') || 0) > 100_000) return new Response('Too large', { status: 413 });
    let update;
    try { update = await request.json(); }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    const message = update?.message;
    if (!shouldReply(message, botUsername)) return new Response('ok');
    try {
      const text = message.text || '';
      const replies = /^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text)
        ? [helpText] : await buildReply(text, botUsername, fetchFn);
      for (const reply of replies) await telegramSend(message, reply);
      return new Response('ok');
    } catch (error) {
      console.error('Skin price lookup failed:', error instanceof Error ? error.message : String(error));
      try { await telegramSend(message, 'Price lookup is temporarily unavailable. Please try again shortly.'); }
      catch { return new Response('Send failed', { status: 502 }); }
      return new Response('ok');
    }
  };
}

