# PARTHAVI FOREX TRADE DESK PRO 2.0

Independent, prediction-only Forex analytics workspace. This repository is separate from the older PARTHAVI Trade Desk.

## Live services

- Dashboard: https://parthavi-forex-trade-desk-pro-2-0.onrender.com
- Data API: https://parthavi-forex-data-api.onrender.com
- Dashboard and data API run as separate Render services.
- Data provider: Biquote public REST and SignalR feed (no API key required).

## Android / browser app installation

- The dashboard is an installable Progressive Web App (PWA) with 192px and 512px icons, a home-screen install prompt, and a cached offline dashboard shell.
- On Android Chrome, open the Dashboard URL and tap **INSTALL APP** when shown. If Chrome does not offer the prompt, use Chrome menu → **Install app** or **Add to Home screen**.
- Offline mode caches only the app shell and static assets. Live quotes, candles, news and calendar still require internet; API responses are never cached by the service worker. This is a PWA, not a signed native Android APK.

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
- `GET /api/forex/cot-positioning?pair=EUR/USD` — official CFTC Traders in Financial Futures futures-only positioning for the seven USD-major currency futures, with leveraged-fund and asset-manager net positions and 52-week percentiles
- `GET /api/forex/shadow-engine?pair=EUR/USD&timeframe=15M` — fixed-rule shadow direction, five-timeframe freshness/alignment and walk-forward research metrics; never a live trade signal

Biquote's terms permit using and displaying its data in web dashboards, but prohibit reselling or redistributing the raw feed. Its quotes/candles are indicative third-party data, may be delayed, incomplete or wrong, and have no uptime SLA. Do not present them as guaranteed executable broker prices or regulated benchmark rates. See:
- https://biquote.io/docs/
- https://biquote.io/terms.html

The browser subscribes to all seven pairs through Biquote SignalR (`/hubs/tick`) with automatic reconnect. REST quote polling is the fallback if SignalR is unavailable. The selected timeframe candles refresh every 3 minutes; the API caches quote responses for 4 seconds and candles for 60 seconds, and applies a local per-IP request cap.

## Independent live-source cross-check

- Independent provider: SiftingIO Forex, which publishes aggregated FX quotes derived from multiple global liquidity/reference sources. It is a separate vendor/feed from Biquote, but it is still an indicative reference price, not a broker execution quote.
- The SiftingIO free tier is $0 with no card, supports one WebSocket connection and up to five symbol subscriptions, and is licensed for personal, non-commercial use. Its REST allowance is 10,000 calls/month. See https://sifting.io/pricing?billing=monthly&market=forex and https://sifting.io/docs/websocket.
- SiftingIO REST history calls are serialized at a conservative pace and honour a bounded `Retry-After` retry for temporary burst limits. A monthly-quota error is not retried. The API health endpoint reports the latest provider rate/quota headers when supplied. The research cache is six hours; live ticks use the WebSocket and do not consume REST quote polling.
- The backend uses one server-side WebSocket connection and no more than five active FX symbols: four core majors plus the currently selected pair. Selecting another pair rotates that selected pair into the subscription set so the selected instrument can be cross-checked.
- Configure the free API key as the Render API service environment variable `SIFTINGIO_API_KEY`. The key stays on the backend and is never sent to the browser. Without this variable the source is explicitly reported as `NOT_CONFIGURED`; it is not represented as live.
- Every accepted SiftingIO tick must contain valid bid/ask values and a timestamp. A tick older than 5 seconds is stale. The selected pair's SiftingIO midpoint is compared with Biquote's midpoint; a relative gap above 0.05% blocks the direction candidate. Missing, stale, disconnected or divergent source data means WAIT.
- The dashboard exposes `GET /api/forex/independent-source?pair=EUR/USD` for the selected pair's provider and quote status. `GET /api/forex/shadow-engine` includes source freshness and price-gap diagnostics.
- Free-tier use is for a personal non-commercial dashboard only; do not use it to redistribute data or expose it as a customer-facing commercial feed without the provider's appropriate license.

