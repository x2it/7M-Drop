#!/usr/bin/env node
'use strict';
/* 自动排版体检：扫描桌面/移动端各界面里的横向溢出、文本裁切、
   元素出屏、可点目标过小。复用 CDP 框架（无需 puppeteer）。 */
const { spawn } = require('child_process');
const http = require('http'), crypto = require('crypto'), net = require('net');
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const MOBILE = process.argv[3] === 'mobile';
const sleep = ms => new Promise(r => setTimeout(r, ms));
class WS {
  constructor(u){const x=new URL(u);this.host=x.hostname;this.port=+x.port;this.path=x.pathname;this.buf=Buffer.alloc(0);this.id=0;this.pending=new Map();}
  connect(){const k=crypto.randomBytes(16).toString('base64');return new Promise((res,rej)=>{this.sock=net.connect(this.port,this.host,()=>{this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`);});let hs=false;this.sock.on('data',d=>{if(!hs){const s=d.toString('binary');const i=s.indexOf('\r\n\r\n');if(i<0)return;hs=true;res();const r=d.slice(Buffer.byteLength(s.slice(0,i+4),'binary'));if(r.length)this._f(r);return;}this._f(d);});this.sock.on('error',rej);});}
  _f(b){this.buf=Buffer.concat([this.buf,b]);for(;;){if(this.buf.length<2)return;const b1=this.buf[1];let len=b1&0x7f,off=2;if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);off=4;}else if(len===127){if(this.buf.length<10)return;len=Number(this.buf.readBigUInt64BE(2));off=10;}if(b1&0x80)off+=4;if(this.buf.length<off+len)return;const p=this.buf.slice(off,off+len);this.buf=this.buf.slice(off+len);let m;try{m=JSON.parse(p.toString());}catch(e){continue;}if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}}}
  send(method,params,sid){const id=++this.id;const o={id,method,params:params||{}};if(sid)o.sessionId=sid;const d=Buffer.from(JSON.stringify(o));const mask=crypto.randomBytes(4);let h;if(d.length<126)h=Buffer.from([0x81,0x80|d.length]);else if(d.length<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=0xfe;h.writeUInt16BE(d.length,2);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0xff;h.writeBigUInt64BE(BigInt(d.length),2);}const mk=Buffer.alloc(d.length);for(let i=0;i<d.length;i++)mk[i]=d[i]^mask[i%4];this.sock.write(Buffer.concat([h,mask,mk]));return new Promise((res,rej)=>{this.pending.set(id,{res,rej});setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);rej(new Error('timeout '+method));}},30000);});}
  close(){try{this.sock.destroy();}catch(e){}}
}
let pass=0,fail=0;
function chk(n,ok,d){console.log((ok?'✔':'✘')+' '+n+(d?'  ['+d+']':''));ok?pass++:fail++;}

/* 页面内体检：以 document 为根（window.documentElement 不是标准属性） */
const AUDIT = `(function(doc,label){
  var win=doc.defaultView, out={label:label,docScroll:[],clipped:[],offscreen:[],tiny:[],misalign:[]};
  var vw=win.innerWidth, de=doc.documentElement;
  if(de.scrollWidth>vw+1) out.docScroll.push(de.scrollWidth+'>'+vw);
  var all=doc.querySelectorAll('*');
  for(var i=0;i<all.length;i++){
    var el=all[i], r=el.getBoundingClientRect(), cs=win.getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden') continue;
    if(r.width===0&&r.height===0) continue;
    var name=(el.id||el.className||el.tagName).toString().slice(0,42);
    if(el.scrollWidth>el.clientWidth+2 && cs.overflowX!=='visible' && el.clientWidth>0){
      if(out.clipped.length<8) out.clipped.push(name+' sw'+el.scrollWidth+'/cw'+el.clientWidth);
    }
    if(r.right>vw+2 && cs.position!=='fixed'){
      if(out.offscreen.length<8) out.offscreen.push(name+' r'+Math.round(r.right));
    }
    var tag=el.tagName;
    if((tag==='BUTTON'||tag==='A'||(el.getAttribute&&el.getAttribute('role')==='button'))&&r.width>0&&r.height>0){
      if(r.height<24||r.width<24){ if(out.tiny.length<8) out.tiny.push(name+' '+Math.round(r.width)+'x'+Math.round(r.height)); }
    }
    if(el.children.length===0 && el.scrollHeight>el.clientHeight+2 && cs.overflowY==='hidden' && el.clientHeight>0){
      if(out.misalign.length<8) out.misalign.push(name+' sh'+el.scrollHeight+'/ch'+el.clientHeight);
    }
  }
  return JSON.stringify(out);
})`;
(async()=>{
  const port=(MOBILE?9880:9870)+Math.floor(Math.random()*9);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/pl-'+(MOBILE?'m':'d')+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
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
  const auditIn=(expr)=>ws.send('Runtime.evaluate',{expression:expr,returnByValue:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('AUDIT EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return JSON.parse(r.result.value);});
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(3200);

  /* ① 桌面 */
  let r=await auditIn('('+AUDIT+')(document,'+JSON.stringify(tag+'-桌面')+')');
  chk(tag+' 桌面：无横向溢出', r.docScroll.length===0 && r.offscreen.length===0, JSON.stringify(r.docScroll)+JSON.stringify(r.offscreen));
  chk(tag+' 桌面：无文本裁切', r.misalign.length===0, JSON.stringify(r.misalign));
  if(MOBILE) chk(tag+' 桌面：可点元素≥24px', r.tiny.length===0, JSON.stringify(r.tiny));

  /* ② 文件管理器（内页 iframe） */
  await ev("(function(){var i=document.querySelector('.dicon[data-app=\"pc\"]'); i.click(); i.click();})()");await sleep(800);
  await ev("(function(){var w=document.getElementById('pcWin'); w.hidden=false; var f=document.getElementById('fmFrame'); if(f && !f.getAttribute('src')) f.setAttribute('src','"+boot.guestUrl+"?embed=1'); return 1;})()");await sleep(3200);
  const ia=await auditIn("(function(){var f=document.getElementById('fmFrame');try{return ("+AUDIT+")(f.contentDocument,'内页');}catch(e){return JSON.stringify({docScroll:[],offscreen:[],misalign:[],tiny:[]});}})()");
  chk(tag+' 内页：无横向溢出', ia.docScroll.length===0 && ia.offscreen.length===0, JSON.stringify(ia.docScroll)+JSON.stringify(ia.offscreen));
  chk(tag+' 内页：无文本裁切', ia.misalign.length===0, JSON.stringify(ia.misalign));
  if(MOBILE) chk(tag+' 内页：可点元素≥24px', ia.tiny.length===0, JSON.stringify(ia.tiny));

  /* ③ 预览弹窗 */
  await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;var row=d.querySelector('.row'); if(row) row.click(); return !!row;})()");await sleep(2200);
  const va=await auditIn("(function(){var f=document.getElementById('fmFrame');try{return ("+AUDIT+")(f.contentDocument,'预览');}catch(e){return JSON.stringify({docScroll:[],offscreen:[],misalign:[],tiny:[]});}})()");
  chk(tag+' 预览：无横向溢出', va.docScroll.length===0 && va.offscreen.length===0, JSON.stringify(va.docScroll)+JSON.stringify(va.offscreen));
  chk(tag+' 预览：无文本裁切', va.misalign.length===0, JSON.stringify(va.misalign));

  /* ④ 链接与权限弹窗（信息量最大的界面） */
  await ev("(function(){var f=document.getElementById('fmFrame');var d=f.contentDocument;var m=d.getElementById('tbMode'); if(m)m.click(); return !!m;})()");await sleep(900);
  const ia2=await auditIn("(function(){var f=document.getElementById('fmFrame');try{return ("+AUDIT+")(f.contentDocument,'权限窗');}catch(e){return JSON.stringify({docScroll:[],offscreen:[],misalign:[],tiny:[]});}})()");
  chk(tag+' 权限窗：无横向溢出', ia2.docScroll.length===0 && ia2.offscreen.length===0, JSON.stringify(ia2.docScroll)+JSON.stringify(ia2.offscreen));
  chk(tag+' 权限窗：无文本裁切', ia2.misalign.length===0, JSON.stringify(ia2.misalign));
  if(MOBILE) chk(tag+' 权限窗：可点元素≥24px', ia2.tiny.length===0, JSON.stringify(ia2.tiny));

  console.log('\n['+tag+'] 结果: '+pass+' 通过 / '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('ERR:',e.message);process.exit(2);});
