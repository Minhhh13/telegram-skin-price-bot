module telegram-skin-price-bot/messenger-sidecar

go 1.26.0

toolchain go1.27.3

require (
	github.com/rs/zerolog v1.35.1
	go.mau.fi/mautrix-meta v0.5.4-0.20261106000600-00f9a7e24173
)

// mautrix/meta uses this fork for the current QUIC and qpack APIs. Replace
// directives are not inherited by downstream modules.
replace github.com/imroc/req/v3 => github.com/beeper/req/v3 v3.0.0-20260925135712-b49593750e56
