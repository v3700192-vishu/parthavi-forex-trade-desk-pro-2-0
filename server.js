/**
 * PARTHAVI FOREX DATA API
 * Biquote public feed gateway: quote snapshots + closed OHLC candles.
 * All provider data is indicative; stale/closed/invalid data is never signal-safe.
 */
'use strict';

const { analyseDirection, walkForward, aggregateDirectionalSentiment } = require('./shadow-engine');
const { buildCftcPositioning, CURRENCY_CONTRACTS } = require('./cftc-positioning');
const { buildGlobalRiskContext, buildFundamentalContext } = require('./fundamental-context');
const { CENTRAL_BANK_NEWS_CACHE_MS, fetchCentralBankNews, buildPairCentralBankNewsContext } = require('./central-bank-news');
const { BIS_AREAS, parseBISPolicyCsv, buildBISPolicyContext, buildPolicyRatePairContext } = require('./central-bank-policy');
const {
  startIndependentSource, selectIndependentPair, getIndependentQuote,
  getIndependentSourceStatus, compareIndependentQuotes
} = require('./independent-source');

const http = require('node:http');
const { URL } = require('node:url');
const {
  normaliseSiftingQuote, normaliseSiftingBars, aggregateHourlyBarsTo4H
} = require('./independent-source');

const PORT = Number(process.env.PORT || 10000);
const PROVIDER = 'Biquote';
const PROVIDER_BASE = 'https://biquote.io';
const SIFTING_REST_BASE = 'https://api.sifting.io';
const SIFTING_REST_FALLBACK_ENABLED = process.env.SIFTINGIO_REST_FALLBACK === 'true';
const SIFTINGIO_WS_WATCHLIST_ENABLED = process.env.SIFTINGIO_WS_WATCHLIST === 'true';
const SIFTINGIO_WS_FIRST_QUOTES_ENABLED = process.env.SIFTINGIO_WS_FIRST_QUOTES === 'true';
const SITE_ORIGIN = 'https://parthavi-forex-trade-desk-pro-2-0.onrender.com';
const PAIRS = new Set(['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD']);
const INTERVALS = new Map([
  ['5M', { upstream:'5m', seconds:300, maxAge:900, limit:288 }],
  ['15M',{ upstream:'15m',seconds:900, maxAge:2400,limit:192 }],
  ['30M',{ upstream:'30m',seconds:1800,maxAge:3600,limit:192 }],
  ['1H', { upstream:'1h', seconds:3600,maxAge:7200,limit:168 }],
  ['4H', { upstream:'4h', seconds:14400,maxAge:28800,limit:180 }]
]);
const QUOTE_CACHE_MS = 4000;
const CANDLE_CACHE_MS = 60000;
const ECB_REFERENCE_BASE = 'https://api.frankfurter.dev';
const REFERENCE_CURRENCIES = ['USD','GBP','JPY','CHF','AUD','NZD','CAD'];
const REFERENCE_PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD'];
const REFERENCE_CACHE_MS = 15 * 60 * 1000;
const FED_REFERENCE_CACHE_MS = 6 * 60 * 60 * 1000;
const CFTC_POSITIONING_CACHE_MS = 6 * 60 * 60 * 1000;
const BIS_POLICY_CACHE_MS = 6 * 60 * 60 * 1000;
const GLOBAL_RISK_CACHE_MS = 6 * 60 * 60 * 1000;
const NEWS_CACHE_MS = 5 * 60 * 1000;
const OFFICIAL_CENTRAL_BANK_NEWS_CACHE_MS = CENTRAL_BANK_NEWS_CACHE_MS;
const CALENDAR_CACHE_MS = 15 * 60 * 1000;
const SHADOW_CACHE_MS = 60 * 1000;
const RESEARCH_CANDLE_CACHE_MS = 6 * 60 * 60 * 1000;
const SIFTING_REST_MIN_INTERVAL_MS = 1250;
const SIFTING_REST_MAX_RETRIES = 1;
const SIFTING_REST_MAX_INLINE_RETRY_MS = 15000;
let siftingRestQueue = Promise.resolve();
let siftingNextRequestAt = 0;
const siftingRestUsage = {
  rateLimit: null, rateRemaining: null,
  quotaLimit: null, quotaUsed: null, quotaRemaining: null,
  lastStatus: null, lastAt: null, retryAfterSeconds: null
};
const researchCandleCache = new Map();
const researchCandleInflight = new Map();
const FED_H10_SERIES = [
  ['EUR/USD','DEXUSEU'],
  ['GBP/USD','DEXUSUK'],
  ['USD/JPY','DEXJPUS'],
  ['USD/CHF','DEXSZUS'],
  ['AUD/USD','DEXUSAL'],
  ['NZD/USD','DEXUSNZ'],
  ['USD/CAD','DEXCAUS']
];
let referenceCache = null;
let fedReferenceCache = null;
let cftcPositioningCache = null;
let bisPolicyCache = null;
let globalRiskCache = null;
let newsCache = null;
let officialCentralBankNewsCache = null;
let officialCentralBankNewsInflight = null;
let calendarCache = null;
const shadowEngineCache = new Map();
const quoteCache = new Map();
const candleCache = new Map();
const requestWindows = new Map();
const PER_IP_PER_MINUTE = 90;

