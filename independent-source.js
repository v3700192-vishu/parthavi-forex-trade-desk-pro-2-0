'use strict';

const WebSocket = require('ws');

const PROVIDER = 'SiftingIO';
const WS_URL = 'wss://stream.sifting.io/ws/v1';
const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD'];
const CORE_PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF'];
const DEFAULT_SELECTED_PAIR = 'EUR/USD';
const MAX_SUBSCRIPTIONS = 5;
const MAX_TICK_AGE_MS = 5000;
const MAX_PRICE_DEVIATION_PCT = 0.05;

let socket = null;
let authenticated = false;
let connected = false;
let started = false;
let selectedPair = DEFAULT_SELECTED_PAIR;
let activePairs = desiredPairs(selectedPair);
let reconnectTimer = null;
let pingTimer = null;
let reconnectDelayMs = 5000;
let lastError = null;
let lastMessageAt = null;
const quotes = new Map();

function normalisePair(value) {
  const raw = String(value || '').toUpperCase().replace(/\s/g, '');
  const pair = raw.includes('/') ? raw : raw.length === 6 ? raw.slice(0, 3) + '/' + raw.slice(3) : '';
  return PAIRS.includes(pair) ? pair : null;
}
function symbolFor(pair) { return pair.replace('/', ''); }
function pairFor(symbol) {
  const value = String(symbol || '').toUpperCase();
  const pair = value.length === 6 ? value.slice(0, 3) + '/' + value.slice(3) : '';
  return PAIRS.includes(pair) ? pair : null;
}
function desiredPairs(pair) {
  const selected = normalisePair(pair) || DEFAULT_SELECTED_PAIR;
  const result = [...CORE_PAIRS];
  if (!result.includes(selected)) result.push(selected);
  else result.push(selected === 'AUD/USD' ? 'NZD/USD' : 'AUD/USD');
  return [...new Set(result)].slice(0, MAX_SUBSCRIPTIONS);
}
function safeSend(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(payload)); return true; } catch { return false; }
}
function subscribeCurrentPairs() {
  return safeSend({ op: 'subscribe', product: 'fx', symbols: activePairs.map(symbolFor) });
}
function selectIndependentPair(value) {
  const pair = normalisePair(value);
  if (!pair) return { ok: false, error: 'unsupported_pair' };
  selectedPair = pair;
  const next = desiredPairs(pair);
  const previous = activePairs;
  const removed = previous.filter(item => !next.includes(item)).map(symbolFor);
  const added = next.filter(item => !previous.includes(item)).map(symbolFor);
  activePairs = next;
  if (authenticated && removed.length) safeSend({ op: 'unsubscribe', product: 'fx', symbols: removed });
  if (authenticated && added.length) safeSend({ op: 'subscribe', product: 'fx', symbols: added });
  return { ok: true, selectedPair, subscribedPairs: [...activePairs] };
}
function getIndependentQuote(value) {
  const pair = normalisePair(value);
  if (!pair) return { ok: false, provider: PROVIDER, pair: null, status: 'UNSUPPORTED_PAIR' };
  const stored = quotes.get(pair);
  if (!activePairs.includes(pair)) {
    return { ok: false, provider: PROVIDER, pair, status: 'NOT_SUBSCRIBED', connected, selectedPair, subscribedPairs: [...activePairs] };
  }
  if (!stored) {
    const status = !process.env.SIFTINGIO_API_KEY ? 'NOT_CONFIGURED' : connected ? 'WAITING_FOR_FIRST_TICK' : 'CONNECTING';
    return { ok: false, provider: PROVIDER, pair, status, connected, selectedPair, subscribedPairs: [...activePairs] };
  }
  const ageMs = Date.now() - stored.timestampMs;
  const fresh = Number.isFinite(ageMs) && ageMs >= -1000 && ageMs <= MAX_TICK_AGE_MS;
  return {
    ok: fresh,
    provider: PROVIDER,
    pair,
    status: fresh ? 'FRESH' : 'STALE',
    connected,
    selectedPair,
    subscribedPairs: [...activePairs],
    quote: {
      bid: stored.bid,
      ask: stored.ask,
      mid: stored.mid,
      timestamp: new Date(stored.timestampMs).toISOString(),
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      source: 'SiftingIO aggregated FX WebSocket'
    },
    meta: { freshness: fresh ? 'FRESH' : 'STALE', safeToSignal: fresh, ageMs: Number.isFinite(ageMs) ? ageMs : null }
  };
}
function getIndependentSourceStatus() {
  const configured = Boolean(process.env.SIFTINGIO_API_KEY);
  return {
    provider: PROVIDER,
    configured,
    connected,
    authenticated,
    selectedPair,
    subscribedPairs: [...activePairs],
    subscriptionLimit: MAX_SUBSCRIPTIONS,
    tickAgeLimitMs: MAX_TICK_AGE_MS,
    lastMessageAt,
    lastError: lastError ? String(lastError).slice(0, 120) : null,
    status: !configured ? 'NOT_CONFIGURED' : connected && authenticated ? 'CONNECTED' : 'CONNECTING'
  };
}
function compareIndependentQuotes(primary, independent, maxDeviationPct = MAX_PRICE_DEVIATION_PCT) {
  const primaryMid = Number(primary && primary.mid);
  const independentMid = Number(independent && independent.mid);
  if (!Number.isFinite(primaryMid) || !Number.isFinite(independentMid) || primaryMid <= 0 || independentMid <= 0) {
    return { aligned: false, deviationPct: null, maxDeviationPct, status: 'MISSING_PRICE' };
  }
  const deviationPct = Math.abs(primaryMid - independentMid) / ((primaryMid + independentMid) / 2) * 100;
  return {
    aligned: deviationPct <= maxDeviationPct,
    deviationPct,
    maxDeviationPct,
    status: deviationPct <= maxDeviationPct ? 'ALIGNED' : 'PRICE_DIVERGENCE'
  };
}
function handleMessage(raw) {
  let message;
  try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
  catch { lastError = 'invalid_json_frame'; return; }
  lastMessageAt = new Date().toISOString();
  if (message.f === 'ack' && message.op === 'auth') {
    authenticated = true;
    connected = true;
    lastError = null;
    reconnectDelayMs = 5000;
    subscribeCurrentPairs();
    return;
  }
  if (message.f === 'tick' && message.class === 'fx') {
    const pair = pairFor(message.s);
    const bid = Number(message.b), ask = Number(message.a), timestampMs = Number(message.t);
    if (!pair || !activePairs.includes(pair) || !Number.isFinite(bid) || !Number.isFinite(ask) ||
        bid <= 0 || ask < bid || !Number.isFinite(timestampMs) || timestampMs <= 0) return;
    const age = Date.now() - timestampMs;
    if (age < -1000 || age > 60000) return;
    const previous = quotes.get(pair);
    if (!previous || timestampMs >= previous.timestampMs) {
      quotes.set(pair, { bid, ask, mid: (bid + ask) / 2, timestampMs });
    }
    return;
  }
  if (message.f === 'error') {
    lastError = String(message.code || 'provider_stream_error');
    if (message.code === 'auth_failed' || message.code === 'auth_required') {
      authenticated = false;
      connected = false;
    }
  }
}
function scheduleReconnect() {
  if (!process.env.SIFTINGIO_API_KEY || reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(60000, reconnectDelayMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}
function connect() {
  if (!process.env.SIFTINGIO_API_KEY || socket || !started) return;
  try {
    socket = new WebSocket(WS_URL + '?key=' + encodeURIComponent(process.env.SIFTINGIO_API_KEY), {
      handshakeTimeout: 10000,
      perMessageDeflate: false
    });
    socket.on('open', () => {
      connected = true;
      lastError = null;
    });
    socket.on('message', handleMessage);
    socket.on('error', error => {
      lastError = String(error && error.message || 'websocket_error').slice(0, 120);
    });
    socket.on('close', (code, reason) => {
      connected = false;
      authenticated = false;
      socket = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      lastError = code === 1000 ? null : 'websocket_closed_' + code + (reason ? '_' + reason.toString().slice(0, 40) : '');
      scheduleReconnect();
    });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => safeSend({ op: 'ping' }), 45000);
    pingTimer.unref?.();
  } catch (error) {
    socket = null;
    connected = false;
    authenticated = false;
    lastError = String(error && error.message || 'websocket_start_failed').slice(0, 120);
    scheduleReconnect();
  }
}
function startIndependentSource() {
  if (started) return getIndependentSourceStatus();
  started = true;
  if (process.env.SIFTINGIO_API_KEY) connect();
  else lastError = 'SIFTINGIO_API_KEY is not configured';
  return getIndependentSourceStatus();
}

module.exports = {
  startIndependentSource,
  selectIndependentPair,
  getIndependentQuote,
  getIndependentSourceStatus,
  normalisePair,
  desiredPairs,
  compareIndependentQuotes,
  constants: { PROVIDER, MAX_SUBSCRIPTIONS, MAX_TICK_AGE_MS, MAX_PRICE_DEVIATION_PCT }
};
