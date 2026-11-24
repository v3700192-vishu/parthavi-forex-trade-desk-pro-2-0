'use strict';
const assert = require('node:assert/strict');
const { analyseDirection, walkForward, wilsonLowerBound, evaluateBarrierOutcome, summariseBarrierResearch } = require('../shadow-engine');

function makeTrendBars(count = 240, direction = 1) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const acceleratingMove = i * 0.0001 + i * i * 0.0000005;
    const close = direction > 0 ? 1.05 + acceleratingMove : 1.25 - acceleratingMove;
    const open = close - direction * 0.00004;
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

const research = walkForward([{ pair: 'EUR/USD', provider: 'SiftingIO', candles: up }]);
assert.equal(research.horizonBars, 3);
assert.deepEqual(research.providers, ['SiftingIO']);
assert.equal(research.byPair[0].provider, 'SiftingIO');
assert.ok(research.evaluated > 0 && research.evaluated < 200);
assert.ok(research.accuracy >= 0 && research.accuracy <= 1);
assert.ok(research.lower95 >= 0 && research.lower95 <= 1);
assert.equal(research.validated, false, 'one 240-bar sample must not clear the 200-sample gate');
assert.ok(research.limitations.some(item => item.includes('No calibrated probability is produced')));
assert.equal(wilsonLowerBound(0, 0), null);
assert.equal(wilsonLowerBound(10, 10) > 0.68, true);


const entry = { open: 1, high: 1.00002, low: 0.99998, close: 1 };
const futureBar = (open, high, low, close) => ({ open, high, low, close });
const targetFirst = evaluateBarrierOutcome(
  [entry, futureBar(1, 1.0003, 0.99995, 1.0002)], 0, 'BULLISH', 0.0001, 1
);
assert.equal(targetFirst.outcome, 'TARGET_FIRST');
assert.ok(targetFirst.mfeR <= 2.000001);

const stopFirst = evaluateBarrierOutcome(
  [entry, futureBar(1, 1.00005, 0.9998, 0.9999)], 0, 'BULLISH', 0.0001, 1
);
assert.equal(stopFirst.outcome, 'STOP_FIRST');
assert.ok(stopFirst.maeR <= 1.000001);

const ambiguous = evaluateBarrierOutcome(
  [entry, futureBar(1, 1.0003, 0.9998, 1.00005)], 0, 'BULLISH', 0.0001, 1
);
assert.equal(ambiguous.outcome, 'AMBIGUOUS_SAME_BAR');

const noTouch = evaluateBarrierOutcome(
  [entry, futureBar(1, 1.0001, 0.99995, 1.00005)], 0, 'BULLISH', 0.0001, 1
);
assert.equal(noTouch.outcome, 'NO_TOUCH');
assert.ok(Number.isFinite(noTouch.horizonCloseR));

const bearishTarget = evaluateBarrierOutcome(
  [entry, futureBar(1, 1.00005, 0.9997, 0.9998)], 0, 'BEARISH', 0.0001, 1
);
assert.equal(bearishTarget.outcome, 'TARGET_FIRST');
assert.equal(evaluateBarrierOutcome([entry], 0, 'BULLISH', 0.0001, 1), null);

assert.equal(research.barrierResearch.evaluated, research.evaluated);
assert.ok(research.barrierResearch.averageMfeR >= 0);
assert.ok(research.barrierResearch.averageMaeR >= 0);
assert.equal(research.validated, false, 'barrier outcomes do not establish calibrated probability');

const denominatorCheck = summariseBarrierResearch({
  evaluated: 10,
  targetFirst: 4,
  stopFirst: 3,
  ambiguousSameBar: 2,
  noTouch: 1,
  mfeRSum: 6,
  maeRSum: 5,
  excursionSamples: 10,
  noTouchCloseRSum: 0.25,
  noTouchCloseSamples: 1
});
assert.equal(denominatorCheck.barrierResolved, 7, 'ambiguous same-bar cases must not count as resolved');
assert.equal(denominatorCheck.targetFirstRateAmongResolved, 4 / 7);
assert.equal(denominatorCheck.targetFirstRateOfAll, 0.4);
assert.equal(denominatorCheck.ambiguousSameBar, 2);


console.log('Shadow engine direction, walk-forward, barrier, MFE/MAE and probability-gate tests passed.');
