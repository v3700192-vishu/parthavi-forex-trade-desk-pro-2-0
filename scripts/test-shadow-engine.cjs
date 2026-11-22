'use strict';
const assert = require('node:assert/strict');
const { assess, walkForward, buildTimeframeResult, buildShadowForecast, TIMEFRAMES } = require('../lib/shadowPredictionEngine');

function makeTrendBars(count = 240) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = 1.05 + i * 0.0002 + Math.sin(i / 5) * 0.00003;
    const open = close - 0.00002;
    bars.push({
      time: new Date(Date.UTC(2026, 0, 1) + i * 900000).toISOString(),
      timestamp: Date.UTC(2026, 0, 1) + i * 900000,
      open, high: close + 0.00005, low: open - 0.00004, close
    });
  }
  return bars;
}

const bars = makeTrendBars();
const latest = assess(bars);
assert.equal(latest.direction, 'BULLISH');
assert.equal(latest.votes.bullish, 4);
const metrics = walkForward(bars);
assert.equal(metrics.method, 'chronological_one-step_walk_forward');
assert.ok(metrics.testCases > 100);
assert.ok(metrics.directionalPredictions > 0);
assert.ok(metrics.accuracyPercent >= 0 && metrics.accuracyPercent <= 100);

const stale = buildTimeframeResult('EUR/USD', '15M', {
  candles: bars,
  meta: { freshness: 'STALE', ageSeconds: 5000, lastCandleAt: bars.at(-1).time }
});
assert.equal(stale.direction, 'BULLISH');
assert.equal(stale.state, 'STALE_SHADOW_ONLY');
assert.equal(stale.liveSignalEligible, false);
assert.equal(stale.probability, null);

const payloads = Object.fromEntries(TIMEFRAMES.map(tf => [tf, {
  candles: bars,
  meta: { freshness: 'FRESH', ageSeconds: 10, freshnessWindowSeconds: 1800, lastCandleAt: bars.at(-1).time }
}]));
const set = buildShadowForecast('EUR/USD', payloads, true);
assert.equal(set.mode, 'SHADOW_ONLY_UNCALIBRATED');
assert.equal(set.topDown.direction, 'BULLISH');
assert.equal(set.topDown.state, 'SHADOW_ONLY');
assert.equal(set.meta.liveSignalEligible, false);
assert.equal(set.meta.calibrated, false);
console.log('Shadow prediction engine tests passed.');
