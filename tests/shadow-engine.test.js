'use strict';

const assert = require('node:assert/strict');
const { analyseDirection, walkForward, wilsonLowerBound } = require('../shadow-engine');

function trendCandles(direction, count = 300) {
  return Array.from({ length: count }, (_, i) => {
    const sign = direction === 'BULLISH' ? 1 : -1;
    const close = 1.1 + sign * i * 0.0005;
    const open = close - sign * 0.00015;
    return {
      time: new Date(Date.UTC(2026, 0, 1, 0, i * 15)).toISOString(),
      timestamp: Date.UTC(2026, 0, 1, 0, i * 15),
      open,
      high: Math.max(open, close) + 0.0002,
      low: Math.min(open, close) - 0.0002,
      close
    };
  });
}

const bullish = analyseDirection(trendCandles('BULLISH'));
assert.equal(bullish.direction, 'BULLISH');
assert.equal(bullish.metrics.bullishVotes, 4);

const bearish = analyseDirection(trendCandles('BEARISH'));
assert.equal(bearish.direction, 'BEARISH');
assert.equal(bearish.metrics.bearishVotes, 4);

assert.equal(analyseDirection(trendCandles('BULLISH', 40)).direction, 'WAIT');

const research = walkForward([{ pair: 'TEST', candles: trendCandles('BULLISH') }]);
assert.ok(research.evaluated > 50);
assert.equal(research.accuracy, 1);
assert.equal(research.validated, false, 'a small single synthetic series must never pass the 200-sample validation gate');
assert.ok(research.lower95 < 1);
assert.ok(wilsonLowerBound(0, 0) === null);

console.log('[SHADOW_ENGINE_TEST] PASS bullish, bearish, insufficient-history, walk-forward and confidence-bound checks');
