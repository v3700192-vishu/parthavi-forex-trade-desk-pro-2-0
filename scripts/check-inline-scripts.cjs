'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const htmlPath=path.join(__dirname,'..','public','index.html');
if(!fs.existsSync(htmlPath))throw new Error('public/index.html not found');
const html=fs.readFileSync(htmlPath,'utf8');
const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
let checked=0;
for(let i=0;i<scripts.length;i++){
  const attributes=scripts[i][1]||'';
  const body=scripts[i][2]||'';
  if(/\bsrc\s*=/.test(attributes)||!body.trim())continue;
  new vm.Script(body,{filename:'public/index.html:inline-script-'+(checked+1)+'.js'});
  checked++;
}
if(checked===0)throw new Error('No inline JavaScript blocks were checked');
if(!html.includes('microsoft-signalr/8.0.0/signalr.min.js'))throw new Error('SignalR client CDN reference missing');
if(!html.includes('https://biquote.io/hubs/tick'))throw new Error('Biquote SignalR hub reference missing');
console.log('Validated server.js and '+checked+' inline JavaScript block(s).');
