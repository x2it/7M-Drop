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
  // ① 状态栏长文案不换行不裁切
  const sb=JSON.parse(await ev("(function(){var s=document.getElementById('fmStatus');s.textContent='访客权限：可查看与上传';"
    +"var r=s.getBoundingClientRect();var cs=getComputedStyle(s);"
    +"return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),wrap:s.scrollHeight>s.clientHeight+2,ws:cs.whiteSpace});})()"));
  chk('状态栏单行不换行', !sb.wrap && sb.ws==='nowrap', JSON.stringify(sb));

  // ② 标题栏图标规格统一 + 标题栏高度
  const tb=JSON.parse(await ev("(function(){var out=[];document.querySelectorAll('#pcWin .titlebar button').forEach(function(b){"
    +"var r=b.getBoundingClientRect();var ps=getComputedStyle(b,'::after');"
    +"out.push({cls:b.className,w:Math.round(r.width),h:Math.round(r.height),ico:Math.round(parseFloat(ps.width))});});"
    +"var bar=document.querySelector('#pcWin .titlebar').getBoundingClientRect();"
    +"return JSON.stringify({barH:Math.round(bar.height),btns:out});})()"));
  const icos=tb.btns.map(b=>b.ico);
  chk('标题栏图标规格统一', icos.every(x=>x===icos[0]), icos.join('/'));
  chk('触屏标题栏 ≥44px', tb.barH>=44, 'barH='+tb.barH);
  chk('控制钮触屏尺寸 38×34', tb.btns.every(b=>b.w===38&&b.h===34), tb.btns.map(b=>b.w+'x'+b.h).join(','));

  // ③ 拖拽不出屏：模拟把窗口往右拖 500px
  const drag=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');var bar=w.querySelector('[data-drag]');"
    +"var r0=bar.getBoundingClientRect();var sx=window.scrollX,sy=window.scrollY;"
    +"function pe(t,x,y){return new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,pointerType:'touch',isPrimary:true});}"
    +"bar.dispatchEvent(pe('pointerdown',r0.x+30,r0.y+10));"
    +"window.dispatchEvent(pe('pointermove',r0.x+30+500,r0.y+10));"
    +"window.dispatchEvent(pe('pointermove',r0.x+30+800,r0.y+10));"
    +"window.dispatchEvent(pe('pointerup',r0.x+30+800,r0.y+10));"
    +"var r1=w.getBoundingClientRect();var vw=document.documentElement.clientWidth;"
    +"return JSON.stringify({left:Math.round(r1.x),right:Math.round(r1.right),vw:vw,ok:r1.right<=vw+1});})()"));
  chk('窗口拖不出屏幕右缘', drag.ok, JSON.stringify(drag));

  // ④ 预览弹窗按钮单行（内页行 tap 靠 pointer 事件，click() 单发不生效）
  const clickRes=await ev("(function(){var f=document.getElementById('fmFrame');try{var d=f.contentDocument;var row=d.querySelector('.row');if(!row)return 'no-row:'+d.querySelectorAll('li').length+' src='+f.src;"
    +"var r=row.getBoundingClientRect();"
    +"function pe(t){return new d.defaultView.PointerEvent(t,{bubbles:true,cancelable:true,clientX:r.x+30,clientY:r.y+10,pointerId:1,pointerType:'touch',isPrimary:true});}"
    +"row.dispatchEvent(pe('pointerdown'));row.dispatchEvent(pe('pointerup'));row.click();return 'ok';}catch(e){return 'ERR:'+e.message;}})()");
  console.log('STEP3 foot', typeof clickRes);
  await sleep(2500);
  const foot=await ev("(function(){var f=document.getElementById('fmFrame');try{var d=f.contentDocument;"
    +"var foot=d.querySelector('.viewer-foot');if(!foot)return JSON.stringify({open:false});"
    +"var out={open:true,btns:[]};foot.querySelectorAll('button,.btn-like').forEach(function(b){"
    +"var cs=getComputedStyle(b);out.btns.push({txt:b.textContent.trim(),w:Math.round(b.getBoundingClientRect().width),"
    +"h:Math.round(b.getBoundingClientRect().height),wrap:b.scrollWidth>b.clientWidth+1,ws:cs.whiteSpace,fs:cs.fontSize});});"
    +"return JSON.stringify(out);}catch(e){return 'ERR:'+e.message;}})()");
  const fj=JSON.parse(foot);
  if(!fj.open){chk('预览弹窗可打开',false,'列表可能为空');}
  else{
    chk('预览底部按钮全部单行', fj.btns.length===3 && fj.btns.every(b=>!b.wrap), fj.btns.map(b=>b.txt+':'+b.w+'x'+b.h+(b.wrap?'[换行!]':'')).join(' '));
    chk('预览底部按钮等宽', fj.btns.length>0 && fj.btns.every(b=>b.w===fj.btns[0].w), fj.btns.map(b=>b.w).join('/'));
    chk('预览底部按钮触屏高度≥40', fj.btns.every(b=>b.h>=40), fj.btns.map(b=>b.h).join('/'));
  }

  const s=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.4.6-移动端排版修复.png',Buffer.from(s.data,'base64'));
  console.log('\\n通过 '+pass+' / 失败 '+fail);
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('ERR:',e.message);process.exit(2);});
