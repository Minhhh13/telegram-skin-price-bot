import { imageFromBytes } from './supabase/functions/skin-price-webhook/gemini.mjs';

// Shared by the existing BUFF channel and the profit channel.
export async function firstDiscordImage(message, fetchFn = fetch) {
  const attachment = message.attachments?.find((item) => {
    if (item.size > 5_000_000) return false;
    if (/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(item.contentType || '')) return true;
    return !item.contentType && (/\.(?:jpe?g|png|webp|heic|heif)$/i.test(item.name || '') || (item.width > 0 && item.height > 0));
  });
  if (!attachment) return null;
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) return null;
  const response = await fetchFn(url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`Discord image HTTP ${response.status}`);
  return imageFromBytes(new Uint8Array(await response.arrayBuffer()));
}
