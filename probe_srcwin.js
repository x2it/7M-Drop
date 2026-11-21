#!/usr/bin/env node
'use strict';
// 探针：源码窗不再撑破页面 + IE 主页文案精简
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
  const port=9800+Math.floor(Math.random()*150);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/src-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1280,860','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(2600);

  // 打开 IE，访问大页面 baidu，再触发"查看源代码"
  await ev("W98.ieOpen(); W98.ieNavTo(document.getElementById('ieWin'), 'https://www.baidu.com');");
  await sleep(7000);
  await ev("(function(){var w=document.getElementById('ieWin');var m=w.querySelector('[data-mu=\"view\"]');if(!m)return 'no-menu';m.click();var it=document.querySelector('[data-act=\"ie-source\"]');if(!it)return 'no-item';it.click();return 'clicked';})()");
  let len=0;
  for(let i=0;i<25;i++){
    await sleep(1000);
    const s=await ev("(function(){var b=document.getElementById('ieSrcBody');var t=b?b.textContent:'';return t.length+(/正在读取/.test(t)?'|loading':'');})()");
    const v=String(s); if(v.indexOf('|loading')<0 && parseInt(v)>1000){ len=parseInt(v); break; }
  }
  ok('源码抓取成功(>1000 字节)', len>1000, 'len='+len);

  const dim=JSON.parse(await ev("(function(){var w=document.getElementById('ieSrcWin');var n=w.querySelector('.notepad');var r=w.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom),inView:r.top>=0&&r.bottom<=window.innerHeight&&r.left>=0&&r.right<=window.innerWidth,scrollable:n.scrollHeight>n.clientHeight,ov:getComputedStyle(n).overflowY,vh:window.innerHeight});})()"));
  ok('源码窗未超出视口(不再撑破)', dim.inView===true, JSON.stringify(dim));
  ok('源码窗高度受控(<视口高)', dim.h<=dim.vh, JSON.stringify(dim));
  ok('超长源码在窗口内滚动', dim.scrollable===true, JSON.stringify(dim));

  const shot=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.3.9-源码窗受控不撑破.png',Buffer.from(shot.data,'base64'));

  // IE 主页文案（服务端文档；iframe 为 opaque origin，父页读不到 contentDocument，故从服务端取）
  const html=await (await fetch(BASE+'/ie-home')).text();
  /* 主页早已从「两个大按钮」改为 Win98 经典链接列表页（.lnk 行），
     这里跟着当前设计断言：两条链接行 + 链接行无下划线 */
  const bigs=[...html.matchAll(/class="lnk"[^>]*>([^<]+)/g)].map(m=>m[1].trim());
  const official=(html.match(/官网/g)||[]).length;
  const noU=/\.lnk\{[^}]*text-decoration:none/.test(html);
  const plain=html.replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
  ok('主页为 2 条链接行（经典链接列表页）', bigs.length===2, JSON.stringify(bigs));
  ok('"官网"只出现 1 次', official===1, 'count='+official);
  ok('链接行无下划线', noU===true, 'no-underline='+noU);
  ok('主页正文明显变短(<200 字)', plain.length<200, 'len='+plain.length+' :: '+plain.slice(0,120));
  const shot2=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.4.8-IE主页链接列表.png',Buffer.from(shot2.data,'base64'));

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e);process.exit(2);});