## Integrity rules

- No synthetic prices, spreads, candles, probability, or performance statistics.
- Bid, ask, mid and spread are displayed only when returned and validated by the quote source.
- The current unfinished OHLC candle is excluded from indicator calculations.
- Quote age and closed-candle age are checked separately for each timeframe. Stale or closed-market data blocks a fresh-data state.
- Biquote is one indicative source, not independent source agreement. Therefore the forecast remains **WAIT** until independent corroboration, top-down timeframe checks, and out-of-sample probability calibration are implemented and validated.
- No broker order execution is implemented.
- EMA, RSI, MACD, ATR, Bollinger Bands and Wilder ADX 14 are computed from returned closed OHLC candles. Confirmed swing points, BOS/CHoCH, support/resistance, 20-bar breakout checks and ATR distance planning are displayed as analytical context only. Real traded FX volume is not inferred from tick volume.

## Daily central-bank policy rates and rate differential

- The API reads the official BIS WS_CBPOL daily end-of-period policy-rate series for the United States (US), euro area (XM), United Kingdom (GB), Japan (JP), Switzerland (CH), Australia (AU), New Zealand (NZ) and Canada (CA).
- The daily series are requested separately by area, filtered to frequency D, unit 368 (per cent per annum), unit multiplier 0 and normal/free observations. The response is cached for six hours with a 400-day lookback to identify the last actual policy-rate change and an approximately 90-day move.
- Pair policy differential is the base-currency policy rate minus the quote-currency policy rate. Example: EUR/USD = Euro-area policy rate minus US policy rate; USD/JPY = US policy rate minus Japanese policy rate.
- BIS daily observations are end-of-period and are usually published around mid-week. Each currency retains its own observation date. Observations up to 7 days old are labelled FRESH_DAILY; observations 8–14 days old are labelled DELAYED_REFERENCE and may still be displayed as dated policy-rate context; observations older than 14 days are excluded from pair differentials. The dashboard shows observation dates and never labels delayed data as fresh.
- This is policy-rate and carry context, not a prediction of spot FX direction. Markets price future policy expectations; a current rate differential alone does not establish a trade signal or calibrated probability.
- Attribution: Bank for International Settlements (BIS), Central bank policy rates, dataset WS_CBPOL. Data are reported directly to the BIS by member central banks. Rate definitions and permitted-use terms are available at https://data.bis.org/topics/CBPOL and https://data.bis.org/help/legal.

## Daily macro and economic-surprise context

- The API caches five public FRED CSV series for six hours: DTWEXBGS (broad trade-weighted USD index), DGS2 and DGS10 (Treasury yields), VIXCLS (VIX), and DCOILWTICO (WTI crude oil).
- Core USD/risk freshness requires the broad USD index (DTWEXBGS), 2Y yield (DGS2), 10Y yield (DGS10) and VIX (VIXCLS). WTI crude (DCOILWTICO) is optional and its own freshness is shown separately; stale oil does not mark all core macro data stale.
- Broad USD context combines the broad USD-index move and 2-year yield move over five observations. Strong opposing USD-index and yield momentum forces MIXED rather than choosing a direction. VIX level and its five-observation change produce a coarse risk-regime label. These are transparent macro context heuristics, not calibrated forecasts.
- Economic-calendar events are scored only when actual and forecast values are both present, the event is in the past, its importance is known, and its name matches an explicit macro-event rule. The current event window is 72 hours with time decay.
- Higher inflation is treated as a possible hawkish-expectations channel, not a guaranteed currency-positive reaction. Unemployment-rate and claims surprises use inverted polarity. Growth, activity and policy-rate surprises use a stronger-activity/higher-rate polarity.
- The current market-news feed is a limited US headline sample. Only explicit Fed/rates, inflation, employment and Treasury-yield phrases are classified; this is low-confidence keyword research context, not NLP sentiment or a directional vote.
- Global macro, event-surprise and headline context is displayed separately from the technical vote-share panel. It is not yet included in the walk-forward probability model; adding it to the calibrated model requires point-in-time historical features and out-of-sample validation.

