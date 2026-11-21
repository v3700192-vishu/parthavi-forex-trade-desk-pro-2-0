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
      dayDiffPercent:Number.isFinite(Number(data.dayDiffPercent))?Number(data.dayDiffPercent):null,
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
      feedMode:'REST quote snapshots + closed OHLC candles',
      freshnessRule:'provider quoteAgeSeconds + candle timestamp checked; stale or closed market blocks signals',
      usageRights:'Provider terms permit use and display in web dashboards; do not redistribute raw feed.',
      disclaimer:'Indicative feed with no uptime SLA. Not a broker execution feed or guaranteed tradable price.',
      pairs:[...PAIRS],timeframes:[...INTERVALS.keys()],
      serverTime:new Date().toISOString()
    });
  }
  const pair=normalisePair(url.searchParams.get('pair'));
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
server.listen(PORT,'0.0.0.0',()=>{
  console.log('[PARTHAVI_FOREX_API] listening port='+PORT);
  console.log('[PARTHAVI_FOREX_API] provider='+PROVIDER+' key_required=false');
});
