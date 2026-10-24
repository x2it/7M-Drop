#!/usr/bin/env node
/* 手机视口验收：窗口拖拽 + 预览关闭（双击 / 页脚 / 标题栏 ✕） */
'use strict';
const { spawn } = require('child_process');
const http = require('http'), crypto = require('crypto'), net = require('net'), fs = require('fs'), path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT = process.argv[3] || '/tmp/mobshots';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class WS {
  constructor(u) { const x = new URL(u); this.host = x.hostname; this.port = +x.port; this.path = x.pathname; this.buf = Buffer.alloc(0); this.id = 0; this.pending = new Map(); }
  connect() { const k = crypto.randomBytes(16).toString('base64'); return new Promise((res, rej) => { this.sock = net.connect(this.port, this.host, () => { this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`); }); let hs = false; this.sock.on('data', d => { if (!hs) { const s = d.toString('binary'); const i = s.indexOf('\r\n\r\n'); if (i < 0) return; hs = true; res(); const r = d.slice(Buffer.byteLength(s.slice(0, i + 4), 'binary')); if (r.length) this._f(r); return; } this._f(d); }); this.sock.on('error', rej); }); }
  _f(b) { this.buf = Buffer.concat([this.buf, b]); for (;;) { if (this.buf.length < 2) return; const b1 = this.buf[1]; let len = b1 & 0x7f, off = 2; if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; } if (b1 & 0x80) off += 4; if (this.buf.length < off + len) return; const p = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len); let m; try { m = JSON.parse(p.toString()); } catch (e) { continue; } if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } } }
  send(method, params, sid) { const id = ++this.id; const o = { id, method, params: params || {} }; if (sid) o.sessionId = sid; const d = Buffer.from(JSON.stringify(o)); const mask = crypto.randomBytes(4); let h; if (d.length < 126) h = Buffer.from([0x81, 0x80 | d.length]); else if (d.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(d.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xff; h.writeBigUInt64BE(BigInt(d.length), 2); } const mk = Buffer.alloc(d.length); for (let i = 0; i < d.length; i++) mk[i] = d[i] ^ mask[i % 4]; this.sock.write(Buffer.concat([h, mask, mk])); return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); }); }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); } }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9700 + Math.floor(Math.random() * 200);
  const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=/tmp/mob-' + process.pid, '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=400,850', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) { await sleep(250); try { const l = await new Promise((res, rej) => { http.get(`http://127.0.0.1:${port}/json/list`, r => { let b = ''; r.on('data', x => b += x); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); }); const t = l.find(x => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } } catch (e) {} }
  const ws = new WS(wsUrl); await ws.connect();
  const tg = await ws.send('Target.getTargets'); const pt = tg.targetInfos.find(t => t.type === 'page');
  const a = await ws.send('Target.attachToTarget', { targetId: pt.targetId, flatten: true }); const sid = a.sessionId;
  await ws.send('Page.enable', {}, sid); await ws.send('Runtime.enable', {}, sid);
  const ev = async e => { const r = await ws.send('Runtime.evaluate', { expression: e, returnByValue: true, userGesture: true }, sid); if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; };
  const shot = async name => { const { data } = await ws.send('Page.captureScreenshot', { format: 'png' }, sid); fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64')); };

  await ws.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 2, mobile: true }, sid);
  await ws.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  await ws.send('Page.navigate', { url: BASE + '/' }, sid); await sleep(2200);

  /* ── 1) 手机视口下拖拽「我的电脑」窗口标题栏 ── */
  await ev(`(function(){var i=document.querySelector('.dicon[data-app="pc"]'); i.click(); i.click();})()`);
  await sleep(900);
  const dragInfo = JSON.parse(await ev(`(function(){
    var win = document.getElementById('pcWin');
    var bar = win.querySelector('.titlebar');
    var r = bar.getBoundingClientRect();
    var sx = r.x + r.width/2, sy = r.y + r.height/2;
    var el = document.elementFromPoint(sx, sy);
    function pd(x, y){ el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerId:1, clientX:x, clientY:y, isPrimary:true})); }
    pd(sx, sy);
    for (var i=1;i<=8;i++){ window.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerId:1, clientX:sx-15*i, clientY:sy-30*i, isPrimary:true})); }
    window.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, pointerId:1, isPrimary:true}));
    var r2 = win.getBoundingClientRect();
    return JSON.stringify({ moveLeftPx: Math.round(r.x - r2.x), moveUpPx: Math.round(r.y - r2.y) });
  })()`));
  ok('手机端窗口可拖拽（左移>80px）', dragInfo.moveLeftPx > 80, '实际左移 ' + dragInfo.moveLeftPx + 'px');
  ok('手机端窗口可拖拽（上移>150px）', dragInfo.moveUpPx > 150, '实际上移 ' + dragInfo.moveUpPx + 'px');
  await shot('mob-1-drag.png');

  /* 拖回原位再打开视频预览（iframe 内） */
  await ev(`document.getElementById('pcWin').style.cssText=''; document.getElementById('pcWin').hidden=false;`);
  let rowsN = 0;
  for (let i = 0; i < 10; i++) {
    rowsN = await ev(`(function(){try{var d=document.querySelector('#fmFrame').contentDocument; if(!d) return 0; var r=d.querySelectorAll('.list li'); return r.length;}catch(e){return 0;}})()`);
    if (rowsN > 0) break;
    await sleep(500);
  }
  if (!rowsN) throw new Error('文件列表为空');
  await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; var rows=d.querySelectorAll('.list li'); rows[0].click();})()`);
  await sleep(1200);

  const v1 = JSON.parse(await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument;
    var v=d.getElementById('viewer'); if(!v) return '{"open":false}';
    var t=v.querySelector('.titlebar'); var foot=v.querySelector('.viewer-foot');
    return JSON.stringify({ open:true, hidden:v.hidden,
      titlebarVisible: !!t && t.getBoundingClientRect().height>0,
      closeBtnVisible: !!d.getElementById('viewerClose') && d.getElementById('viewerClose').getBoundingClientRect().height>0,
      footCloseExists: !!d.getElementById('viewerCloseFoot'),
      videoFills: (function(){var b=v.querySelector('.viewer-body'); return b? b.getBoundingClientRect().height>200:false;})() });})()`));
  ok('预览已打开且视频撑满主体', v1.open && v1.videoFills);
  ok('内嵌预览标题栏可见（根因修复）', v1.titlebarVisible);
  ok('标题栏 ✕ 关闭按钮可见', v1.closeBtnVisible);
  ok('页脚「关闭」按钮存在', v1.footCloseExists);
  await shot('mob-2-video.png');

  /* ── 2) 双击视频区域关闭 ── */
  await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; var b=d.getElementById('viewerBody');
    var r=b.getBoundingClientRect(); var x=r.x+r.width/2, y=r.y+Math.min(80,r.height/2);
    function pd(){ b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,clientX:x,clientY:y,isPrimary:true})); }
    pd(); setTimeout(pd, 120);})()`);
  await sleep(400);
  const closedByDbl = await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; return d.getElementById('viewer').hidden;})()`);
  ok('双击预览内容即关闭', closedByDbl === true);
  await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; d.querySelectorAll('.list li')[0].click();})()`);
  await sleep(800);

  /* ── 3) 页脚「关闭」按钮 ── */
  await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; d.getElementById('viewerCloseFoot').click();})()`);
  await sleep(300);
  const closedByFoot = await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; return d.getElementById('viewer').hidden;})()`);
  ok('页脚「关闭」按钮可关闭预览', closedByFoot === true);

  /* ── 4) 标题栏 ✕ ── */
  await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; d.querySelectorAll('.list li')[1].click();})()`);
  await sleep(800);
  await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; d.getElementById('viewerClose').click();})()`);
  await sleep(300);
  const closedByX = await ev(`(function(){var d=document.querySelector('#fmFrame').contentDocument; return d.getElementById('viewer').hidden;})()`);
  ok('标题栏 ✕ 可关闭预览', closedByX === true);
  await shot('mob-3-closed.png');

  console.log('手机端验收: ' + pass + ' 通过 / ' + fail + ' 失败');
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
