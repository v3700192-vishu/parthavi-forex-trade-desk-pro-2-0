# PARTHAVI FOREX TRADE DESK PRO 2.0

Independent, prediction-only Forex analytics workspace. This repository is separate from the older PARTHAVI Trade Desk.

## Live services

- Dashboard: https://parthavi-forex-trade-desk-pro-2-0.onrender.com
- Data API: https://parthavi-forex-data-api.onrender.com
- Dashboard and data API run as separate Render services.
- Data provider: Biquote public REST API (no API key required).

## Market-data integration

The backend normalises Biquote quote snapshots and OHLC bars for:
EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, NZD/USD and USD/CAD.

Supported chart intervals: 5M, 15M, 30M, 1H and 4H.

- `GET /health` — service status
- `GET /api/forex/status` — provider and feed configuration
- `GET /api/forex/quote?pair=EUR/USD` — bid, ask, mid, spread, quote age and market state
- `GET /api/forex/candles?pair=EUR/USD&timeframe=15M` — validated closed OHLC bars

Biquote's terms permit using and displaying its data in web dashboards, but prohibit reselling or redistributing the raw feed. Its quotes/candles are indicative third-party data, may be delayed, incomplete or wrong, and have no uptime SLA. Do not present them as guaranteed executable broker prices or regulated benchmark rates. See:
- https://biquote.io/docs/
- https://biquote.io/terms.html

The dashboard refreshes the selected quote every 5 seconds, the 7-pair watchlist every 60 seconds, and the selected timeframe candles every 3 minutes. The API caches quote responses for 4 seconds and candles for 60 seconds, and applies a local per-IP request cap.

## Integrity rules

- No synthetic prices, spreads, candles, probability, or performance statistics.
- Bid, ask, mid and spread are displayed only when returned and validated by the quote source.
- The current unfinished OHLC candle is excluded from indicator calculations.
- Quote age and closed-candle age are checked separately for each timeframe. Stale or closed-market data blocks a fresh-data state.
- Biquote is one indicative source, not independent source agreement. Therefore the forecast remains **WAIT** until independent corroboration, top-down timeframe checks, and out-of-sample probability calibration are implemented and validated.
- No broker order execution is implemented.
- EMA, RSI, MACD, ATR and Bollinger Bands are computed from returned closed OHLC candles. ADX and other unimplemented indicators remain blank. Real traded FX volume is not inferred from tick volume.

## Run locally

```bash
npm install
npm run check
npm start
```

No provider API key is required. Render Free instances may sleep when idle and take time to wake.
