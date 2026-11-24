'use strict';

const COUNTRY_CURRENCY = Object.freeze({
  US: 'USD', USA: 'USD', USD: 'USD',
  EU: 'EUR', EZ: 'EUR', EUR: 'EUR',
  GB: 'GBP', UK: 'GBP', GBP: 'GBP',
  JP: 'JPY', JPN: 'JPY', JPY: 'JPY',
  CH: 'CHF', CHE: 'CHF', CHF: 'CHF',
  AU: 'AUD', AUS: 'AUD', AUD: 'AUD',
  NZ: 'NZD', NZL: 'NZD', NZD: 'NZD',
  CA: 'CAD', CAN: 'CAD', CAD: 'CAD'
});

const USD_PAIR_EXPOSURE = Object.freeze({
  'EUR/USD': -1, 'GBP/USD': -1, 'AUD/USD': -1, 'NZD/USD': -1,
  'USD/JPY': 1, 'USD/CHF': 1, 'USD/CAD': 1
});

const CURRENCY_EVENT_RULES = [
  { pattern: /unemployment rate|jobless claims|initial claims|continuing claims|claimant count/i, polarity: -1, category: 'LABOUR_WEAKNESS' },
  { pattern: /consumer price|core cpi|cpi|pce|inflation/i, polarity: 1, category: 'INFLATION_HAWKISH_CHANNEL' },
  { pattern: /interest rate|policy rate|fed funds rate|cash rate|refinancing rate/i, polarity: 1, category: 'POLICY_RATE' },
  { pattern: /non[- ]?farm|payroll|employment change|employment report|average hourly earnings|wage growth|gdp|pmi|retail sales|industrial production/i, polarity: 1, category: 'GROWTH_OR_LABOUR_STRENGTH' }
];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
function round(value, places = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}
function parseTime(value) {
  const stamp = Date.parse(String(value || ''));
  return Number.isFinite(stamp) ? stamp : null;
}
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function normaliseCurrency(value, countryCode) {
  const direct = String(value || '').trim().toUpperCase();
  if (COUNTRY_CURRENCY[direct]) return COUNTRY_CURRENCY[direct];
  const country = String(countryCode || '').trim().toUpperCase();
  return COUNTRY_CURRENCY[country] || null;
}
function latestSeriesSummary(series, maxAgeDays, nowMs) {
  const entries = series instanceof Map ? [...series.entries()] : Object.entries(series || {});
  const sorted = entries.map(([date, value]) => ({ date: String(date).slice(0, 10), value: finite(value) }))
    .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number.isFinite(item.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return { status: 'UNAVAILABLE', observations: 0, latest: null, reference: null };
  const latest = sorted[sorted.length - 1];
  const reference = sorted[Math.max(0, sorted.length - 6)];
  const ageDays = Math.max(0, Math.floor((nowMs - Date.parse(latest.date + 'T00:00:00.000Z')) / 86400000));
  return {
    status: ageDays <= maxAgeDays ? 'FRESH' : 'STALE',
    observations: sorted.length,
    latestDate: latest.date,
    latest: latest.value,
    referenceDate: reference.date,
    reference: reference.value,
    ageDays,
    change: latest.value - reference.value,
    changePercent: reference.value !== 0 ? ((latest.value / reference.value) - 1) * 100 : null
  };
}

function buildGlobalRiskContext(seriesById, now = Date.now()) {
  const series = seriesById && typeof seriesById === 'object' ? seriesById : {};
  const broadUsd = latestSeriesSummary(series.DTWEXBGS, 10, now);
  const twoYear = latestSeriesSummary(series.DGS2, 5, now);
  const tenYear = latestSeriesSummary(series.DGS10, 5, now);
  const vix = latestSeriesSummary(series.VIXCLS, 5, now);
  const oil = latestSeriesSummary(series.DCOILWTICO, 5, now);

  const usdInputsFresh = broadUsd.status === 'FRESH' && twoYear.status === 'FRESH';
  let usdScore = null, usdBias = 'MIXED';
  if (usdInputsFresh && Number.isFinite(broadUsd.changePercent) && Number.isFinite(twoYear.change)) {
    const dollarMomentum = clamp(broadUsd.changePercent / 0.25, -1, 1);
    const yieldMomentum = clamp((twoYear.change * 100) / 8, -1, 1);
    usdScore = round((0.65 * dollarMomentum) + (0.35 * yieldMomentum));
    if (usdScore >= 0.3) usdBias = 'BULLISH';
    else if (usdScore <= -0.3) usdBias = 'BEARISH';
  }

  let riskRegime = 'UNAVAILABLE';
  if (vix.status === 'FRESH' && Number.isFinite(vix.latest)) {
    if (vix.latest >= 25 || (Number.isFinite(vix.changePercent) && vix.changePercent >= 15)) {
      riskRegime = 'RISK_OFF';
    } else if (vix.latest < 20 && Number.isFinite(vix.changePercent) && vix.changePercent <= -10) {
      riskRegime = 'RISK_ON';
    } else {
      riskRegime = 'MIXED';
    }
  }

  const availableSeries = [broadUsd, twoYear, tenYear, vix, oil]
    .filter(item => item.status === 'FRESH').length;
  return {
    ok: true,
    provider: 'Federal Reserve Economic Data (FRED) public CSV download',
    status: availableSeries === 5 ? 'FRESH' : availableSeries ? 'PARTIAL' : 'UNAVAILABLE',
    availableSeries,
    expectedSeries: 5,
    usdBias,
    usdScore,
    riskRegime,
    sources: {
      broadUsdIndex: {
        seriesId: 'DTWEXBGS',
        name: 'Trade Weighted U.S. Dollar Index: Broad, Goods and Services',
        ...broadUsd,
        changeOverFiveObservationsPercent: round(broadUsd.changePercent, 3)
      },
      twoYearYield: {
        seriesId: 'DGS2',
        name: '2-Year Treasury Constant Maturity Rate',
        ...twoYear,
        changeOverFiveObservationsBasisPoints: round(twoYear.change * 100, 1)
      },
      tenYearYield: {
        seriesId: 'DGS10',
        name: '10-Year Treasury Constant Maturity Rate',
        ...tenYear,
        changeOverFiveObservationsBasisPoints: round(tenYear.change * 100, 1)
      },
      volatilityIndex: {
        seriesId: 'VIXCLS',
        name: 'CBOE Volatility Index',
        ...vix,
        changeOverFiveObservationsPercent: round(vix.changePercent, 2)
      },
      crudeOil: {
        seriesId: 'DCOILWTICO',
        name: 'WTI Crude Oil Spot Price',
        ...oil,
        changeOverFiveObservationsPercent: round(oil.changePercent, 2)
      }
    },
    methodology: {
      usdBias: 'Context score combines broad USD-index momentum and 2-year Treasury-yield momentum; this is a heuristic macro context, not a calibrated forecast.',
      riskRegime: 'VIX level and recent percentage change classify broad risk regime; it is not a direct FX order-flow measure.',
      horizon: 'Daily macro observations, suitable as higher-timeframe context rather than a 5-minute trigger.'
    },
    signalEligible: false,
    fetchedAt: new Date(now).toISOString()
  };
}

function buildPairGlobalRiskContext(context, pair) {
  const exposure = USD_PAIR_EXPOSURE[pair];
  if (!exposure || !context) return { pair, status: 'UNAVAILABLE', usdPairBias: 'MIXED', riskRegime: 'UNAVAILABLE' };
  const usdBias = context.usdBias || 'MIXED';
  let usdPairBias = 'MIXED';
  if (usdBias === 'BULLISH') usdPairBias = exposure === 1 ? 'BULLISH' : 'BEARISH';
  else if (usdBias === 'BEARISH') usdPairBias = exposure === 1 ? 'BEARISH' : 'BULLISH';
  return {
    pair,
    status: context.status || 'UNAVAILABLE',
    usdBias,
    usdPairBias,
    usdScore: context.usdScore,
    riskRegime: context.riskRegime || 'UNAVAILABLE',
    riskSensitiveNonUsdLeg: ['AUD/USD', 'NZD/USD', 'USD/CAD'].includes(pair),
    signalEligible: false,
    interpretation: 'Broad USD and global-risk context only; not a pair-specific calibrated forecast.'
  };
}

function eventRule(name) {
  const text = String(name || '');
  return CURRENCY_EVENT_RULES.find(rule => rule.pattern.test(text)) || null;
}
function eventWeight(importance) {
  const value = String(importance || '').toLowerCase();
  if (value === 'high') return 1;
  if (value === 'medium') return 0.65;
  if (value === 'low') return 0.3;
  return 0;
}
function biasFromScore(score, threshold = 0.12) {
  if (!Number.isFinite(score)) return 'MIXED';
  if (score >= threshold) return 'BULLISH';
  if (score <= -threshold) return 'BEARISH';
  return 'MIXED';
}

function buildEconomicSurpriseContext(items, pair, now = Date.now()) {
  const pairParts = String(pair || '').split('/');
  if (pairParts.length !== 2) return { status: 'UNAVAILABLE', direction: 'MIXED', signalEligible: false };
  const accumulators = new Map();
  const scoredEvents = [];
  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    const time = parseTime(item && item.time);
    if (time === null || time > now) continue;
    const ageHours = (now - time) / 3600000;
    if (ageHours > 72) continue;
    const currency = normaliseCurrency(item.currency, item.countryCode);
    const rule = eventRule(item && item.name);
    const weight = eventWeight(item && item.importance);
    const actual = finite(item && item.actual);
    const forecast = finite(item && item.forecast);
    if (!currency || !rule || !weight || actual === null || forecast === null || actual === forecast) continue;

    const delta = actual - forecast;
    const previous = finite(item.previous);
    const denominator = Math.max(Math.abs(forecast), Number.isFinite(previous) ? Math.abs(previous) * 0.25 : 0, 1);
    const relativeSurprise = delta / denominator;
    const magnitude = clamp(Math.abs(relativeSurprise) * 3, 0.05, 1);
    const decay = Math.exp(-ageHours / 36);
    const score = Math.sign(delta) * rule.polarity * magnitude;
    const weightedScore = score * weight * decay;
    if (!accumulators.has(currency)) accumulators.set(currency, { sum: 0, weight: 0, count: 0 });
    const bucket = accumulators.get(currency);
    bucket.sum += weightedScore;
    bucket.weight += weight * decay;
    bucket.count += 1;
    scoredEvents.push({
      currency,
      name: String(item.name || '').slice(0, 160),
      time: new Date(time).toISOString(),
      importance: String(item.importance || 'unknown'),
      category: rule.category,
      actual,
      forecast,
      relativeSurprise: round(relativeSurprise, 4),
      score: round(weightedScore, 4),
      ageHours: round(ageHours, 1)
    });
  }

  const currencyScores = {};
  for (const currency of new Set(pairParts)) {
    const bucket = accumulators.get(currency);
    const score = bucket && bucket.weight > 0 ? bucket.sum / bucket.weight : null;
    currencyScores[currency] = {
      score: round(score, 3),
      bias: biasFromScore(score),
      eventCount: bucket ? bucket.count : 0
    };
  }
  const baseScore = currencyScores[pairParts[0]] && currencyScores[pairParts[0]].score;
  const quoteScore = currencyScores[pairParts[1]] && currencyScores[pairParts[1]].score;
  const pairScore = Number.isFinite(baseScore) || Number.isFinite(quoteScore)
    ? (Number.isFinite(baseScore) ? baseScore : 0) - (Number.isFinite(quoteScore) ? quoteScore : 0)
    : null;
  const availableCurrencies = pairParts.filter(currency =>
    currencyScores[currency] && Number.isFinite(currencyScores[currency].score)
  ).length;
  const sortedEvents = scoredEvents.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 12);
  return {
    pair,
    status: scoredEvents.length ? 'SCORED' : 'NO_VERIFIED_SURPRISES',
    direction: biasFromScore(pairScore),
    score: round(pairScore, 3),
    currencyScores,
    availableCurrencies,
    eventCount: scoredEvents.length,
    latestEventAt: sortedEvents[0] ? sortedEvents[0].time : null,
    events: sortedEvents,
    windowHours: 72,
    signalEligible: false,
    disclaimer: 'Rule-based actual-versus-forecast surprise context only. Inflation surprises use a hawkish-expectations channel; market reaction can differ when growth or risk effects dominate. This score is not calibrated and is not a trade signal.'
  };
}

