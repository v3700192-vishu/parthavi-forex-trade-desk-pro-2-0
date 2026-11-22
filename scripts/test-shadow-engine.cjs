'use strict';
const assert = require('node:assert/strict');
const { analyseDirection, walkForward, wilsonLowerBound } = require('../shadow-engine');

function makeTrendBars(count = 240, direction = 1) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = 1.05 + direction * i * 0.0002 + Math.sin(i / 5) * 0.00001;
    const open = close - direction * 0.00002;
    bars.push({
      time: new Date(Date.UTC(2026, 0, 1) + i * 900000).toISOString(),
      timestamp: Date.UTC(2026, 0, 1) + i * 900000,
      open, high: Math.max(open, close) + 0.00005,
      low: Math.min(open, close) - 0.00004, close
    });
  }
  return bars;
}

const up = makeTrendBars(240, 1);
const down = makeTrendBars(240, -1);
assert.equal(analyseDirection(up).direction, 'BULLISH');
assert.equal(analyseDirection(down).direction, 'BEARISH');
assert.equal(analyseDirection(up.slice(0, 30)).direction, 'WAIT');

const research = walkForward([{ pair: 'EUR/USD', candles: up }]);
assert.equal(research.horizonBars, 3);
assert.ok(research.evaluated > 0 && research.evaluated < 200);
assert.ok(research.accuracy >= 0 && research.accuracy <= 1);
assert.ok(research.lower95 >= 0 && research.lower95 <= 1);
assert.equal(research.validated, false, 'one 240-bar sample must not clear the 200-sample gate');
assert.ok(research.limitations.some(item => item.includes('not a calibrated win probability')));
assert.equal(wilsonLowerBound(0, 0), null);
assert.equal(wilsonLowerBound(10, 10) > 0.68, true);

console.log('Shadow engine direction, horizon, walk-forward and gate tests passed.');
