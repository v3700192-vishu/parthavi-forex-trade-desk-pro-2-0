'use strict';

const BIS_AREAS = Object.freeze({
  USD: 'US',
  EUR: 'XM',
  GBP: 'GB',
  JPY: 'JP',
  CHF: 'CH',
  AUD: 'AU',
  NZD: 'NZ',
  CAD: 'CA'
});

const BIS_SOURCE = 'Bank for International Settlements (BIS) · Central bank policy rates (WS_CBPOL)';
const MAX_OBSERVATION_AGE_DAYS = 7;
const MAX_RATE_LOOKBACK_DAYS = 400;
const PAIR_CURRENCIES = Object.freeze({
  'EUR/USD': ['EUR', 'USD'],
  'GBP/USD': ['GBP', 'USD'],
  'USD/JPY': ['USD', 'JPY'],
  'USD/CHF': ['USD', 'CHF'],
  'AUD/USD': ['AUD', 'USD'],
  'NZD/USD': ['NZD', 'USD'],
  'USD/CAD': ['USD', 'CAD']
});

function parseCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('bis_csv_unclosed_quote');
  if (field.length || row.length) {
    row.push(field);
    if (row.some(value => value.length > 0)) rows.push(row);
  }
  return rows;
}

function parseBISPolicyCsv(text, expectedArea) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(value => value.trim());
  const required = ['FREQ', 'REF_AREA', 'UNIT_MEASURE', 'UNIT_MULT', 'TITLE', 'TIME_PERIOD', 'OBS_VALUE', 'OBS_STATUS', 'OBS_CONF'];
  if (required.some(name => !headers.includes(name))) throw new Error('bis_policy_csv_schema_missing');
  const index = Object.fromEntries(required.map(name => [name, headers.indexOf(name)]));
  const parsed = [];

  for (const row of rows.slice(1)) {
    const get = name => String(row[index[name]] ?? '').trim();
    const frequency = get('FREQ');
    const area = get('REF_AREA');
    const unit = get('UNIT_MEASURE');
    const multiplier = get('UNIT_MULT');
    const date = get('TIME_PERIOD');
    const valueText = get('OBS_VALUE');
    const status = get('OBS_STATUS');
    const confidentiality = get('OBS_CONF');
    const rate = valueText === '' ? NaN : Number(valueText);

    if (frequency !== 'D' || area !== expectedArea || unit !== '368' || multiplier !== '0') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))) continue;
    if (!Number.isFinite(rate) || rate < -20 || rate > 100) continue;
    if (status && status !== 'A') continue;
    if (confidentiality && confidentiality !== 'F') continue;

    parsed.push({
      area,
      date,
      rate,
      status: status || 'UNKNOWN',
      title: get('TITLE').slice(0, 200)
    });
  }

  const byDate = new Map();
  parsed.forEach(item => byDate.set(item.date, item));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function dayAge(date, nowMs) {
  const stamp = Date.parse(date + 'T00:00:00.000Z');
  return Number.isFinite(stamp) ? Math.max(0, Math.floor((nowMs - stamp) / 86400000)) : null;
}

function addUtcDays(dateText, days) {
  const stamp = Date.parse(dateText + 'T00:00:00.000Z');
  return Number.isFinite(stamp) ? new Date(stamp + days * 86400000).toISOString().slice(0, 10) : null;
}

function latestAtOrBefore(observations, targetDate) {
  for (let index = observations.length - 1; index >= 0; index--) {
    if (observations[index].date <= targetDate) return observations[index];
  }
  return null;
}

function buildCurrencyPolicyRate(currency, area, observations, now = Date.now()) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return {
      currency, area, status: 'UNAVAILABLE',
      ratePercent: null, observationDate: null,
      lastChangeDate: null, lastChangeBps: null,
      change90dBps: null, signalEligible: false
    };
  }

  const latest = observations[observations.length - 1];
  const ageDays = dayAge(latest.date, now);
  let lastChange = null;
  for (let index = observations.length - 1; index > 0; index--) {
    if (Math.abs(observations[index].rate - observations[index - 1].rate) >= 1e-10) {
      lastChange = {
        date: observations[index].date,
        previousRate: observations[index - 1].rate,
        rate: observations[index].rate,
        changeBps: Math.round((observations[index].rate - observations[index - 1].rate) * 100)
      };
      break;
    }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const ninetyDaysAgo = addUtcDays(today, -90);
  const historical = latestAtOrBefore(observations, ninetyDaysAgo);
  const change90dBps = historical
    ? Math.round((latest.rate - historical.rate) * 100)
    : null;

  return {
    currency,
    area,
    title: latest.title,
    status: ageDays <= MAX_OBSERVATION_AGE_DAYS ? 'FRESH_DAILY' : 'STALE_DAILY',
    ratePercent: latest.rate,
    observationDate: latest.date,
    ageDays,
    lastChangeDate: lastChange ? lastChange.date : null,
    previousRateBeforeLastChange: lastChange ? lastChange.previousRate : null,
    rateAtLastChange: lastChange ? lastChange.rate : null,
    lastChangeBps: lastChange ? lastChange.changeBps : null,
    change90dBps,
    lookbackObservations: observations.length,
    signalEligible: false
  };
}

