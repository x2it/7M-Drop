#!/usr/bin/env node
'use strict';
// 探针：手机视口 + embed 模式下，viewer 弹窗标题栏按钮图标是否渲染
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
  const port=9995+Math.floor(Math.random()*4);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/ic-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  // 手机视口（与用户截图一致：约 400×870 CSS px）
  await ws.send('Emulation.setDeviceMetricsOverride',{width:400,height:870,deviceScaleFactor:2,mobile:true},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});

  // embed 模式（=「我的电脑」窗口里内嵌的文件服务页）
  await ws.send('Page.navigate',{url:BASE+'/s/guest1234/?embed=1&nc='+Date.now()});await sleep(3600);
  const st=JSON.parse(await ev("(function(){var cs=getComputedStyle(document.documentElement);var v=cs.getPropertyValue('--ico-x');var sheets=[];for(var i=0;i<document.styleSheets.length;i++){try{sheets.push(document.styleSheets[i].href||'inline');}catch(e){sheets.push('ERR');}}"
    +"var cs2=getComputedStyle(document.body);return JSON.stringify({icoX:v.trim().slice(0,50),bodyIco:cs2.getPropertyValue('--ico-x').trim().slice(0,50),sheets:sheets,bodyCls:document.body.className,htmlStyle:document.querySelector('link[rel=stylesheet]')?document.querySelector('link[rel=stylesheet]').href:null});})()"));
  ok('embed 页 CSS 变量 --ico-x 有定义', st.icoX.indexOf('data:image/svg+xml')>=0, JSON.stringify(st));

  // 打开 viewer，检查标题栏两个按钮的 ::before 图标
  await ev("(function(){var row=document.querySelector('.row.tappable');if(row)row.click();return !!row;})()");
  await sleep(1200);
  await ev("(function(){var b=document.querySelector('.sheet-item[data-act=\"preview\"]');if(b&&!b.hidden){b.click();return 1;}return 0;})()");
  await sleep(2500);
  const btn=JSON.parse(await ev("(function(){"
    +"function info(sel){var b=document.querySelector(sel);if(!b)return {sel:sel,miss:true};"
    +"var cs=getComputedStyle(b);var bs=getComputedStyle(b,'::before');"
    +"return {sel:sel,w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height),"
    +"bg:bs.backgroundImage.slice(0,60),bgSize:bs.backgroundSize,bw:bs.width,bh:bs.height,content:bs.content,vis:cs.visibility,z:cs.zIndex};}"
    +"return JSON.stringify({close:info('#viewerClose'),fs:info('#viewerFs')});})()"));
  ok('关闭按钮 ::before 有 svg 图标', !!btn.close && btn.close.bg && btn.close.bg.indexOf('data:image/svg+xml')>=0, JSON.stringify(btn.close));
  ok('全屏按钮 ::before 有 svg 图标', !!btn.fs && btn.fs.bg && btn.fs.bg.indexOf('data:image/svg+xml')>=0, JSON.stringify(btn.fs));
  ok('按钮有实际尺寸', btn.close && btn.close.w>=15 && btn.close.h>=15, JSON.stringify(btn.close));

  const s=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.4.1-手机embed-预览弹窗按钮.png',Buffer.from(s.data,'base64'));

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e.message);process.exit(2);});
