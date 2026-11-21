#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const http = require('http'), crypto = require('crypto'), net = require('net'), fs = require('fs');
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
(async()=>{
  const port=(MOBILE?9820:9810)+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/psb-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
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
  const boot=await new Promise((res,rej)=>{http.get(BASE+'/api/boot',r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});
  const tag=MOBILE?'移动端':'桌面端';
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(3200);
  await ev("(function(){var i=document.querySelector('.dicon[data-app=\"pc\"]'); i.click(); i.click();})()");await sleep(800);
  await ev("(function(){var w=document.getElementById('pcWin'); w.hidden=false; var f=document.getElementById('fmFrame'); if(f && !f.getAttribute('src')) f.setAttribute('src','"+boot.guestUrl+"?embed=1'); return 1;})()");await sleep(4000);

  const r=JSON.parse(await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;"
    +"var inner=d.querySelector('.statusbar');"
    +"var outer=document.querySelector('#pcWin .statusbar');"
    +"var s1=document.getElementById('fmStatus'), s2=document.getElementById('fmInfo'), s3=document.getElementById('fmWho');"
    +"function box(el){if(!el)return null;var b=el.getBoundingClientRect();return {t:Math.round(b.top),h:Math.round(b.height),w:Math.round(b.width),txt:el.textContent.trim(),cut:el.scrollWidth>el.clientWidth+1};}"
    +"return JSON.stringify({innerHidden: !inner || getComputedStyle(inner).display==='none' || inner.getBoundingClientRect().height===0,"
    +"outer:box(outer),s1:box(s1),s2:box(s2),s3:box(s3)});})()"));
  chk(tag+' 内页状态栏已隐藏（只剩一条）', r.innerHidden===true, JSON.stringify(r.innerHidden));
  chk(tag+' 外壳状态栏仅一条', !!r.outer, JSON.stringify(r.outer&&r.outer.h));
  chk(tag+' 外壳状态栏权限文案正确', /分享模式|管理模式/.test(r.s1.txt), r.s1.txt);
  chk(tag+' 外壳状态栏含容量/限制信息（未丢失）', r.s2.txt.length>0, r.s2.txt);
  chk(tag+' 外壳状态栏身份标识', /访客|管理员/.test(r.s3.txt), r.s3.txt);
  chk(tag+' 状态栏三格不溢出/不裁切', !r.s1.cut && !r.s2.cut && !r.s3.cut, JSON.stringify({s1:r.s1.cut,s2:r.s2.cut,s3:r.s3.cut}));
  const shot=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.mkdirSync('/tmp/shots4',{recursive:true});
  fs.writeFileSync('/tmp/shots4/sb-'+(MOBILE?'m':'d')+'.png',Buffer.from(shot.data,'base64'));
  console.log('\n结果: '+pass+' 通过 / '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('ERR:',e.message);process.exit(2);});