function classifyDifferential(differential) {
  if (!Number.isFinite(differential)) return 'UNAVAILABLE';
  if (differential >= 0.25) return 'BASE_CARRY_ADVANTAGE';
  if (differential <= -0.25) return 'QUOTE_CARRY_ADVANTAGE';
  return 'NEAR_PARITY';
}

function classifyRelativePolicyMove(baseRate, quoteRate) {
  if (!Number.isFinite(baseRate) || !Number.isFinite(quoteRate)) return 'UNAVAILABLE';
  const gap = baseRate - quoteRate;
  if (gap >= 25) return 'BASE_POLICY_RATE_RISING_RELATIVE';
  if (gap <= -25) return 'QUOTE_POLICY_RATE_RISING_RELATIVE';
  return 'NO_CLEAR_RELATIVE_SHIFT';
}

function buildPairPolicyContext(pair, rates) {
  const currencies = PAIR_CURRENCIES[pair];
  if (!currencies) return { pair, status: 'UNAVAILABLE', signalEligible: false };
  const [baseCurrency, quoteCurrency] = currencies;
  const base = rates && rates[baseCurrency];
  const quote = rates && rates[quoteCurrency];
  const available = Boolean(base && quote &&
    ['FRESH_DAILY', 'STALE_DAILY'].includes(base.status) &&
    ['FRESH_DAILY', 'STALE_DAILY'].includes(quote.status) &&
    Number.isFinite(base.ratePercent) && Number.isFinite(quote.ratePercent));
  if (!available) {
    return {
      pair, status: 'PARTIAL_OR_UNAVAILABLE',
      baseCurrency, quoteCurrency,
      baseRatePercent: base && base.ratePercent,
      quoteRatePercent: quote && quote.ratePercent,
      rateDifferentialPercent: null,
      differentialBias: 'UNAVAILABLE',
      signalEligible: false
    };
  }

  const differential = base.ratePercent - quote.ratePercent;
  const fresh = base.status === 'FRESH_DAILY' && quote.status === 'FRESH_DAILY';
  const baseDelta90 = base.change90dBps;
  const quoteDelta90 = quote.change90dBps;
  const relativeMoveBps = Number.isFinite(baseDelta90) && Number.isFinite(quoteDelta90)
    ? baseDelta90 - quoteDelta90
    : null;

  return {
    pair,
    status: fresh ? 'FRESH_DAILY' : 'STALE_DAILY',
    baseCurrency,
    quoteCurrency,
    baseRatePercent: base.ratePercent,
    quoteRatePercent: quote.ratePercent,
    baseObservationDate: base.observationDate,
    quoteObservationDate: quote.observationDate,
    differentialPercent: Number(differential.toFixed(3)),
    differentialBias: classifyDifferential(differential),
    baseLastChangeDate: base.lastChangeDate,
    baseLastChangeBps: base.lastChangeBps,
    quoteLastChangeDate: quote.lastChangeDate,
    quoteLastChangeBps: quote.lastChangeBps,
    baseChange90dBps: baseDelta90,
    quoteChange90dBps: quoteDelta90,
    relativeMove90dBps: relativeMoveBps,
    relativePolicyMove: classifyRelativePolicyMove(baseDelta90, quoteDelta90),
    interpretation: 'Daily policy-rate differential and recent relative policy changes are carry/monetary-policy context. Markets price expected future rates; this is not an intraday FX direction or standalone trade signal.',
    signalEligible: false
  };
}

function buildBISPolicyContext(seriesByCurrency, now = Date.now()) {
  const currencies = {};
  for (const [currency, area] of Object.entries(BIS_AREAS)) {
    currencies[currency] = buildCurrencyPolicyRate(currency, area,
      seriesByCurrency && seriesByCurrency[currency], now);
  }
  const available = Object.values(currencies).filter(item => item.status === 'FRESH_DAILY').length;
  const pairs = {};
  for (const pair of Object.keys(PAIR_CURRENCIES)) pairs[pair] = buildPairPolicyContext(pair, currencies);
  return {
    ok: true,
    provider: BIS_SOURCE,
    datasetId: 'WS_CBPOL',
    frequency: 'DAILY',
    availableCurrencies: available,
    expectedCurrencies: 8,
    status: available === 8 ? 'FRESH_DAILY' : available ? 'PARTIAL_OR_STALE' : 'UNAVAILABLE',
    currencies,
    pairs,
    signalEligible: false,
    attribution: 'Source: Bank for International Settlements (BIS), Central bank policy rates (WS_CBPOL). Data are reported directly to the BIS by member central banks. Policy-rate series are selected by participating central banks and may represent target, repo, discount or another identified policy instrument.',
    disclaimer: 'Daily end-of-period observations are released around mid-week and may lag a new announcement. The rate differential is monetary-policy/carry context, not a predicted exchange-rate move or calibrated probability.',
    fetchedAt: new Date(now).toISOString()
  };
}

function buildPolicyRatePairContext(fullContext, pair) {
  return fullContext && fullContext.pairs && fullContext.pairs[pair]
    ? fullContext.pairs[pair]
    : { pair, status: 'UNAVAILABLE', signalEligible: false };
}

module.exports = {
  BIS_AREAS,
  PAIR_CURRENCIES,
  parseCsv,
  parseBISPolicyCsv,
  buildCurrencyPolicyRate,
  buildBISPolicyContext,
  buildPolicyRatePairContext
};
