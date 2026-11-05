const MAX_BODY_BYTES = 100_000;
const MAX_SIGNATURE_AGE_SECONDS = 300;

function bytesFromHex(hex) {
  return Uint8Array.from(hex.match(/.{2}/g) || [], (pair) => Number.parseInt(pair, 16));
}

export async function verifyDiscordRequest(headers, body, publicKey) {
  const signature = headers.get('x-signature-ed25519') || '';
  const timestamp = headers.get('x-signature-timestamp') || '';
  if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\d{10}$/.test(timestamp) ||
      !/^[a-f0-9]{64}$/i.test(publicKey || '') ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
  try {
    const key = await crypto.subtle.importKey('raw', bytesFromHex(publicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytesFromHex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function json(data) {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}

async function forwardToRender(body, headers, interaction, config, fetchFn) {
  try {
    const response = await fetchFn(config.renderUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': headers.get('x-signature-ed25519'),
        'x-signature-timestamp': headers.get('x-signature-timestamp'),
      },
      body,
      signal: AbortSignal.timeout(110_000),
    });
    if (!response.ok) throw new Error(`Render returned HTTP ${response.status}`);
  } catch (error) {
    console.error('Discord forwarding failed:', error instanceof Error ? error.message : String(error));
    try {
      await fetchFn(`https://discord.com/api/v10/webhooks/${config.applicationId}/${interaction.token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Price lookup is temporarily unavailable. Please try again shortly.', allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(9000),
      });
    } catch (followupError) {
      console.error('Discord error reply failed:', followupError instanceof Error ? followupError.message : String(followupError));
    }
  }
}

export async function handleDiscordBridge(request, config, waitUntil, fetchFn = fetch) {
  if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/health')) {
    return new Response('ok', { headers: { 'content-type': 'text/plain' } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!config?.publicKey || !config?.applicationId || !config?.guildId || !config?.channelId ||
      config?.renderUrl !== 'https://telegram-skin-price-bot.onrender.com/discord') {
    return new Response('Discord bridge not configured', { status: 503 });
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) return new Response('Too large', { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return new Response('Too large', { status: 413 });
  if (!await verifyDiscordRequest(request.headers, body, config.publicKey)) {
    return new Response('Invalid signature', { status: 401 });
  }
  let interaction;
  try { interaction = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (interaction.application_id !== config.applicationId) return new Response('Wrong application', { status: 401 });
  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.type !== 2 || interaction.data?.name !== 'buff') return new Response('Unsupported interaction', { status: 400 });
  if (interaction.guild_id !== config.guildId || interaction.channel_id !== config.channelId) {
    return json({ type: 4, data: { content: 'Use /buff in #buff-botpricer.', flags: 64, allowed_mentions: { parse: [] } } });
  }
  waitUntil(forwardToRender(body, request.headers, interaction, config, fetchFn));
  return json({ type: 5 });
}

if (typeof Deno !== 'undefined' && typeof EdgeRuntime !== 'undefined') {
  Deno.serve((request) => {
    let config;
    try { config = JSON.parse(Deno.env.get('DISCORD_BRIDGE_CONFIG') || '{}'); }
    catch { config = {}; }
    return handleDiscordBridge(request, config, (promise) => EdgeRuntime.waitUntil(promise));
  });
}
