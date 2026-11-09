# Trade Desk Discord profit checker

The checker uses the existing bot connection in a separate Discord channel. The existing BUFF channel and `/buff` handler keep their current behavior.

## Member flow

- `/profitsetup` or **Link Trade Desk** opens a private form for the member's Trade Desk email or Account ID.
- The member follows the short-lived confirmation link and confirms while signed into the matching Trade Desk account. The identifier alone does not grant access to another account.
- `/profit items: ak redline ft` returns a private personal estimate. Posting a skin name in the profit channel creates **Check my profit**; each click uses that clicker's linked account.
- **Refresh** rechecks the member's current Trade Desk account rate and the shared conversion. **Custom buying rate** accepts `3.65` or `3650` VND per CNY. **Share result** publishes the displayed snapshot only after the member clicks it.
- An ambiguous request offers up to five actual Trade Desk identities. Phase, wear, StatTrak and Souvenir remain part of the exact price identity.

## Owner flow

`/ratechange` opens the shared weekly USD/USDT payout-unit to VND form. `!ratechange` posts a button opening the same form. Only the configured Discord owner can submit it; Trade Desk independently enforces that owner check. No conversion is assumed before the owner saves one.

Trade Desk remains the source for current personal USD estimates and the shared rate. The bot never receives the merchant key, raw unadjusted Trade Desk prices or a member's configured account percentage.

## Calculation and freshness

`proceeds VND = personal USD cents × weekly VND per USD ÷ 100`

`purchase cost VND = BUFF CNY × buying rate × 1000`

`estimated profit = proceeds − purchase cost`

`return on cost % = profit ÷ purchase cost × 100`

Amounts round to the nearest VND after Trade Desk's existing per-item USD-cent rounding. Results show their currency rate and both source timestamps. Green/red requires positive current values from both sources; missing, rejected or stale values remain neutral. Profit is an estimate before extra fees and is not an executable inventory quote.

## Configuration

Bot Render service:

```text
DISCORD_PROFIT_CHANNEL_ID=<new channel ID>
DISCORD_PROFIT_OWNER_ID=<owner Discord user ID>
TRADE_DESK_URL=https://tradedesk.click
TRADE_DESK_DISCORD_API_KEY=<separate restricted integration credential>
```

The existing Discord guild, application, public key and bot token are reused. Trade Desk configures the same integration credential with its approved guild and owner IDs. Keep the integration secret only in service environment settings.

The bot calls the Trade Desk `/api/integrations/discord/` adapter over HTTPS with bearer authentication. It caches only catalogue identities for up to 60 seconds; version checks avoid retransferring an unchanged catalogue and preserve its prepared local matching index. Personalized offers are not cached. Clear warm lookups make one quote request; ambiguous requests check linked-account status before showing choices. No background catalogue polling, another bot connection or Gemini request is added.

## Verification

`node --test test/profit.test.mjs test/profit-discord.test.mjs` checks currency units, return on cost, missing/stale prices, exact variants, cache reuse, member separation, fresh account/conversion values, owner-only rate changes, signature/channel validation, private linking, bot-owned button context and additive command registration. The full `npm test` suite protects the existing BUFF, Telegram and Messenger behavior.
