#!/usr/bin/env node
'use strict';
// 移动端交互探针：真触屏事件（touch）驱动，验证主要操作可用
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
  const port=9900+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/mi-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});
  await ws.send('Emulation.setDeviceMetricsOverride',{width:400,height:870,deviceScaleFactor:2,mobile:true},sid);
  await ws.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5},sid);
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(3600);

  // 真触屏点击某个元素的中心
  async function tap(sel, nth, wait) {
    const box=await ev("(function(){var els=document.querySelectorAll("+JSON.stringify(sel)+");var e=els["+(nth||0)+"];if(!e)return '{}';"
      +"var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});})()");
    const b=JSON.parse(box);
    if (!b.x && b.x!==0) return null;
    await ws.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:b.x,y:b.y}]},sid);
    await sleep(40);
    await ws.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sid);
    await sleep(wait||500);
    return b;
  }

  // ① 双击桌面图标（触屏：两次快速 tap）→ 打开窗口
  await tap('.dicon[data-app="pc"]', 0, 120);
  await tap('.dicon[data-app="pc"]', 0, 400);
  await sleep(1500);
  let opened=await ev("!document.getElementById('pcWin').hidden");
  ok('触屏双击图标打开「我的电脑」', opened===true, 'hidden='+opened);

  // ② 触屏点菜单 → 下拉出现
  const mb=await tap('#pcWin .menubar .mu');
  const drop=await ev("document.querySelectorAll('#pcWin .mdrop').length");
  ok('触屏点菜单弹出下拉', drop>0, 'mdrop='+drop);

  // ③ 菜单项可点（触发动作）
  await tap('#pcWin .mdrop .ctxi');
  await sleep(800);
  const afterMenu=await ev("(function(){return JSON.stringify({mdrop:document.querySelectorAll('#pcWin .mdrop').length,dialogs:document.querySelectorAll('.dlg:not([hidden]),.mask:not([hidden])').length});})()");
  ok('触屏点菜单项有响应（下拉关闭）', JSON.parse(afterMenu).mdrop===0, afterMenu);

  // ④ 触屏点关闭钮 → 窗口关闭
  await tap('#pcWin .wclose');
  await sleep(900);
  const closed=await ev("document.getElementById('pcWin').hidden");
  ok('触屏点关闭钮关闭窗口', closed===true, 'hidden='+closed);

  // ⑤ 触屏点开始按钮 → 开始菜单
  const sb=await tap('#startBtn');
  const sm=await ev("document.querySelectorAll('.startmenu:not([hidden]),#startMenu:not([hidden])').length");
  ok('触屏点「开始」弹出菜单', sm>0, 'count='+sm);
  await ev("(function(){document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return 1;})()");

  // ⑥ 触屏长按桌面图标 → 右键菜单
  await ev("(function(){var ic=document.querySelector('.dicon[data-app=\"ie\"]');var r=ic.getBoundingClientRect();"
    +"ic.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[new Touch({identifier:1,target:ic,clientX:r.left+10,clientY:r.top+10})]}));return 1;})()");
  await sleep(800);
  const ctxShown=await ev("!document.getElementById('iconCtx').hidden");
  ok('触屏长按图标出右键菜单', ctxShown===true, 'hidden='+ctxShown);

  // ⑦ 无横向溢出
  const ov=await ev("document.documentElement.scrollWidth<=document.documentElement.clientWidth");
  ok('无横向溢出', ov===true, 'scrollW='+await ev("document.documentElement.scrollWidth"));

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e.message);process.exit(2);});
