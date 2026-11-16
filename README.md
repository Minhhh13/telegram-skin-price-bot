# Discord CS2 price and profit bot

This Node service runs the BUFF price checker and the private/team Trade Desk profit checkers in Discord. It exposes `/discord` for signed interactions, `/health` for hosting checks, and one Discord Gateway connection for ordinary messages and photos. Telegram and Messenger are retired: the service no longer registers a Telegram webhook, serves `/telegram`, starts a Messenger worker, or builds a Messenger sidecar.

## Channels

| Channel | Service behavior |
| --- | --- |
| `buff-botpricer` | BUFF CNY prices, VND conversions, photos and customer quote controls. |
| Private profit channel | Personal Trade Desk offers and estimated profit for the requesting member. |
| Team profit channel | The same profit checker, scoped to each requesting member's linked account. |
| `cs-market-update` | Existing channel integration managed outside this service. |
| `binance-p2p-usdt-rate` | Existing channel integration managed outside this service. |
| `c5-youpin-code` | Existing channel integration managed outside this service. |

Only the configured BUFF channel and explicit profit channel IDs are handled by this service. It ignores other channels and messages from bots. The other three channels retain their existing integrations.

## BUFF checker

Post a request in `buff-botpricer`, or use `/buff items: AK redline ft`:

```text
AK-47 | Redline (Field-Tested)
AK redline ft; AWP asiimov ft rate 3.65
karambit gamma dop phase 2
```

Requests can contain up to ten items. The bot matches against its local [OpenSkin catalogue](https://openskin.dev/) and requests BUFF CNY feed prices only for resolved names. It supports common abbreviations, close spellings, unique finish words within a weapon, reversed weapon/finish order, agents, vanilla knives and collectibles. Explicit wear, StatTrak, Souvenir, sticker modifiers and event/year remain part of the identity. An ambiguous request offers real catalogue choices rather than a guessed price.

The default CNY-to-VND conversions are `3.60`, `3.65`, `3.70`, `3.75`, `3.78` and `3.80`. A rate of `3.65` means 3,650 VND per CNY; `rate 3650` is equivalent. A request can specify 1–12 rates. Missing wear returns available base wears. Doppler requests can specify Phase 1–4, Ruby, Sapphire, Black Pearl or Emerald. Float-range and paint-seed prices are unavailable from this feed.

When `GEMINI_API_KEY` is configured, members can attach a JPEG, PNG, WebP, HEIC or HEIF image under 5 MB, including a BUFF screenshot with a visible Chinese title. Clear text matches stay local. Gemini interprets unresolved text and images; it never supplies prices. The response shows the feed timestamp and marks quotes older than five minutes as potentially missing newer listings.

Click **Customer quote** to choose an item and displayed conversion rate, or **Custom rate** to enter another rate. These controls use the price already in the reply and make no extra price or AI request. The private copy contains the exact item, CNY ask, VND price and BUFF link. **Copy on phone** opens the same text in a selectable field. Send a new lookup to obtain a fresh BUFF price.

## Profit checkers

Both configured profit channels use the same checker and shared weekly USD-to-VND rate. Members use `/setup` to enter their team Trade Desk Account ID privately, then post item names or supported photos. `/profit` remains available for a private lookup. Each lookup, refresh and item selection uses the requesting member's linked account; personal offers are never shared through the catalogue cache.

Search uses the active Trade Desk catalogue, including names absent from the BUFF snapshot. An unresolved weapon, wear or Doppler style remains an explicit choice. The checker rejects missing or mismatched quote identities before displaying profit. **Custom buying rate** recalculates one selected item; **Customer quote** copies only the BUFF customer-facing values. See [profit checker setup and calculations](docs/PROFIT-CHECKER.md) for details.

## Configuration

Use Node 22. Configure the existing Discord application with the `bot` and `applications.commands` scopes, enable Message Content intent, and give it View Channel, Send Messages and Read Message History in the configured channels.

Required environment variables:

```text
DISCORD_PUBLIC_KEY=<application public key>
DISCORD_APPLICATION_ID=<application ID>
DISCORD_GUILD_ID=<server ID>
DISCORD_CHANNEL_ID=<buff-botpricer channel ID>
DISCORD_BOT_TOKEN=<bot token>
```

Profit channel configuration:

```text
DISCORD_PROFIT_CHANNEL_IDS=<private channel ID>,<team channel ID>
DISCORD_PROFIT_OWNER_ID=<owner Discord user ID>
TRADE_DESK_URL=https://tradedesk.click
TRADE_DESK_DISCORD_API_KEY=<integration key>
```

The legacy singular `DISCORD_PROFIT_CHANNEL_ID` is merged with the plural setting. `GEMINI_API_KEY` enables optional text/photo interpretation. Keep tokens and integration keys in the host's secret environment settings.

## Hosting and development

The existing Render web service can host the HTTP endpoint and Discord Gateway together. Build with `npm ci`, start with `npm start`, and use `/health` as the health check. Set the Discord Interactions Endpoint to `https://<existing-service-host>/discord`. The existing hostname may retain its historical Telegram name; the runtime and route are Discord-only. Commands are registered on startup and interactions require a valid Discord Ed25519 signature.

No Messenger package, postinstall patch, Go build or child listener process is required. Retired Telegram/Messenger environment variables are ignored. The shared matching and image modules remain under `supabase/functions/skin-price-webhook/` because Discord imports them; their directory name does not introduce a separate runtime or database requirement.

Run `npm test` for the shared matcher, Discord handlers, profit checks and runtime regression tests. Refresh the BUFF catalogue after new CS2 items are released with `npm run sync:catalog`, then redeploy. The profit checker obtains its own versioned catalogue from the Trade Desk integration and caches catalogue identities for at most 60 seconds.
