#!/usr/bin/env node
'use strict';
/* 截图工具：用 CDP 打开页面并抓取指定状态。
   用法: node shot.js <输出目录>
   产出：desktop.png / mines.png / saver-star.png / saver-fly.png / saver-pipe.png
        / login.png / filemanager.png / mobile.png */
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[3] || 'http://127.0.0.1:3000';
const OUT = process.argv[2] || '/workspace/meowdrop-验收截图';
const TOKEN = process.env.TOKEN || 'wby6sg8pm0';
const PASS = process.env.ADMIN_PASS || '@8688991230';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class WS {
  constructor(u) { const x = new URL(u); this.host = x.hostname; this.port = +x.port; this.path = x.pathname; this.buf = Buffer.alloc(0); this.id = 0; this.pending = new Map(); }
  connect() {
    const k = crypto.randomBytes(16).toString('base64');
    return new Promise((res, rej) => {
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let hs = false;
      this.sock.on('data', d => {
        if (!hs) { const s = d.toString('binary'); const i = s.indexOf('\r\n\r\n'); if (i < 0) return; hs = true; res(); const r = d.slice(Buffer.byteLength(s.slice(0, i + 4), 'binary')); if (r.length) this._f(r); return; }
        this._f(d);
      });
      this.sock.on('error', rej);
    });
  }
  _f(b) {
    this.buf = Buffer.concat([this.buf, b]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1]; let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (b1 & 0x80) off += 4;
      if (this.buf.length < off + len) return;
      const p = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      let m; try { m = JSON.parse(p.toString()); } catch (e) { continue; }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    }
  }
  send(method, params, sid) {
    const id = ++this.id; const o = { id, method, params: params || {} }; if (sid) o.sessionId = sid;
    const d = Buffer.from(JSON.stringify(o)); const mask = crypto.randomBytes(4);
    let h; if (d.length < 126) h = Buffer.from([0x81, 0x80 | d.length]);
    else if (d.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(d.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xff; h.writeBigUInt64BE(BigInt(d.length), 2); }
    const mk = Buffer.alloc(d.length); for (let i = 0; i < d.length; i++) mk[i] = d[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([h, mask, mk]));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); });
  }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9700 + Math.floor(Math.random() * 200);
  const chrome = spawn('/usr/bin/chromium', [
    '--headless=new', '--remote-debugging-port=' + port,
    '--user-data-dir=/tmp/shot-cdp-' + process.pid,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1280,860', 'about:blank',
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const l = await new Promise((res, rej) => { http.get(`http://127.0.0.1:${port}/json/list`, r => { let b = ''; r.on('data', x => b += x); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); });
      const t = l.find(x => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch (e) {}
  }
  const ws = new WS(wsUrl); await ws.connect();
  const tg = await ws.send('Target.getTargets');
  const pt = tg.targetInfos.find(t => t.type === 'page');
  const a = await ws.send('Target.attachToTarget', { targetId: pt.targetId, flatten: true });
  const sid = a.sessionId;
  await ws.send('Page.enable', {}, sid);
  await ws.send('Runtime.enable', {}, sid);

  const ev = async (e) => {
    const r = await ws.send('Runtime.evaluate', { expression: e, returnByValue: true, userGesture: true }, sid);
    if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await ws.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('  ✓ ' + name);
  };
  const metrics = (w, h, mob) => ws.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: !!mob,
  }, sid);

  /* 桌面端全流程 */
  await metrics(1280, 860, false);
  await ws.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(2000);

  /* 1. 桌面 */
  await ev(`(function(){ var m=document.getElementById('msgWin'); if(m) m.hidden=true; })()`);
  await sleep(300);
  await shot('desktop.png');

  /* 2. 开始菜单（展开程序二级菜单） */
  await ev(`document.getElementById('startBtn').click()`);
  await sleep(200);
  await ev(`document.querySelector('.smi.has-sub[data-sub="prog"]').click()`);
  await sleep(300);
  await shot('startmenu.png');
  await ev(`document.getElementById('startBtn').click()`);
  await sleep(200);

  /* 3. 扫雷：先挖几格让画面有内容 */
  await ev(`(function(){var i=document.querySelector('.dicon[data-app="mines"]'); i.click(); i.click();})()`);
  await sleep(500);
  await ev(`(function(){
    var cells=document.querySelectorAll('#mineGrid .cell');
    cells[40].click(); cells[41].click(); cells[31].click();
    cells[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    cells[8].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  })()`);
  await sleep(900);
  await shot('mines.png');
  await ev(`document.querySelector('#mineWin [data-close]').click()`);
  await sleep(250);

  /* 4. 三款屏保：各截一张（给足绘制时间） */
  const kinds = [['saver-star.png', 0, 1600], ['saver-fly.png', 1, 1200], ['saver-maze.png', 2, 2500], ['saver-pipe.png', 3, 2200]];
  for (const [file, idx, wait] of kinds) {
    await ev(`(function(){
      var s=document.getElementById('saverPick'); s.value='${idx}';
      s.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('saverPreview').click();
    })()`);
    await sleep(wait);
    await shot(file);
    await ev(`document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await sleep(400);
  }

  /* 5. 关机三选一 */
  await ev(`document.getElementById('startBtn').click()`);
  await sleep(200);
  await ev(`document.querySelector('#startMenu .smi[data-app="shutdown"]').click()`);
  await sleep(400);
  await shot('shutdown.png');

  /* 5b. 关机全屏：橙字黑底「现在可以安全地关闭计算机了」 */
  await ev(`document.getElementById('shutOk').click()`);
  await sleep(900);
  await shot('shutdown-screen.png');
  await ev(`document.getElementById('shutdown').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await sleep(600);

  /* 6. 登录框 */
  await sleep(400);
  await shot('login.png');

  /* 7. 以 Administrator 登录 → 文件管理器窗口 */
  await ev(`(function(){
    var u=document.getElementById('loginUser'); u.value='Administrator'; u.dispatchEvent(new Event('change',{bubbles:true}));
    var p=document.getElementById('loginPass'); p.value='${PASS}';
  })()`);
  await ev(`document.getElementById('loginOk').click()`);
  await sleep(3500);
  await shot('filemanager-admin.png');

  /* 8. 移动端竖屏 */
  await metrics(390, 844, true);
  await sleep(600);
  await ws.send('Page.navigate', { url: BASE + '/' }, sid);
  await sleep(2200);
  await ev(`(function(){ var m=document.getElementById('msgWin'); if(m) m.hidden=true; })()`);
  await sleep(300);
  await shot('mobile-desktop.png');

  await ev(`(function(){var i=document.querySelector('.dicon[data-app="mines"]'); i.click(); i.click();})()`);
  await sleep(700);
  await shot('mobile-mines.png');

  /* 9. 404 页：Win98 风格错误对话框 */
  await ws.send('Page.navigate', { url: BASE + '/dgd' }, sid);
  await sleep(2200);
  await shot('error-404.png');

  ws.close();
  chrome.kill();
  await sleep(400);
  try { fs.rmSync('/tmp/shot-cdp-' + process.pid, { recursive: true, force: true }); } catch (e) {}
  console.log('\n截图已保存到 ' + OUT);
  process.exit(0);
})().catch(e => { console.error('异常:', e && e.stack || e); process.exit(1); });
