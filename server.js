/**
 * PARTHAVI FOREX DATA API
 * Biquote public feed gateway: quote snapshots + closed OHLC candles.
 * All provider data is indicative; stale/closed/invalid data is never signal-safe.
 */
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 10000);
const PROVIDER = 'Biquote';
const PROVIDER_BASE = 'https://biquote.io';
const SITE_ORIGIN = 'https://parthavi-forex-trade-desk-pro-2-0.onrender.com';
const PAIRS = new Set(['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD']);
const INTERVALS = new Map([
  ['5M', { upstream:'5m', seconds:300, maxAge:900, limit:288 }],
  ['15M',{ upstream:'15m',seconds:900, maxAge:1800,limit:192 }],
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
async function getQuote(pair) {
  const cacheKey=pair, cached=quoteCache.get(cacheKey);
  if(cached && Date.now()-cached.at<QUOTE_CACHE_MS) return {...cached.value,cache:'HIT'};
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
    ok:numericValid,
    provider:PROVIDER,
    pair,
    quote:{
      bid:numericValid?bid:null,
      ask:numericValid?ask:null,
      mid:numericValid?mid:null,
      spread:numericValid?spread:null,
      dayDiffPercent:data.marketState==='open' && data.dayDiffPercent!==null && data.dayDiffPercent!==undefined && Number.isFinite(Number(data.dayDiffPercent))?Number(data.dayDiffPercent):null,
      timestamp:Number.isFinite(timestamp)?new Date(timestamp).toISOString():null,
      source:String(data.source || 'Biquote feed').slice(0,100),
      marketState:String(data.marketState || 'unknown'),
      stale,
      ageSeconds:Number.isFinite(age)?age:null
    },
    meta:{
      freshness:!stale && numericValid?'FRESH':'STALE',
      safeToSignal:!stale && numericValid,
      quoteAgeSeconds:Number.isFinite(age)?age:null,
      disclaimer:'Indicative third-party broker-feed quote; not a guaranteed executable broker price.'
    },
    fetchedAt:new Date().toISOString(),
    cache:'MISS'
  };
  if(!numericValid) {
    const e=new Error('invalid_quote_fields');e.statusCode=422;throw e;
  }
  quoteCache.set(cacheKey,{at:Date.now(),value:result});
  return result;
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

async function getNews() {
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
  return {
    ok:true,provider:PROVIDER,items,
    fetchedAt:new Date().toISOString(),
    disclaimer:'Aggregated third-party news; headlines are context, not a directional trading signal.'
  };
}
async function getCalendar() {
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
  return {
    ok:true,provider:PROVIDER,items,
    fetchedAt:new Date().toISOString(),
    disclaimer:'Economic calendar coverage depends on upstream country/source coverage. Null readings mean unpublished, not zero.'
  };
}

async function getCandles(pair,timeframe) {
  const spec=INTERVALS.get(timeframe), cacheKey=pair+'|'+timeframe, cached=candleCache.get(cacheKey);
  if(cached && Date.now()-cached.at<CANDLE_CACHE_MS) return {...cached.value,cache:'HIT'};
  const url=new URL('/api/'+symbolFor(pair)+'/ohlc',PROVIDER_BASE);
  url.searchParams.set('interval',spec.upstream);
  url.searchParams.set('limit',String(spec.limit));
  const data=await providerJson(url);
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
      feedMode:'SignalR WebSocket quote stream in browser + REST closed OHLC candles; REST quote fallback',
      freshnessRule:'provider quoteAgeSeconds + candle timestamp checked; stale or closed market blocks signals',
      usageRights:'Provider terms permit use and display in web dashboards; do not redistribute raw feed.',
      disclaimer:'Indicative feed with no uptime SLA. Not a broker execution feed or guaranteed tradable price.',
      pairs:[...PAIRS],timeframes:[...INTERVALS.keys()],
      serverTime:new Date().toISOString()
    });
  }
  const pair=normalisePair(url.searchParams.get('pair'));
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
    ['EURUSD 15M candles', () => getCandles('EUR/USD','15M')],
    ['economic calendar', () => getCalendar()],
    ['market news', () => getNews()]
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
  upstreamSelfCheck().catch(error=>console.log('[UPSTREAM_CHECK] unexpected_failure='+safeError(error)));
});