function respond(res, status, body, origin) {
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Access-Control-Allow-Origin':origin || SITE_ORIGIN,
    'Vary':'Origin',
    'X-Content-Type-Options':'nosniff'
  });
  res.end(JSON.stringify(body));
}
function allowedOrigin(req,res) {
  const origin=req.headers.origin;
  const local=/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  if(origin && origin!==SITE_ORIGIN && !local.test(origin)) {
    respond(res,403,{ok:false,error:'origin_not_allowed'},SITE_ORIGIN);
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin',origin || SITE_ORIGIN);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  return true;
}
function allowRequest(ip) {
  const now=Date.now(), key=ip || 'unknown';
  let state=requestWindows.get(key);
  if(!state || now-state.start>=60000) state={start:now,count:0};
  state.count+=1;
  requestWindows.set(key,state);
  if(requestWindows.size>5000) {
    for(const [k,v] of requestWindows) if(now-v.start>120000) requestWindows.delete(k);
  }
  return state.count<=PER_IP_PER_MINUTE;
}
function normalisePair(value) {
  const pair=String(value || '').toUpperCase().replace(/\s/g,'');
  if(pair.includes('/')) return PAIRS.has(pair)?pair:null;
  if(pair.length===6) {
    const candidate=pair.slice(0,3)+'/'+pair.slice(3);
    return PAIRS.has(candidate)?candidate:null;
  }
  return null;
}
function symbolFor(pair) { return pair.replace('/',''); }
function parseTimestamp(value) {
  const n=Date.parse(value);
  return Number.isFinite(n)?n:NaN;
}
async function providerJson(url) {
  const response=await fetch(url,{headers:{'Accept':'application/json'},signal:AbortSignal.timeout(12000)});
  let data=null;
  try { data=await response.json(); } catch { /* handled below */ }
  if(!response.ok) {
    const e=new Error('provider_http_'+response.status);
    e.statusCode=response.status===404?404:502;
    throw e;
  }
  if(!data || typeof data!=='object' || data.message && !data.symbol && !data.bars) {
    const e=new Error(String(data && (data.message || data.error) || 'provider_invalid_response').slice(0,160));
    e.statusCode=502;
    throw e;
  }
  return data;
}
function safeError(error) {
  return String(error && error.message || 'upstream_unavailable').replace(/[\r\n]/g,' ').slice(0,180);
}
function sleepMs(ms) {
  return new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));
}
function numericHeader(headers,name) {
  const raw=headers.get(name);
  if(raw===null||raw==='') return null;
  const value=Number(raw);
  return Number.isFinite(value)?value:null;
}
function scheduleSiftingRest(work) {
  const task=siftingRestQueue.then(async()=>{
    const waitMs=Math.max(0,siftingNextRequestAt-Date.now());
    if(waitMs>0) await sleepMs(waitMs);
    try {
      return await work();
    } finally {
      // Keep the free-tier REST burst below its 60 requests/minute ceiling.
      siftingNextRequestAt=Date.now()+SIFTING_REST_MIN_INTERVAL_MS;
    }
  });
  siftingRestQueue=task.then(()=>undefined,()=>undefined);
  return task;
}
async function siftingJson(url, timeoutMs = 15000) {
  const key=process.env.SIFTINGIO_API_KEY;
  if(!key) { const e=new Error('siftingio_api_key_not_configured');e.statusCode=503;throw e; }
  return scheduleSiftingRest(async()=>{
    for(let attempt=0;attempt<=SIFTING_REST_MAX_RETRIES;attempt++) {
      const response=await fetch(url,{
        headers:{'Accept':'application/json','Accept-Encoding':'gzip','X-API-Key':key},
        signal:AbortSignal.timeout(timeoutMs)
      });
      let data=null;
      try { data=await response.json(); } catch { /* handled below */ }

      siftingRestUsage.rateLimit=numericHeader(response.headers,'x-ratelimit-limit');
      siftingRestUsage.rateRemaining=numericHeader(response.headers,'x-ratelimit-remaining');
      siftingRestUsage.quotaLimit=numericHeader(response.headers,'x-quota-limit');
      siftingRestUsage.quotaUsed=numericHeader(response.headers,'x-quota-used');
      siftingRestUsage.quotaRemaining=numericHeader(response.headers,'x-quota-remaining');
      siftingRestUsage.lastStatus=response.status;
      siftingRestUsage.lastAt=new Date().toISOString();

      if(!response.ok) {
        const code=String(data&&data.error||'siftingio_http_'+response.status).slice(0,100);
        const retryAfterHeader=response.headers.get('retry-after');
        const retryAfterValue=data&&data.retry_after!==undefined?data.retry_after:retryAfterHeader;
        const retryAfterSeconds=Number(retryAfterValue);
        siftingRestUsage.retryAfterSeconds=Number.isFinite(retryAfterSeconds)?retryAfterSeconds:null;

        // A burst limit is temporary; honour the provider's Retry-After once.
        // Monthly quota exhaustion is permanent until reset and is never retried.
        if(response.status===429 && code==='rate_limit_exceeded' &&
           attempt<SIFTING_REST_MAX_RETRIES && Number.isFinite(retryAfterSeconds) &&
           retryAfterSeconds>=0 && retryAfterSeconds*1000<=SIFTING_REST_MAX_INLINE_RETRY_MS) {
          await sleepMs(Math.max(1000,retryAfterSeconds*1000)+250);
          continue;
        }
        const detail=code==='monthly_quota_exceeded'
          ?code+'_used_'+String(data&&data.used)+'_of_'+String(data&&data.quota)
          :code+(Number.isFinite(retryAfterSeconds)?'_retry_after_'+retryAfterSeconds+'s':'');
        const e=new Error(detail.slice(0,160));
        e.statusCode=response.status===404?404:response.status===429?429:502;
        throw e;
      }
      if(!data||typeof data!=='object') {
        const e=new Error('siftingio_invalid_response');e.statusCode=502;throw e;
      }
      siftingRestUsage.retryAfterSeconds=null;
      return data;
    }
    const e=new Error('siftingio_retry_budget_exhausted');
    e.statusCode=429;
    throw e;
  });
}
async function getSiftingRestQuote(pair) {
  const url=new URL('/v1/last/quote/forex/'+symbolFor(pair),SIFTING_REST_BASE);
  const data=await siftingJson(url,10000);
  const normalized=normaliseSiftingQuote(pair,data);
  if(!normalized.ok) {
    const e=new Error('siftingio_quote_'+normalized.status.toLowerCase());e.statusCode=503;throw e;
  }
  const q=normalized.quote;
  return {
    ok:true,provider:'SiftingIO',pair,
    quote:{
      bid:q.bid,ask:q.ask,mid:q.mid,spread:q.spread,dayDiffPercent:null,
      timestamp:q.timestamp,source:q.source,marketState:q.marketState,
      stale:q.stale,ageSeconds:normalized.meta.quoteAgeSeconds
    },
    meta:{...normalized.meta,provider:'SiftingIO',fallbackFrom:'Biquote',safeToSignal:true,
      disclaimer:'SiftingIO aggregated indicative reference quote; not a broker executable price.'},
    fallbackFrom:'Biquote',
    fetchedAt:new Date().toISOString(),cache:'MISS'
  };
}
async function getQuote(pair) {
  const cacheKey=pair, cached=quoteCache.get(cacheKey);
  if(cached && Date.now()-cached.at<QUOTE_CACHE_MS) return {...cached.value,cache:'HIT'};
  try {
    const url=new URL('/api/'+symbolFor(pair),PROVIDER_BASE);
    const data=await providerJson(url);
    const bid=Number(data.bid),ask=Number(data.ask),mid=Number(data.mid),spread=Number(data.spread);
    const timestamp=parseTimestamp(data.timestamp || data.lastQuoteAt);
    const age=Number.isFinite(Number(data.quoteAgeSeconds))
      ?Math.max(0,Number(data.quoteAgeSeconds))
      :Number.isFinite(timestamp)?Math.max(0,Math.floor((Date.now()-timestamp)/1000)):Infinity;
    const numericValid=[bid,ask,mid,spread].every(Number.isFinite) && bid>0 && ask>=bid && mid>0 && spread>=0;
    const stale=Boolean(data.stale) || data.marketState!=='open' || age>300 || !Number.isFinite(timestamp);
    const result={
      ok:numericValid,provider:PROVIDER,pair,
      quote:{
        bid:numericValid?bid:null,ask:numericValid?ask:null,mid:numericValid?mid:null,spread:numericValid?spread:null,
        dayDiffPercent:data.marketState==='open' && data.dayDiffPercent!==null && data.dayDiffPercent!==undefined && Number.isFinite(Number(data.dayDiffPercent))?Number(data.dayDiffPercent):null,
        timestamp:Number.isFinite(timestamp)?new Date(timestamp).toISOString():null,
        source:String(data.source || 'Biquote feed').slice(0,100),
        marketState:String(data.marketState || 'unknown'),stale,ageSeconds:Number.isFinite(age)?age:null
      },
      meta:{
        freshness:!stale && numericValid?'FRESH':'STALE',safeToSignal:!stale && numericValid,
        quoteAgeSeconds:Number.isFinite(age)?age:null,provider:PROVIDER,
        disclaimer:'Indicative third-party broker-feed quote; not a guaranteed executable broker price.'
      },
      fetchedAt:new Date().toISOString(),cache:'MISS'
    };
    if(!numericValid) { const e=new Error('invalid_quote_fields');e.statusCode=422;throw e; }
    quoteCache.set(cacheKey,{at:Date.now(),value:result});
    return result;
  } catch(primaryError) {
    const streamQuote=independentQuoteAsApiQuote(pair);
    if(streamQuote.meta&&streamQuote.meta.freshness==='FRESH') {
      streamQuote.meta.fallbackFrom='Biquote REST via SiftingIO WebSocket';
      quoteCache.set(cacheKey,{at:Date.now(),value:streamQuote});
      return streamQuote;
    }
    if(SIFTINGIO_WS_FIRST_QUOTES_ENABLED && streamQuote.status==='NOT_SUBSCRIBED') {
      const e=new Error('pair_not_in_current_siftingio_websocket_subscription_set_select_pair_to_activate');
      e.statusCode=503;throw e;
    }
    if(!SIFTING_REST_FALLBACK_ENABLED) throw primaryError;
    try {
      const fallback=await getSiftingRestQuote(pair);
      fallback.meta.primaryError=safeError(primaryError);
      quoteCache.set(cacheKey,{at:Date.now(),value:fallback});
      return fallback;
    } catch(fallbackError) {
      fallbackError.primaryError=safeError(primaryError);
      throw fallbackError;
    }
  }
}

