# Trade Desk Discord profit checker

The checker uses the existing bot connection in a separate Discord channel. The existing BUFF channel and `/buff` handler keep their current behavior.

## Member flow

- `/setup`, `/profitsetup` or **Set up Account ID** opens a private form for the member's team Trade Desk Account ID in UUID format. The backend accepts only its approved team-account roster. There is no email entry, Discord role gate, member approval or website confirmation step.
- After setup, posting a skin name or supported photo in the profit channel automatically returns the posting member's personal prices and profit. No command or extra button is needed. Photos use the existing Gemini image-reading path; clear text matches stay local.
- `/profit items: ak redline ft` remains an optional private lookup. Each lookup and button click uses that Discord member's configured Account ID.
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

The bot calls the Trade Desk `/api/integrations/discord/` adapter over HTTPS with bearer authentication. UUID setup uses `setup` with `{guildId,discordUserId,accountId}` and expects `{linked:true}`. It caches only catalogue identities for up to 60 seconds; version checks avoid retransferring an unchanged catalogue and preserve its prepared local matching index. Personalized offers are not cached. Each lookup checks setup status before downloading a photo, calling Gemini, or fetching personal prices. Clear text then makes one quote request; photos and unresolved text can use Gemini for interpretation. No background catalogue polling or another bot connection is added.

## Verification

`node --test test/profit.test.mjs test/profit-discord.test.mjs` checks currency units, return on cost, missing/stale prices, exact variants, cache reuse, member separation, fresh account/conversion values, owner-only rate changes, signature/channel validation, private UUID setup, automatic text/photo lookup, the pre-setup price/AI gate, bot-owned button context and additive command registration. The full `npm test` suite protects the existing BUFF, Telegram and Messenger behavior.
