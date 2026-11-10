# Trade Desk Discord profit checker

The checker uses the existing bot connection in an explicit list of profit channels, such as the owner's private channel and the team channel. Both use the same setup, account mapping, shared weekly rate and prepared catalogue cache. The existing BUFF channel and `/buff` handler keep their current behavior.

## Member flow

- `/setup`, `/profitsetup` or **Set up Account ID** opens a private form for the member's team Trade Desk Account ID in UUID format. The backend accepts only its approved team-account roster. There is no email entry, Discord role gate, member approval or website confirmation step.
- After setup, posting a skin name or supported photo in the profit channel automatically returns the posting member's personal prices and profit. The first automatic reply mentions only that member; later chunks do not ping again. No command or extra button is needed. Photos use the existing Gemini image-reading path; clear text matches stay local.
- `/profit items: ak redline ft` remains an optional private lookup. Each lookup and button click uses that Discord member's configured Account ID.
- **Refresh** rechecks the member's current Trade Desk account rate and the shared conversion. **Custom buying rate** accepts `3.65` or `3650` VND per CNY. **Share result** publishes the displayed snapshot only after the member clicks it.
- **Customer quote** opens private item and preset-rate dropdowns in either profit channel, matching the BUFF checker. Its copy block contains the exact item, `BUFF: ¥… CNY`, the selected `3.65 → ₫…` conversion and BUFF listing link. Profit, USD conversion and Trade Desk account details stay out of that block. **Custom buying rate** lets you select one item and enter a different rate; its result can then be copied with **Customer quote**. **Copy on phone** opens the same four lines in a selectable field for the Discord iPhone app, and previously generated three-line copies still work. Copying makes no new price or AI request; use **Refresh** first when a new price is needed.
- An ambiguous request offers up to five actual Trade Desk identities. Phase, wear, StatTrak and Souvenir remain part of the exact price identity.

## Owner flow

`/ratechange` opens the shared weekly USD/USDT payout-unit to VND form. `!ratechange` posts a button opening the same form. Only the configured Discord owner can submit it; Trade Desk independently enforces that owner check. No conversion is assumed before the owner saves one.

Trade Desk remains the source for current personal USD estimates and the shared rate. The bot never receives the merchant key, raw unadjusted Trade Desk prices or a member's configured account percentage.

## Calculation and freshness

`proceeds VND = personal USD cents × weekly VND per USD ÷ 100`

`purchase cost VND = BUFF CNY × buying rate × 1000`

`estimated profit = proceeds − purchase cost`

`return on cost % = profit ÷ purchase cost × 100`

Amounts round to the nearest VND after Trade Desk's existing per-item USD-cent rounding. Results show the shared currency rate and buying-rate rows at 3.60, 3.65, 3.70, 3.75 and 3.80. An explicitly requested or custom 3.78 remains supported. Source timestamps and the estimate footer are omitted from the display. A known saved Trade Desk USD price can remain visible and be converted to VND while it is stale; green/red profit still requires positive current values from both sources internally. Missing, rejected or stale values remain neutral, and a missing price is reported as unavailable rather than as a currency-conversion failure.

## Configuration

Bot Render service:

```text
DISCORD_PROFIT_CHANNEL_IDS=<private channel ID>,<team channel ID>
DISCORD_PROFIT_OWNER_ID=<owner Discord user ID>
TRADE_DESK_URL=https://tradedesk.click
TRADE_DESK_DISCORD_API_KEY=<separate restricted integration credential>
```

The legacy `DISCORD_PROFIT_CHANNEL_ID` remains supported and is merged with the comma-separated plural setting, with duplicates removed. Only explicit numeric channel IDs in the configured guild are accepted; names and wildcards do not enable a channel. The bot must have View Channel, Send Messages and Read Message History in each listed channel. One bounded startup diagnostic reports each configured channel ID as ready or missing access without posting messages or changing permissions. A missing optional profit channel does not stop the original BUFF listener.

The existing Discord guild, application, public key and bot token are reused. Trade Desk configures the same integration credential with its approved guild and owner IDs. Keep the integration secret only in service environment settings.

The bot calls the Trade Desk `/api/integrations/discord/` adapter over HTTPS with bearer authentication. UUID setup uses `setup` with `{guildId,discordUserId,accountId}` and expects `{linked:true}`. It caches only catalogue identities for up to 60 seconds; version checks avoid retransferring an unchanged catalogue and preserve its prepared local matching index. Personalized offers are not cached. Each lookup checks setup status before downloading a photo, calling Gemini, or fetching personal prices. Clear text then makes one quote request; photos and unresolved text can use Gemini for interpretation. No background catalogue polling or another bot connection is added.

## Verification

`node --test test/profit.test.mjs test/profit-discord.test.mjs test/profit-customer.test.mjs` checks currency units, return on cost, missing/stale prices, exact variants, cache reuse, member separation, fresh account/conversion values, owner-only rate changes, signature/channel validation, private UUID setup, automatic text/photo lookup, the pre-setup price/AI gate, bot-owned button context, private customer quotes and mobile copying, and additive command registration. The full `npm test` suite protects the existing BUFF, Telegram and Messenger behavior.
