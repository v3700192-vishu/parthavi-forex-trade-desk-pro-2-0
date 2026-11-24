/**
 * PARTHAVI FOREX SHADOW ENGINE
 * Deterministic technical research model; not an order or trade executor.
 * Forecast horizon: direction of the close three completed candles ahead.
 * No probability is emitted. Walk-forward labels use only candles after each
 * forecast timestamp; overlapping labels are avoided by stepping 3 candles.
 */
'use strict';

const MIN_HISTORY = 60;
const HORIZON_BARS = 3;
const MIN_VALIDATION_SAMPLES = 200;
const VALIDATED_ACCURACY_GATE = 0.68;

function finite(value) { return Number.isFinite(value); }

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return NaN;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change; else loss -= change;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function macdHistogram(values) {
  if (!Array.isArray(values) || values.length < 35) return NaN;
  const fast = [], slow = [];
  const emaSeries = (input, period) => {
    const k = 2 / (period + 1);
    let result = input[0];
    const output = [result];
    for (let i = 1; i < input.length; i++) {
      result = input[i] * k + result * (1 - k);
      output.push(result);
    }
    return output;
  };
  const f = emaSeries(values, 12), s = emaSeries(values, 26);
  for (let i = 0; i < values.length; i++) fast.push(f[i] - s[i]);
  slow.push(...emaSeries(fast, 9));
  return fast[fast.length - 1] - slow[slow.length - 1];
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return NaN;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const values = tr.slice(-period);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function adx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 2) return NaN;
  const tr = [], plus = [], minus = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  let smTr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlus = plus.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minus.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      smTr = smTr - smTr / period + tr[i];
      smPlus = smPlus - smPlus / period + plus[i];
      smMinus = smMinus - smMinus / period + minus[i];
    }
    const pdi = smTr > 0 ? 100 * smPlus / smTr : 0;
    const mdi = smTr > 0 ? 100 * smMinus / smTr : 0;
    dx.push(pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  if (dx.length < period) return NaN;
  let value = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) value = (value * (period - 1) + dx[i]) / period;
  return value;
}

function analyseDirection(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_HISTORY) {
    return { direction: 'WAIT', reason: 'INSUFFICIENT_HISTORY', votes: {} };
  }
  const closes = candles.map(c => Number(c.close));
  if (closes.some(v => !finite(v) || v <= 0)) {
    return { direction: 'WAIT', reason: 'INVALID_CANDLE_VALUES', votes: {} };
  }
  const last = closes[closes.length - 1];
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const momentum = rsi(closes, 14), histogram = macdHistogram(closes);
  const trendStrength = adx(candles, 14), volatility = atr(candles, 14);
  if (![e9, e21, e50, momentum, histogram, trendStrength, volatility].every(finite) || volatility <= 0) {
    return { direction: 'WAIT', reason: 'INDICATORS_NOT_READY', votes: {} };
  }

  const votes = {
    trend: last > e9 && e9 > e21 && e21 > e50 ? 'BULLISH'
      : last < e9 && e9 < e21 && e21 < e50 ? 'BEARISH' : 'NEUTRAL',
    momentum: momentum >= 52 ? 'BULLISH' : momentum <= 48 ? 'BEARISH' : 'NEUTRAL',
    macd: histogram > 0 ? 'BULLISH' : histogram < 0 ? 'BEARISH' : 'NEUTRAL',
    recentPrice: last > closes[closes.length - 5] ? 'BULLISH'
      : last < closes[closes.length - 5] ? 'BEARISH' : 'NEUTRAL'
  };
  const values = Object.values(votes);
  const bullish = values.filter(v => v === 'BULLISH').length;
  const bearish = values.filter(v => v === 'BEARISH').length;
  let direction = 'WAIT', reason = 'MIXED_OR_WEAK_VOTES';
  if (trendStrength < 18) reason = 'ADX_TREND_STRENGTH_BELOW_18';
  else if (bullish === 4) { direction = 'BULLISH'; reason = 'FOUR_OF_FOUR_DIRECTIONAL_VOTES'; }
  else if (bearish === 4) { direction = 'BEARISH'; reason = 'FOUR_OF_FOUR_DIRECTIONAL_VOTES'; }

  return {
    direction, reason, votes,
    metrics: {
      ema9: e9, ema21: e21, ema50: e50,
      rsi14: momentum, macdHistogram: histogram,
      adx14: trendStrength, atr14: volatility,
      bullishVotes: bullish, bearishVotes: bearish
    }
  };
}

