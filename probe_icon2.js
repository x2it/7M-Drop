#!/usr/bin/env node
'use strict';
// 探针：外壳窗口控制钮图标渲染核查（桌面 + 手机）
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
  const port=9990+Math.floor(Math.random()*4);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/ib-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});

  // ── 外壳（根桌面）窗口控制钮 ──
  await ws.send('Emulation.setDeviceMetricsOverride',{width:400,height:870,deviceScaleFactor:2,mobile:true},sid);
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(2800);
  const root=JSON.parse(await ev("(function(){var cs=getComputedStyle(document.documentElement);var v=cs.getPropertyValue('--ico-x');return JSON.stringify({icoX:v.trim().slice(0,50),hasVar:v.indexOf('data:image/svg+xml')>=0});})()"));
  ok('外壳 :root --ico-x 已定义', root.hasVar===true, JSON.stringify(root));

  // 打开「我的电脑」窗口，检查其标题栏按钮图标
  await ev("(function(){var w=document.getElementById('pcWin');if(!w)return 'no-win';W98.openWin(w);return 'opened';})()");
  await sleep(2000);
  await sleep(1800);
  const wb=JSON.parse(await ev("(function(){"
    +"function bg(x){return x?String(x).slice(0,55):''}"
    +"function info(el,label,pseudo){var ps=getComputedStyle(el,pseudo||'::after');var r=el.getBoundingClientRect();"
    +"return {sel:label,bg:bg(ps.backgroundImage),w:Math.round(r.width),h:Math.round(r.height)};}"
    +"var out=[];var w=document.getElementById('pcWin');if(!w)return JSON.stringify([{sel:'pcWin missing'}]);"
    +"var c=w.querySelector('.wclose');if(c)out.push(info(c,'pcWin.wclose','::after'));"
    +"var b=w.querySelector('.wbtn.min');if(b)out.push(info(b,'pcWin.min','::after'));"
    +"var b2=w.querySelector('.wbtn.max');if(b2)out.push(info(b2,'pcWin.max','::after'));"
    +"return JSON.stringify(out);})()"));
  console.log('  外壳按钮:', JSON.stringify(wb));
  ok('「我的电脑」窗口关闭钮有 X 图标', wb.some(x=>x.sel==='pcWin.wclose'&&x.bg&&x.bg.indexOf('data:image/svg+xml')>=0), JSON.stringify(wb));
  ok('「我的电脑」窗口最小化钮有图标', wb.some(x=>x.sel==='pcWin.min'&&x.bg&&x.bg.indexOf('data:image/svg+xml')>=0), JSON.stringify(wb));

  // ── 桌面图标本身（.dicon 里的 svg 图标）──
  const icons=JSON.parse(await ev("(function(){var bad=[],n=0;"
    +"document.querySelectorAll('.dicon .ico-pc,.dicon .ico-mine,.dicon .ico-snake,.dicon .ico-saver,"
    +".dicon .ico-install,.dicon .ico-note,.dicon .ico-ie,.dicon .ico-net,.dicon .ico-qq,.dicon .ico-dos,.dicon .ico-trash')"
    +".forEach(function(el){n++;var cs=getComputedStyle(el);var pb=getComputedStyle(el,'::before');"
    +"var r=el.getBoundingClientRect();"
    +"var hasPaint=(pb.backgroundImage&&pb.backgroundImage!=='none')||(pb.content&&pb.content!=='none'&&pb.content!=='\"\"')"
    +"||(cs.backgroundImage&&cs.backgroundImage!=='none')||(pb.boxShadow&&pb.boxShadow!=='none');"
    +"var painted=hasPaint||(el.textContent&&el.textContent.trim().length>0);"
    +"if(!painted||r.width<8||r.height<8){bad.push(el.className+' w='+Math.round(r.width)+' h='+Math.round(r.height)+' paint='+hasPaint);}});"
    +"return JSON.stringify({total:n,bad:bad,labels:Array.prototype.map.call(document.querySelectorAll('.dicon .dlabel'),function(x){return x.textContent;})});})()"));
  console.log('  桌面图标:', JSON.stringify(icons.total), '异常:', JSON.stringify(icons.bad));
  ok('桌面图标无空图标', icons.bad.length===0, JSON.stringify(icons.bad));
  ok('桌面 11 个图标齐全', icons.labels.length===11, JSON.stringify(icons.labels));

  const s=await ws.send('Page.captureScreenshot',{format:'png'},sid);
  fs.writeFileSync('/workspace/7M-Drop-验收截图/v2.4.1-手机端图标核查.png',Buffer.from(s.data,'base64'));

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e.message);process.exit(2);});