async function getEcbReferenceRates() {
  if(referenceCache && Date.now()-referenceCache.at<REFERENCE_CACHE_MS) {
    return {...referenceCache.value,cache:'HIT'};
  }
  const fromDate=new Date(Date.now()-14*86400000).toISOString().slice(0,10);
  const url=new URL('/v2/providers/ecb/rates',ECB_REFERENCE_BASE);
  url.searchParams.set('base','EUR');
  url.searchParams.set('quotes',REFERENCE_CURRENCIES.join(','));
  url.searchParams.set('from',fromDate);
  const response=await fetch(url,{headers:{'Accept':'application/json'},signal:AbortSignal.timeout(12000)});
  if(!response.ok) {
    const e=new Error('ecb_reference_http_'+response.status);
    e.statusCode=502;
    throw e;
  }
  const rows=await response.json();
  if(!Array.isArray(rows)) {
    const e=new Error('ecb_reference_invalid_response');
    e.statusCode=502;
    throw e;
  }
  const byDate=new Map();
  rows.forEach(row=>{
    const date=String(row.date||'').slice(0,10);
    const quote=String(row.quote||'').toUpperCase();
    const rate=Number(row.rate);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
       !REFERENCE_CURRENCIES.includes(quote) || !Number.isFinite(rate) || rate<=0) return;
    if(!byDate.has(date)) byDate.set(date,{});
    byDate.get(date)[quote]=rate;
  });
  const completeDates=[...byDate.keys()].filter(date=>
    REFERENCE_CURRENCIES.every(currency=>Number.isFinite(byDate.get(date)[currency])&&byDate.get(date)[currency]>0)
  ).sort();
  if(!completeDates.length) {
    const e=new Error('ecb_reference_no_complete_observation');
    e.statusCode=502;
    throw e;
  }
  const latestDate=completeDates[completeDates.length-1];
  const previousDate=completeDates.length>1?completeDates[completeDates.length-2]:null;
  const latest=byDate.get(latestDate);
  const previous=previousDate?byDate.get(previousDate):null;
  const crossRate=(pair,observation)=>{
    const [base,quote]=pair.split('/');
    const basePerEur=base==='EUR'?1:observation[base];
    const quotePerEur=quote==='EUR'?1:observation[quote];
    return Number.isFinite(basePerEur)&&basePerEur>0&&Number.isFinite(quotePerEur)&&quotePerEur>0
      ?quotePerEur/basePerEur:null;
  };
  const pairs=REFERENCE_PAIRS.map(pair=>{
    const rate=crossRate(pair,latest);
    const previousRate=previous?crossRate(pair,previous):null;
    return {
      pair,rate,
      previousRate,
      changePercent:Number.isFinite(rate)&&Number.isFinite(previousRate)&&previousRate>0
        ?(rate/previousRate-1)*100:null,
      date:latestDate,previousDate
    };
  });
  if(pairs.some(item=>!Number.isFinite(item.rate)||item.rate<=0)) {
    const e=new Error('ecb_reference_cross_rate_invalid');
    e.statusCode=502;
    throw e;
  }
  const today=new Date().toISOString().slice(0,10);
  const ageDays=Math.max(0,Math.floor((Date.parse(today+'T00:00:00Z')-Date.parse(latestDate+'T00:00:00Z'))/86400000));
  const result={
    ok:true,provider:'European Central Bank',relay:'Frankfurter API',
    base:'EUR',pairs,
    meta:{
      latestDate,previousDate,ageDays,
      freshness:ageDays<=4?'FRESH_REFERENCE':'STALE_REFERENCE',
      signalEligible:false,
      disclaimer:'ECB daily reference rates are macro/reference context only, not live quotes or executable prices. They are never an intraday trade signal.'
    },
    fetchedAt:new Date().toISOString(),cache:'MISS'
  };
  referenceCache={at:Date.now(),value:result};
  return result;
}

