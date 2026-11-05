# Telegram BUFF163 skin price bot

Standalone on-demand Telegram lookup for up to 10 CS2 items per request. It uses the [OpenSkin free Pricing API](https://openskin.dev/) to search exact item names and obtain BUFF163's original CNY lowest ask. No OpenSkin account, paid model or scrape session is required. A CNY→VND rate of `3.65` means **3,650 VND per CNY**. The bot uses no Trade Desk data or code.

## Group use

Add the bot to a Telegram group. Members can send:

```text
/price AK-47 | Redline (Field-Tested)
/price AK-47 | Redline (Field-Tested); AWP | Asiimov (Field-Tested) rate 3.65
/price AK-47 | Redline (Field-Tested)
AWP | Asiimov (Field-Tested) rates 3.6, 3.65, 3.7
```

Members can also mention the bot and ask for a base price in ordinary language. Telegram's default bot privacy mode is sufficient for commands and mentions. If a name lacks a wear or could refer to several weapons, the bot lists matching names and requests the exact one. A price is never fabricated from a USD conversion or another marketplace. Quotes older than two hours are marked stale.

The default rate table is `3.50, 3.60, 3.65, 3.70–3.76`. A request may override this with 1–12 rates. Values like `3650` are accepted as equivalent to `3.65`. All conversion values are rounded to the nearest VND. The BUFF quote is the cheapest active listing observed by OpenSkin; inspect the live BUFF listing before trading special floats, stickers, phases or patterns.

## Hosting

The repository supports either a separate Render web service or a separate Supabase Edge Function. Only one host should own the Telegram webhook. Neither option needs a database, an OpenSkin key, or an AI subscription.

### Render

Create a **separate** Node web service from this repository with build command `npm ci` (or `npm install` if no lockfile), start command `npm start`, and health check `/health`. Put the three secrets below in the service environment. Set the Telegram webhook URL to `https://<service>.onrender.com/telegram` with the same `secret_token`. The Render Free plan spins down after 15 minutes of inactivity, so an occasional first response can be delayed by roughly a minute; the service is otherwise event driven.

### Supabase Edge Function

The source has no database dependency. Deploy `supabase/functions/skin-price-webhook/index.js` with its local `skin-price.mjs` dependency and `verify_jwt=false` because Telegram cannot provide a Supabase JWT. The function authenticates calls using Telegram's `secret_token` webhook header.

Configure three secrets, separate from all other bots:

```text
TELEGRAM_SKIN_BOT_TOKEN=<new bot token from BotFather>
TELEGRAM_SKIN_WEBHOOK_SECRET=<random 32+ character letters/numbers/underscores/hyphens>
TELEGRAM_SKIN_BOT_USERNAME=<new bot username without @>
```

Set the webhook with a **POST** to Telegram's `setWebhook` Bot API method. Body:

```json
{"url":"https://<project-ref>.supabase.co/functions/v1/skin-price-webhook","secret_token":"<same secret>","allowed_updates":["message"]}
```

Keep the bot token out of source, chat messages, and screenshots. Run `npm test` locally. Check `getWebhookInfo` for delivery errors after connecting the bot.

