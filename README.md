# BUFF163 skin price bot for Telegram, Discord, and Messenger

Standalone on-demand lookup for up to 10 CS2 items per request. It resolves names against a local snapshot of the [OpenSkin free item catalog](https://openskin.dev/) and requests BUFF163 CNY feed prices from OpenSkin only for the resolved names. This keeps routine name matching fast and prevents AI from substituting an unrelated item. OpenSkin says its BUFF163 source refreshes about every 30 minutes; replies show each quote's source timestamp and warn after five minutes, since a feed quote is not a live BUFF listing. No OpenSkin account, paid model or scrape session is required. A CNY→VND rate of `3.65` means **3,650 VND per CNY**. The bot uses no Trade Desk data or code.

Refresh the catalog after new CS2 items are released with `npm run sync:catalog`, then redeploy. The snapshot currently contains 38,043 item names. Text requests use the local catalog for fast name matching, including common shorthand, close spellings, unique finish words within a named weapon (`ak lotus fn`), reversed weapon/finish order, agent names, vanilla knives, stickers, charms, cases, and other collectibles. Sticker modifiers and event/year stay part of the identity. Clear matches go straight to the price feed without spending a Gemini request. When configured, Gemini receives the full original message plus nearby catalog names for unresolved text or photos. It never supplies prices, and a returned name must pass explicit constraints. Ambiguous names offer real catalogue choices instead of an assumed price.

## Group use

Add the bot to a Telegram group. Members can send:

```text
/price AK-47 | Redline (Field-Tested)
/price AK-47 | Redline (Field-Tested); AWP | Asiimov (Field-Tested) rate 3.65
/price AK-47 | Redline (Field-Tested)
AWP | Asiimov (Field-Tested) rates 3.6, 3.65, 3.7
```

Members can also mention or reply to the bot and ask for a base price in ordinary language or attach a JPEG/PNG screenshot under 5 MB. Telegram's default bot privacy mode remains on. When `GEMINI_API_KEY` is configured, only messages and images addressed to the bot go to Gemini 3.5 Flash-Lite's free tier for item-name recognition. Gemini never supplies prices. If a name lacks wear, the bot quotes all available base wears; if it could refer to several weapons, the bot lists matching names and requests the exact one. A price is never fabricated from a USD conversion or another marketplace. Quotes older than five minutes are marked as possibly missing newer listings. Explicit float requests receive an unavailable message because the free OpenSkin feed cannot filter BUFF listings by float.

The default conversion shows `3.60`, `3.65`, `3.70`, `3.75`, `3.78`, and `3.80`, with two rates per row. A request may override this with 1–12 rates. Values like `3650` are accepted as equivalent to `3.65`. All conversion values are rounded to the nearest VND. Doppler requests can specify Phase 1–4, Ruby, Sapphire, Black Pearl, or Emerald; the response shows the selected style and uses OpenSkin's BUFF style price. Multiple style requests share repeated item fetches and run at most three fetches at a time. The BUFF link opens the item page, where the user must select the same style filter to verify the listing. Exact float range and paint seed filters are not supported by this free feed.

## Discord

The same Node service exposes `/discord` for a guild-scoped `/buff` command and connects to Discord's Gateway for plain text messages. It only answers in the configured guild and `#buff-botpricer` channel. Members can simply post `AK redline ft; karambit gamma dop phase 2`, or use `/buff items: AK redline ft`. Members can optionally attach a JPEG, PNG, WebP, HEIC, or HEIF image under 5 MB when Gemini is configured, including a BUFF screenshot with a visible Chinese item title. The app must be installed in the guild with the `bot` and `applications.commands` scopes, permission to view/send in the dedicated channel, and Message Content intent enabled. The service verifies each slash command's Ed25519 signature and registers it on startup. The Gateway listener ignores other channels and bot messages. Discord link embeds are suppressed in its replies.

To send a price to a customer, click **Customer quote** below a priced reply and choose one item and a displayed CNY-to-VND rate. Click **Custom rate** to enter another rate, such as `3.72` or `3720` VND per CNY. Both produce a private quote with the item name, CNY ask, converted VND price, and BUFF link. On Discord for iPhone, click **Copy on phone** in that private reply, tap the prefilled text field, then use **Select All → Copy**. These quote controls use the price already in the bot's reply, so they make no extra price or AI request. To refresh the price, send a new lookup first.

When a reply shows possible catalogue matches, choose one of up to five names from **Choose an item to price**. The bot fetches only the selected item's BUFF price and returns a private, one-item result with the same quote controls.

The always-on Render Starter instance points Discord's Interactions Endpoint directly to `https://telegram-skin-price-bot.onrender.com/discord`; the Node handler verifies the Discord signature, immediately defers the command, then sends the price as a follow-up. The older Supabase `discord-bridge` source remains in this repository but is not in the live request path.

## Messenger

The existing Render Starter Node service also runs a Messenger listener using the clone account, scoped to the configured TradeDesk group. Send `!buff awp long dog ft` or tag `@Thang Manh Nguyen` or `@BUFF BOT PRICE CHECKER` followed by skin names. The listener handles live insert and upsert events and refreshes the inbox about every 30–45 seconds as a fallback. This unofficial client has no target-thread history API: if a live event is missed, a refresh may return only the newest group message. Discord's direct event delivery is more reliable and faster. The Messenger client runs in a child process that recycles every 18 minutes to contain native memory growth. In-flight replies finish before a normal refresh; successfully answered message IDs and refreshed session cookies survive the child recycle. A full Render restart reloads the cookie from its environment setting. Replies use a compact plain-text layout with a direct BUFF item URL; Messenger may generate its own large preview card. This unofficial integration can still break when Meta changes its protocol or the clone session expires.

Set these two Render environment variables on the **same** web service:

```text
MESSENGER_THREAD_ID=<exact approved group thread ID>
MESSENGER_COOKIES=<clone account's approved Facebook.com session cookies>
```

Keep the complete cookie string only in Render's secret environment setting. Do not send it in chat, commit it, or use the primary Facebook account. When both variables are present, the service logs a connection result at startup and retries a disconnected session. A browser login does not transfer to Render by itself. A fresh clone session may be needed if the current session expires. The implementation uses [meta-messenger.js](https://github.com/yumi-team/meta-messenger.js).

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

The live service uses one Render Starter instance for the HTTP webhook, Discord Gateway, and Messenger worker. It does not require another Render service or database. For a new deployment, use build command `npm ci` (or `npm install` if no lockfile), start command `npm start`, and health check `/health`. The root `postinstall` script applies a guarded 75 ms idle-poll pause to the pinned Messenger library to avoid wasting CPU. Put the three Telegram secrets below in the service environment, plus `TELEGRAM_SKIN_WEBHOOK_URL=https://<service>.onrender.com/telegram`. The service registers its Telegram webhook on startup with the same secret token.

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


