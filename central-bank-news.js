'use strict';

const CENTRAL_BANK_NEWS_CACHE_MS = 15 * 60 * 1000;
const MAX_FEED_BYTES = 1_500_000;
const MAX_ITEMS_PER_FEED = 25;
const MAX_NEWS_AGE_DAYS = 14;
const MAX_FEED_ITEM_AGE_DAYS = 30;

const CENTRAL_BANK_NEWS_FEEDS = Object.freeze([
  { currency: 'USD', bank: 'Federal Reserve', feed: 'FOMC monetary policy press releases', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', host: 'federalreserve.gov' },
  { currency: 'EUR', bank: 'European Central Bank', feed: 'ECB press releases and speeches', url: 'https://www.ecb.europa.eu/rss/press.html', host: 'ecb.europa.eu' },
  { currency: 'GBP', bank: 'Bank of England', feed: 'Bank of England official news', url: 'https://www.bankofengland.co.uk/rss/news', host: 'bankofengland.co.uk' },
  { currency: 'JPY', bank: 'Bank of Japan', feed: 'Bank of Japan official updates', url: 'https://www.boj.or.jp/en/rss/whatsnew.xml', host: 'boj.or.jp' },
  { currency: 'CHF', bank: 'Swiss National Bank', feed: 'SNB official press releases', url: 'https://www.snb.ch/public/rss/en/pressrel', host: 'snb.ch' },
  { currency: 'AUD', bank: 'Reserve Bank of Australia', feed: 'RBA media releases', url: 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml', host: 'rba.gov.au' },
  { currency: 'AUD', bank: 'Reserve Bank of Australia', feed: 'RBA speeches', url: 'https://www.rba.gov.au/rss/rss-cb-speeches.xml', host: 'rba.gov.au' },
  { currency: 'NZD', bank: 'Reserve Bank of New Zealand', feed: 'RBNZ official news', url: 'https://www.rbnz.govt.nz/feeds/news', host: 'rbnz.govt.nz' },
  { currency: 'CAD', bank: 'Bank of Canada', feed: 'Bank of Canada press releases', url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/', host: 'bankofcanada.ca' }
]);

const PAIR_CURRENCIES = Object.freeze({
  'EUR/USD': ['EUR', 'USD'], 'GBP/USD': ['GBP', 'USD'],
  'USD/JPY': ['USD', 'JPY'], 'USD/CHF': ['USD', 'CHF'],
  'AUD/USD': ['AUD', 'USD'], 'NZD/USD': ['NZD', 'USD'],
  'USD/CAD': ['USD', 'CAD']
});

function cleanXmlValue(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlTag(block, tagName) {
  const escaped = tagName.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp('<' + escaped + '\\b[^>]*>([\\s\\S]*?)<\\/' + escaped + '\\s*>', 'i'));
  return match ? cleanXmlValue(match[1]) : '';
}

function extractXmlLink(block, feedUrl, allowedHost) {
  const linkTag = block.match(/<link\b([^>]*)>([\s\S]*?)<\/link\s*>/i);
  let raw = '';
  if (linkTag) {
    const href = linkTag[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    raw = href ? href[1] : cleanXmlValue(linkTag[2]);
  }
  if (!raw) {
    const alternate = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
    raw = alternate ? alternate[1] : '';
  }
  if (!raw) {
    const about = block.match(/\brdf:about\s*=\s*["']([^"']+)["']/i);
    raw = about ? about[1] : '';
  }
  try {
    const url = new URL(raw, feedUrl);
    if (url.protocol === 'http:' && allowedHost === 'boj.or.jp') url.protocol = 'https:';
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' ||
        (hostname !== allowedHost && !hostname.endsWith('.' + allowedHost))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseOfficialFeedXml(xml, source, now = Date.now()) {
  if (typeof xml !== 'string' || !xml.trim() || xml.length > MAX_FEED_BYTES) {
    throw new Error('central_bank_feed_invalid_size');
  }
  if (!/<(?:rss|rdf:RDF|feed)\b/i.test(xml)) {
    throw new Error('central_bank_feed_invalid_xml_root');
  }
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1\s*>/gi)].map(match => match[0]);
  const items = [];
  const seen = new Set();
  for (const block of blocks) {
    const title = extractXmlTag(block, 'title');
    const description = extractXmlTag(block, 'description') ||
      extractXmlTag(block, 'summary') ||
      extractXmlTag(block, 'content:encoded') ||
      extractXmlTag(block, 'content');
    const dateText = extractXmlTag(block, 'pubDate') ||
      extractXmlTag(block, 'dc:date') ||
      extractXmlTag(block, 'published') ||
      extractXmlTag(block, 'updated') ||
      extractXmlTag(block, 'date');
    const publishedAt = Date.parse(dateText);
    const url = extractXmlLink(block, source.url, source.host);
    if (!title || !Number.isFinite(publishedAt) || publishedAt > now + 5 * 60 * 1000 || !url) continue;
    const ageDays = Math.max(0, (now - publishedAt) / 86400000);
    if (ageDays > MAX_FEED_ITEM_AGE_DAYS) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      currency: source.currency,
      centralBank: source.bank,
      feedName: source.feed,
      title: title.slice(0, 260),
      description: description.slice(0, 1400),
      url,
      publishedAt: new Date(publishedAt).toISOString(),
      ageHours: Math.round((now - publishedAt) / 3600000 * 10) / 10,
      source: 'OFFICIAL_CENTRAL_BANK'
    });
    if (items.length >= MAX_ITEMS_PER_FEED) break;
  }
  return items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function classifyPolicyNews(item) {
  const text = String(item && item.title || '') + ' ' + String(item && item.description || '');
  const positive = [];
  const negative = [];

  if (/\b(?:raises?|hikes?|increases?|lifts?)\b[^.]{0,90}\b(?:policy |interest |bank |cash |official )?rates?\b|\b(?:policy |interest |bank |cash |official )?rates?\b[^.]{0,90}\b(?:raised|hiked|increased|lifted)\b|\brate hikes?\b|\bhike rates?\b/i.test(text)) positive.push('POLICY_RATE_INCREASE');
  if (/\b(?:cuts?|lowers?|reduces?|eases?)\b[^.]{0,90}\b(?:policy |interest |bank |cash |official )?rates?\b|\b(?:policy |interest |bank |cash |official )?rates?\b[^.]{0,90}\b(?:cut|lowered|reduced)\b|\brate cuts?\b|\bcut rates?\b/i.test(text)) negative.push('POLICY_RATE_DECREASE');
  if (/\bhawkish\b|\bhigher for longer\b|\bfurther (?:monetary )?tightening\b|\badditional tightening\b|\bmore restrictive (?:monetary )?policy\b/i.test(text)) positive.push('HAWKISH_POLICY_LANGUAGE');
  if (/\bdovish\b|\bpolicy easing\b|\beasing cycle\b|\bmore accommodative\b|\bmonetary accommodation\b|\bexpect(?:s|ed)? rate cuts?\b/i.test(text)) negative.push('DOVISH_POLICY_LANGUAGE');
  if (/\b(?:intervention|intervene)\b[^.]{0,100}\b(?:support|defend|strengthen|buy)\b[^.]{0,50}\b(?:currency|exchange rate|yen|franc|pound|euro|dollar)\b/i.test(text) ||
      /\b(?:support|defend|strengthen)\b[^.]{0,70}\b(?:currency|exchange rate|yen|franc|pound|euro|dollar)\b[^.]{0,50}\b(?:intervention|intervene)\b/i.test(text)) positive.push('CURRENCY_SUPPORT_INTERVENTION');
  if (/\b(?:intervention|intervene)\b[^.]{0,100}\b(?:sell|selling)\b[^.]{0,50}\b(?:currency|yen|franc|pound|euro|dollar)\b/i.test(text)) negative.push('CURRENCY_SELLING_INTERVENTION');

  const positiveUnique = [...new Set(positive)];
  const negativeUnique = [...new Set(negative)];
  if (positiveUnique.length && negativeUnique.length) {
    return { direction: 'MIXED', score: 0, categories: [...positiveUnique, ...negativeUnique], conflict: true };
  }
  if (positiveUnique.length) return { direction: 'BULLISH', score: 1, categories: positiveUnique, conflict: false };
  if (negativeUnique.length) return { direction: 'BEARISH', score: -1, categories: negativeUnique, conflict: false };
  return { direction: 'UNSCORED', score: null, categories: [], conflict: false };
}

function buildCurrencyNewsContext(currency, sourceResults, now = Date.now()) {
  const relatedFeeds = sourceResults.filter(result => result.currency === currency);
  const connectedFeeds = relatedFeeds.filter(result => result.status === 'CONNECTED');
  const items = relatedFeeds.flatMap(result => result.items || [])
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const uniqueItems = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const classification = classifyPolicyNews(item);
    const ageDays = Math.max(0, (now - Date.parse(item.publishedAt)) / 86400000);
    uniqueItems.push({
      ...item,
      ageDays: Math.round(ageDays * 10) / 10,
      classification
    });
  }

  const scored = uniqueItems.filter(item =>
    item.classification.direction !== 'UNSCORED' &&
    item.classification.direction !== 'MIXED' &&
    item.ageDays <= MAX_NEWS_AGE_DAYS
  );
  let weightedSum = 0, totalWeight = 0;
  const halfLifeDays = 5;
  for (const item of scored) {
    const weight = Math.exp(-Math.LN2 * item.ageDays / halfLifeDays);
    weightedSum += item.classification.score * weight;
    totalWeight += weight;
  }
  const score = totalWeight > 0 ? weightedSum / totalWeight : null;
  let bias = 'MIXED';
  let status = 'NO_EXPLICIT_POLICY_SIGNAL';
  if (!connectedFeeds.length) {
    status = 'UNAVAILABLE';
    bias = 'WAIT';
  } else if (Number.isFinite(score)) {
    status = 'SCORED';
    if (score >= 0.25) bias = 'BULLISH';
    else if (score <= -0.25) bias = 'BEARISH';
  } else if (!uniqueItems.length) {
    status = 'NO_RECENT_PUBLICATIONS';
  }

  return {
    currency,
    centralBank: relatedFeeds[0] ? relatedFeeds[0].bank : null,
    sourceStatus: !connectedFeeds.length ? 'UNAVAILABLE' : connectedFeeds.length === relatedFeeds.length ? 'CONNECTED' : 'PARTIAL',
    connectedFeeds: connectedFeeds.length,
    expectedFeeds: relatedFeeds.length,
    itemCount: uniqueItems.length,
    policyRelevantCount: scored.length,
    latestPublishedAt: uniqueItems[0] ? uniqueItems[0].publishedAt : null,
    latestAgeDays: uniqueItems[0] ? uniqueItems[0].ageDays : null,
    bias,
    score: Number.isFinite(score) ? Math.round(score * 1000) / 1000 : null,
    scoredHeadlines: scored.slice(0, 8),
    recentHeadlines: uniqueItems.slice(0, 8)
  };
}

function buildPairCentralBankNewsContext(aggregate, pair) {
  const pairCurrencies = PAIR_CURRENCIES[pair];
  if (!pairCurrencies) return { pair, status: 'UNAVAILABLE', direction: 'WAIT', signalEligible: false };
  const [baseCurrency, quoteCurrency] = pairCurrencies;
  const currencies = aggregate && aggregate.currencies || {};
  const base = currencies[baseCurrency] || null;
  const quote = currencies[quoteCurrency] || null;
  const bothConnected = base && quote &&
    base.sourceStatus !== 'UNAVAILABLE' && quote.sourceStatus !== 'UNAVAILABLE';
  const bothScored = bothConnected &&
    Number.isFinite(base.score) && Number.isFinite(quote.score);

  let pairScore = null;
  let direction = 'WAIT';
  let status = !bothConnected ? 'PARTIAL_SOURCE' : 'NO_EXPLICIT_POLICY_SIGNAL';
  if (bothScored) {
    pairScore = base.score - quote.score;
    direction = pairScore >= 0.25 ? 'BULLISH' : pairScore <= -0.25 ? 'BEARISH' : 'MIXED';
    status = 'SCORED';
  } else if (bothConnected) {
    direction = 'MIXED';
    if (base.policyRelevantCount || quote.policyRelevantCount) status = 'PARTIAL_POLICY_SIGNAL';
  }

  const pairItems = [...(base ? base.scoredHeadlines : []), ...(quote ? quote.scoredHeadlines : [])]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 8);
  return {
    pair, baseCurrency, quoteCurrency, status, direction,
    score: Number.isFinite(pairScore) ? Math.round(pairScore * 1000) / 1000 : null,
    baseCurrencyContext: base, quoteCurrencyContext: quote,
    recentPolicyHeadlines: pairItems,
    signalEligible: false,
    methodology: 'Pair context is the difference between explicit official central-bank policy headlines scored for the base and quote currencies. Explicit rate hikes/hawkish language are positive; cuts/dovish language are negative. Unclassified headlines do not vote. This is a heuristic and not a calibrated trade signal.'
  };
}

async function fetchOneOfficialFeed(source, now = Date.now(), fetchImpl = fetch) {
  try {
    const response = await fetchImpl(source.url, {
      headers: {
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': 'PARTHAVI-FOREX-DATA-API/1.2 (+https://parthavi-forex-trade-desk-pro-2-0.onrender.com)'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      return {
        currency: source.currency, bank: source.bank, feed: source.feed, url: source.url,
        status: 'UNAVAILABLE', httpStatus: response.status, items: [],
        error: 'HTTP_' + response.status
      };
    }
    const finalUrl = new URL(response.url || source.url);
    const finalHost = finalUrl.hostname.toLowerCase();
    if (finalUrl.protocol !== 'https:' ||
        (finalHost !== source.host && !finalHost.endsWith('.' + source.host))) {
      return {
        currency: source.currency, bank: source.bank, feed: source.feed, url: source.url,
        status: 'UNAVAILABLE', httpStatus: response.status, items: [],
        error: 'REDIRECTED_OUTSIDE_OFFICIAL_HOST'
      };
    }
    const xml = await response.text();
    const items = parseOfficialFeedXml(xml, source, now);
    return {
      currency: source.currency, bank: source.bank, feed: source.feed, url: source.url,
      status: 'CONNECTED', httpStatus: response.status,
      fetchedAt: new Date(now).toISOString(), items
    };
  } catch (error) {
    return {
      currency: source.currency, bank: source.bank, feed: source.feed, url: source.url,
      status: 'UNAVAILABLE', items: [],
      error: String(error && error.name === 'TimeoutError' ? 'TIMEOUT' : error && error.message || 'FETCH_ERROR').slice(0, 120)
    };
  }
}

async function fetchCentralBankNews(now = Date.now(), fetchImpl = fetch) {
  const sourceResults = await Promise.all(
    CENTRAL_BANK_NEWS_FEEDS.map(source => fetchOneOfficialFeed(source, now, fetchImpl))
  );
  const currencies = {};
  for (const currency of ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD']) {
    currencies[currency] = buildCurrencyNewsContext(currency, sourceResults, now);
  }
  const availableCurrencies = Object.values(currencies).filter(value => value.sourceStatus !== 'UNAVAILABLE').length;
  const connectedFeeds = sourceResults.filter(value => value.status === 'CONNECTED').length;
  const pairs = Object.fromEntries(Object.keys(PAIR_CURRENCIES).map(pair => [
    pair, buildPairCentralBankNewsContext({ currencies }, pair)
  ]));
  return {
    ok: availableCurrencies > 0,
    provider: 'Official central-bank RSS / Atom feeds',
    status: availableCurrencies === 8 ? 'CONNECTED' : availableCurrencies > 0 ? 'PARTIAL' : 'UNAVAILABLE',
    availableCurrencies,
    expectedCurrencies: 8,
    connectedFeeds,
    expectedFeeds: CENTRAL_BANK_NEWS_FEEDS.length,
    fetchedAt: new Date(now).toISOString(),
    currencies, pairs,
    feeds: sourceResults.map(result => ({
      currency: result.currency, bank: result.bank, feed: result.feed, url: result.url,
      status: result.status, httpStatus: result.httpStatus || null,
      itemCount: result.items.length, error: result.error || null,
      fetchedAt: result.fetchedAt || null
    })),
    signalEligible: false,
    disclaimer: 'Official central-bank publication context only. Only explicit rate changes and clearly stated hawkish/dovish policy language receive a directional research score. Administrative, generic economic or unclassified headlines do not vote. Feed publication is not a live market quote or calibrated forecast.'
  };
}

module.exports = {
  CENTRAL_BANK_NEWS_CACHE_MS, CENTRAL_BANK_NEWS_FEEDS, PAIR_CURRENCIES,
  cleanXmlValue, parseOfficialFeedXml, classifyPolicyNews,
  buildCurrencyNewsContext, buildPairCentralBankNewsContext, fetchCentralBankNews
};
