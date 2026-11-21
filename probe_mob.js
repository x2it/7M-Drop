#!/usr/bin/env node
'use strict';
// 移动端全面体检：视口、触摸目标、溢出、按钮比例
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
(async()=>{
  const port=9910+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/mob-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
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

  const r1=JSON.parse(await ev("(function(){"
    +"var de=document.documentElement;"
    +"return JSON.stringify({vw:window.innerWidth,vh:window.innerHeight,deScroll:de.scrollWidth,deClient:de.clientWidth,"
    +"overflow:de.scrollWidth>de.clientWidth});})()"));
  console.log('① 视口/溢出:', JSON.stringify(r1));

  // 桌面图标触摸目标
  const icons=JSON.parse(await ev("(function(){var out=[];document.querySelectorAll('.dicon').forEach(function(d){"
    +"var r=d.getBoundingClientRect();out.push({t:d.getAttribute('data-app'),w:Math.round(r.width),h:Math.round(r.height)});});"
    +"return JSON.stringify(out);})()"));
  const smallIcon=icons.filter(x=>x.w<44||x.h<44);
  console.log('② 桌面图标尺寸:', icons.map(x=>x.t+':'+x.w+'x'+x.h).join(' '));
  console.log('   <44px 的:', smallIcon.length? JSON.stringify(smallIcon):'无');

  // 打开窗口，检查控制钮尺寸与图标比例
  await ev("(function(){var w=document.getElementById('pcWin');if(w)W98.openWin(w);return 1;})()");
  await sleep(2000);
  const btns=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');var out=[];"
    +"w.querySelectorAll('.wbtn,.wclose').forEach(function(b){var r=b.getBoundingClientRect();"
    +"var ps=getComputedStyle(b,'::after');var pb=getComputedStyle(b,'::before');"
    +"var g=getComputedStyle(b);"
    +"out.push({cls:b.className,w:Math.round(r.width),h:Math.round(r.height),"
    +"iconW:ps.width||pb.width||'0',iconH:ps.height||pb.height||'0',bg:(ps.backgroundImage||pb.backgroundImage||'none').slice(0,20),bgSize:ps.backgroundSize||pb.backgroundSize});});"
    +"return JSON.stringify(out);})()"));
  console.log('③ 窗口控制钮:', JSON.stringify(btns));

  // 菜单栏项触摸高度
  const menu=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');var m=w.querySelector('.menubar .mu');"
    +"if(!m)return '{}';var r=m.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height)});})()"));
  console.log('④ 菜单项尺寸:', JSON.stringify(menu));

  // 任务栏
  const tb=JSON.parse(await ev("(function(){var t=document.getElementById('taskbar')||document.querySelector('.taskbar');if(!t)return '{}';"
    +"var r=t.getBoundingClientRect();var st=document.querySelector('.taskbar .tb-start, #btnStart, .startbtn');"
    +"var sr=st?st.getBoundingClientRect():null;"
    +"return JSON.stringify({bar:{h:Math.round(r.height)},start:sr?{w:Math.round(sr.width),h:Math.round(sr.height)}:null});})()"));
  console.log('⑤ 任务栏:', JSON.stringify(tb));

  // 窗口是否溢出屏幕
  const win=JSON.parse(await ev("(function(){var w=document.getElementById('pcWin');var r=w.getBoundingClientRect();"
    +"return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),vw:window.innerWidth});})()"));
  console.log('⑥ 我的电脑窗口:', JSON.stringify(win));

  const s=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.4.5-移动端体检.png',Buffer.from(s.data,'base64'));
  ws.close();chrome.kill('SIGKILL');process.exit(0);
})().catch(e=>{console.error('ERR:',e.message);process.exit(2);});