## Weekly CFTC positioning intelligence

- The API reads the official CFTC Public Reporting Environment TFF futures-only dataset (gpe5-46if) without an API token, selecting the seven CME currency futures contracts: EUR 099741, GBP 096742, JPY 097741, CHF 092741, AUD 232741, NZD 112741 and CAD 090741.
- The backend caches the response for six hours and computes leveraged-fund and asset-manager net positions as a percentage of open interest, weekly changes, and rolling 52-report percentiles.
- Pair direction accounts for quote-currency inversion: a long JPY, CHF or CAD futures positioning bias maps inversely to USD/JPY, USD/CHF or USD/CAD; long EUR, GBP, AUD and NZD maps in the same direction as their USD pairs.
- CFTC reports are weekly, based on Tuesday positions and generally released Friday at 3:30 p.m. America/New_York. The dashboard labels this data as weekly positioning context, not intraday spot flow or a live trade signal.
- The CFTC context is displayed separately and is not yet fed into the walk-forward probability model. It must be time-aligned to the Friday publication time before it can be used in any historical model training, to avoid look-ahead leakage.

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
- Live decision candles remain on Biquote. For walk-forward research and cross-pair historical context only, the API prefers up to 2,000 closed SiftingIO bars per pair/timeframe when the configured free-tier key is available; research history is cached for six hours. If that request fails, the engine falls back to the available validated OHLC source and labels the provider. Research OHLC never becomes an extra live directional vote. The 200-sample minimum is only a research-screen threshold, not proof of a profitable strategy.
- The displayed historical accuracy is not a future probability. The nominal pooled Wilson lower bound is descriptive only because pairs and time-series observations are correlated; its IID assumptions are not established. The engine emits no probability, `probabilityCalibrated=false`, `validated=false`, and `liveEligible=false`. Final trade state remains WAIT.
- A separate browser-local forward ledger records a forecast only when the current quote and that timeframe's closed candles are fresh. The entry is evaluated against the close three further completed candles later. It reports HIT/MISS/FLAT and a historical hit rate; flat outcomes are excluded from the hit-rate denominator.
- The walk-forward report also includes a volatility-scaled barrier study: the mean of the prior 14 true ranges sets a 1× risk stop and a 2× risk target over the same three-completed-candle horizon. It records target-first, stop-first, no-touch and same-candle ambiguous outcomes, plus MFE/MAE in initial risk (R) units. Both barriers touched in one OHLC candle are marked ambiguous and excluded from the target-first resolved denominator and never counted as target wins.
- Forward records are kept in the current browser's local storage, are not synced to other devices, and can be lost if browser data is cleared. This tracker is shadow research only, not a calibrated probability or broker execution result. No automatic orders are sent.

No Brier score or probability calibration result is displayed because no calibrated probability model exists. Barrier and MFE/MAE results are historical OHLC research only: spread, slippage, financing, gaps and broker execution are not fully simulated, and same-candle dual touches are ambiguous. These metrics do not establish profitability or a future probability.

## Derived cross-pair analytics

- Currency strength is a relative average contribution derived from the last up to 96 synchronized 15M closed-bar returns across the seven supported pairs. It is not a broad-market benchmark or a separate fundamental source.
- The correlation matrix uses Pearson correlation on synchronized 15M log returns, with a minimum of 30 common returns and a maximum of 96. Misaligned or insufficient history leaves the matrix blank.
- Both panels are historical context from the selected research-history provider (SiftingIO where available) and cannot, by themselves, produce a trading signal. They are not a separate fundamental vote.

## Validation

`npm run check` validates `server.js` and `shadow-engine.js` syntax, runs deterministic direction / walk-forward / barrier / MFE-MAE / probability-gate tests for the shadow engine, and checks every inline browser JavaScript block for syntax. It does not validate predictive profitability or calibrated probability.

## Run locally

```bash
npm install
npm run check
npm start
```

No provider API key is required. Render Free instances may sleep when idle and take time to wake.
