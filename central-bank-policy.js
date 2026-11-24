'use strict';

const BIS_POLICY_URL = 'https://stats.bis.org/api/v1/data/WS_CBPOL/.';
const BIS_RATE_UNIT = '368';
const BIS_DAILY_FREQUENCY = 'D';
const POLICY_LOOKBACK_DAYS = 400;
const POLICY_FRESH_MAX_AGE_DAYS = 10;

const CENTRAL_BANKS = Object.freeze({
  USD: { area: 'US', name: 'Federal Reserve', source: 'US Federal Reserve System' },
  EUR: { area: 'XM', name: 'European Central Bank', source: 'European Central Bank' },
  GBP: { area: 'GB', name: 'Bank of England', source: 'Bank of England' },
  JPY: { area: 'JP', name: 'Bank of Japan', source: 'Bank of Japan' },
  CHF: { area: 'CH', name: 'Swiss National Bank', source: 'Swiss National Bank' },
  AUD: { area: 'AU', name: 'Reserve Bank of Australia', source: 'Reserve Bank of Australia' },
  NZD: { area: 'NZ', name: 'Reserve Bank of New Zealand', source: 'Reserve Bank of New Zealand' },
  CAD: { area: 'CA', name: 'Bank of Canada', source: 'Bank of Canada' }
});

const POLICY_PAIRS = Object.freeze({
  'EUR/USD': ['EUR', 'USD'],
  'GBP/USD': ['GBP', 'USD'],
  'USD/JPY': ['USD', 'JPY'],
  'USD/CHF': ['USD', 'CHF'],
  'AUD/USD': ['AUD', 'USD'],
  'NZD/USD': ['NZD', 'USD'],
  'USD/CAD': ['USD', 'CAD']
});

function parseBISCsv(text) {
  if (typeof text !== 'string' || text.length > 20_000_000) {
    throw new TypeError('bis_csv_invalid_size');
  }
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new TypeError('bis_csv_unclosed_quote');
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  if (rows.length < 2) throw new TypeError('bis_csv_no_observations');

  const headers = rows.shift().map(value => value.trim());
  const required = [
    'FREQ', 'REF_AREA', 'UNIT_MEASURE', 'UNIT_MULT', 'SOURCE_REF',
    'TITLE', 'TIME_PERIOD', 'OBS_VALUE', 'OBS_STATUS'
  ];
  if (!required.every(key => headers.includes(key))) {
    throw new TypeError('bis_csv_required_columns_missing');
  }
  const indexByName = Object.fromEntries(headers.map((name, index) => [name, index]));
  return rows.filter(values => values.length === headers.length).map(values =>
    Object.fromEntries(headers.map((name, index) => [name, values[index] || '']))
  );
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalisePolicyRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('bis_rows_must_be_array');
  const areaToCurrency = new Map(
    Object.entries(CENTRAL_BANKS).map(([currency, config]) => [config.area, currency])
  );
  const grouped = new Map(
    Object.keys(CENTRAL_BANKS).map(currency => [currency, new Map()])
  );

  for (const row of rows) {
    const currency = areaToCurrency.get(String(row.REF_AREA || '').trim().toUpperCase());
    if (!currency) continue;
    if (String(row.FREQ || '').trim() !== BIS_DAILY_FREQUENCY) continue;
    if (String(row.UNIT_MEASURE || '').trim() !== BIS_RATE_UNIT) continue;
    if (String(row.UNIT_MULT || '0').trim() !== '0') continue;
    if (String(row.OBS_STATUS || 'A').trim() !== 'A') continue;

    const date = String(row.TIME_PERIOD || '').trim();
    const value = finiteNumber(row.OBS_VALUE);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || value === null || value < 0 || value > 100) continue;
    const source = String(row.SOURCE_REF || '').trim();
    const expectedSource = CENTRAL_BANKS[currency].source;
    if (source && source.toLowerCase() !== expectedSource.toLowerCase()) continue;

    grouped.get(currency).set(date, {
      date,
      rate: value,
      source: source || expectedSource,
      title: String(row.TITLE || '').trim().slice(0, 180),
      observationStatus: String(row.OBS_STATUS || 'A')
    });
  }

  return Object.fromEntries([...grouped.entries()].map(([currency, observations]) => [
    currency,
    [...observations.values()].sort((a, b) => a.date.localeCompare(b.date))
  ]));
}

function addUtcDays(dateText, days) {
  const stamp = Date.parse(dateText + 'T00:00:00.000Z');
  if (!Number.isFinite(stamp)) return null;
  return new Date(stamp + days * 86400000).toISOString().slice(0, 10);
}

function latestAtOrBefore(observations, targetDate) {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    if (observations[index].date <= targetDate) return observations[index];
  }
  return null;
}

