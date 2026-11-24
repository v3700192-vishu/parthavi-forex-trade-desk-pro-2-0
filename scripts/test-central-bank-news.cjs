'use strict';

const assert = require('node:assert/strict');
const {
  CENTRAL_BANK_NEWS_FEEDS,
  parseOfficialFeedXml,
  classifyPolicyNews,
  fetchCentralBankNews
} = require('../central-bank-news');

const now = Date.parse('2026-11-24T12:00:00.000Z');
assert.equal(CENTRAL_BANK_NEWS_FEEDS.length, 9, 'seven official banks plus two RBA feeds');
assert.equal(new Set(CENTRAL_BANK_NEWS_FEEDS.map(feed => feed.currency)).size, 8);
const source = CENTRAL_BANK_NEWS_FEEDS.find(item => item.currency === 'USD');

const rss = '<?xml version="1.0"?>\n<rss version="2.0"><channel><item>' +
  '<title><![CDATA[Federal Reserve raises policy rate by 25 basis points]]></title>' +
  '<link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261124a.htm]]></link>' +
  '<description><![CDATA[The FOMC raised the target range for the federal funds rate.]]></description>' +
  '<pubDate>Tue, 24 Nov 2026 10:00:00 GMT</pubDate>' +
  '</item></channel></rss>';
