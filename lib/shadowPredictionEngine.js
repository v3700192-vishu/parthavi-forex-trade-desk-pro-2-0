'use strict';

/*
 * PARTHAVI FOREX — Shadow Prediction Engine v1
 * Deterministic indicator rule baseline for walk-forward research only.
 * It emits no probability and can never authorize a trade.
 */

const REQUIRED_BARS = 60;
const TIMEFRAMES = ['5M', '15M', '30M', '1H', '4H'];

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return NaN;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (let i = period; i < values.length; i++) value += alpha * (values[i] - value);
  return value;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return NaN;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const averageGain = gains / period;
  const averageLoss = losses / period;
  if (averageLoss === 0) return averageGain > 0 ? 100 : 50;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return NaN;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i], previous = candles[i - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  const sample = ranges.slice(-period);
  return sample.length ? sample.reduce((sum, n) => sum + n, 0) / sample.length : NaN;
}

function macdHistogram(values) {
  if (!Array.isArray(values) || values.length < 35) return NaN;
  const line = [];
  for (let i = 0; i < values.length; i++) {
    const partial = values.slice(0, i + 1);
    const fast = ema(partial, 12), slow = ema(partial, 26);
    line.push(Number.isFinite(fast) && Number.isFinite(slow) ? fast - slow : NaN);
  }
  const valid = line.filter(Number.isFinite);
  if (valid.length < 9) return NaN;
  const signal = ema(valid, 9);
  return valid[valid.length - 1] - signal;
}

function priceActionVote(candles) {
  if (candles.length < 30) return 'NEUTRAL';
  const prior = candles.slice(-21, -11);
  const recent = candles.slice(-10);
  const priorHigh = Math.max(...prior.map(c => c.high));
  const recentHigh = Math.max(...recent.map(c => c.high));
  const priorLow = Math.min(...prior.map(c => c.low));
  const recentLow = Math.min(...recent.map(c => c.low));
  if (recentHigh > priorHigh && recentLow > priorLow) return 'BULLISH';
  if (recentHigh < priorHigh && recentLow < priorLow) return 'BEARISH';
  return 'NEUTRAL';
}

function assess(candles) {
  if (!Array.isArray(candles) || candles.length < REQUIRED_BARS) {
    return { direction: 'WAIT', votes: { bullish: 0, bearish: 0, neutral: 4 }, reasons: ['insufficient_history'] };
  }
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const momentum = rsi(closes, 14);
  const histogram = macdHistogram(closes);
  const trend = last > e9 && e9 > e21 && e21 > e50 ? 'BULLISH'
    : last < e9 && e9 < e21 && e21 < e50 ? 'BEARISH' : 'NEUTRAL';
  const momentumVote = momentum >= 55 ? 'BULLISH' : momentum <= 45 ? 'BEARISH' : 'NEUTRAL';
  const macdVote = histogram > 0 ? 'BULLISH' : histogram < 0 ? 'BEARISH' : 'NEUTRAL';
  const structure = priceActionVote(candles);
  const votes = [trend, momentumVote, macdVote, structure];
  const bullish = votes.filter(v => v === 'BULLISH').length;
  const bearish = votes.filter(v => v === 'BEARISH').length;
  let direction = 'WAIT';
  if (bullish >= 3 && bearish === 0) direction = 'BULLISH';
  if (bearish >= 3 && bullish === 0) direction = 'BEARISH';
  return {
    direction,
    votes: { bullish, bearish, neutral: 4 - bullish - bearish },
    components: { trend, momentum: momentumVote, macd: macdVote, priceAction: structure },
    reasons: direction === 'WAIT' ? ['votes_mixed_or_below_3_of_4'] : ['three_or_more_rules_aligned'],
    raw: {
      rsi: Number.isFinite(momentum) ? Number(momentum.toFixed(2)) : null,
      macdHistogram: Number.isFinite(histogram) ? Number(histogram.toPrecision(7)) : null,
      ema9: Number.isFinite(e9) ? e9 : null,
      ema21: Number.isFinite(e21) ? e21 : null,
      ema50: Number.isFinite(e50) ? e50 : null
    }
  };
}

function outcomeFor(current, next, volatility) {
  const change = next.close - current.close;
  const deadband = Number.isFinite(volatility) && volatility > 0 ? volatility * 0.1 : 0;
  if (change > deadband) return 'BULLISH';
  if (change < -deadband) return 'BEARISH';
  return 'FLAT';
}