function buildCurrencyPolicyContext(currency, observations, now = Date.now()) {
  const config = CENTRAL_BANKS[currency];
  if (!config || !Array.isArray(observations) || !observations.length) return null;
  const latest = observations[observations.length - 1];
  const reportAgeDays = Math.max(0, Math.floor(
    (Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z') -
      Date.parse(latest.date + 'T00:00:00.000Z')) / 86400000
  ));
  const yearPrior = latestAtOrBefore(observations, addUtcDays(latest.date, -365));
  let previousDifferent = null;
  let effectiveDate = null;
  for (let index = observations.length - 2; index >= 0; index -= 1) {
    if (observations[index].rate !== latest.rate) {
      previousDifferent = observations[index];
      effectiveDate = observations[index + 1].date;
      break;
    }
  }

  const change12m = yearPrior ? latest.rate - yearPrior.rate : null;
  const lastChange = previousDifferent
    ? {
        effectiveDate,
        previousRate: previousDifferent.rate,
        currentRate: latest.rate,
        changePercentagePoints: latest.rate - previousDifferent.rate
      }
    : null;

  return {
    currency,
    areaCode: config.area,
    centralBank: config.name,
    source: latest.source,
    currentRatePercent: latest.rate,
    observationDate: latest.date,
    reportAgeDays,
    freshness: reportAgeDays <= POLICY_FRESH_MAX_AGE_DAYS ? 'FRESH' : 'STALE',
    observationsAvailable: observations.length,
    lastChange,
    twelveMonth: {
      referenceDate: yearPrior ? yearPrior.date : null,
      referenceRatePercent: yearPrior ? yearPrior.rate : null,
      changePercentagePoints: change12m
    }
  };
}

function buildPairPolicyContext(pair, currencies) {
  const pairCurrencies = POLICY_PAIRS[pair];
  if (!pairCurrencies) return { pair, status: 'UNAVAILABLE', policyBias: 'WAIT' };
  const [baseCurrency, quoteCurrency] = pairCurrencies;
  const base = currencies[baseCurrency] || null;
  const quote = currencies[quoteCurrency] || null;
  if (!base || !quote) {
    return {
      pair, baseCurrency, quoteCurrency,
      status: 'UNAVAILABLE', policyBias: 'WAIT',
      reason: 'ONE_OR_BOTH_CENTRAL_BANK_SERIES_UNAVAILABLE'
    };
  }

  const fresh = base.freshness === 'FRESH' && quote.freshness === 'FRESH';
  const rateDifferential = base.currentRatePercent - quote.currentRatePercent;
  const impulseDifferential = Number.isFinite(base.twelveMonth.changePercentagePoints) &&
    Number.isFinite(quote.twelveMonth.changePercentagePoints)
    ? base.twelveMonth.changePercentagePoints - quote.twelveMonth.changePercentagePoints
    : null;

  let policyBias = 'WAIT';
  let reason = 'STALE_OR_INCOMPLETE_POLICY_RATE_OBSERVATIONS';
  if (fresh && Number.isFinite(impulseDifferential)) {
    if (impulseDifferential >= 0.25) {
      policyBias = 'BULLISH';
      reason = 'BASE_CURRENCY_POLICY_RATE_ROSE_MORE_THAN_QUOTE_OVER_12M';
    } else if (impulseDifferential <= -0.25) {
      policyBias = 'BEARISH';
      reason = 'QUOTE_CURRENCY_POLICY_RATE_ROSE_MORE_THAN_BASE_OVER_12M';
    } else {
      policyBias = 'MIXED';
      reason = '12M_RELATIVE_POLICY_RATE_CHANGE_BELOW_0_25PP';
    }
  } else if (fresh) {
    reason = '12M_REFERENCE_NOT_AVAILABLE';
  }

  return {
    pair,
    baseCurrency,
    quoteCurrency,
    status: fresh && Number.isFinite(impulseDifferential) ? 'FRESH' : 'PARTIAL_OR_STALE',
    policyBias,
    reason,
    base,
    quote,
    currentRateDifferentialPercentagePoints: Number(rateDifferential.toFixed(3)),
    twelveMonthPolicyImpulseDifferentialPercentagePoints:
      Number.isFinite(impulseDifferential) ? Number(impulseDifferential.toFixed(3)) : null,
    methodology: 'Policy bias is a research heuristic from the difference between each currency policy-rate change over 12 months. Current rate differential is shown as carry context only. Neither is an intraday signal or calibrated probability.',
    signalEligible: false
  };
}

function buildCentralBankPolicyContext(rows, now = Date.now()) {
  const observations = normalisePolicyRows(rows);
  const currencies = {};
  for (const currency of Object.keys(CENTRAL_BANKS)) {
    currencies[currency] = buildCurrencyPolicyContext(currency, observations[currency] || [], now);
  }

  const availableCurrencies = Object.values(currencies).filter(Boolean).length;
  const freshCurrencies = Object.values(currencies).filter(item => item && item.freshness === 'FRESH').length;
  const pairs = Object.fromEntries(Object.keys(POLICY_PAIRS).map(pair => [
    pair,
    buildPairPolicyContext(pair, currencies)
  ]));
  return {
    ok: availableCurrencies > 0,
    provider: 'Bank for International Settlements (BIS)',
    dataset: 'Central bank policy rates',
    datasetId: 'WS_CBPOL',
    frequency: 'DAILY',
    unit: 'Percent per annum',
    status: availableCurrencies === 8 && freshCurrencies === 8 ? 'FRESH' : availableCurrencies ? 'PARTIAL_OR_STALE' : 'UNAVAILABLE',
    availableCurrencies,
    expectedCurrencies: 8,
    currencies,
    pairs,
    fetchedAt: new Date(now).toISOString(),
    signalEligible: false,
    disclaimer: 'BIS daily central-bank policy-rate observations are a higher-timeframe monetary-policy reference. Rate levels and 12-month changes are not standalone FX direction signals or calibrated probabilities.'
  };
}

module.exports = {
  BIS_POLICY_URL,
  CENTRAL_BANKS,
  POLICY_PAIRS,
  POLICY_FRESH_MAX_AGE_DAYS,
  parseBISCsv,
  normalisePolicyRows,
  buildCurrencyPolicyContext,
  buildPairPolicyContext,
  buildCentralBankPolicyContext
};
