'use strict';

const assert = require('node:assert/strict');
const { buildCftcPositioning, parseCftcRows, percentileRank } = require('../cftc-positioning');

const codes = {
  EUR: '099741',
  GBP: '096742',
  JPY: '097741',
  CHF: '092741',
  AUD: '232741',
  NZD: '112741',
  CAD: '090741'
};
const reportDates = ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17'];
const rows = [];

for (const [currency, code] of Object.entries(codes)) {
  reportDates.forEach((reportDate, index) => {
    let leveragedNet = index * 100;
    if (currency === 'JPY') leveragedNet = index * 100;
    if (currency === 'CHF') leveragedNet = (3 - index) * 100;
    const openInterest = 1000;
    rows.push({
      cftc_contract_market_code: code,
      market_and_exchange_names: currency + ' - CHICAGO MERCANTILE EXCHANGE',
      report_date_as_yyyy_mm_dd: reportDate + 'T00:00:00.000',
      open_interest_all: String(openInterest),
      lev_money_positions_long: String(500 + leveragedNet),
      lev_money_positions_short: '500',
      asset_mgr_positions_long: String(600 + leveragedNet),
      asset_mgr_positions_short: '500'
    });
  });
}
rows.push({
  cftc_contract_market_code: '000000',
  report_date_as_yyyy_mm_dd: '2026-11-17T00:00:00.000',
  open_interest_all: '100',
  lev_money_positions_long: '80',
  lev_money_positions_short: '20',
  asset_mgr_positions_long: '80',
  asset_mgr_positions_short: '20'
});
rows.push({
  cftc_contract_market_code: codes.EUR,
  report_date_as_yyyy_mm_dd: '2026-11-18T00:00:00.000',
  open_interest_all: '0',
  lev_money_positions_long: '100',
  lev_money_positions_short: '20',
  asset_mgr_positions_long: '100',
  asset_mgr_positions_short: '20'
});

assert.equal(percentileRank([1, 2, 3, 4], 4), 87.5);
assert.equal(percentileRank([1, 2, 3, 4], 1), 12.5);
assert.equal(parseCftcRows(rows).length, 28);

const now = Date.parse('2026-11-24T12:00:00.000Z');
const result = buildCftcPositioning(rows, now);
assert.equal(result.provider, 'Commodity Futures Trading Commission (CFTC)');
assert.equal(result.availableCurrencies, 7);
assert.equal(result.status, 'FRESH_WEEKLY');
assert.equal(result.pairs['EUR/USD'].direction, 'BULLISH');
assert.equal(result.pairs['EUR/USD'].leveragedFunds.pairBias, 'BULLISH');
assert.equal(result.pairs['USD/JPY'].direction, 'BEARISH');
assert.equal(result.pairs['USD/CHF'].direction, 'BULLISH');
assert.equal(result.pairs['USD/CHF'].leveragedFunds.pairBias, 'BULLISH');
assert.equal(result.pairs['GBP/USD'].reportDate, '2026-11-17');
assert.equal(result.pairs['EUR/USD'].publicationDate, '2026-11-20');

const stale = buildCftcPositioning(rows, Date.parse('2026-12-01T12:00:00.000Z'));
assert.equal(stale.pairs['EUR/USD'].status, 'STALE_WEEKLY');
assert.equal(stale.status, 'PARTIAL_OR_STALE');

const empty = buildCftcPositioning([], now);
assert.equal(empty.status, 'UNAVAILABLE');
assert.equal(empty.pairs['EUR/USD'].direction, 'MIXED');

console.log('CFTC futures-only positioning, pair sign, 52-week percentile and freshness tests passed.');