function parseFredCsv(text,seriesId) {
  if(typeof text!=='string'||text.length>1000000) {
    const e=new Error('fred_csv_invalid_size');e.statusCode=502;throw e;
  }
  const lines=text.trim().split(/\r?\n/);
  const header=(lines.shift()||'').split(',');
  if(header[0]!=='observation_date'||header[1]!==seriesId) {
    const e=new Error('fred_csv_invalid_header_'+seriesId);e.statusCode=502;throw e;
  }
  const observations=new Map();
  for(const line of lines) {
    const cells=line.split(',');
    const date=String(cells[0]||'').trim();
    const raw=String(cells[1]||'').trim();
    const value=Number(raw);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!raw||raw==='.'||!Number.isFinite(value)||value<=0)continue;
    observations.set(date,value);
  }
  return observations;
}
async function fetchFredSeries(seriesId,fromDate,toDate) {
  const url=new URL('/graph/fredgraph.csv','https://fred.stlouisfed.org');
  url.searchParams.set('id',seriesId);
  url.searchParams.set('cosd',fromDate);
  url.searchParams.set('coed',toDate);
  const response=await fetch(url,{headers:{'Accept':'text/csv'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) {
    const e=new Error('fred_'+seriesId+'_http_'+response.status);
    e.statusCode=502;throw e;
  }
  return parseFredCsv(await response.text(),seriesId);
}

async function getGlobalRiskContext() {
  if(globalRiskCache && Date.now()-globalRiskCache.at<GLOBAL_RISK_CACHE_MS) {
    return {...globalRiskCache.value,cache:'HIT'};
  }
  const toDate=new Date().toISOString().slice(0,10);
  const fromDate=new Date(Date.now()-45*86400000).toISOString().slice(0,10);
  const seriesIds=['DTWEXBGS','DGS2','DGS10','VIXCLS','DCOILWTICO'];
  const results=await Promise.allSettled(seriesIds.map(id=>fetchFredSeries(id,fromDate,toDate)));
  const series={},sourceErrors=[];
  results.forEach((result,index)=>{
    const id=seriesIds[index];
    if(result.status==='fulfilled') series[id]=result.value;
    else sourceErrors.push({seriesId:id,error:safeError(result.reason)});
  });
  const result=buildGlobalRiskContext(series);
  result.sourceErrors=sourceErrors;
  result.seriesWindowDays=45;
  result.cache='MISS';
  globalRiskCache={at:Date.now(),value:result};
  return result;
}

async function getFundamentalContext(pair) {
  const results=await Promise.allSettled([
    getGlobalRiskContext(),
    getCalendar(),
    getNews(),
    getOfficialCentralBankNews()
  ]);
  const globalRisk=results[0].status==='fulfilled'?results[0].value:null;
  const calendar=results[1].status==='fulfilled'?results[1].value:null;
  const news=results[2].status==='fulfilled'?results[2].value:null;
  const officialNews=results[3].status==='fulfilled'?results[3].value:null;
  const context=buildFundamentalContext({
    globalRisk,
    calendarItems:calendar&&Array.isArray(calendar.items)?calendar.items:[],
    newsItems:news&&Array.isArray(news.items)?news.items:[],
    pair
  });
  context.centralBankNews=officialNews
    ?buildPairCentralBankNewsContext(officialNews,pair)
    :{pair,status:'UNAVAILABLE',direction:'WAIT',signalEligible:false,reason:'OFFICIAL_CENTRAL_BANK_FEEDS_UNAVAILABLE'};
  context.centralBankNews.overallStatus=officialNews?officialNews.status:'UNAVAILABLE';
  context.centralBankNews.availableCurrencies=officialNews?officialNews.availableCurrencies:0;
  context.centralBankNews.expectedCurrencies=officialNews?officialNews.expectedCurrencies:8;
  context.centralBankNews.connectedFeeds=officialNews?officialNews.connectedFeeds:0;
  context.centralBankNews.expectedFeeds=officialNews?officialNews.expectedFeeds:9;
  context.centralBankNews.currencySources=officialNews?officialNews.currencies:{};
  context.centralBankNews.recentPolicyHeadlines=context.centralBankNews.recentPolicyHeadlines||[];
  context.sourceStatus={
    globalRisk:globalRisk?globalRisk.status:'UNAVAILABLE',
    calendar:calendar?'CONNECTED':'UNAVAILABLE',
    calendarItems:calendar&&Array.isArray(calendar.items)?calendar.items.length:0,
    news:news?'CONNECTED':'UNAVAILABLE',
    newsItems:news&&Array.isArray(news.items)?news.items.length:0,
    officialCentralBankNews:officialNews?officialNews.status:'UNAVAILABLE',
    officialCentralBankNewsCurrencies:officialNews?officialNews.availableCurrencies:0,
    officialCentralBankNewsFeeds:officialNews?officialNews.connectedFeeds:0
  };
  context.sourceErrors=[
    results[0].status==='rejected'?{source:'FRED',error:safeError(results[0].reason)}:null,
    results[1].status==='rejected'?{source:'CALENDAR',error:safeError(results[1].reason)}:null,
    results[2].status==='rejected'?{source:'NEWS',error:safeError(results[2].reason)}:null,
    results[3].status==='rejected'?{source:'OFFICIAL_CENTRAL_BANK_NEWS',error:safeError(results[3].reason)}:null
  ].filter(Boolean);
  context.fetchedAt=new Date().toISOString();
  return context;
}

async function getFederalReserveReferenceRates() {
  if(fedReferenceCache&&Date.now()-fedReferenceCache.at<FED_REFERENCE_CACHE_MS) {
    return {...fedReferenceCache.value,cache:'HIT'};
  }
  const today=new Date().toISOString().slice(0,10);
  const fromDate=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
  const seriesMaps=await Promise.all(FED_H10_SERIES.map(async([pair,seriesId])=>({
    pair,seriesId,observations:await fetchFredSeries(seriesId,fromDate,today)
  })));
  let commonDates=null;
  for(const item of seriesMaps) {
    const dates=new Set(item.observations.keys());
    commonDates=commonDates===null?dates:new Set([...commonDates].filter(date=>dates.has(date)));
  }
  const fedDates=[...(commonDates||[])].sort();
  if(!fedDates.length) {
    const e=new Error('fred_h10_no_common_observation');e.statusCode=502;throw e;
  }
  const latestFedDate=fedDates[fedDates.length-1];
  const ecbUrl=new URL('/v2/providers/ecb/rates',ECB_REFERENCE_BASE);
  ecbUrl.searchParams.set('base','EUR');
  ecbUrl.searchParams.set('quotes',REFERENCE_CURRENCIES.join(','));
  ecbUrl.searchParams.set('from',fromDate);
  ecbUrl.searchParams.set('to',latestFedDate);
  const ecbResponse=await fetch(ecbUrl,{headers:{'Accept':'application/json'},signal:AbortSignal.timeout(12000)});
  if(!ecbResponse.ok) {
    const e=new Error('ecb_overlap_http_'+ecbResponse.status);e.statusCode=502;throw e;
  }
  const ecbRows=await ecbResponse.json();
  if(!Array.isArray(ecbRows)) {
    const e=new Error('ecb_overlap_invalid_response');e.statusCode=502;throw e;
  }
  const ecbByDate=new Map();
  ecbRows.forEach(row=>{
    const date=String(row.date||'').slice(0,10);
    const quote=String(row.quote||'').toUpperCase();
    const rate=Number(row.rate);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||
       !REFERENCE_CURRENCIES.includes(quote)||!Number.isFinite(rate)||rate<=0)return;
    if(!ecbByDate.has(date))ecbByDate.set(date,{});
    ecbByDate.get(date)[quote]=rate;
  });
  const ecbDates=[...ecbByDate.keys()].sort();
  const latestEcbDate=ecbDates[ecbDates.length-1]||'none';
  const latestEcbRates=ecbByDate.get(latestEcbDate)||{};
  const commonComparisonDates=fedDates.filter(date=>{
    const rates=ecbByDate.get(date);
    return rates&&REFERENCE_CURRENCIES.every(currency=>Number.isFinite(rates[currency])&&rates[currency]>0);
  });
  if(!commonComparisonDates.length) {
    const e=new Error('fred_ecb_no_common_reference_date');e.statusCode=502;throw e;
  }
  const observationDate=commonComparisonDates[commonComparisonDates.length-1];
  const ecb=ecbByDate.get(observationDate);
  const fedPairs=seriesMaps.map(item=>{
    const fedRate=item.observations.get(observationDate);
    let ecbRate=null;
    const [base,quote]=item.pair.split('/');
    const basePerEur=base==='EUR'?1:ecb[base];
    const quotePerEur=quote==='EUR'?1:ecb[quote];
    if(Number.isFinite(basePerEur)&&basePerEur>0&&Number.isFinite(quotePerEur)&&quotePerEur>0) {
      ecbRate=quotePerEur/basePerEur;
    }
    const differencePercent=Number.isFinite(fedRate)&&Number.isFinite(ecbRate)&&ecbRate>0
      ?(fedRate/ecbRate-1)*100:null;
    return {pair:item.pair,series:item.seriesId,fedRate,ecbRate,differencePercent,date:observationDate};
  });
  if(fedPairs.some(item=>!Number.isFinite(item.fedRate)||!Number.isFinite(item.ecbRate))) {
    const e=new Error('fred_ecb_reference_pair_validation_failed');e.statusCode=502;throw e;
  }
  const ageDays=Math.max(0,Math.floor((Date.parse(today+'T00:00:00Z')-Date.parse(observationDate+'T00:00:00Z'))/86400000));
  const result={
    ok:true,provider:'Board of Governors of the Federal Reserve System · H.10',
    relay:'FRED graph CSV',pairs:fedPairs,
    meta:{
      observationDate,ageDays,
      freshness:ageDays<=10?'CURRENT_WEEKLY_REFERENCE':'STALE_WEEKLY_REFERENCE',
      frequency:'daily observations released weekly',
      signalEligible:false,
      disclaimer:'Federal Reserve H.10 noon buying rates are published weekly for the previous business week. They are compared with ECB reference rates on the same date. This is historical/reference validation only, not a live quote or intraday signal.'
    },
    fetchedAt:new Date().toISOString(),cache:'MISS'
  };
  fedReferenceCache={at:Date.now(),value:result};
  return result;
}

async function getOfficialCentralBankNews() {
  if (officialCentralBankNewsCache &&
      Date.now() - officialCentralBankNewsCache.at < OFFICIAL_CENTRAL_BANK_NEWS_CACHE_MS) {
    return { ...officialCentralBankNewsCache.value, cache: 'HIT' };
  }
  if (officialCentralBankNewsInflight) return officialCentralBankNewsInflight;
  officialCentralBankNewsInflight = fetchCentralBankNews()
    .then(result => {
      result.cache = 'MISS';
      officialCentralBankNewsCache = { at: Date.now(), value: result };
      return result;
    })
    .finally(() => { officialCentralBankNewsInflight = null; });
  return officialCentralBankNewsInflight;
}

async function getNews() {
  if(newsCache && Date.now()-newsCache.at<NEWS_CACHE_MS) return {...newsCache.value,cache:'HIT'};
  const url=new URL('/api/news/market',PROVIDER_BASE);
  url.searchParams.set('language','en');
  url.searchParams.set('country','US');
  url.searchParams.set('maxResults','10');
  const payload=await providerJson(url);
  if(!Array.isArray(payload)) {
    const e=new Error('news_feed_invalid_response');e.statusCode=422;throw e;
  }
  const items=payload.map(item=>{
    let articleUrl=null;
    try {
      const u=new URL(String(item.url||''));
      if(u.protocol==='https:') articleUrl=u.toString();
    } catch {}
    const published=Date.parse(String(item.publishedDate||''));
    if(!item.title || !articleUrl || !Number.isFinite(published)) return null;
    return {
      title:String(item.title).slice(0,260),
      description:String(item.description||'').slice(0,700),
      url:articleUrl,
      publisher:String(item.publisher||'Unknown').slice(0,100),
      publishedDate:new Date(published).toISOString(),
      country:String(item.country||'').slice(0,8),
      category:item.category?String(item.category).slice(0,80):null
    };
  }).filter(Boolean).sort((a,b)=>Date.parse(b.publishedDate)-Date.parse(a.publishedDate));
  const result={
    ok:true,provider:PROVIDER,items,
    fetchedAt:new Date().toISOString(),
    disclaimer:'Aggregated third-party news; headlines are context, not a directional trading signal.'
  };
  newsCache={at:Date.now(),value:result};
  return {...result,cache:'MISS'};
}
async function getCalendar() {
  if(calendarCache && Date.now()-calendarCache.at<CALENDAR_CACHE_MS) return {...calendarCache.value,cache:'HIT'};
  const url=new URL('/api/calendar/upcoming',PROVIDER_BASE);
  url.searchParams.set('importance','medium');
  url.searchParams.set('limit','100');
  const payload=await providerJson(url);
  if(!Array.isArray(payload)) {
    const e=new Error('calendar_feed_invalid_response');e.statusCode=422;throw e;
  }
  const items=payload.map(item=>{
    const t=Date.parse(String(item.time||''));
    if(!item.name || !Number.isFinite(t)) return null;
    return {
      id:String(item.id||'').slice(0,100),
      time:new Date(t).toISOString(),
      timeMode:String(item.timeMode||'tentative'),
      currency:String(item.currency||item.countryCode||'').slice(0,12),
      countryCode:String(item.countryCode||'').slice(0,8),
      name:String(item.name).slice(0,200),
      importance:String(item.importance||'unknown').toLowerCase(),
      type:String(item.type||'event').slice(0,32),
      actual:item.actual===null||item.actual===undefined?null:(Number.isFinite(Number(item.actual))?Number(item.actual):null),
      forecast:item.forecast===null||item.forecast===undefined?null:(Number.isFinite(Number(item.forecast))?Number(item.forecast):null),
      previous:item.previous===null||item.previous===undefined?null:(Number.isFinite(Number(item.previous))?Number(item.previous):null),
      revisedPrevious:item.revisedPrevious===null||item.revisedPrevious===undefined?null:(Number.isFinite(Number(item.revisedPrevious))?Number(item.revisedPrevious):null),
      unit:String(item.unit||'').slice(0,32),
      multiplier:String(item.multiplier||'').slice(0,32),
      source:String(item.source||'').slice(0,32)
    };
  }).filter(Boolean).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const result={
    ok:true,provider:PROVIDER,items,
    fetchedAt:new Date().toISOString(),
    disclaimer:'Economic calendar coverage depends on upstream country/source coverage. Null readings mean unpublished, not zero.'
  };
  calendarCache={at:Date.now(),value:result};
  return {...result,cache:'MISS'};
}

async function getSiftingCandles(pair,timeframe,spec) {
  const interval=timeframe==='4H'?'1h':spec.upstream;
  const intervalMs=timeframe==='5M'?300000:timeframe==='15M'?900000:timeframe==='30M'?1800000:3600000;
  const historyBars=2000;
  const start=new Date(Date.now()-(historyBars*intervalMs+intervalMs*3)).toISOString();
  const url=new URL('/v1/hist/forex/'+symbolFor(pair)+'/bars',SIFTING_REST_BASE);
  url.searchParams.set('start',start);
  url.searchParams.set('end',new Date().toISOString());
  url.searchParams.set('interval',interval);
  url.searchParams.set('order','asc');
  url.searchParams.set('limit',String(historyBars));
  const data=await siftingJson(url,25000);
  let candles=timeframe==='4H'
    ?aggregateHourlyBarsTo4H(normaliseSiftingBars(data,'1H',Date.now(),historyBars),Date.now(),Math.floor(historyBars/4))
    :normaliseSiftingBars(data,timeframe,Date.now(),historyBars);
  if(candles.length<30) {
    const e=new Error('siftingio_insufficient_closed_candles_'+candles.length);e.statusCode=422;throw e;
  }
  const last=candles[candles.length-1];
  const ageSeconds=Math.max(0,Math.floor((Date.now()-last.timestamp)/1000));
  const freshness=ageSeconds<=spec.maxAge?'FRESH':'STALE';
  return {
    ok:true,provider:'SiftingIO',pair,timeframe,interval:timeframe==='4H'?'4h':interval,
    meta:{
      symbol:symbolFor(pair),lastCandleAt:last.time,ageSeconds,candleCount:candles.length,
      freshness,freshnessWindowSeconds:spec.maxAge,safeToSignal:false,
      sourceInterval:interval,
      fallbackFrom:'Biquote',
      sourceMethod:timeframe==='4H'?'SiftingIO 1H closed OHLC bars aggregated into complete UTC 4H buckets':'SiftingIO historical closed OHLC bars; open candle excluded',
      disclaimer:'Aggregated indicative historical FX OHLC. Tick count is not traded currency volume; price basis may differ from brokers.'
    },
    candles,
    fetchedAt:new Date().toISOString(),cache:'MISS'
  };
}
async function getCandles(pair,timeframe) {
  const spec=INTERVALS.get(timeframe), cacheKey=pair+'|'+timeframe, cached=candleCache.get(cacheKey);
  const siftingTtl={
    '5M':9*60*1000,'15M':20*60*1000,'30M':30*60*1000,
    '1H':60*60*1000,'4H':4*60*60*1000
  };
  const cacheTtl=cached&&cached.value.provider==='SiftingIO'?(siftingTtl[timeframe]||CANDLE_CACHE_MS):CANDLE_CACHE_MS;
  if(cached && Date.now()-cached.at<cacheTtl) return {...cached.value,cache:'HIT'};
  let data;
  try {
    const url=new URL('/api/'+symbolFor(pair)+'/ohlc',PROVIDER_BASE);
    url.searchParams.set('interval',spec.upstream);
    url.searchParams.set('limit',String(spec.limit));
    data=await providerJson(url);
  } catch(primaryError) {
    if(!SIFTING_REST_FALLBACK_ENABLED) throw primaryError;
    try {
      const fallback=await getSiftingCandles(pair,timeframe,spec);
      fallback.meta.primaryError=safeError(primaryError);
      candleCache.set(cacheKey,{at:Date.now(),value:fallback});
      return fallback;
    } catch(fallbackError) {
      fallbackError.primaryError=safeError(primaryError);
      throw fallbackError;
    }
  }
  if(!Array.isArray(data.bars)) {
    const e=new Error('provider_candle_array_missing');e.statusCode=422;throw e;
  }
  const candles=data.bars.map(bar=>({
    time:bar.openTime,
    timestamp:parseTimestamp(bar.openTime),
    open:Number(bar.open),high:Number(bar.high),low:Number(bar.low),close:Number(bar.close),
    tickVolume:Number.isFinite(Number(bar.tickVolume))?Number(bar.tickVolume):null,
    isOpen:Boolean(bar.isOpen)
  })).filter(c=>!c.isOpen && Number.isFinite(c.timestamp) &&
    [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.open>0 && c.high>=Math.max(c.open,c.close,c.low) &&
    c.low<=Math.min(c.open,c.close,c.high))
   .sort((a,b)=>a.timestamp-b.timestamp);
  if(candles.length<30) {
    const e=new Error('insufficient_closed_candles');e.statusCode=422;throw e;
  }
  const last=candles[candles.length-1];
  const ageSeconds=Math.max(0,Math.floor((Date.now()-last.timestamp)/1000));
  const freshness=ageSeconds<=spec.maxAge?'FRESH':'STALE';
  const result={
    ok:true,provider:PROVIDER,pair,timeframe,interval:spec.upstream,
    meta:{
      symbol:data.symbol || symbolFor(pair),
      lastCandleAt:last.time,
      ageSeconds,candleCount:candles.length,
      freshness,freshnessWindowSeconds:spec.maxAge,
      safeToSignal:false,
      sourceMethod:'closed OHLC bars; open candle excluded',
      disclaimer:'Indicative aggregated mid-price candles. Single provider only; not sufficient alone for a trade signal.'
    },
    candles:candles.map(({isOpen,...c})=>c),
    fetchedAt:new Date().toISOString(),
    cache:'MISS'
  };
  candleCache.set(cacheKey,{at:Date.now(),value:result});
  return result;
}

async function getResearchCandles(pair,timeframe) {
  const key=pair+'|'+timeframe, cached=researchCandleCache.get(key);
  if(cached&&Date.now()-cached.at<RESEARCH_CANDLE_CACHE_MS) return {...cached.value,cache:'RESEARCH_HIT'};
  if(researchCandleInflight.has(key)) return {...await researchCandleInflight.get(key),cache:'RESEARCH_JOINED'};

  const work=(async()=>{
    let value=null;
    let researchError=null;
    // Prefer the longer SiftingIO history for backtesting only. Live candles used
    // by the directional engine continue to come from Biquote via getCandles().
    if(SIFTING_REST_FALLBACK_ENABLED && process.env.SIFTINGIO_API_KEY) {
      try {
        value=await getSiftingCandles(pair,timeframe,INTERVALS.get(timeframe));
        value.meta.researchOnly=true;
        value.meta.sourceRole='HISTORICAL_RESEARCH_ONLY';
        value.meta.fallbackFrom=null;
        value.meta.safeToSignal=false;
        value.meta.disclaimer='Longer SiftingIO indicative historical OHLC used only for walk-forward research and cross-pair context. Live timeframe decisions use the Biquote feed; this history is not a live vote or executable price.';
      } catch(error) {
        researchError=safeError(error);
      }
    }
    if(!value) {
      value=await getCandles(pair,timeframe);
      value.meta.researchOnly=true;
      value.meta.sourceRole='HISTORICAL_RESEARCH_FALLBACK';
      value.meta.safeToSignal=false;
      if(researchError) value.meta.researchPrimaryError=researchError;
    }
    researchCandleCache.set(key,{at:Date.now(),value});
    if(researchCandleCache.size>100) {
      for(const [entry,item] of researchCandleCache) {
        if(Date.now()-item.at>RESEARCH_CANDLE_CACHE_MS) researchCandleCache.delete(entry);
      }
    }
    return value;
  })().finally(()=>researchCandleInflight.delete(key));

  researchCandleInflight.set(key,work);
  return {...await work,cache:'RESEARCH_MISS'};
}
function independentQuoteAsApiQuote(pair) {
  const value=getIndependentQuote(pair);
  if(!value||!value.ok||!value.quote) return {
    ok:false,provider:'SiftingIO',pair,status:value&&value.status||'WAIT',
    meta:{freshness:'STALE',safeToSignal:false},
    quote:{marketState:'unknown',stale:true}
  };
  const q=value.quote,ageSeconds=Math.max(0,Math.floor(Number(q.ageMs||0)/1000));
  return {
    ok:true,provider:'SiftingIO',pair,
    quote:{
      bid:q.bid,ask:q.ask,mid:q.mid,spread:q.ask-q.bid,dayDiffPercent:null,
      timestamp:q.timestamp,source:q.source,marketState:'open',stale:false,ageSeconds
    },
    meta:{freshness:'FRESH',safeToSignal:true,quoteAgeSeconds:ageSeconds,provider:'SiftingIO'}
  };
}


async function getBISPolicyRates() {
  if (bisPolicyCache && Date.now() - bisPolicyCache.at < BIS_POLICY_CACHE_MS) {
    return { ...bisPolicyCache.value, cache: 'HIT' };
  }
  const startPeriod = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const currencies = Object.keys(BIS_AREAS);
  const results = await Promise.allSettled(currencies.map(async currency => {
    const area = BIS_AREAS[currency];
    const url = new URL('/api/v1/data/WS_CBPOL/D.' + area, 'https://stats.bis.org');
    url.searchParams.set('startPeriod', startPeriod);
    url.searchParams.set('format', 'csvfile');
    const response = await fetch(url, {
      headers: { 'Accept': 'text/csv' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const error = new Error('bis_policy_rate_' + area + '_http_' + response.status);
      error.statusCode = 502;
      throw error;
    }
    const csv = await response.text();
    if (!csv || csv.length > 2_000_000) {
      const error = new Error('bis_policy_rate_' + area + '_invalid_payload');
      error.statusCode = 502;
      throw error;
    }
    return { currency, area, observations: parseBISPolicyCsv(csv, area) };
  }));
  const series = {}, sourceErrors = [];
  results.forEach((result, index) => {
    const currency = currencies[index];
    if (result.status === 'fulfilled') {
      series[currency] = result.value.observations;
    } else {
      series[currency] = [];
      sourceErrors.push({ currency, area: BIS_AREAS[currency], error: safeError(result.reason) });
    }
  });
  const value = buildBISPolicyContext(series);
  value.sourceErrors = sourceErrors;
  value.cache = 'MISS';
  value.lookbackDays = 400;
  bisPolicyCache = { at: Date.now(), value };
  return value;
}

async function getPolicyRateContext(pair) {
  const all = await getBISPolicyRates();
  return {
    ...buildPolicyRatePairContext(all, pair),
    overallSourceStatus: all.status,
    availableCurrencies: all.availableCurrencies,
    expectedCurrencies: all.expectedCurrencies,
    sourceErrors: all.sourceErrors,
    provider: all.provider,
    datasetId: all.datasetId,
    frequency: all.frequency,
    attribution: all.attribution,
    disclaimer: all.disclaimer,
    fetchedAt: all.fetchedAt
  };
}

async function getCftcPositioning() {
  if (cftcPositioningCache && Date.now() - cftcPositioningCache.at < CFTC_POSITIONING_CACHE_MS) {
    return { ...cftcPositioningCache.value, cache: 'HIT' };
  }
  const url = new URL('/resource/gpe5-46if.json', 'https://publicreporting.cftc.gov');
  const codes = Object.values(CURRENCY_CONTRACTS);
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  url.searchParams.set('$select', [
    'report_date_as_yyyy_mm_dd',
    'cftc_contract_market_code',
    'market_and_exchange_names',
    'open_interest_all',
    'lev_money_positions_long',
    'lev_money_positions_short',
    'asset_mgr_positions_long',
    'asset_mgr_positions_short'
  ].join(','));
  url.searchParams.set('$where',
    "futonly_or_combined = 'FutOnly' AND cftc_contract_market_code IN (" +
    codes.map(quote).join(',') + ')'
  );
  url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
  url.searchParams.set('$limit', String(codes.length * 52));
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error('cftc_tff_http_' + response.status);
    error.statusCode = 502;
    throw error;
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length > codes.length * 52) {
    const error = new Error('cftc_tff_invalid_response');
    error.statusCode = 502;
    throw error;
  }
  const result = buildCftcPositioning(rows);
  result.cache = 'MISS';
  cftcPositioningCache = { at: Date.now(), value: result };
  return result;
}

async function getShadowEngine(pair,timeframe) {
  const key=pair+'|'+timeframe, cached=shadowEngineCache.get(key);
  if(cached && Date.now()-cached.at<SHADOW_CACHE_MS) return {...cached.value,cache:'HIT'};

  selectIndependentPair(pair);
  const cftcPromise = getCftcPositioning().then(value => value.pairs[pair] || null)
    .catch(error => ({ pair, status: 'UNAVAILABLE', direction: 'MIXED', reason: safeError(error) }));
  const fundamentalPromise = getFundamentalContext(pair).catch(error => ({
    pair,decisionRole:'RESEARCH_CONTEXT_ONLY',sourceStatus:{globalRisk:'UNAVAILABLE',calendar:'UNAVAILABLE',news:'UNAVAILABLE'},
    sourceErrors:[{source:'FUNDAMENTAL_CONTEXT',error:safeError(error)}]
  }));
  const policyPromise = getPolicyRateContext(pair).catch(error => ({
    pair,status:'UNAVAILABLE',signalEligible:false,provider:'BIS WS_CBPOL',error:safeError(error)
  }));
  const allPairs=[...PAIRS];
  const historyResults=await Promise.allSettled(allPairs.map(p=>getResearchCandles(p,timeframe)));
  const history=historyResults.map((result,index)=>result.status==='fulfilled'
    ?{pair:allPairs[index],provider:result.value.provider,candles:result.value.candles}
    :{pair:allPairs[index],provider:'UNAVAILABLE',candles:[]});
  const selectedCandlesResult=await getCandles(pair,timeframe).then(value=>({status:'fulfilled',value})).catch(reason=>({status:'rejected',reason}));
  const selectedCandles=selectedCandlesResult.status==='fulfilled'?selectedCandlesResult.value:null;
  const timeframes=[...INTERVALS.keys()];
  const currentResults=await Promise.allSettled(timeframes.map(tf=>
    tf===timeframe&&selectedCandles?Promise.resolve(selectedCandles):getCandles(pair,tf)
  ));
  let quote=null;
  try { quote=await getQuote(pair); } catch(error) { /* fail closed below */ }
  const independentQuote=getIndependentQuote(pair);
  const cftcPairContext=await cftcPromise;
  const fundamentalContext=await fundamentalPromise;
  const policyRateContext=await policyPromise;

  const timeframeStates=currentResults.map((result,index)=>{
    if(result.status!=='fulfilled') return {timeframe:timeframes[index],direction:'WAIT',freshness:'UNAVAILABLE',reason:safeError(result.reason)};
    const value=result.value, analysis=analyseDirection(value.candles);
    return {
      timeframe:timeframes[index],
      direction:analysis.direction,
      reason:analysis.reason,
      freshness:value.meta.freshness,
      lastCandleAt:value.meta.lastCandleAt,
      ageSeconds:value.meta.ageSeconds,
      votes:analysis.votes,
      metrics:analysis.metrics||null
    };
  });
  const directionalSentiment=aggregateDirectionalSentiment(timeframeStates);
  const research=walkForward(history);
  research.providers=[...new Set(history.map(item=>item.provider).filter(provider=>provider&&provider!=='UNAVAILABLE'))];
  research.sourceRole='HISTORICAL_RESEARCH_ONLY';
  const quoteFresh=Boolean(quote&&quote.meta&&quote.meta.freshness==='FRESH'&&quote.quote&&quote.quote.marketState==='open');
  const allCandlesFresh=timeframeStates.length===5&&timeframeStates.every(s=>s.freshness==='FRESH');
  const directions=timeframeStates.map(s=>s.direction);
  const aligned=directions.length===5&&['BULLISH','BEARISH'].includes(directions[0])&&directions.every(side=>side===directions[0]);
  const primaryMid=quote&&quote.quote?quote.quote.mid:null;
  const independentMid=independentQuote&&independentQuote.quote?independentQuote.quote.mid:null;
  const priceAgreement=compareIndependentQuotes({mid:primaryMid},{mid:independentMid});
  const independentQuoteFresh=Boolean(independentQuote&&independentQuote.meta&&independentQuote.meta.freshness==='FRESH');
  const primaryVendorIndependent=Boolean(quote&&quote.provider===PROVIDER);
  const independentAligned=quoteFresh&&independentQuoteFresh&&primaryVendorIndependent&&priceAgreement.aligned;
  const shadowDirection=quoteFresh&&independentAligned&&allCandlesFresh&&aligned?directions[0]:'WAIT';
  const blockers=[];
  if(!quoteFresh)blockers.push('Primary live quote stale or unavailable');
  if(!allCandlesFresh)blockers.push('one or more timeframe candles stale/unavailable');
  if(!aligned)blockers.push('five-timeframe direction is mixed or incomplete');
  if(!independentQuoteFresh)blockers.push('SiftingIO independent live quote unavailable or stale');
  else if(!quoteFresh)blockers.push('Primary live quote unavailable; cross-source price agreement cannot be evaluated');
  else if(!primaryVendorIndependent)blockers.push('SiftingIO REST and WebSocket are the same provider; independent second-vendor confirmation is not established');
  else if(!priceAgreement.aligned)blockers.push('Biquote and SiftingIO price divergence exceeds '+priceAgreement.maxDeviationPct+'%');
  blockers.push('68% probability calibration not established');
  const result={
    ok:true,engine:'PARTHAVI SHADOW DIRECTION ENGINE',
    pair,timeframe,
    live:{
      shadowDirection,
      finalDecision:'WAIT',
      liveEligible:false,
      quoteFresh,
      allCandlesFresh,
      fiveTimeframeAligned:aligned,
      directionalSentiment,
      marketContext:{
        cftcPositioning:cftcPairContext,
        cftcRole:'WEEKLY_POSITIONING_CONTEXT_ONLY',
        fundamentals:fundamentalContext,
        centralBankPolicy:policyRateContext
      },
      independentSource:{
        provider:'SiftingIO',primaryProvider:quote&&quote.provider||'UNAVAILABLE',
        status:!independentQuoteFresh?independentQuote.status:!quoteFresh?'PRIMARY_STALE':!primaryVendorIndependent?'SAME_PROVIDER_NOT_INDEPENDENT':priceAgreement.status,
        connected:Boolean(independentQuote&&independentQuote.connected),quoteFresh:independentQuoteFresh,priceAligned:independentAligned,
        timestamp:independentQuote&&independentQuote.quote?independentQuote.quote.timestamp:null,
        ageMs:independentQuote&&independentQuote.meta?independentQuote.meta.ageMs:null,
        bid:independentQuote&&independentQuote.quote?independentQuote.quote.bid:null,
        ask:independentQuote&&independentQuote.quote?independentQuote.quote.ask:null,mid:independentMid,primaryMid,
        deviationPct:priceAgreement.deviationPct,maxDeviationPct:priceAgreement.maxDeviationPct,
        subscribedPairs:independentQuote&&independentQuote.subscribedPairs?independentQuote.subscribedPairs:[]
      },
      reason:blockers.join('; '),
      timeframes:timeframeStates
    },
    research,
    methodology:{
      indicators:['EMA 9/21/50 stack','RSI 14 momentum','MACD histogram','four-bar price momentum','ADX 14 trend-strength gate'],
      decisionRule:'All four directional votes must agree and ADX 14 must be at least 18.',
      horizon:'Close direction after the next 3 completed candles of the selected timeframe.',
      dataProvider:'Biquote + SiftingIO independent aggregated FX quote stream',
      probabilityEmitted:false,
      disclaimer:'Shadow research only. This is not a calibrated probability, independent-source agreement, broker execution quote or trade instruction.'
    },
    fetchedAt:new Date().toISOString(),
    cache:'MISS'
  };
  shadowEngineCache.set(key,{at:Date.now(),value:result});
  return result;
}

const server=http.createServer(async(req,res)=>{
  if(!allowedOrigin(req,res)) return;
  if(req.method==='OPTIONS') { res.writeHead(204);return res.end(); }
  if(req.method!=='GET') return respond(res,405,{ok:false,error:'method_not_allowed'});
  if(!allowRequest(req.socket.remoteAddress)) return respond(res,429,{ok:false,error:'local_rate_limit'});
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health' || url.pathname==='/api/forex/status') {
    return respond(res,200,{
      ok:true,service:'PARTHAVI FOREX DATA API',
      provider:PROVIDER,providerConfigured:true,authenticationRequired:false,
      independentSource:getIndependentSourceStatus(),
      siftingRestUsage:{...siftingRestUsage},
      fallbackProviderConfigured:Boolean(process.env.SIFTINGIO_API_KEY&&SIFTING_REST_FALLBACK_ENABLED),
      websocketWatchlistEnabled:SIFTINGIO_WS_WATCHLIST_ENABLED,
      websocketFirstQuotePolicy:SIFTINGIO_WS_FIRST_QUOTES_ENABLED,
      feedMode:'Biquote primary with SiftingIO REST quote/OHLC fallback and independent WebSocket diagnostics',
      freshnessRule:'provider quoteAgeSeconds + candle timestamp checked; stale or closed market blocks signals',
      usageRights:'Provider terms permit use and display in web dashboards; do not redistribute raw feed.',
      disclaimer:'Indicative feed with no uptime SLA. Not a broker execution feed or guaranteed tradable price.',
      pairs:[...PAIRS],timeframes:[...INTERVALS.keys()],
      serverTime:new Date().toISOString()
    });
  }
  const pair=normalisePair(url.searchParams.get('pair'));
  if(url.pathname==='/api/forex/independent-source') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    selectIndependentPair(pair);
    return respond(res,200,{ok:true,source:getIndependentSourceStatus(),quote:getIndependentQuote(pair)});
  }
  if(url.pathname==='/api/forex/watchlist-quotes') {
    if(!SIFTINGIO_WS_WATCHLIST_ENABLED) return respond(res,503,{ok:false,error:'websocket_watchlist_disabled'});
    selectIndependentPair(pair||'EUR/USD');
    const quotes=Object.fromEntries([...PAIRS].map(symbol=>[symbol,independentQuoteAsApiQuote(symbol)]));
    return respond(res,200,{
      ok:true,provider:'SiftingIO',selectedPair:pair||'EUR/USD',
      source:getIndependentSourceStatus(),quotes,
      note:'Five WebSocket subscriptions are available on the free tier. Unsubscribed pairs are intentionally returned as WAIT; selecting a pair rotates it into the live subscription set.'
    });
  }
  if(url.pathname==='/api/forex/research-candles') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    const timeframe=String(url.searchParams.get('timeframe')||'15M').toUpperCase();
    if(!INTERVALS.has(timeframe)) return respond(res,400,{ok:false,error:'unsupported_timeframe'});
    try { return respond(res,200,await getResearchCandles(pair,timeframe)); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:'historical_research',pair,timeframe,error:safeError(error)}); }
  }
  if(url.pathname==='/api/forex/shadow-engine') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    const timeframe=String(url.searchParams.get('timeframe')||'15M').toUpperCase();
    if(!INTERVALS.has(timeframe)) return respond(res,400,{ok:false,error:'unsupported_timeframe'});
    try { return respond(res,200,await getShadowEngine(pair,timeframe)); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,engine:'PARTHAVI SHADOW DIRECTION ENGINE',pair,timeframe,error:safeError(error),liveEligible:false,finalDecision:'WAIT'}); }
  }
  if(url.pathname==='/api/forex/policy-rates') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    try { return respond(res,200,await getPolicyRateContext(pair)); }
    catch(error) {
      return respond(res,Number(error.statusCode)||502,{
        ok:false,provider:'Bank for International Settlements (BIS)',
        datasetId:'WS_CBPOL',pair,status:'UNAVAILABLE',
        error:safeError(error),signalEligible:false
      });
    }
  }
  if(url.pathname==='/api/forex/fundamental-context') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    try { return respond(res,200,await getFundamentalContext(pair)); }
    catch(error) {
      return respond(res,Number(error.statusCode)||502,{
        ok:false,pair,status:'UNAVAILABLE',decisionRole:'RESEARCH_CONTEXT_ONLY',
        error:safeError(error),signalEligible:false
      });
    }
  }
  if(url.pathname==='/api/forex/global-risk') {
    try { return respond(res,200,await getGlobalRiskContext()); }
    catch(error) {
      return respond(res,Number(error.statusCode)||502,{
        ok:false,provider:'FRED',status:'UNAVAILABLE',error:safeError(error),signalEligible:false
      });
    }
  }
  if(url.pathname==='/api/forex/central-bank-news') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    try {
      const data=await getOfficialCentralBankNews();
      return respond(res,200,{
        ...data,
        selectedPair:buildPairCentralBankNewsContext(data,pair),
        signalEligible:false
      });
    } catch(error) {
      return respond(res,Number(error.statusCode)||502,{
        ok:false,provider:'Official central-bank RSS / Atom feeds',
        error:safeError(error),status:'UNAVAILABLE',signalEligible:false
      });
    }
  }
  if(url.pathname==='/api/forex/central-bank-policy') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    try {
      const data=await getPolicyRateContext(pair);
      return respond(res,200,{
        ok:data.status!=='PARTIAL_OR_UNAVAILABLE',
        ...data,
        signalEligible:false
      });
    } catch(error) {
      return respond(res,Number(error.statusCode)||502,{
        ok:false,provider:'BIS WS_CBPOL',pair,
        error:safeError(error),status:'UNAVAILABLE',signalEligible:false
      });
    }
  }
  if(url.pathname==='/api/forex/cot-positioning') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    try {
      const data=await getCftcPositioning();
      return respond(res,200,{...data,selectedPair:data.pairs[pair]||null});
    } catch(error) {
      return respond(res,Number(error.statusCode)||502,{
        ok:false,provider:'Commodity Futures Trading Commission (CFTC)',
        dataset:'Traders in Financial Futures · Futures Only',
        error:safeError(error),status:'UNAVAILABLE',signalEligible:false
      });
    }
  }
  if(url.pathname==='/api/forex/fed-reference-rates') {
    try { return respond(res,200,await getFederalReserveReferenceRates()); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:'Federal Reserve H.10',relay:'FRED graph CSV',error:safeError(error),signalEligible:false}); }
  }
  if(url.pathname==='/api/forex/reference-rates') {
    try { return respond(res,200,await getEcbReferenceRates()); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:'European Central Bank',relay:'Frankfurter API',error:safeError(error),signalEligible:false}); }
  }
  if(url.pathname==='/api/forex/news') {
    try { return respond(res,200,await getNews()); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:PROVIDER,error:safeError(error)}); }
  }
  if(url.pathname==='/api/forex/calendar') {
    try { return respond(res,200,await getCalendar()); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:PROVIDER,error:safeError(error)}); }
  }
  if(url.pathname==='/api/forex/quote') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    try { return respond(res,200,await getQuote(pair)); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:PROVIDER,pair,error:safeError(error),safeToSignal:false}); }
  }
  if(url.pathname==='/api/forex/candles') {
    if(!pair) return respond(res,400,{ok:false,error:'unsupported_pair'});
    const timeframe=String(url.searchParams.get('timeframe')||'15M').toUpperCase();
    if(!INTERVALS.has(timeframe)) return respond(res,400,{ok:false,error:'unsupported_timeframe'});
    try { return respond(res,200,await getCandles(pair,timeframe)); }
    catch(error) { return respond(res,Number(error.statusCode)||502,{ok:false,provider:PROVIDER,pair,timeframe,error:safeError(error),safeToSignal:false}); }
  }
  return respond(res,404,{ok:false,error:'not_found'});
});
async function crossPairHistorySelfCheck() {
  const results = await Promise.allSettled([...PAIRS].map(pair => getCandles(pair,'15M')));
  let common = null;
  let successful = 0;
  results.forEach((result,index) => {
    const pair=[...PAIRS][index];
    if(result.status!=='fulfilled') {
      console.log('[CROSS_PAIR_HISTORY] '+pair+'=FAILED reason='+safeError(result.reason));
      return;
    }
    successful += 1;
    const candles=result.value.candles;
    const timestamps=new Set(candles.map(c=>c.timestamp));
    common=common===null?timestamps:new Set([...common].filter(t=>timestamps.has(t)));
    console.log('[CROSS_PAIR_HISTORY] '+pair+'=OK bars='+candles.length+' freshness='+result.value.meta.freshness);
  });
  const commonBars=common?common.size:0;
  console.log('[CROSS_PAIR_HISTORY] successfulPairs='+successful+'/7 commonClosedBars='+commonBars+' correlationReady='+(successful===7&&commonBars>=31));
}
async function upstreamSelfCheck() {
  const checks = [
    ['EURUSD quote', () => getQuote('EUR/USD')],
    ['ECB reference rates', () => getEcbReferenceRates()],
    ['Federal Reserve H10 reference rates', () => getFederalReserveReferenceRates()],
    ['CFTC TFF currency positioning', () => getCftcPositioning()],
    ['FRED global risk context', () => getGlobalRiskContext()],
    ['BIS central bank policy-rate differential', () => getBISPolicyRates()],
    ['EURUSD 15M candles', () => getCandles('EUR/USD','15M')],
    ['economic calendar', () => getCalendar()],
    ['market news', () => getNews()],
    ['official central-bank news', () => getOfficialCentralBankNews()]
  ];
  const results = await Promise.allSettled(checks.map(([,run]) => run()));
  results.forEach((result,index) => {
    const label=checks[index][0];
    if(result.status!=='fulfilled') {
      console.log('[UPSTREAM_CHECK] '+label+'=FAILED reason='+safeError(result.reason));
      return;
    }
    const value=result.value;
    if(label==='Federal Reserve H10 reference rates') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK observationDate='+value.meta.observationDate+' ageDays='+value.meta.ageDays+' pairs='+value.pairs.length+' freshness='+value.meta.freshness);
    } else if(label==='ECB reference rates') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK latestDate='+value.meta.latestDate+' ageDays='+value.meta.ageDays+' pairs='+value.pairs.length+' freshness='+value.meta.freshness);
    } else if(label==='official central-bank news') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK currencies='+value.availableCurrencies+'/'+value.expectedCurrencies+' feeds='+value.connectedFeeds+'/'+value.expectedFeeds+' EURUSD='+value.pairs['EUR/USD'].direction+' status='+value.status);
    } else if(label==='BIS central bank policy-rate differential') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK current='+value.availableCurrencies+'/'+value.expectedCurrencies+' fresh='+value.freshCurrencies+'/'+value.expectedCurrencies+' status='+value.status+' EUR='+value.currencies.EUR.status+' USD='+value.currencies.USD.status);
    } else if(label==='FRED global risk context') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK coreSeries='+value.availableSeries+'/'+value.expectedSeries+' status='+value.status+' USD='+value.usdBias+' conflict='+value.usdConflict+' risk='+value.riskRegime+' WTI='+value.optionalSeries.crudeOilStatus);
    } else if(label==='CFTC TFF currency positioning') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK currencies='+value.availableCurrencies+'/7 status='+value.status+' report='+Object.values(value.currencies).filter(Boolean).map(item=>item.reportDate).sort().slice(-1)[0]);
    } else if(label==='EURUSD quote') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK freshness='+value.meta.freshness+' ageSeconds='+value.meta.quoteAgeSeconds+' state='+value.quote.marketState);
    } else if(label==='EURUSD 15M candles') {
      console.log('[UPSTREAM_CHECK] '+label+'=OK freshness='+value.meta.freshness+' closedBars='+value.candles.length);
    } else {
      console.log('[UPSTREAM_CHECK] '+label+'=OK items='+value.items.length);
    }
  });
  await crossPairHistorySelfCheck();
}

server.listen(PORT,'0.0.0.0',()=>{
  console.log('[PARTHAVI_FOREX_API] listening port='+PORT);
  console.log('[PARTHAVI_FOREX_API] provider='+PROVIDER+' key_required=false');
  startIndependentSource();
  console.log('[INDEPENDENT_SOURCE] provider=SiftingIO configured='+getIndependentSourceStatus().configured+' status='+getIndependentSourceStatus().status);
  upstreamSelfCheck().catch(error=>console.log('[UPSTREAM_CHECK] unexpected_failure='+safeError(error)));
});