function walkForward(candles) {
  const totalBars = Math.max(0, candles.length - REQUIRED_BARS - 1);
  let predictions = 0, correct = 0, neutralOutcomes = 0;
  let bullishPredictions = 0, bearishPredictions = 0;
  let bullishCorrect = 0, bearishCorrect = 0;
  let totalEvaluated = 0;

  for (let i = REQUIRED_BARS - 1; i < candles.length - 1; i++) {
    const history = candles.slice(0, i + 1);
    const assessment = assess(history);
    totalEvaluated++;
    if (assessment.direction === 'WAIT') continue;
    predictions++;
    if (assessment.direction === 'BULLISH') bullishPredictions++;
    if (assessment.direction === 'BEARISH') bearishPredictions++;
    const actual = outcomeFor(candles[i], candles[i + 1], atr(history, 14));
    if (actual === 'FLAT') {
      neutralOutcomes++;
      continue;
    }
    if (actual === assessment.direction) {
      correct++;
      if (actual === 'BULLISH') bullishCorrect++;
      if (actual === 'BEARISH') bearishCorrect++;
    }
  }

  const scored = predictions - neutralOutcomes;
  const accuracy = scored ? correct / scored : null;
  return {
    method: 'chronological_one-step_walk_forward',
    target: 'next_closed_candle_direction_after_0.1_ATR_deadband',
    historyBars: candles.length,
    testCases: totalEvaluated,
    directionalPredictions: predictions,
    scoredPredictions: scored,
    flatOutcomesExcluded: neutralOutcomes,
    correct,
    accuracyPercent: accuracy === null ? null : Number((accuracy * 100).toFixed(2)),
    coveragePercent: totalEvaluated ? Number((predictions / totalEvaluated * 100).toFixed(2)) : 0,
    bullish: {
      predictions: bullishPredictions,
      precisionPercent: bullishPredictions ? Number((bullishCorrect / bullishPredictions * 100).toFixed(2)) : null
    },
    bearish: {
      predictions: bearishPredictions,
      precisionPercent: bearishPredictions ? Number((bearishCorrect / bearishPredictions * 100).toFixed(2)) : null
    },
    sampleState: scored >= 100 ? 'RESEARCH_SAMPLE_ONLY' : 'SMALL_SAMPLE'
  };
}

function normaliseCandles(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(c => c && [c.open, c.high, c.low, c.close].every(v => Number.isFinite(Number(v))) &&
    Number(c.open) > 0 && Number(c.high) >= Math.max(Number(c.open), Number(c.close), Number(c.low)) &&
    Number(c.low) <= Math.min(Number(c.open), Number(c.close), Number(c.high)))
    .map(c => ({ ...c, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .sort((a, b) => {
      const at = Number.isFinite(Number(a.timestamp)) ? Number(a.timestamp) : Date.parse(a.time);
      const bt = Number.isFinite(Number(b.timestamp)) ? Number(b.timestamp) : Date.parse(b.time);
      return at - bt;
    });
}

function buildTimeframeResult(pair, timeframe, candlePayload) {
  const candles = normaliseCandles(candlePayload && candlePayload.candles);
  const meta = candlePayload && candlePayload.meta || {};
  const latest = candles[candles.length - 1] || null;
  const assessment = assess(candles);
  const tested = walkForward(candles);
  const isFresh = meta.freshness === 'FRESH' && Number(meta.ageSeconds) <= Number(meta.freshnessWindowSeconds || Infinity);
  return {
    pair,
    timeframe,
    direction: assessment.direction,
    state: assessment.direction === 'WAIT' ? 'WAIT' : isFresh ? 'SHADOW_ONLY' : 'STALE_SHADOW_ONLY',
    votes: assessment.votes,
    components: assessment.components || null,
    reasons: assessment.reasons,
    lastCandleAt: meta.lastCandleAt || latest && (latest.time || latest.timestamp) || null,
    ageSeconds: Number.isFinite(Number(meta.ageSeconds)) ? Number(meta.ageSeconds) : null,
    freshness: isFresh ? 'FRESH' : 'STALE',
    walkForward: tested,
    raw: assessment.raw || null,
    probability: null,
    liveSignalEligible: false
  };
}

function buildShadowForecast(pair, candlePayloads, quoteFresh = false) {
  const byTimeframe = {};
  for (const timeframe of TIMEFRAMES) {
    byTimeframe[timeframe] = buildTimeframeResult(pair, timeframe, candlePayloads && candlePayloads[timeframe]);
  }
  const sides = TIMEFRAMES.map(tf => byTimeframe[tf].direction);
  const allFresh = TIMEFRAMES.every(tf => byTimeframe[tf].freshness === 'FRESH');
  const aligned = ['BULLISH', 'BEARISH'].includes(sides[0]) && sides.every(side => side === sides[0]);
  return {
    ok: true,
    engine: 'PARTHAVI_SHADOW_RULE_BASELINE_V1',
    mode: 'SHADOW_ONLY_UNCALIBRATED',
    pair,
    timeframes: byTimeframe,
    topDown: {
      direction: aligned ? sides[0] : 'WAIT',
      state: aligned && allFresh && quoteFresh ? 'SHADOW_ONLY' : 'WAIT',
      aligned,
      allTimeframesFresh: allFresh,
      quoteFresh: Boolean(quoteFresh)
    },
    meta: {
      probabilityAvailable: false,
      calibrated: false,
      liveSignalEligible: false,
      tradeExecutionEnabled: false,
      disclaimer: 'Research baseline only. Walk-forward accuracy is not a probability estimate. One indicative provider, no independent executable-price confirmation, and no calibrated model; do not trade from this output.'
    }
  };
}

module.exports = { TIMEFRAMES, REQUIRED_BARS, assess, walkForward, buildTimeframeResult, buildShadowForecast };