const parsed = parseOfficialFeedXml(rss, source, now);
assert.equal(parsed.length, 1);
assert.match(parsed[0].title, /raises policy rate/);
assert.equal(parsed[0].currency, 'USD');
assert.equal(parsed[0].url, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261124a.htm');
assert.equal(parsed[0].ageHours, 2);

const atomSource = CENTRAL_BANK_NEWS_FEEDS.find(item => item.currency === 'GBP');
const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry>' +
  '<title>Bank of England signals higher for longer policy rates</title>' +
  '<link href="https://www.bankofengland.co.uk/news/2026/november/policy-outlook"/>' +
  '<updated>2026-11-24T10:00:00Z</updated>' +
  '<summary>Policy is expected to remain restrictive.</summary>' +
  '</entry></feed>';
const atomItems = parseOfficialFeedXml(atom, atomSource, now);
assert.equal(atomItems.length, 1);
assert.match(atomItems[0].url, /policy-outlook/);

const rdfSource = CENTRAL_BANK_NEWS_FEEDS.find(item => item.currency === 'CAD');
const rdf = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<item rdf:about="https://www.bankofcanada.ca/2026/11/rate-decision/">' +
  '<title>Bank of Canada cuts its policy rate by 25 basis points</title>' +
  '<link>https://www.bankofcanada.ca/2026/11/rate-decision/</link>' +
  '<dc:date>2026-11-24T10:00:00Z</dc:date>' +
  '</item></rdf:RDF>';
const rdfItems = parseOfficialFeedXml(rdf, rdfSource, now);
assert.equal(rdfItems.length, 1);
assert.match(rdfItems[0].title, /cuts its policy rate/);

const unsafe = rss.replace('https://www.federalreserve.gov/newsevents/pressreleases/monetary20261124a.htm',
  'https://evil.example/fake');
assert.equal(parseOfficialFeedXml(unsafe, source, now).length, 0);
const past = rss.replace('Tue, 24 Nov 2026 10:00:00 GMT', 'Tue, 01 Sep 2026 10:00:00 GMT');
assert.equal(parseOfficialFeedXml(past, source, now).length, 0);

assert.equal(classifyPolicyNews({ title: 'Bank of Canada raises the policy rate by 25 basis points' }).direction, 'BULLISH');
assert.equal(classifyPolicyNews({ title: 'ECB cuts its policy rate by 25 basis points' }).direction, 'BEARISH');
assert.equal(classifyPolicyNews({ title: 'Fed signals higher for longer rates' }).direction, 'BULLISH');
assert.equal(classifyPolicyNews({ title: 'RBNZ moves to a dovish easing cycle' }).direction, 'BEARISH');
assert.equal(classifyPolicyNews({ title: 'Central bank reports a new office building' }).direction, 'UNSCORED');
assert.equal(classifyPolicyNews({ title: 'Central bank raises rates but signals rate cuts soon' }).direction, 'MIXED');

const testHeadlines = {
  USD: 'Federal Reserve signals higher for longer policy rates',
  EUR: 'European Central Bank cuts its policy rate by 25 basis points',
  GBP: 'Bank of England raises the policy rate by 25 basis points',
  JPY: 'Bank of Japan signals a dovish easing cycle',
  CHF: 'Swiss National Bank uses hawkish policy language',
  AUD: 'Reserve Bank of Australia raises its cash rate',
  NZD: 'Reserve Bank of New Zealand cuts its official cash rate',
  CAD: 'Bank of Canada raises its policy rate'
};

(async () => {
  const fakeFetch = async input => {
    const url = String(input);
    const feed = CENTRAL_BANK_NEWS_FEEDS.find(item => item.url === url);
    assert.ok(feed, 'fetch must use one of the fixed allowlisted official feeds');
    const title = testHeadlines[feed.currency];
    const xml = '<rss version="2.0"><channel><item><title>' + title +
      '</title><link>https://' + feed.host + '/test/' + feed.currency.toLowerCase() +
      '</link><description>Official monetary policy announcement.</description>' +
      '<pubDate>Tue, 24 Nov 2026 10:00:00 GMT</pubDate>' +
      '</item></channel></rss>';
    return { ok: true, status: 200, text: async () => xml };
  };

  const live = await fetchCentralBankNews(now, fakeFetch);
  assert.equal(live.status, 'CONNECTED');
  assert.equal(live.availableCurrencies, 8);
  assert.equal(live.expectedCurrencies, 8);
  assert.equal(live.connectedFeeds, CENTRAL_BANK_NEWS_FEEDS.length);
  assert.equal(live.currencies.USD.bias, 'BULLISH');
  assert.equal(live.currencies.EUR.bias, 'BEARISH');
  assert.equal(live.pairs['EUR/USD'].direction, 'BEARISH',
    'dovish EUR and hawkish USD context should point lower in EUR/USD');
  assert.equal(live.pairs['USD/JPY'].direction, 'BULLISH',
    'hawkish USD and dovish JPY context should point higher in USD/JPY');
  assert.equal(live.pairs['NZD/USD'].direction, 'BEARISH',
    'dovish NZD and hawkish USD context should point lower in NZD/USD');
  assert.equal(live.pairs['EUR/USD'].signalEligible, false);

  const redirectFetch = async input => {
    if (String(input) === source.url) {
      return { ok:true, status:200, url:'https://evil.example/redirect', text:async()=>rss };
    }
    return fakeFetch(input);
  };
  const redirected = await fetchCentralBankNews(now, redirectFetch);
  assert.equal(redirected.currencies.USD.sourceStatus, 'UNAVAILABLE');
  assert.equal(redirected.pairs['EUR/USD'].direction, 'WAIT',
    'a feed redirected outside its official host must not create a currency policy score');

  const missingFetch = async input => {
    if (String(input).includes('rbnz.govt.nz')) {
      return { ok: false, status: 503, text: async () => '' };
    }
    return fakeFetch(input);
  };
  const partial = await fetchCentralBankNews(now, missingFetch);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.availableCurrencies, 7);
  assert.equal(partial.currencies.NZD.sourceStatus, 'UNAVAILABLE');
  assert.equal(partial.pairs['NZD/USD'].direction, 'WAIT');

  assert.throws(() => parseOfficialFeedXml('<html>not an XML feed</html>', source, now), /invalid_xml_root/);
  console.log('Official central-bank feeds, RSS/RDF/Atom parsers, policy-language scoring, pair orientation and missing-source safeguards passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});