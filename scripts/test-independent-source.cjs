'use strict';
const assert = require('node:assert/strict');
const {
  normalisePair, desiredPairs, compareIndependentQuotes, constants
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
console.log('Independent SiftingIO source selection, subscription-cap, and quote-agreement tests passed.');