function wilsonLowerBound(successes, total, z = 1.96) {
  if (!Number.isInteger(total) || total <= 0) return null;
  const p = successes / total, z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total)));
  return (centre - margin) / denominator;
}


function evaluateBarrierOutcome(candles, index, direction, atrValue,
  horizonBars = HORIZON_BARS, stopAtr = 1, targetAtr = 2) {
  if (!Array.isArray(candles) || !['BULLISH', 'BEARISH'].includes(direction) ||
      !Number.isInteger(index) || index < 0 ||
      !Number.isInteger(horizonBars) || horizonBars < 1 ||
      index + horizonBars >= candles.length ||
      !finite(Number(atrValue)) || Number(atrValue) <= 0 ||
      !finite(Number(stopAtr)) || Number(stopAtr) <= 0 ||
      !finite(Number(targetAtr)) || Number(targetAtr) <= 0) return null;

  const entry = Number(candles[index].close);
  const riskDistance = Number(atrValue) * Number(stopAtr);
  const targetDistance = Number(atrValue) * Number(targetAtr);
  if (!finite(entry) || entry <= 0 || !finite(riskDistance) || !finite(targetDistance)) return null;

  let mfeDistance = 0;
  let maeDistance = 0;
  let outcome = 'NO_TOUCH';
  let barsHeld = horizonBars;

  for (let step = 1; step <= horizonBars; step++) {
    const bar = candles[index + step];
    const open = Number(bar && bar.open);
    const high = Number(bar && bar.high);
    const low = Number(bar && bar.low);
    const close = Number(bar && bar.close);
    if (![open, high, low, close].every(finite) || open <= 0 ||
        high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;

    const favourable = direction === 'BULLISH'
      ? Math.max(0, high - entry)
      : Math.max(0, entry - low);
    const adverse = direction === 'BULLISH'
      ? Math.max(0, entry - low)
      : Math.max(0, high - entry);
    mfeDistance = Math.max(mfeDistance, favourable);
    maeDistance = Math.max(maeDistance, adverse);

    const targetHit = direction === 'BULLISH'
      ? high >= entry + targetDistance
      : low <= entry - targetDistance;
    const stopHit = direction === 'BULLISH'
      ? low <= entry - riskDistance
      : high >= entry + riskDistance;

    if (targetHit && stopHit) {
      outcome = 'AMBIGUOUS_SAME_BAR';
      barsHeld = step;
      mfeDistance = Math.min(mfeDistance, targetDistance);
      maeDistance = Math.min(maeDistance, riskDistance);
      break;
    }
    if (targetHit) {
      outcome = 'TARGET_FIRST';
      barsHeld = step;
      mfeDistance = Math.min(mfeDistance, targetDistance);
      break;
    }
    if (stopHit) {
      outcome = 'STOP_FIRST';
      barsHeld = step;
      maeDistance = Math.min(maeDistance, riskDistance);
      break;
    }
  }

  const finalClose = Number(candles[index + horizonBars].close);
  const horizonCloseR = outcome === 'NO_TOUCH' && finite(finalClose)
    ? (direction === 'BULLISH' ? finalClose - entry : entry - finalClose) / riskDistance
    : null;

  return {
    outcome,
    barsHeld,
    entry,
    stopAtr: Number(stopAtr),
    targetAtr: Number(targetAtr),
    mfeR: mfeDistance / riskDistance,
    maeR: maeDistance / riskDistance,
    horizonCloseR
  };
}

function summariseBarrierResearch(stats, horizonBars = HORIZON_BARS) {
  const resolved = stats.targetFirst + stats.stopFirst + stats.ambiguousSameBar;
  return {
    method: '14-bar mean true-range barrier simulation; 1x risk stop, 2x risk target; same-bar double touches are ambiguous',
    horizonBars,
    stopAtr: 1,
    targetAtr: 2,
    evaluated: stats.evaluated,
    targetFirst: stats.targetFirst,
    stopFirst: stats.stopFirst,
    ambiguousSameBar: stats.ambiguousSameBar,
    noTouch: stats.noTouch,
    barrierResolved: resolved,
    targetFirstRateAmongResolved: resolved ? stats.targetFirst / resolved : null,
    targetFirstRateOfAll: stats.evaluated ? stats.targetFirst / stats.evaluated : null,
    averageMfeR: stats.excursionSamples ? stats.mfeRSum / stats.excursionSamples : null,
    averageMaeR: stats.excursionSamples ? stats.maeRSum / stats.excursionSamples : null,
    averageNoTouchCloseR: stats.noTouchCloseSamples ? stats.noTouchCloseRSum / stats.noTouchCloseSamples : null
  };
}

function walkForward(datasets, horizonBars = HORIZON_BARS) {
  const effectiveHorizon = Number.isInteger(horizonBars) && horizonBars > 0 ? horizonBars : HORIZON_BARS;
  const byPair = [];
  const barrierTotals = {
    evaluated: 0, targetFirst: 0, stopFirst: 0, ambiguousSameBar: 0, noTouch: 0,
    mfeRSum: 0, maeRSum: 0, excursionSamples: 0,
    noTouchCloseRSum: 0, noTouchCloseSamples: 0
  };
  let evaluated = 0, correct = 0, bullish = 0, bearish = 0;
  let actualBullish = 0, actualBearish = 0, trueBullish = 0, trueBearish = 0;
  let firstForecastAt = null, lastForecastAt = null;

  for (const dataset of datasets) {
    const candles = Array.isArray(dataset.candles) ? dataset.candles : [];
    let pairEvaluated = 0, pairCorrect = 0, pairBullish = 0, pairBearish = 0;
    const pairBarrier = {
      evaluated: 0, targetFirst: 0, stopFirst: 0, ambiguousSameBar: 0, noTouch: 0,
      mfeRSum: 0, maeRSum: 0, excursionSamples: 0,
      noTouchCloseRSum: 0, noTouchCloseSamples: 0
    };

    for (let i = MIN_HISTORY - 1; i + effectiveHorizon < candles.length; i += effectiveHorizon) {
      const sample = candles.slice(0, i + 1);
      const prediction = analyseDirection(sample);
      if (!['BULLISH', 'BEARISH'].includes(prediction.direction)) continue;
      const start = Number(candles[i].close), end = Number(candles[i + effectiveHorizon].close);
      if (!finite(start) || !finite(end) || end === start) continue;

      const actual = end > start ? 'BULLISH' : 'BEARISH';
      const isCorrect = actual === prediction.direction;
      pairEvaluated++; evaluated++;
      if (isCorrect) { pairCorrect++; correct++; }
      if (actual === 'BULLISH') actualBullish++; else actualBearish++;
      if (prediction.direction === 'BULLISH') {
        pairBullish++; bullish++;
        if (actual === 'BULLISH') trueBullish++;
      } else {
        pairBearish++; bearish++;
        if (actual === 'BEARISH') trueBearish++;
      }

      const barrier = evaluateBarrierOutcome(
        candles, i, prediction.direction,
        prediction.metrics && prediction.metrics.atr14,
        effectiveHorizon, 1, 2
      );
      if (barrier) {
        for (const target of [barrierTotals, pairBarrier]) {
          target.evaluated++;
          if (barrier.outcome === 'TARGET_FIRST') target.targetFirst++;
          else if (barrier.outcome === 'STOP_FIRST') target.stopFirst++;
          else if (barrier.outcome === 'AMBIGUOUS_SAME_BAR') target.ambiguousSameBar++;
          else target.noTouch++;
          target.mfeRSum += barrier.mfeR;
          target.maeRSum += barrier.maeR;
          target.excursionSamples++;
          if (barrier.horizonCloseR !== null) {
            target.noTouchCloseRSum += barrier.horizonCloseR;
            target.noTouchCloseSamples++;
          }
        }
      }

      const stamp = candles[i].time || new Date(candles[i].timestamp).toISOString();
      if (!firstForecastAt || stamp < firstForecastAt) firstForecastAt = stamp;
      if (!lastForecastAt || stamp > lastForecastAt) lastForecastAt = stamp;
    }

    byPair.push({
      pair: dataset.pair,
      evaluated: pairEvaluated,
      correct: pairCorrect,
      accuracy: pairEvaluated ? pairCorrect / pairEvaluated : null,
      bullish: pairBullish,
      bearish: pairBearish,
      barrierResearch: summariseBarrierResearch(pairBarrier, effectiveHorizon)
    });
  }

  const accuracy = evaluated ? correct / evaluated : null;
  const lower95 = wilsonLowerBound(correct, evaluated);
  const bullishRecall = actualBullish ? trueBullish / actualBullish : null;
  const bearishRecall = actualBearish ? trueBearish / actualBearish : null;
  const balancedAccuracy = bullishRecall !== null && bearishRecall !== null
    ? (bullishRecall + bearishRecall) / 2 : null;
  const majorityClassBaseline = evaluated
    ? Math.max(actualBullish, actualBearish) / evaluated : null;
  const accuracyScreenPassed = evaluated >= MIN_VALIDATION_SAMPLES &&
    accuracy !== null && accuracy >= VALIDATED_ACCURACY_GATE;

  return {
    method: 'fixed-rule chronological walk-forward; no look-ahead in features',
    target: 'direction of close after next ' + effectiveHorizon + ' completed candles',
    horizonBars: effectiveHorizon,
    evaluated, correct, incorrect: evaluated - correct,
    bullish, bearish, actualBullish, actualBearish,
    bullishRecall, bearishRecall, balancedAccuracy, majorityClassBaseline,
    accuracy, lower95,
    firstForecastAt, lastForecastAt,
    minimumSamples: MIN_VALIDATION_SAMPLES,
    accuracyScreen: VALIDATED_ACCURACY_GATE,
    accuracyScreenPassed,
    probabilityGate: 0.68,
    probabilityCalibrated: false,
    validated: false,
    status: evaluated < MIN_VALIDATION_SAMPLES ? 'INSUFFICIENT_SAMPLE'
      : accuracyScreenPassed ? 'ACCURACY_SCREEN_ONLY_CALIBRATION_MISSING'
      : 'ACCURACY_SCREEN_NOT_PASSED',
    lower95Interpretation: 'Nominal Wilson bound only; pooled FX pairs and serial observations are correlated, so IID confidence assumptions are not established.',
    barrierResearch: summariseBarrierResearch(barrierTotals, effectiveHorizon),
    byPair,
    limitations: [
      'Single indicative provider only',
      'Pooled FX pairs and time-series observations are correlated; pooled confidence bounds are descriptive only',
      'Barrier distances use the mean of the last 14 true ranges: 1x risk stop and 2x risk target over the forecast horizon',
      'Both barriers touched in one OHLC candle are marked ambiguous and never counted as target wins',
      'MFE/MAE are measured in initial risk units until the first barrier or horizon end',
      'No transaction costs, spread, slippage, financing or broker execution simulation',
      'No calibrated probability is produced; the 68% probability gate remains unavailable',
      'Not a live trade signal'
    ]
  };
}

module.exports = { analyseDirection, walkForward, wilsonLowerBound, evaluateBarrierOutcome };
