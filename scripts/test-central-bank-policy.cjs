'use strict';

const assert = require('node:assert/strict');
const {
  CENTRAL_BANKS,
  parseBISCsv,
  normalisePolicyRows,
  buildCentralBankPolicyContext
} = require('../central-bank-policy');

const now = Date.parse('2026-11-24T12:00:00.000Z');
const dates = ['2025-11-17', '2026-01-15', '2026-11-17'];
const rates = {
  USD: [4.5, 4.0, 3.875],
  EUR: [2.0, 2.25, 2.5],
  GBP: [4.75, 4.25, 4.0],
  JPY: [0.5, 0.75, 1.25],
  CHF: [1.0, 0.5, 0.0],
  AUD: [4.35, 4.6, 4.85],
  NZD: [4.0, 3.5, 2.75],
  CAD: [3.5, 3.0, 2.5]
};

const rows = [];
for (const [currency, config] of Object.entries(CENTRAL_BANKS)) {
  dates.forEach((date, index) => {
    rows.push({
      FREQ: 'D',
      REF_AREA: config.area,
      UNIT_MEASURE: '368',
      UNIT_MULT: '0',
      SOURCE_REF: config.source,
      TITLE: 'Central bank policy rates - test',
      TIME_PERIOD: date,
      OBS_VALUE: String(rates[currency][index]),
      OBS_STATUS: 'A'
    });
  });
}
rows.push({
  FREQ: 'M',
  REF_AREA: 'US',
  UNIT_MEASURE: '368',
  UNIT_MULT: '0',
  SOURCE_REF: CENTRAL_BANKS.USD.source,
  TITLE: 'Monthly duplicate must be excluded',
  TIME_PERIOD: '2026-11',
  OBS_VALUE: '99',
  OBS_STATUS: 'A'
});
rows.push({
  FREQ: 'D',
  REF_AREA: 'US',
  UNIT_MEASURE: '368',
  UNIT_MULT: '0',
  SOURCE_REF: CENTRAL_BANKS.USD.source,
  TITLE: 'Preliminary observation must be excluded',
  TIME_PERIOD: '2026-11-18',
  OBS_VALUE: '99',
  OBS_STATUS: 'P'
});
rows.push({
  FREQ: 'D',
  REF_AREA: 'XX',
  UNIT_MEASURE: '368',
  UNIT_MULT: '0',
  SOURCE_REF: 'Unknown source',
  TITLE: 'Unknown area must be excluded',
  TIME_PERIOD: '2026-11-17',
  OBS_VALUE: '99',
  OBS_STATUS: 'A'
});

const csv = [
  'FREQ,REF_AREA,UNIT_MEASURE,UNIT_MULT,TIME_FORMAT,COMPILATION,DECIMALS,SOURCE_REF,SUPP_INFO_BREAKS,TITLE,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK',
  'D,US,368,0,,Policy rate,4,US Federal Reserve System,,Central bank policy rates - United States - Daily,2026-11-17,3.875,A,F,',
  'D,GB,368,0,,Policy rate,4,Bank of England,,"Central bank policy rates - UK, Daily",2026-11-17,4.0,A,F,',
  'D,CH,368,0,,Policy rate,4,Swiss National Bank,,"Policy rates include a quoted ""central bank"" description",2026-11-17,0,A,F,'
].join('\n');
const parsedCsv = parseBISCsv(csv);
assert.equal(parsedCsv.length, 3);
assert.equal(parsedCsv[1].TITLE, 'Central bank policy rates - UK, Daily');
assert.equal(parsedCsv[2].TITLE, 'Policy rates include a quoted "central bank" description');

const normalised = normalisePolicyRows(rows);
assert.equal(normalised.USD.length, 3, 'monthly and preliminary observations must be excluded');
assert.equal(Object.values(normalised).filter(items => items.length).length, 8);

const result = buildCentralBankPolicyContext(rows, now);
assert.equal(result.ok, true);
assert.equal(result.status, 'FRESH');
assert.equal(result.availableCurrencies, 8);
assert.equal(result.expectedCurrencies, 8);
assert.equal(result.signalEligible, false);

assert.equal(result.currencies.USD.currentRatePercent, 3.875);
assert.equal(result.currencies.EUR.observationDate, '2026-11-17');
assert.equal(result.currencies.EUR.twelveMonth.referenceRatePercent, 2.0);
assert.equal(result.currencies.EUR.twelveMonth.changePercentagePoints, 0.5);
assert.equal(result.currencies.EUR.lastChange.effectiveDate, '2026-11-17');
assert.equal(result.currencies.EUR.lastChange.changePercentagePoints, 0.25);

assert.equal(result.pairs['EUR/USD'].currentRateDifferentialPercentagePoints, -1.375);
assert.equal(result.pairs['EUR/USD'].twelveMonthPolicyImpulseDifferentialPercentagePoints, 1.125);
assert.equal(result.pairs['EUR/USD'].policyBias, 'BULLISH');
assert.equal(result.pairs['USD/JPY'].policyBias, 'BEARISH');
assert.equal(result.pairs['USD/CHF'].policyBias, 'BULLISH');
assert.equal(result.pairs['AUD/USD'].policyBias, 'BULLISH');
assert.equal(result.pairs['NZD/USD'].policyBias, 'BEARISH');
assert.equal(result.pairs['USD/CAD'].policyBias, 'BULLISH');
assert.equal(result.pairs['EUR/USD'].signalEligible, false);

const stale = buildCentralBankPolicyContext(rows, Date.parse('2026-12-01T12:00:00.000Z'));
assert.equal(stale.currencies.USD.freshness, 'STALE');
assert.equal(stale.pairs['EUR/USD'].policyBias, 'WAIT');
assert.equal(stale.pairs['EUR/USD'].status, 'PARTIAL_OR_STALE');

const incomplete = buildCentralBankPolicyContext(
  rows.filter(row => row.REF_AREA !== CENTRAL_BANKS.NZD.area), now
);
assert.equal(incomplete.availableCurrencies, 7);
assert.equal(incomplete.pairs['NZD/USD'].policyBias, 'WAIT');
assert.equal(incomplete.pairs['EUR/USD'].policyBias, 'BULLISH');

const empty = buildCentralBankPolicyContext([], now);
assert.equal(empty.ok, false);
assert.equal(empty.status, 'UNAVAILABLE');
assert.equal(empty.pairs['EUR/USD'].policyBias, 'WAIT');

assert.throws(() => parseBISCsv('not,a,valid,schema\n1,2,3,4'), /bis_csv_required_columns_missing/);
assert.throws(() => normalisePolicyRows({}), /bis_rows_must_be_array/);

console.log('BIS policy CSV parsing, eight central-bank mapping, rate changes, pair differentials and freshness tests passed.');
