'use strict';

const CURRENCY_CONTRACTS = Object.freeze({
  EUR: '099741',
  GBP: '096742',
  JPY: '097741',
  CHF: '092741',
  AUD: '232741',
  NZD: '112741',
  CAD: '090741'
});

const PAIR_EXPOSURE = Object.freeze({
  'EUR/USD': { currency: 'EUR', sign: 1 },
  'GBP/USD': { currency: 'GBP', sign: 1 },
  'USD/JPY': { currency: 'JPY', sign: -1 },
  'USD/CHF': { currency: 'CHF', sign: -1 },
  'AUD/USD': { currency: 'AUD', sign: 1 },
  'NZD/USD': { currency: 'NZD', sign: 1 },
  'USD/CAD': { currency: 'CAD', sign: -1 }
});

const LOOKBACK_WEEKS = 52;
const FRESH_REPORT_MAX_AGE_DAYS = 10;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normaliseReportDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const stamp = Date.parse(text + 'T00:00:00.000Z');
  return Number.isFinite(stamp) ? text : null;
}

function addUtcDays(dateText, days) {
  const stamp = Date.parse(dateText + 'T00:00:00.000Z');
  if (!Number.isFinite(stamp)) return null;
  return new Date(stamp + days * 86400000).toISOString().slice(0, 10);
}

function percentileRank(values, target) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length || !Number.isFinite(target)) return null;
  const lower = clean.filter(value => value < target).length;
  const equal = clean.filter(value => value === target).length;
  return Math.round(((lower + equal / 2) / clean.length) * 1000) / 10;
}

function biasFromPercentile(percentile) {
  if (!Number.isFinite(percentile)) return 'MIXED';
  if (percentile >= 65) return 'BULLISH';
  if (percentile <= 35) return 'BEARISH';
  return 'MIXED';
}

function crowdingFromPercentile(percentile) {
  if (!Number.isFinite(percentile)) return 'UNKNOWN';
  if (percentile >= 90) return 'EXTREME_LONG';
  if (percentile >= 75) return 'LONG_BIASED';
  if (percentile <= 10) return 'EXTREME_SHORT';
  if (percentile <= 25) return 'SHORT_BIASED';
  return 'NOT_EXTREME';
}

function parseCftcRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('cftc_response_must_be_array');
  const codeToCurrency = new Map(
    Object.entries(CURRENCY_CONTRACTS).map(([currency, code]) => [code, currency])
  );
  const parsed = [];

  for (const row of rows) {
    const code = String(row && row.cftc_contract_market_code || '').trim();
    const currency = codeToCurrency.get(code);
    const reportDate = normaliseReportDate(row && row.report_date_as_yyyy_mm_dd);
    const openInterest = finiteNumber(row && row.open_interest_all);
    const leveragedLong = finiteNumber(row && row.lev_money_positions_long);
    const leveragedShort = finiteNumber(row && row.lev_money_positions_short);
    const assetManagerLong = finiteNumber(row && row.asset_mgr_positions_long);
    const assetManagerShort = finiteNumber(row && row.asset_mgr_positions_short);

    if (!currency || !reportDate || !Number.isFinite(openInterest) || openInterest <= 0 ||
        ![leveragedLong, leveragedShort, assetManagerLong, assetManagerShort].every(Number.isFinite) ||
        [leveragedLong, leveragedShort, assetManagerLong, assetManagerShort].some(value => value < 0)) {
      continue;
    }

    parsed.push({
      currency,
      contractCode: code,
      market: String(row.market_and_exchange_names || '').slice(0, 160),
      reportDate,
      publicationDate: addUtcDays(reportDate, 3),
      openInterest,
      leveragedLong,
      leveragedShort,
      leveragedNet: leveragedLong - leveragedShort,
      leveragedNetPctOi: ((leveragedLong - leveragedShort) / openInterest) * 100,
      assetManagerLong,
      assetManagerShort,
      assetManagerNet: assetManagerLong - assetManagerShort,
      assetManagerNetPctOi: ((assetManagerLong - assetManagerShort) / openInterest) * 100
    });
  }

  return parsed.sort((a, b) =>
    a.currency.localeCompare(b.currency) || a.reportDate.localeCompare(b.reportDate)
  );
}

