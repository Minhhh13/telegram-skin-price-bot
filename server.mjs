import { createServer } from 'node:http';
import { createHandler } from './supabase/functions/skin-price-webhook/handler.mjs';

const handler = createHandler({
  token: process.env.TELEGRAM_SKIN_BOT_TOKEN || '',
  secret: process.env.TELEGRAM_SKIN_WEBHOOK_SECRET || '',
  botUsername: process.env.TELEGRAM_SKIN_BOT_USERNAME || '',
});
const port = Number(process.env.PORT || 10000);

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url !== '/telegram') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) {
      res.writeHead(413);
      res.end('Too large');
      return;
    }
    chunks.push(chunk);
  }
  const request = new Request(`http://localhost:${port}/telegram`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(port, '0.0.0.0', () => console.log(`Skin price webhook listening on ${port}`));

