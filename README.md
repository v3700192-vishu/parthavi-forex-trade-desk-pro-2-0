# PARTHAVI FOREX TRADE DESK PRO 2.0

Independent, prediction-only Forex analytics workspace. This repository is separate from the older PARTHAVI Trade Desk.

## Live services

- Dashboard: https://parthavi-forex-trade-desk-pro-2-0.onrender.com
- Secure data API: https://parthavi-forex-data-api.onrender.com
- Data service runtime: Node.js on Render Free, Singapore region
- Market-data provider adapter: Twelve Data REST candles

## Configure the provider key

1. Create a Twelve Data Basic account: https://twelvedata.com/pricing
2. Copy the API key from the Twelve Data dashboard.
3. Open the Render service: https://dashboard.render.com/web/srv-dc0ndne1egvs738fskd0
4. Open **Environment** and add:
   - Key: `TWELVE_DATA_API_KEY`
   - Value: your Twelve Data API key
5. Save/deploy the service. The key stays in the backend environment and is not embedded in the public website.

Do not paste the provider key into the public website or commit it to GitHub.

## API endpoints

- `GET /health` — service health and provider-key status
- `GET /api/forex/status` — data provider configuration status
- `GET /api/forex/candles?pair=EUR/USD&timeframe=15M` — normalized OHLC candles

Supported pairs: EUR/USD, GBP/USD, USD/JPY, USD/CHF, AUD/USD, NZD/USD, USD/CAD.

Supported timeframes: 5M, 15M, 30M, 1H, 4H.

## Free-tier controls

The dashboard uses the selected pair/timeframe on a 3-minute refresh and refreshes the seven-pair watchlist hourly while open. The backend applies a local cap of 8 requests per minute and 760 requests per UTC day, below the published Twelve Data Basic allowance of 8 credits/minute and 800 credits/day. A cache avoids repeated requests.

Render Free services can sleep when idle and may take time to wake.

## Integrity rules

- No synthetic market prices, candles, spreads, or performance statistics.
- The Twelve Data candles provide OHLC close values; bid, ask, and spread remain blank unless a verified source explicitly supplies them.
- Stale, missing, malformed, or quota-blocked data is not used for signals.
- The forecast stays **WAIT** until multi-timeframe agreement, validation, and calibrated out-of-sample performance are established.
- No broker order execution is implemented.
- EMA, RSI, MACD, ATR, and Bollinger values are calculated from returned OHLC candles in the dashboard. ADX and consolidated spot-FX volume remain unavailable until validated inputs are added.

## Run locally

```bash
npm install
npm run check
npm start
```

Set `TWELVE_DATA_API_KEY` in the local environment before requesting provider candles.