function buildCurrencyContext(history, nowMs) {
  if (!history.length) return null;
  const recent = history.slice(-LOOKBACK_WEEKS);
  const latest = recent[recent.length - 1];
  const previous = recent.length > 1 ? recent[recent.length - 2] : null;
  const reportStamp = Date.parse(latest.reportDate + 'T00:00:00.000Z');
  const ageDays = Math.max(0, Math.floor((nowMs - reportStamp) / 86400000));

  const leveragedPercentile = percentileRank(
    recent.map(item => item.leveragedNetPctOi), latest.leveragedNetPctOi
  );
  const assetManagerPercentile = percentileRank(
    recent.map(item => item.assetManagerNetPctOi), latest.assetManagerNetPctOi
  );

  return {
    currency: latest.currency,
    contractCode: latest.contractCode,
    market: latest.market,
    reportDate: latest.reportDate,
    publicationDate: latest.publicationDate,
    reportAgeDays: ageDays,
    status: ageDays <= FRESH_REPORT_MAX_AGE_DAYS ? 'FRESH_WEEKLY' : 'STALE_WEEKLY',
    sampleWeeks: recent.length,
    openInterest: latest.openInterest,
    leveragedFunds: {
      longContracts: latest.leveragedLong,
      shortContracts: latest.leveragedShort,
      netContracts: latest.leveragedNet,
      netPercentOpenInterest: Math.round(latest.leveragedNetPctOi * 1000) / 1000,
      weeklyNetChangeContracts: previous ? latest.leveragedNet - previous.leveragedNet : null,
      percentile52Week: leveragedPercentile,
      bias: biasFromPercentile(leveragedPercentile),
      crowding: crowdingFromPercentile(leveragedPercentile)
    },
    assetManagers: {
      longContracts: latest.assetManagerLong,
      shortContracts: latest.assetManagerShort,
      netContracts: latest.assetManagerNet,
      netPercentOpenInterest: Math.round(latest.assetManagerNetPctOi * 1000) / 1000,
      weeklyNetChangeContracts: previous ? latest.assetManagerNet - previous.assetManagerNet : null,
      percentile52Week: assetManagerPercentile,
      bias: biasFromPercentile(assetManagerPercentile),
      crowding: crowdingFromPercentile(assetManagerPercentile)
    }
  };
}

function buildCftcPositioning(rows, now = Date.now()) {
  const parsed = parseCftcRows(rows);
  const byCurrency = new Map(Object.keys(CURRENCY_CONTRACTS).map(currency => [currency, []]));
  parsed.forEach(item => {
    if (byCurrency.has(item.currency)) byCurrency.get(item.currency).push(item);
  });

  const currencies = {};
  for (const [currency, history] of byCurrency) {
    currencies[currency] = buildCurrencyContext(history, now);
  }

  const pairs = {};
  for (const [pair, exposure] of Object.entries(PAIR_EXPOSURE)) {
    const context = currencies[exposure.currency];
    if (!context) {
      pairs[pair] = {
        pair,
        currency: exposure.currency,
        status: 'UNAVAILABLE',
        direction: 'MIXED',
        reason: 'CFTC_POSITIONING_NOT_AVAILABLE'
      };
      continue;
    }

    const rawLeveragedPercentile = context.leveragedFunds.percentile52Week;
    const rawAssetManagerPercentile = context.assetManagers.percentile52Week;
    const pairLeveragedPercentile = Number.isFinite(rawLeveragedPercentile)
      ? (exposure.sign === 1 ? rawLeveragedPercentile : 100 - rawLeveragedPercentile)
      : null;
    const pairAssetManagerPercentile = Number.isFinite(rawAssetManagerPercentile)
      ? (exposure.sign === 1 ? rawAssetManagerPercentile : 100 - rawAssetManagerPercentile)
      : null;
    const leveragedBias = biasFromPercentile(pairLeveragedPercentile);
    const assetManagerBias = biasFromPercentile(pairAssetManagerPercentile);
    const aligned = leveragedBias !== 'MIXED' && leveragedBias === assetManagerBias;
    const direction = aligned ? leveragedBias : 'MIXED';

    pairs[pair] = {
      pair,
      currency: exposure.currency,
      contractCode: context.contractCode,
      market: context.market,
      status: context.status,
      reportDate: context.reportDate,
      publicationDate: context.publicationDate,
      reportAgeDays: context.reportAgeDays,
      sampleWeeks: context.sampleWeeks,
      openInterest: context.openInterest,
      direction,
      directionalAgreement: aligned ? 'ALIGNED' : 'MIXED',
      leveragedFunds: {
        ...context.leveragedFunds,
        pairPercentile52Week: pairLeveragedPercentile,
        pairBias: leveragedBias,
        pairCrowding: crowdingFromPercentile(pairLeveragedPercentile)
      },
      assetManagers: {
        ...context.assetManagers,
        pairPercentile52Week: pairAssetManagerPercentile,
        pairBias: assetManagerBias
      },
      interpretation: 'Weekly futures positioning context for the non-USD currency leg; not an intraday spot-flow or standalone trade signal.'
    };
  }

  const available = Object.values(currencies).filter(Boolean).length;
  const stale = Object.values(currencies).filter(item => item && item.status === 'STALE_WEEKLY').length;
  return {
    ok: true,
    provider: 'Commodity Futures Trading Commission (CFTC)',
    dataset: 'Traders in Financial Futures · Futures Only',
    datasetId: 'gpe5-46if',
    frequency: 'WEEKLY',
    reportConvention: 'Positions are as of Tuesday and are generally published Friday at 3:30 p.m. America/New_York.',
    status: available === 7 && stale === 0 ? 'FRESH_WEEKLY' : available ? 'PARTIAL_OR_STALE' : 'UNAVAILABLE',
    availableCurrencies: available,
    expectedCurrencies: 7,
    currencies,
    pairs,
    fetchedAt: new Date(now).toISOString(),
    disclaimer: 'CFTC futures positioning is a weekly, delayed proxy for the non-USD currency leg. Futures positions do not represent the entire decentralised spot-FX market, and they do not establish an intraday direction or calibrated probability.'
  };
}

module.exports = {
  CURRENCY_CONTRACTS,
  PAIR_EXPOSURE,
  parseCftcRows,
  percentileRank,
  buildCftcPositioning
};
