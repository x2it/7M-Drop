#!/usr/bin/env node
'use strict';
// 探针：右键菜单点空白关闭 / 内层 viewer 设计统一 / 主页链接列表
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
  const port=9970+Math.floor(Math.random()*25);
  const chrome=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-port='+port,'--user-data-dir=/tmp/pp-'+process.pid,'--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1280,860','about:blank'],{stdio:'ignore'});
  let wsUrl=null;
  for(let i=0;i<40;i++){await sleep(250);try{const l=await new Promise((res,rej)=>{http.get(`http://127.0.0.1:${port}/json/list`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(JSON.parse(b)));}).on('error',rej);});const t=l.find(x=>x.type==='page');if(t){wsUrl=t.webSocketDebuggerUrl;break;}}catch(e){}}
  const ws=new WS(wsUrl);await ws.connect();
  const tg=await ws.send('Target.getTargets');const pt=tg.targetInfos.find(t=>t.type==='page');
  const a=await ws.send('Target.attachToTarget',{targetId:pt.targetId,flatten:true});const sid=a.sessionId;
  await ws.send('Page.enable',{},sid);await ws.send('Runtime.enable',{},sid);
  const ev=e=>ws.send('Runtime.evaluate',{expression:e,returnByValue:true,userGesture:true},sid).then(r=>{if(r.exceptionDetails)throw new Error('EXC: '+(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails.text));return r.result.value;});
  await ws.send('Page.navigate',{url:BASE+'/?nc='+Date.now()});await sleep(2600);

  // ① 图标右键菜单 → 点空白应消失
  const openMenu=await ev("(function(){var ic=document.querySelector('.dicon[data-app=\"ie\"]');var r=ic.getBoundingClientRect();ic.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+5,clientY:r.top+5}));var m=document.getElementById('iconCtx');return m.hidden?('hidden:'+m.querySelectorAll('.ctxi').length):'shown';})()");
  ok('图标右键菜单能弹出', openMenu==='shown', openMenu);
  await ev("(function(){document.getElementById('desk').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,clientX:600,clientY:500}));return 1;})()");
  await sleep(400);
  const closed=await ev("document.getElementById('iconCtx').hidden");
  ok('点空白处 → 图标右键菜单消失', closed===true, 'hidden='+closed);

  // ② 桌面空白右键菜单 → 点空白应消失（回归）
  await ev("(function(){document.getElementById('desk').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:500}));return 1;})()");
  await sleep(300);
  const c2open=await ev("!document.getElementById('ctxMenu').hidden");
  ok('桌面空白右键菜单能弹出', c2open===true, 'shown='+c2open);
  await ev("(function(){document.getElementById('desk').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,clientX:300,clientY:400}));return 1;})()");
  await sleep(300);
  const c2=await ev("document.getElementById('ctxMenu').hidden");
  ok('点空白处 → 桌面右键菜单消失', c2===true, 'hidden='+c2);

  // ③ 内层 viewer 设计统一（/s/ 文件服务页的预览弹窗）—— 需打开真实预览才能取到元素，
  //    没有可预览文件时改为核对 CSS 规则本身（.viewer-body 底色 / .viewer-tip 文字 / 按钮立体阴影）
  const guestUrl=JSON.parse(await new Promise((res,rej)=>{http.get(BASE+'/api/boot',r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>res(b));}).on('error',rej);})).guestUrl;
  await ws.send('Page.navigate',{url:BASE+guestUrl+'?nc='+Date.now()});await sleep(3400);
  const vw=JSON.parse(await ev("(function(){var d=document.getElementById('viewerBody');var cs=d?getComputedStyle(d):null;var tip=document.querySelector('.viewer-tip');var btn=document.querySelector('.viewer-tip .btn-like');"
    +"var css='';for(var i=0;i<document.styleSheets.length;i++){try{var r=document.styleSheets[i].cssRules;for(var j=0;j<r.length;j++){css+=r[j].cssText+'\\n';}}catch(e){}}"
    +"function rule(sel){var re=new RegExp('\\\\'+sel.replace(/\\s+/g,'\\\\s*')+'\\\\s*\\\\{([^}]*)');var m=css.match(re);return m?m[1]:null;}"
    +"var rb=rule('.viewer-body'), rt=rule('.viewer-tip'), rbtn=rule('.viewer-tip .btn-like'), rfoot=rule('.btn-like');"
    +"return JSON.stringify({bg:cs?cs.backgroundColor:null,ruleBg:rb,rbg:rb?((rb.match(/background:\\s*([^;]+)/)||[])[1]||null):null,"
    +"tipRule:rt,btnRule:rbtn,footRule:rfoot,tipColor:tip?getComputedStyle(tip).color:null,btnShadow:btn?getComputedStyle(btn).boxShadow:null,btnRadius:btn?getComputedStyle(btn).borderRadius:null});})()"));
  ok('预览区改为 98 浅底（非纯黑）', vw.bg!=='rgb(0, 0, 0)' && (!vw.rbg || vw.rbg.indexOf('#000')<0), JSON.stringify(vw));
  ok('提示文字为深色（浅底可读）', vw.tipColor==='rgb(0, 0, 0)' || (!!vw.tipRule && /color:\s*(#000\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/.test(vw.tipRule)), JSON.stringify(vw));
  ok('下载按钮为 98 立体阴影（非无阴影现代按钮）', (!!vw.btnShadow && vw.btnShadow!=='none') || (!!vw.btnRule && /box-shadow/.test(vw.btnRule)), JSON.stringify(vw));
  ok('下载按钮无圆角', vw.btnRadius==='0px' || (!!vw.btnRule && !/border-radius/.test(vw.btnRule)), JSON.stringify(vw));

  // ④ 主页链接列表
  const home=await (await fetch(BASE+'/ie-home')).text();
  const links=[...home.matchAll(/class="lnk"[^>]*>([^<]*)<span class="u">([^<]*)</g)].map(m=>m[1].trim()+' | '+m[2]);
  ok('主页为链接列表（2 条）', links.length===2, JSON.stringify(links));
  ok('无残留的「大按钮卡片」样式', !/class="big"/.test(home) && !/a\.big\{/.test(home), '');
  const official=(home.match(/官网/g)||[]).length;
  ok('「官网」全页只出现 1 次', official===1, 'count='+official);
  ok('无「官方网站」独立行', !/官方网站/.test(home), '');

  console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
  ws.close();chrome.kill('SIGKILL');process.exit(fail?1:0);
})().catch(e=>{console.error('探针异常:',e.message);process.exit(2);});
