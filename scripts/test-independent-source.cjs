'use strict';
const assert = require('node:assert/strict');
const {
  normalisePair, desiredPairs, compareIndependentQuotes, normaliseSiftingQuote,
  normaliseSiftingBars, aggregateHourlyBarsTo4H, constants
} = require('../independent-source');

assert.equal(normalisePair('EURUSD'), 'EUR/USD');
assert.equal(normalisePair('NZD/USD'), 'NZD/USD');
assert.equal(normalisePair('UNKNOWN'), null);
for (const pair of ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD']) {
  const selected = desiredPairs(pair);
  assert.equal(selected.length, 5, 'free tier stays within its five-symbol WebSocket cap');
  assert.ok(selected.includes(pair), 'the currently selected pair is always subscribed');
  assert.equal(new Set(selected).size, 5, 'subscriptions are unique');
}
const aligned = compareIndependentQuotes({mid:1.10000},{mid:1.10020});
assert.equal(aligned.status, 'ALIGNED');
assert.equal(aligned.aligned, true);
const divergent = compareIndependentQuotes({mid:1.10000},{mid:1.10200});
assert.equal(divergent.status, 'PRICE_DIVERGENCE');
assert.equal(divergent.aligned, false);
assert.equal(compareIndependentQuotes({mid:null},{mid:1}).status, 'MISSING_PRICE');
assert.equal(constants.MAX_SUBSCRIPTIONS, 5);

const now = Date.UTC(2026, 10, 24, 12, 0, 0);
const freshQuote = normaliseSiftingQuote('EUR/USD', {
  s:'EURUSD', b:'1.1000', a:'1.1002', t:now - 500
}, now);
assert.equal(freshQuote.status, 'FRESH');
assert.equal(freshQuote.quote.mid, 1.1001);
assert.equal(normaliseSiftingQuote('EUR/USD', {
  s:'EURUSD', b:'1.1000', a:'1.1002', t:now - 7000
}, now).status, 'STALE');
assert.equal(normaliseSiftingQuote('GBP/USD', {
  s:'EURUSD', b:'1.1000', a:'1.1002', t:now
}, now).status, 'INVALID_QUOTE');
const bars = [];
const start = Date.UTC(2026, 10, 24, 0, 0, 0);
for (let i = 0; i < 8; i++) {
  const close = 1.1 + i * 0.0001;
  bars.push({t:start + i * 3600000, o:close - 0.00005, h:close + 0.0001,
    l:close - 0.0001, c:close, v:10});
}
assert.equal(normaliseSiftingBars({data:bars}, '1H', start + 9*3600000).length, 8);
const fourHour = aggregateHourlyBarsTo4H(
  bars.map(bar => ({time:new Date(bar.t).toISOString(),timestamp:bar.t,open:bar.o,high:bar.h,low:bar.l,close:bar.c,tickVolume:bar.v})),
  start + 9*3600000
);
assert.equal(fourHour.length, 2);
assert.equal(fourHour[0].open, bars[0].o);
assert.equal(fourHour[0].close, bars[3].c);
assert.equal(fourHour[0].tickVolume, 40);
assert.equal(aggregateHourlyBarsTo4H(bars.slice(0,3).map(bar => ({time:new Date(bar.t).toISOString(),timestamp:bar.t,open:bar.o,high:bar.h,low:bar.l,close:bar.c,tickVolume:bar.v})), start+9*3600000).length, 0);
console.log('Independent SiftingIO source selection, quote freshness, OHLC validation, 4H aggregation and quote-agreement tests passed.');

