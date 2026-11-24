'use strict';

const assert = require('node:assert/strict');
const {
  buildGlobalRiskContext,
  buildPairGlobalRiskContext,
  buildEconomicSurpriseContext,
  buildUsdNewsContext
} = require('../fundamental-context');

function series(rows) {
  return new Map(rows);
}
const now = Date.parse('2026-11-24T12:00:00.000Z');
const macro = buildGlobalRiskContext({
  DTWEXBGS: series([
    ['2026-11-17', 102.5], ['2026-11-18', 102.6], ['2026-11-19', 102.7],
    ['2026-11-20', 102.8], ['2026-11-23', 103.0]
  ]),
  DGS2: series([
    ['2026-11-17', 4.00], ['2026-11-18', 4.02], ['2026-11-19', 4.04],
    ['2026-11-20', 4.06], ['2026-11-23', 4.10]
  ]),
  DGS10: series([
    ['2026-11-17', 4.10], ['2026-11-18', 4.12], ['2026-11-19', 4.14],
    ['2026-11-20', 4.16], ['2026-11-23', 4.20]
  ]),
  VIXCLS: series([
    ['2026-11-17', 20], ['2026-11-18', 21], ['2026-11-19', 22],
    ['2026-11-20', 23], ['2026-11-23', 26]
  ]),
  DCOILWTICO: series([
    ['2026-11-17', 70], ['2026-11-18', 71], ['2026-11-19', 72],
    ['2026-11-20', 73], ['2026-11-23', 74]
  ])
}, now);

assert.equal(macro.status, 'FRESH');
assert.equal(macro.usdBias, 'BULLISH');
assert.equal(macro.riskRegime, 'RISK_OFF');
assert.equal(macro.sources.twoYearYield.changeOverFiveObservationsBasisPoints, 10);
assert.equal(buildPairGlobalRiskContext(macro, 'EUR/USD').usdPairBias, 'BEARISH');
assert.equal(buildPairGlobalRiskContext(macro, 'USD/JPY').usdPairBias, 'BULLISH');
assert.equal(buildPairGlobalRiskContext(macro, 'USD/JPY').riskRegime, 'RISK_OFF');

const staleMacro = buildGlobalRiskContext({
  DTWEXBGS: series([['2026-11-01', 100], ['2026-11-02', 101]]),
  DGS2: series([['2026-11-01', 4], ['2026-11-02', 4.1]])
}, now);
assert.equal(staleMacro.usdBias, 'MIXED');
assert.equal(staleMacro.usdScore, null);

const calendar = [
  {
    time: '2026-11-24T10:00:00.000Z', currency: 'USD', countryCode: 'US',
    name: 'US Nonfarm Payrolls', importance: 'high', actual: 180, forecast: 150, previous: 145
  },
  {
    time: '2026-11-24T09:00:00.000Z', currency: 'EUR', countryCode: 'EU',
    name: 'Euro Area CPI', importance: 'high', actual: 2.8, forecast: 2.5, previous: 2.4
  },
  {
    time: '2026-11-24T08:00:00.000Z', currency: 'USD', countryCode: 'US',
    name: 'US Unemployment Rate', importance: 'medium', actual: 4.0, forecast: 4.2, previous: 4.1
  },
  {
    time: '2026-11-25T10:00:00.000Z', currency: 'USD', countryCode: 'US',
    name: 'Future GDP', importance: 'high', actual: 4, forecast: 3, previous: 3
  },
  {
    time: '2026-11-24T06:00:00.000Z', currency: 'USD', countryCode: 'US',
    name: 'Unknown confidence survey', importance: 'high', actual: 100, forecast: 90, previous: 95
  }
];
const surprise = buildEconomicSurpriseContext(calendar, 'EUR/USD', now);
assert.equal(surprise.status, 'SCORED');
assert.equal(surprise.eventCount, 3);
assert.equal(surprise.availableCurrencies, 2);
assert.ok(Number.isFinite(surprise.score));
assert.equal(surprise.signalEligible, false);

const noSurprise = buildEconomicSurpriseContext(calendar.filter(item => item.actual === null), 'EUR/USD', now);
assert.equal(noSurprise.status, 'NO_VERIFIED_SURPRISES');
assert.equal(noSurprise.direction, 'MIXED');

const news = [
  {
    title: 'Fed signals hawkish policy and higher for longer rates',
    description: 'Rate policy outlook',
    publisher: 'Test source',
    publishedDate: '2026-11-24T11:00:00.000Z'
  },
  {
    title: 'US nonfarm payrolls beat forecasts',
    description: 'Stronger than expected jobs report',
    publisher: 'Test source',
    publishedDate: '2026-11-24T10:00:00.000Z'
  },
  {
    title: 'Fed may cut rates as inflation cools',
    description: 'Dovish policy expectations',
    publisher: 'Test source',
    publishedDate: '2026-11-24T09:00:00.000Z'
  }
];
const newsContext = buildUsdNewsContext(news, 'EUR/USD', now);
assert.equal(newsContext.matchedHeadlines, 3);
assert.equal(newsContext.usdBias, 'BULLISH');
assert.equal(newsContext.pairBias, 'BEARISH');
assert.equal(newsContext.signalEligible, false);

console.log('FRED macro context, pair sign, economic surprises and USD headline-screen tests passed.');
