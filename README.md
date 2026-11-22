# PARTHAVI FOREX TRADE DESK PRO 2.0

Independent, prediction-only Forex analytics workspace. This repository is separate from the older PARTHAVI Trade Desk.

## Live services

- Dashboard: https://parthavi-forex-trade-desk-pro-2-0.onrender.com
- Data API: https://parthavi-forex-data-api.onrender.com
- Dashboard and data API run as separate Render services.
- Data provider: Biquote public REST and SignalR feed (no API key required).

## Market-data integration

The backend normalises Biquote quote snapshots and OHLC bars for:
EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, NZD/USD and USD/CAD.

Supported chart intervals: 5M, 15M, 30M, 1H and 4H.

- `GET /health` — service status
- `GET /api/forex/status` — provider and feed configuration
- `GET /api/forex/quote?pair=EUR/USD` — bid, ask, mid, spread, quote age and market state
- `GET /api/forex/candles?pair=EUR/USD&timeframe=15M` — validated closed OHLC bars
- `GET /api/forex/reference-rates` — daily ECB reference rates for the seven supported pairs, relayed by Frankfurter; reference context only, never a live signal
- `GET /api/forex/fed-reference-rates` — Federal Reserve H.10 weekly-published daily observations, compared with ECB rates on the same observation date; reference validation only, never a live signal
- `GET /api/forex/shadow-engine?pair=EUR/USD&timeframe=15M` — fixed-rule shadow direction, five-timeframe freshness/alignment and walk-forward research metrics; never a live trade signal

Biquote's terms permit using and displaying its data in web dashboards, but prohibit reselling or redistributing the raw feed. Its quotes/candles are indicative third-party data, may be delayed, incomplete or wrong, and have no uptime SLA. Do not present them as guaranteed executable broker prices or regulated benchmark rates. See:
- https://biquote.io/docs/
- https://biquote.io/terms.html

The browser subscribes to all seven pairs through Biquote SignalR (`/hubs/tick`) with automatic reconnect. REST quote polling is the fallback if SignalR is unavailable. The selected timeframe candles refresh every 3 minutes; the API caches quote responses for 4 seconds and candles for 60 seconds, and applies a local per-IP request cap.

## Integrity rules

- No synthetic prices, spreads, candles, probability, or performance statistics.
- Bid, ask, mid and spread are displayed only when returned and validated by the quote source.
- The current unfinished OHLC candle is excluded from indicator calculations.
- Quote age and closed-candle age are checked separately for each timeframe. Stale or closed-market data blocks a fresh-data state.
- Biquote is one indicative source, not independent source agreement. Therefore the forecast remains **WAIT** until independent corroboration, top-down timeframe checks, and out-of-sample probability calibration are implemented and validated.
- No broker order execution is implemented.
- EMA, RSI, MACD, ATR, Bollinger Bands and Wilder ADX 14 are computed from returned closed OHLC candles. Confirmed swing points, BOS/CHoCH, support/resistance, 20-bar breakout checks and ATR distance planning are displayed as analytical context only. Real traded FX volume is not inferred from tick volume.

## Risk and signal gating

- ATR 14, per-bar realised volatility (20/50 closed returns) and ADX-based regime are calculated from the selected timeframe's closed candles.
- The calendar gate blocks on high-impact events for either pair currency from 15 minutes before to 60 minutes after the event.
- The displayed spread is the current Biquote quote spread only; no long-run normal-spread benchmark is available.
- Daily range and session-specific volatility are not inferred because the current endpoint does not provide the required daily/session dataset.
- Order-book liquidity is not measured because Level-2 depth is not supplied.
- ECB and Federal Reserve H.10 rates are daily/weekly reference comparisons only; neither is an intraday directional vote.
- Central-bank policy bias, risk sentiment, CPI/employment surprises and news sentiment are not yet verified/scored. Missing evidence remains WAIT.
- No trade forecast or probability is issued until an independent permitted live-price source, all required risk checks, and out-of-sample calibration at or above the 68% threshold are demonstrated.

## Shadow prediction engine and forward evaluation

- `GET /api/forex/shadow-engine?pair=EUR/USD&timeframe=15M` returns the research-only engine state, five-timeframe context, and a chronological walk-forward summary for the selected timeframe across the seven supported pairs.
- The fixed-rule baseline uses EMA 9/21/50 alignment, RSI 14, MACD histogram, four-bar price momentum and a Wilder ADX 14 trend-strength floor of 18. A directional candidate requires all four direction votes to agree. The forecast horizon is the close direction after three completed candles; walk-forward samples advance by three candles to avoid overlapping labels.
- The history window is limited by the upstream OHLC endpoint, so the research set may be too small. The 200-sample minimum is only a research-screen threshold, not proof of a profitable strategy.
- The displayed historical accuracy is not a future probability. The nominal pooled Wilson lower bound is descriptive only because pairs and time-series observations are correlated; its IID assumptions are not established. The engine emits no probability, `probabilityCalibrated=false`, `validated=false`, and `liveEligible=false`. Final trade state remains WAIT.
- A separate browser-local forward ledger records a forecast only when the current quote and that timeframe's closed candles are fresh. The entry is evaluated against the close three further completed candles later. It reports HIT/MISS/FLAT and a historical hit rate; flat outcomes are excluded from the hit-rate denominator.
- Forward records are kept in the current browser's local storage, are not synced to other devices, and can be lost if browser data is cleared. This tracker is shadow research only, not a calibrated probability or broker execution result. No automatic orders are sent.

No Brier score or probability calibration result is displayed because no calibrated probability model exists. MFE/MAE and a stop-loss/target outcome simulator remain future work.

## Derived cross-pair analytics

- Currency strength is a relative average contribution derived from the last up to 96 synchronized 15M closed-bar returns across the seven supported pairs. It is not a broad-market benchmark or a separate fundamental source.
- The correlation matrix uses Pearson correlation on synchronized 15M log returns, with a minimum of 30 common returns and a maximum of 96. Misaligned or insufficient history leaves the matrix blank.
- Both panels are historical context from the same indicative Biquote feed and cannot, by themselves, produce a trading signal.

## Validation

`npm run check` validates the backend syntax and every inline browser JavaScript block. GitHub Actions runs this check on each push to `main` and on pull requests.

## Run locally

```bash
npm install
npm run check
npm start
```

No provider API key is required. Render Free instances may sleep when idle and take time to wake.
