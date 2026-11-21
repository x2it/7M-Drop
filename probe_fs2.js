#!/usr/bin/env node
'use strict';
// 探针：① SW 缓存键是否带版本号（旧 CSS 混搭的根因）
//      ② 内嵌预览「全屏」是否真的铺满视口
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
  const port=9920+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/ov2-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});

  // ① SW 源码：缓存键必须含 search
  const swSrc=await (await fetch(BASE+'/sw.js')).text();
  const keyFix=swSrc.indexOf("var key = url.pathname + url.search;")>=0;
  ok('SW 缓存键含版本号（不再命中旧 CSS）', keyFix, 'found='+keyFix);
  ok('SW 预缓存同时存带版本号与裸路径', /SHELL\.forEach\(function \(u\)/.test(swSrc) && swSrc.indexOf("list.push(u + vs)")>=0, '');

  // ② 内层 is-full 不得用 100vw/100dvh
  const appCss=await (await fetch(BASE+'/app.css')).text();
  const badVw=/\.viewer-dlg\.is-full\{[^}]*100vw/.test(appCss);
  ok('内层 is-full 不用 100vw（iframe 内 vw 只半屏宽）', !badVw, 'has100vw='+badVw);

  // ③ 手机视口：内嵌预览全屏要铺满视口
  await ws.send('Emulation.setDeviceMetricsOverride',{width:500,height:1080,deviceScaleFactor:2,mobile:true},sid);
  await ws.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},sid);
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(3500);
  await ev("(function(){var w=document.getElementById('pcWin');if(w)W98.openWin(w);return 1;})()");
  await sleep(2000);
  // 先在「我的电脑」内打开一个文件的预览（sheet → 预览），再点全屏
  await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;if(!d)return 1;"
    +"var row=d.querySelector('.row.tappable');if(row)row.click();return 1;})()");
  await sleep(1500);
  await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;if(!d)return 1;"
    +"var b=d.querySelector('.sheet-item[data-act=\"preview\"]');if(b&&!b.hidden)b.click();return 1;})()");
  await sleep(2500);
  // 直接从 iframe 内发「铺满全屏」消息（等价于内层点全屏按钮时发的消息）
  // 在外壳装一个探针监听器，确认消息是否到达父窗口
  await ev("(function(){window.__got=[];window.addEventListener('message',function(e){"
    +"window.__got.push({type:(e.data&&e.data.type)||'?',src:(e.source===window)?'self':(e.source===document.getElementById('fmFrame').contentWindow?'iframe':'other')});},true);return 1;})()");
  const clicked=await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;if(!d)return 'no-doc';"
    +"try{ d.defaultView.parent.postMessage({type:'7md:embed-fullscreen',on:true},'*'); return 'sent'; }catch(e){ return 'ERR:'+e.message; }})()");
  console.log('  内层发消息:', clicked);
  await sleep(2000);
  const got=await ev("JSON.stringify(window.__got)");
  console.log('  父窗口收到:', got);
  const geo=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');var f=document.getElementById('fmFrame');"
    +"var r=w.getBoundingClientRect();var fr=f.getBoundingClientRect();"
    +"return JSON.stringify({cls:w.className,win:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},"
    +"frame:{x:Math.round(fr.x),y:Math.round(fr.y),w:Math.round(fr.width),h:Math.round(fr.height)},"
    +"vw:window.innerWidth,vh:window.innerHeight});})()"));
  console.log('  几何:', JSON.stringify(geo));
  ok('宿主窗口已加 embed-fs 状态', /embed-fs/.test(geo.cls||''), JSON.stringify(geo));
  ok('全屏后窗口铺满视口宽', Math.abs(geo.win.w-geo.vw)<=2, 'win.w='+geo.win.w+' vw='+geo.vw);
  ok('全屏后窗口铺满视口高', Math.abs(geo.win.h-geo.vh)<=2, 'win.h='+geo.win.h+' vh='+geo.vh);
  ok('iframe 也铺满（允许窗口边框 8px）', geo.frame.w>=geo.vw-10 && geo.frame.h>=geo.vh-10, 'frame='+geo.frame.w+'x'+geo.frame.h+' vw='+geo.vw+'x'+geo.vh);

  const s=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.4.3-移动端全屏铺满.png',Buffer.from(s.data,'base64'));

  // 退出全屏要还原（内层 exitFull 会发 on:false；此处直接发该消息验证通路）
  await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;if(!d)return 1;"
    +"try{ d.defaultView.parent.postMessage({type:'7md:embed-fullscreen',on:false},'*'); }catch(e){} return 1;})()");
  await sleep(2000);
  const back=await ev("(function(){var w=document.getElementById('pcWin');var r=w.getBoundingClientRect();return JSON.stringify({cls:w.className,h:Math.round(r.height)});})()");
  ok('退出全屏后移除 embed-fs', String(back).indexOf('embed-fs')<0, String(back));

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e.message);process.exit(2);});
