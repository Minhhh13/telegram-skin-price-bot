# BUFF163 skin price bot for Telegram and Discord

Standalone on-demand lookup for up to 10 CS2 items per request. It resolves names against a local snapshot of the [OpenSkin free item catalog](https://openskin.dev/) and requests BUFF163 CNY feed prices from OpenSkin only for the resolved names. This keeps routine name matching fast and prevents AI from substituting an unrelated item. OpenSkin snapshots can lag BUFF's live listings, so replies show the source timestamp and warn after five minutes. No OpenSkin account, paid model or scrape session is required. A CNY→VND rate of `3.65` means **3,650 VND per CNY**. The bot uses no Trade Desk data or code.

Refresh the catalog after new CS2 items are released with `npm run sync:catalog`, then redeploy. The snapshot currently contains 38,043 item names. Text requests use the local catalog first; Gemini handles photos and unclear text, and its text suggestions must agree with the requested skin name before any price is quoted.

## Group use

Add the bot to a Telegram group. Members can send:

```text
/price AK-47 | Redline (Field-Tested)
/price AK-47 | Redline (Field-Tested); AWP | Asiimov (Field-Tested) rate 3.65
/price AK-47 | Redline (Field-Tested)
AWP | Asiimov (Field-Tested) rates 3.6, 3.65, 3.7
```

Members can also mention or reply to the bot and ask for a base price in ordinary language or attach a JPEG/PNG screenshot under 5 MB. Telegram's default bot privacy mode remains on. When `GEMINI_API_KEY` is configured, only messages and images addressed to the bot go to Gemini 3.5 Flash-Lite's free tier for item-name recognition. Gemini never supplies prices. If a name lacks wear, the bot quotes all available base wears; if it could refer to several weapons, the bot lists matching names and requests the exact one. A price is never fabricated from a USD conversion or another marketplace. Quotes older than five minutes are marked as possibly missing newer listings. Explicit float requests receive an unavailable message because the free OpenSkin feed cannot filter BUFF listings by float.

The default conversion shows `3.60`, `3.65`, `3.70`, `3.75`, `3.78`, and `3.80`, with two rates per row. A request may override this with 1–12 rates. Values like `3650` are accepted as equivalent to `3.65`. All conversion values are rounded to the nearest VND. Doppler requests can specify Phase 1–4, Ruby, Sapphire, Black Pearl, or Emerald; the response shows the selected style and uses OpenSkin's BUFF style price. The BUFF link opens the item page, where the user must select the same style filter to verify the listing. Exact float range and paint seed filters are not supported by this free feed.

## Discord

The same Node service exposes `/discord` for a guild-scoped `/buff` command and connects to Discord's Gateway for plain text messages. It only answers in the configured guild and `#buff-botpricer` channel. Members can simply post `AK redline ft; karambit gamma dop phase 2`, or use `/buff items: AK redline ft`. Members can optionally attach an image when Gemini is configured. The app must be installed in the guild with the `bot` and `applications.commands` scopes, permission to view/send in the dedicated channel, and Message Content intent enabled. The service verifies each slash command's Ed25519 signature and registers it on startup. The Gateway listener ignores other channels and bot messages. Discord link embeds are suppressed in its replies.

The always-on Render Starter instance points Discord's Interactions Endpoint directly to `https://telegram-skin-price-bot.onrender.com/discord`; the Node handler verifies the Discord signature, immediately defers the command, then sends the price as a follow-up. The older Supabase `discord-bridge` source remains in this repository but is not in the live request path.

## Messenger

The existing Render Node service also runs a Messenger listener using the clone account, scoped to the configured TradeDesk group. Send `!buff awp long dog ft` or tag `@Thang Manh Nguyen` followed by skin names. The newer LightSpeed client must still pass an end-to-end live group test before Messenger replies can be called reliable. Discord and Telegram use the same OpenSkin lookup engine independently of this listener.

Set these two Render environment variables on the **same** web service:

```text
MESSENGER_THREAD_ID=<exact approved group thread ID>
MESSENGER_COOKIES=<clone account's Cookie request-header value from messenger.com>
```

Keep the complete cookie string only in Render's secret environment setting. Do not send it in chat, commit it, or use the primary Facebook account. When both variables are present, the service logs a connection result at startup and retries a disconnected session. A browser login does not transfer to Render by itself. The Messenger client uses an unofficial protocol and may stop working when Meta changes it or the session expires; a fresh clone session may then be needed. The implementation uses [meta-messenger.js](https://github.com/yumi-team/meta-messenger.js).

Required Render environment variables for Discord:

```text
DISCORD_PUBLIC_KEY=<application public key>
DISCORD_APPLICATION_ID=<application ID>
DISCORD_GUILD_ID=<server ID>
DISCORD_CHANNEL_ID=<buff-botpricer channel ID>
DISCORD_BOT_TOKEN=<bot token for guild command registration>
GEMINI_API_KEY=<optional Google AI Studio free-tier key for text and photo understanding>
```

## Hosting

The repository supports either a separate Render web service or a separate Supabase Edge Function. Only one host should own the Telegram webhook. Neither option needs a database, an OpenSkin key, or an AI subscription.

### Render

Create a **separate** Node web service from this repository with build command `npm ci` (or `npm install` if no lockfile), start command `npm start`, and health check `/health`. Put the three Telegram secrets below in the service environment, plus `TELEGRAM_SKIN_WEBHOOK_URL=https://<service>.onrender.com/telegram`. The service registers its Telegram webhook on startup with the same secret token. The Render Free plan spins down after 15 minutes of inactivity, so an occasional first response can be delayed by roughly a minute; the service is otherwise event driven.

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


