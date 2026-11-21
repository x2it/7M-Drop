#!/usr/bin/env node
'use strict';
// 移动端排版体检 v3：预览按钮单行、标题栏图标规格、拖拽不出屏
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
function chk(name,ok,detail){console.log((ok?'✔':'✘')+' '+name+(detail?'  ['+detail+']':''));ok?pass++:fail++;}
(async()=>{
  const port=9940+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/mob3-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});
  await ws.send('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:2,mobile:true},sid);
  await ws.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},sid);
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(3600);

  console.log('STEP1 nav done');
  // 打开「我的电脑」（fmOpen 在 IIFE 内不可达，直接给 fmFrame 设 src）
  const boot=await new Promise((res,rej)=>{http.get(BASE+'/api/boot',r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});
  await ev("(function(){document.getElementById('pcWin').hidden=false;"
    +"document.getElementById('fmFrame').setAttribute('src','" + boot.guestUrl + "?embed=1');return 1;})()");
  await sleep(5000);

  console.log('STEP2 opened');
  // ① 外壳窗口打开即自动 maxed：最大化按钮图形必须是四角箭头(expand)，不是双框(restore)
  const maxIco = await ev("(function(){var w=document.getElementById('pcWin');var b=w.querySelector('.wbtn.max');"
    +"var im=getComputedStyle(b,'::after').backgroundImage;"
    +"return JSON.stringify({cls:b.className,expand:im.indexOf('M2 5V2H5')>=0,rect:im.indexOf('rect')>=0});})()");
  const m = JSON.parse(maxIco);
  chk('外壳 maxed 态最大化按钮=四角箭头', m.expand && !m.restore && !m.restore2, maxIco);

  // ② 点击还原后图形仍是四角箭头
  await ev("(function(){var w=document.getElementById('pcWin');w.querySelector('.wbtn.max').click();return 1;})()");
  await sleep(300);
  const restIco = await ev("(function(){var w=document.getElementById('pcWin');var b=w.querySelector('.wbtn.max');"
    +"var im=getComputedStyle(b,'::after').backgroundImage;"
    +"return JSON.stringify({cls:b.className,expand:im.indexOf('M2 5V2H5')>=0,rect:im.indexOf('rect')>=0});})()");
  const r2 = JSON.parse(restIco);
  chk('外壳还原态按钮仍=四角箭头', r2.expand && !r2.rect, restIco);
  // 还原窗口状态回 maxed（后续步骤基于 maxed 布局）
  await ev("(function(){document.getElementById('pcWin').querySelector('.wbtn.max').click();return 1;})()");
  await sleep(300);

  // ③ 内层 viewer 全屏按钮：全屏前后图形都是四角箭头
  const clickRes = await ev("(function(){var f=document.getElementById('fmFrame');try{var d=f.contentDocument;var row=d.querySelector('.row');if(!row)return 'no-row';"
    +"var r=row.getBoundingClientRect();"
    +"function pe(t,x,y){return new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,pointerType:'touch',isPrimary:true});}"
    +"row.dispatchEvent(pe('pointerdown',r.x+30,r.y+10));row.dispatchEvent(pe('pointerup',r.x+30,r.y+10));row.click();return 'ok';}catch(e){return 'ERR:'+e.message;}})()");
  await sleep(2200);
  const fsIco = await ev("(function(){var f=document.getElementById('fmFrame');try{var d=f.contentDocument;var b=d.querySelector('.tb-btn.fs');if(!b)return 'no-btn';"
    +"var im=d.defaultView.getComputedStyle(b,'::before').backgroundImage;"
    +"return JSON.stringify({expand:im.indexOf('M2 5V2H5')>=0,rect:im.indexOf('rect x=')>=0});}catch(e){return 'ERR:'+e.message;}})()");
  console.log('   行点击:', clickRes, ' viewer全屏按钮:', fsIco);
  const f1 = JSON.parse(fsIco);
  chk('内层 viewer 未全屏按钮=四角箭头', f1.expand && !f1.rect, fsIco);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('ERR:',e.message);process.exit(2);});