const USD_NEWS_POSITIVE = [
  /fed.{0,35}(hawkish|rate hike|higher for longer|tighten)/i,
  /(hawkish|rate hike|higher for longer|tighten).{0,35}fed/i,
  /(cpi|pce|inflation).{0,45}(hotter|above estimates|beats forecasts|accelerat)/i,
  /(non[- ]?farm|payroll|jobs?).{0,45}(beat|stronger|above estimates|surge)/i,
  /treasury yields?.{0,30}(rise|surge|jump|higher)/i
];
const USD_NEWS_NEGATIVE = [
  /fed.{0,35}(dovish|rate cut|cut rates|cuts rates|easing)/i,
  /(dovish|rate cut|cuts rates|easing).{0,35}fed/i,
  /(cpi|pce|inflation).{0,45}(cooler|cools|below estimates|misses forecasts|slows)/i,
  /(non[- ]?farm|payroll|jobs?).{0,45}(miss|weaker|below estimates|fall)/i,
  /treasury yields?.{0,30}(fall|drop|slide|lower)/i
];

function buildUsdNewsContext(items, pair, now = Date.now()) {
  const pairSign = USD_PAIR_EXPOSURE[pair];
  if (pairSign === undefined) return { pair, status: 'UNAVAILABLE', bias: 'MIXED', signalEligible: false };
  const classified = [];
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const published = parseTime(item && item.publishedDate);
    if (published === null || published > now) continue;
    const ageHours = (now - published) / 3600000;
    if (ageHours > 72) continue;
    const text = String((item && item.title) || '') + ' ' + String((item && item.description) || '');
    const positive = USD_NEWS_POSITIVE.some(pattern => pattern.test(text));
    const negative = USD_NEWS_NEGATIVE.some(pattern => pattern.test(text));
    if (positive === negative) continue;
    classified.push({
      title: String(item.title || '').slice(0, 220),
      publisher: String(item.publisher || 'Unknown').slice(0, 80),
      publishedDate: new Date(published).toISOString(),
      usdBias: positive ? 'BULLISH' : 'BEARISH',
      ageHours: round(ageHours, 1)
    });
  }
  const positiveCount = classified.filter(item => item.usdBias === 'BULLISH').length;
  const negativeCount = classified.filter(item => item.usdBias === 'BEARISH').length;
  let usdBias = 'MIXED';
  if (positiveCount > negativeCount) usdBias = 'BULLISH';
  else if (negativeCount > positiveCount) usdBias = 'BEARISH';
  const pairBias = usdBias === 'MIXED' ? 'MIXED' :
    (pairSign === 1 ? usdBias : (usdBias === 'BULLISH' ? 'BEARISH' : 'BULLISH'));
  return {
    pair,
    status: classified.length ? 'RULE_MATCHES_FOUND' : 'NO_EXPLICIT_MACRO_MATCH',
    usdBias,
    pairBias,
    positiveHeadlines: positiveCount,
    negativeHeadlines: negativeCount,
    matchedHeadlines: classified.length,
    headlines: classified.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate)).slice(0, 8),
    signalEligible: false,
    disclaimer: 'Low-confidence keyword screening of a limited US headline feed. It is displayed for research context only and is not used as a trade vote.'
  };
}

function buildFundamentalContext({ globalRisk, calendarItems, newsItems, pair, now = Date.now() }) {
  return {
    pair,
    globalRisk: buildPairGlobalRiskContext(globalRisk, pair),
    economicSurprises: buildEconomicSurpriseContext(calendarItems, pair, now),
    usdNews: buildUsdNewsContext(newsItems, pair, now),
    decisionRole: 'RESEARCH_CONTEXT_ONLY',
    disclaimer: 'Macro, event-surprise and headline context is not calibrated and does not independently produce a trade signal.'
  };
}

module.exports = {
  latestSeriesSummary,
  buildGlobalRiskContext,
  buildPairGlobalRiskContext,
  buildEconomicSurpriseContext,
  buildUsdNewsContext,
  buildFundamentalContext
};
