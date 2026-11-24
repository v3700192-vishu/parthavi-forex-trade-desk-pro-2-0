'use strict';

const assert = require('node:assert/strict');
const {
  parseCsv,
  parseBISPolicyCsv,
  buildCurrencyPolicyRate,
  buildBISPolicyContext,
  buildPolicyRatePairContext
} = require('../central-bank-policy');

const sample = [
  'FREQ,REF_AREA,UNIT_MEASURE,UNIT_MULT,TIME_FORMAT,COMPILATION,DECIMALS,SOURCE_REF,SUPP_INFO_BREAKS,TITLE,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK',
  'D,US,368,0,,Policy "mid-point" rate.,4,US Federal Reserve System,,Central bank policy rates - United States - Daily - End of period,2026-11-16,3.875,A,F,',
  'D,US,368,0,,Policy "mid-point" rate.,4,US Federal Reserve System,,Central bank policy rates - United States - Daily - End of period,2026-11-17,3.875,A,F,',
  'D,US,368,0,,Policy "mid-point" rate.,4,US Federal Reserve System,,Central bank policy rates - United States - Daily - End of period,2026-11-18,4.000,A,F,',
  'D,US,368,0,,Policy "mid-point" rate.,4,US Federal Reserve System,,Central bank policy rates - United States - Daily - End of period,2026-11-19,4.000,A,F,',
  'M,US,368,0,,Monthly rate,4,US Federal Reserve System,,Monthly,2026-11,4.000,A,F,',
  'D,US,999,0,,Wrong unit,4,US Federal Reserve System,,Wrong unit,2026-11-19,4.000,A,F,',
  'D,GB,368,0,,Wrong area,4,Bank of England,,UK policy rate,2026-11-19,4.000,A,F,',
  'D,US,368,0,,Missing,4,US Federal Reserve System,,US policy rate,2026-11-20,NA,A,F,'
].join('\n');

const parsedCsv = parseCsv('a,b,c\n1,"text, with comma","quoted ""value"""\n');
assert.deepEqual(parsedCsv, [['a', 'b', 'c'], ['1', 'text, with comma', 'quoted "value"']]);
const parsedRates = parseBISPolicyCsv(sample, 'US');
assert.equal(parsedRates.length, 4);
assert.equal(parsedRates[0].title, 'Central bank policy rates - United States - Daily - End of period');
assert.equal(parsedRates[2].rate, 4.0);

const now = Date.parse('2026-11-24T12:00:00.000Z');
const usd = buildCurrencyPolicyRate('USD', 'US', parsedRates, now);
assert.equal(usd.status, 'FRESH_DAILY');
assert.equal(usd.ratePercent, 4);
assert.equal(usd.lastChangeDate, '2026-11-18');
assert.equal(usd.lastChangeBps, 13);

const stale = buildCurrencyPolicyRate('USD', 'US', parsedRates, Date.parse('2026-12-01T12:00:00Z'));
assert.equal(stale.status, 'STALE_DAILY');

const rateSets = {
  USD: parsedRates,
  EUR: [
    { area:'XM', date:'2026-11-16', rate:2.5, title:'ECB deposit facility' },
    { area:'XM', date:'2026-11-17', rate:2.5, title:'ECB deposit facility' },
    { area:'XM', date:'2026-11-18', rate:2.5, title:'ECB deposit facility' },
    { area:'XM', date:'2026-11-19', rate:2.5, title:'ECB deposit facility' }
  ],
  GBP: [{area:'GB',date:'2026-11-19',rate:4,title:'BoE bank rate'}],
  JPY: [{area:'JP',date:'2026-11-19',rate:1.25,title:'BoJ policy rate'}],
  CHF: [{area:'CH',date:'2026-11-19',rate:0,title:'SNB policy rate'}],
  AUD: [{area:'AU',date:'2026-11-19',rate:3.6,title:'RBA cash rate'}],
  NZD: [{area:'NZ',date:'2026-11-19',rate:2.25,title:'RBNZ OCR'}],
  CAD: [{area:'CA',date:'2026-11-19',rate:2.25,title:'BoC overnight rate'}]
};
const allPairs = buildBISPolicyContext(rateSets, now);
assert.equal(allPairs.availableCurrencies, 8);
assert.equal(allPairs.status, 'FRESH_DAILY');
assert.equal(allPairs.pairs['EUR/USD'].differentialPercent, -1.5);
assert.equal(allPairs.pairs['EUR/USD'].differentialBias, 'QUOTE_CARRY_ADVANTAGE');
assert.equal(allPairs.pairs['USD/JPY'].differentialPercent, 2.75);
assert.equal(buildPolicyRatePairContext(allPairs,'USD/CAD').baseCurrency, 'USD');
assert.equal(allPairs.signalEligible, false);

const missing = buildBISPolicyContext({USD:parsedRates}, now);
assert.equal(missing.status, 'PARTIAL_OR_STALE');
assert.equal(missing.pairs['EUR/USD'].differentialPercent, null);

console.log('BIS policy-rate CSV, freshness, last-change, base/quote differential and missing-data tests passed.');
