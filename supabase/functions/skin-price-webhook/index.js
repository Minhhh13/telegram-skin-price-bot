import { createHandler } from './handler.mjs';

Deno.serve(createHandler({
  token: Deno.env.get('TELEGRAM_SKIN_BOT_TOKEN') || '',
  secret: Deno.env.get('TELEGRAM_SKIN_WEBHOOK_SECRET') || '',
  botUsername: Deno.env.get('TELEGRAM_SKIN_BOT_USERNAME') || '',
  geminiKey: Deno.env.get('GEMINI_API_KEY') || '',
}));

