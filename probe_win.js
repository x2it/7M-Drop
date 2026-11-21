#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const http = require('http'), crypto = require('crypto'), net = require('net');
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const MOBILE = process.argv[3] === 'mobile';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class WS{constructor(u){const x=new URL(u);this.host=x.hostname;this.port=+x.port;this.path=x.pathname;this.buf=Buffer.alloc(0);this.id=0;this.pending=new Map();}
connect(){const k=crypto.randomBytes(16).toString('base64');return new Promise((res,rej)=>{this.sock=net.connect(this.port,this.host,()=>{this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`);});let hs=false;this.sock.on('data',d=>{if(!hs){const s=d.toString('binary');const i=s.indexOf('\r\n\r\n');if(i<0)return;hs=true;res();const r=d.slice(Buffer.byteLength(s.slice(0,i+4),'binary'));if(r.length)this._f(r);return;}this._f(d);});this.sock.on('error',rej);});}
_f(b){this.buf=Buffer.concat([this.buf,b]);for(;;){if(this.buf.length<2)return;const b1=this.buf[1];let len=b1&0x7f,off=2;if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);off=4;}else if(len===127){if(this.buf.length<10)return;len=Number(this.buf.readBigUInt64BE(2));off=10;}if(b1&0x80)off+=4;if(this.buf.length<off+len)return;const p=this.buf.slice(off,off+len);this.buf=this.buf.slice(off+len);let m;try{m=JSON.parse(p.toString());}catch(e){continue;}if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}}}
send(method,params,sid){const id=++this.id;const o={id,method,params:params||{}};if(sid)o.sessionId=sid;const d=Buffer.from(JSON.stringify(o));const mask=crypto.randomBytes(4);let h;if(d.length<126)h=Buffer.from([0x81,0x80|d.length]);else if(d.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=0xfe;h.writeUInt16BE(d.length,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0xff;h.writeBigUInt64BE(BigInt(d.length),2);}const mk=Buffer.alloc(d.length);for(let i=0;i<d.length;i++)mk[i]=d[i]^mask[i%4];this.sock.write(Buffer.concat([h,mask,mk]));return new Promise((res,rej)=>{this.pending.set(id,{res,rej});setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('timeout '+method));}},30000);});}
close(){try{this.sock.destroy();}catch(e){}}}
let pass=0,fail=0;
function chk(n,ok,d){console.log((ok?'✔':'✘')+' '+n+(d?'  ['+d+']':''));ok?pass++:fail++;}

/* 窗口体检：检查可见窗口是否溢出视口、标题栏按钮规格、控件是否被裁 */
const WINAUDIT = `(function(winId){
  var w=document.getElementById(winId); if(!w||w.hidden) return JSON.stringify({skip:1});
  var r=w.getBoundingClientRect(), vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
  var out={id:winId,r:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
    offscreen:r.right>vw+2||r.bottom>vh+2||r.left<-2||r.top<-2,
    clipped:[],tiny:[],btn:[]};
  var cs=getComputedStyle(w);
  // 内容是否溢出窗口
  var body=w.querySelector('.win-body,.notepad,.fm-frame,.ie-frame-el,.dos-body,.chat-body');
  if(body){var br=body.getBoundingClientRect();
    if(body.scrollHeight>body.clientHeight+2 && getComputedStyle(body).overflowY==='hidden') out.clipped.push('body sh'+body.scrollHeight+'/ch'+body.clientHeight);
    if(body.scrollWidth>body.clientWidth+2 && getComputedStyle(body).overflowX==='hidden') out.clipped.push('body sw'+body.scrollWidth+'/cw'+body.clientWidth);
  }
  // 标题栏按钮规格
  var tb=w.querySelector('.titlebar');
  if(tb){tb.querySelectorAll('.wclose,.wbtn,.tb-btn').forEach(function(b){
    var br=b.getBoundingClientRect();
    out.btn.push((b.className||'')+' '+Math.round(br.width)+'x'+Math.round(br.height));
    var MINH=14;
    if(br.height<MINH||br.width<12) out.tiny.push((b.className||'')+' '+Math.round(br.width)+'x'+Math.round(br.height));
  });}
  // 窗口内可点元素过小
  w.querySelectorAll('button,a').forEach(function(b){var br=b.getBoundingClientRect();
    if(br.width>0&&br.height>0&&br.height<14){if(out.tiny.length<6)out.tiny.push((b.id||b.className||b.tagName)+' '+Math.round(br.width)+'x'+Math.round(br.height));}});
  return JSON.stringify(out);
})`;
(async()=>{
  const MINH=MOBILE?30:14;
  const port=(MOBILE?9860:9850)+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/pw-'+(MOBILE?'m':'d')+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const W=MOBILE?393:1366,H=MOBILE?852:768;
  await ws.send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:MOBILE},sid);
  if(MOBILE) await ws.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});
  const tag=MOBILE?'移动端':'桌面端';
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(3200);
  const winAudit=id=>ws.send('Runtime.evaluate',{expression:'('+WINAUDIT.replace(/__MINH__/g,MINH)+')('+JSON.stringify(id)+')',returnByValue:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return JSON.parse(r.result.value);});

  const WINS=[['pcWin','我的电脑'],['ieWin','IE 浏览器'],['mineWin','扫雷'],['dosWin','MS-DOS'],['readmeWin','readme'],['ieSrcWin','IE 查看源码']];
  // 逐个打开
  for(const [id,label] of WINS){
    const app=id.replace('Win','').replace('ieSrcWin','ie');
    if(id==='ieSrcWin') continue;
    const appId={'pcWin':'pc','ieWin':'ie','mineWin':'mine','dosWin':'dos','readmeWin':'readme'}[id];
    const ok=await ev("(function(){var i=document.querySelector('.dicon[data-app=\""+appId+"\"]'); if(!i)return false; i.click(); i.click(); return true;})()");
    await sleep(900);
    const r=await winAudit(id);
    if(r.skip){console.log('· '+label+'：未打开');continue;}
    chk(tag+' '+label+'：窗口完整在屏内', !r.offscreen, JSON.stringify(r.r));
    chk(tag+' '+label+'：无内容裁切', r.clipped.length===0, JSON.stringify(r.clipped));
    chk(tag+' '+label+'：标题栏按钮规格达标', r.tiny.filter(x=>/wclose|wbtn|tb-btn/.test(x)).length===0, JSON.stringify(r.btn));
    if(MOBILE) chk(tag+' '+label+'：可点元素≥24px', r.tiny.length===0, JSON.stringify(r.tiny));
  }
  console.log('\n['+tag+'] 结果: '+pass+' 通过 / '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('ERR:',e.message);process.exit(2);});
