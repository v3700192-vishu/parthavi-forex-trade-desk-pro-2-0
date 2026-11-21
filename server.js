/**
 * PARTHAVI FOREX DATA API
 * Secure Twelve Data gateway. Provider key is read only from server environment.
 * Prediction engine remains WAIT unless fresh, verified candle data is present.
 */
'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const PROVIDER_KEY = String(process.env.TWELVE_DATA_API_KEY || '').trim();
const PROVIDER = 'Twelve Data';
const SITE_ORIGIN = 'https://parthavi-forex-trade-desk-pro-2-0.onrender.com';
const ALLOWED_PAIRS = new Set([
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF',
  'AUD/USD', 'NZD/USD', 'USD/CAD'
]);
const INTERVALS = new Map([
  ['5M', '5min'], ['15M', '15min'], ['30M', '30min'],
  ['1H', '1h'], ['4H', '4h']
]);
const CACHE_TTL_MS = 180000;
const MAX_CALLS_PER_MINUTE = 7;
const MAX_CALLS_PER_UTC_DAY = 760;
const cache = new Map();
const usage = { minute: -1, minuteCalls: 0, day: '', dayCalls: 0 };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': SITE_ORIGIN,
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== SITE_ORIGIN && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    json(res, 403, { ok: false, error: 'origin_not_allowed' });
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin || SITE_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

function providerBudgetAvailable() {
  const now = new Date();
  const minute = Math.floor(Date.now() / 60000);
  const day = now.toISOString().slice(0, 10);
  if (usage.minute !== minute) {
    usage.minute = minute;
    usage.minuteCalls = 0;
  }
  if (usage.day !== day) {
    usage.day = day;
    usage.dayCalls = 0;
  }
  if (usage.minuteCalls >= MAX_CALLS_PER_MINUTE) return { ok: false, reason: 'minute_guard' };
  if (usage.dayCalls >= MAX_CALLS_PER_UTC_DAY) return { ok: false, reason: 'daily_safety_cap' };
  usage.minuteCalls += 1;
  usage.dayCalls += 1;
  return { ok: true };
}

function safeProviderMessage(payload) {
  const message = String(payload && (payload.message || payload.code || payload.status) || 'provider_error');
  return message.slice(0, 180).replace(/[\r\n]/g, ' ');
}

async function fetchCandles(pair, timeframe) {
  const interval = INTERVALS.get(timeframe);
  const key = pair + '|' + timeframe;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached.value, cache: 'HIT' };
  }
  if (!PROVIDER_KEY) {
    const error = new Error('provider_key_missing');
    error.statusCode = 503;
    throw error;
  }
  const budget = providerBudgetAvailable();
  if (!budget.ok) {
    const error = new Error(budget.reason);
    error.statusCode = 429;
    throw error;
  }

  const requestUrl = new URL('https://api.twelvedata.com/time_series');
  requestUrl.searchParams.set('symbol', pair);
  requestUrl.searchParams.set('interval', interval);
  requestUrl.searchParams.set('outputsize', '250');
  requestUrl.searchParams.set('timezone', 'UTC');
  requestUrl.searchParams.set('apikey', PROVIDER_KEY);

  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    const error = new Error('provider_http_' + response.status);
    error.statusCode = 502;
    throw error;
  }
  const payload = await response.json();
  if (payload && payload.status === 'error') {
    const error = new Error('provider_' + safeProviderMessage(payload));
    error.statusCode = 502;
    throw error;
  }
  if (!Array.isArray(payload.values) || payload.values.length < 30) {
    const error = new Error('insufficient_candle_history');
    error.statusCode = 422;
    throw error;
  }

  const candles = payload.values.map(row => ({
    time: row.datetime,
    timestamp: Date.parse(String(row.datetime).replace(' ', 'T') + (String(row.datetime).includes('Z') ? '' : 'Z')),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close)
  })).filter(c => Number.isFinite(c.timestamp) &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close, c.high))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (candles.length < 30) {
    const error = new Error('invalid_or_insufficient_candle_values');
    error.statusCode = 422;
    throw error;
  }

  const last = candles[candles.length - 1];
  const ageSeconds = Math.max(0, Math.floor((Date.now() - last.timestamp) / 1000));
  const result = {
    ok: true,
    provider: PROVIDER,
    pair,
    timeframe,
    interval,
    meta: {
      symbol: payload.meta && payload.meta.symbol || pair,
      exchange: payload.meta && payload.meta.exchange || 'FOREX',
      currency: payload.meta && payload.meta.currency || null,
      lastCandleAt: last.time,
      ageSeconds,
      candleCount: candles.length,
      freshness: ageSeconds <= 1200 ? 'FRESH' : 'STALE',
      timestampBasis: 'provider_candle_timestamp'
    },
    candles,
    fetchedAt: new Date().toISOString(),
    cache: 'MISS'
  };
  cache.set(key, { savedAt: Date.now(), value: result });
  return result;
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) return;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || SITE_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    });
    return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' || url.pathname === '/api/forex/status') {
    return json(res, 200, {
      ok: true,
      service: 'PARTHAVI FOREX DATA API',
      provider: PROVIDER,
      providerConfigured: Boolean(PROVIDER_KEY),
      dataReady: false,
      apiPlan: 'Basic free tier compatible; subject to provider symbol/endpoint entitlements',
      limits: {
        localRequestsPerMinute: MAX_CALLS_PER_MINUTE,
        localDailySafetyCap: MAX_CALLS_PER_UTC_DAY,
        providerDailyPublishedLimit: 800
      },
      feedMode: 'REST candles; no bid/ask or spread is fabricated',
      serverTime: new Date().toISOString()
    });
  }
  if (url.pathname === '/api/forex/candles') {
    const pair = String(url.searchParams.get('pair') || '').toUpperCase();
    const timeframe = String(url.searchParams.get('timeframe') || '15M').toUpperCase();
    if (!ALLOWED_PAIRS.has(pair)) return json(res, 400, { ok: false, error: 'unsupported_pair' });
    if (!INTERVALS.has(timeframe)) return json(res, 400, { ok: false, error: 'unsupported_timeframe' });
    try {
      const result = await fetchCandles(pair, timeframe);
      return json(res, 200, result);
    } catch (error) {
      const status = Number(error.statusCode) || 502;
      return json(res, status, {
        ok: false,
        provider: PROVIDER,
        pair,
        timeframe,
        error: error.message || 'data_request_failed',
        providerConfigured: Boolean(PROVIDER_KEY),
        safeToSignal: false,
        serverTime: new Date().toISOString()
      });
    }
  }
  return json(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[PARTHAVI_FOREX_API] listening port=' + PORT);
  console.log('[PARTHAVI_FOREX_API] provider_key_configured=' + Boolean(PROVIDER_KEY));
});
