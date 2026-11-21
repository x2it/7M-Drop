#!/usr/bin/env node
'use strict';
// 探针：「放大到极限」全站同一设计（外壳窗口最大化 vs 内层视频全屏）
const { spawn } = require('child_process');
const http = require('http'), crypto = require('crypto'), net = require('net'), fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
class WS {
  constructor(u){const x=new URL(u);this.host=x.hostname;this.port=+x.port;this.path=x.pathname;this.buf=Buffer.alloc(0);this.id=0;this.pending=new Map();}
  connect(){const k=crypto.randomBytes(16).toString('base64');return new Promise((res,rej)=>{this.sock=net.connect(this.port,this.host,()=>{this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`);});let hs=false;this.sock.on('data',d=>{if(!hs){const s=d.toString('binary');const i=s.indexOf('\r\n\r\n');if(i<0)return;hs=true;res();const r=d.slice(Buffer.byteLength(s.slice(0,i+4),'binary'));if(r.length)this._f(r);return;}this._f(d);});this.sock.on('error',rej);});}
  _f(b){this.buf=Buffer.concat([this.buf,b]);for(;;){if(this.buf.length<2)return;const b1=this.buf[1];let len=b1&0x7f,off=2;if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);off=4;}else if(len===127){if(this.buf.length<10)return;len=Number(this.buf.readBigUInt64BE(2));off=10;}if(b1&0x80)off+=4;if(this.buf.length<off+len)return;const p=this.buf.slice(off,off+len);this.buf=this.buf.slice(off+len);let m;try{m=JSON.parse(p.toString());}catch(e){continue;}if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}}}
  send(method,params,sid){const id=++this.id;const o={id,method,params:params||{}};if(sid)o.sessionId=sid;const d=Buffer.from(JSON.stringify(o));const mask=crypto.randomBytes(4);let h;if(d.length<126)h=Buffer.from([0x81,0x80|d.length]);else if(d.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=0xfe;h.writeUInt16BE(d.length,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0xff;h.writeBigUInt64BE(BigInt(d.length),2);}const mk=Buffer.alloc(d.length);for(let i=0;i<d.length;i++)mk[i]=d[i]^mask[i%4];this.sock.write(Buffer.concat([h,mask,mk]));return new Promise((res,rej)=>{this.pending.set(id,{res,rej});setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('timeout '+method));}},30000);});}
  close(){try{this.sock.destroy();}catch(e){}}
}
let pass=0,fail=0;
function ok(n,c,e){if(c){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(e!==undefined?'  -> '+e:''));}}
(async()=>{
  const port=9980+Math.floor(Math.random()*15);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/fs-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1280,860','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});

  // ── 外壳：窗口最大化按钮图标 ──
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(2800);
  await ev("(function(){var w=document.getElementById('pcWin');if(w)W98.openWin(w);return 1;})()");
  await sleep(1500);
  const shell=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');if(!w)return '{}';"
    +"var b=w.querySelector('.wbtn.max');if(!b)return '{}';"
    +"var ps=getComputedStyle(b,'::after');var r=b.getBoundingClientRect();"
    +"var root=getComputedStyle(document.documentElement);"
    +"return JSON.stringify({bg:ps.backgroundImage,w:Math.round(r.width),h:Math.round(r.height),"
    +"expandVar:root.getPropertyValue('--ico-expand').trim().slice(0,60)});})()"));
  ok('外壳最大化钮用四角箭头(--ico-expand)', shell.bg && shell.bg.indexOf(shell.expandVar.slice(5,45))>=0 && shell.bg.indexOf('svg')>=0, JSON.stringify(shell));
  const shellIcon=String(shell.bg||'');

  // 最大化后 → 还原图标
  await ev("(function(){var w=document.getElementById('pcWin');var b=w.querySelector('.wbtn.max');if(b)b.click();return 1;})()");
  await sleep(1200);
  const restIcon=await ev("(function(){var w=document.getElementById('pcWin');var b=w.querySelector('.wbtn.max');if(!b)return '';return getComputedStyle(b,'::after').backgroundImage;})()");
  ok('外壳最大化后切还原图标(--ico-restore)', String(restIcon).indexOf('svg')>=0 && String(restIcon)!==shellIcon, String(restIcon).slice(0,60));

  // ── 内层：文件服务页视频全屏按钮 ──
  await ws.send('Page.navigate',{url:BASE+'/s/guest1234/?nc='+Date.now()});await sleep(3400);
  const inner=JSON.parse(await ev("(function(){var b=document.getElementById('viewerFs');if(!b)return '{}';"
    +"var ps=getComputedStyle(b,'::before');var r=b.getBoundingClientRect();"
    +"var root=getComputedStyle(document.documentElement);"
    +"return JSON.stringify({bg:ps.backgroundImage,w:Math.round(r.width),h:Math.round(r.height),"
    +"expandVar:root.getPropertyValue('--ico-expand').trim()});})()"));
  ok('内层全屏钮用四角箭头(--ico-expand)', inner.bg && inner.bg.indexOf('svg')>=0 && inner.bg===inner.expandVar, JSON.stringify(inner));
  ok('内外「放大」按钮图标完全一致', inner.bg===shellIcon, 'shell='+String(shellIcon).slice(0,50)+' inner='+String(inner.bg).slice(0,50));

  // 尺寸一致性：viewer 未打开时 rect 为 0，改从 CSS 规则读声明值
  const innerCss=JSON.parse(await ev("(function(){var b=document.getElementById('viewerFs');var cs=getComputedStyle(b);return JSON.stringify({w:cs.width,h:cs.height});})()"));
  const px=v=>parseFloat(String(v));
  ok('内外按钮尺寸一致(16×14)', px(innerCss.w)===shell.w && px(innerCss.h)===shell.h, 'shell='+shell.w+'x'+shell.h+' inner='+innerCss.w+'x'+innerCss.h);

  // ── 移动端：外壳按钮也要放大到 38×34 ──
  await ws.send('Emulation.setDeviceMetricsOverride',{width:400,height:870,deviceScaleFactor:2,mobile:true},sid);
  await ws.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},sid);
  await ws.send('Page.navigate',{url:BASE+'/?nc2='+Date.now()});await sleep(2800);
  await ev("(function(){var w=document.getElementById('pcWin');if(w)W98.openWin(w);return 1;})()");
  await sleep(1500);
  const mob=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');var b=w&&w.querySelector('.wbtn.max');if(!b)return '{}';var r=b.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height)});})()"));
  ok('移动端外壳按钮放大到 38×34', mob.w===38 && mob.h===34, JSON.stringify(mob));

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e.message);process.exit(2);});
