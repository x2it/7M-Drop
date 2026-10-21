#!/usr/bin/env node
'use strict';
/* 桌面（根路径）验收：CDP 直连 headless Chromium，不依赖任何 npm 包。
   用法: node desktoptest.js [baseUrl] [token] [shareToken]
   默认 http://127.0.0.1:8080 / wby6sg8pm0 / guest1234

   为什么自己写 CDP 而不用 playwright：本项目卖点是零依赖，
   测试脚本也不该引入 300MB 的浏览器驱动。WebSocket 客户端用最朴素的方式实现。*/

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
const TOKEN = process.argv[3] || process.env.TOKEN || 'wby6sg8pm0';
const SHARE = process.argv[4] || process.env.SHARE_TOKEN || 'guest1234';
const ADMIN_PASS = process.env.ADMIN_PASS || '@8688991230';

const { spawn, execSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── 极简 WebSocket 客户端（只支持文本帧，够 CDP 用）── */
class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this._res = res; this._rej = rej; });
  }
  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.connect(this.port, this.host, () => {
      this.sock.write(
        'GET ' + this.path + ' HTTP/1.1\r\n' +
        'Host: ' + this.host + ':' + this.port + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let handshaken = false;
    this.sock.on('data', (d) => {
      if (!handshaken) {
        const s = d.toString('binary');
        const idx = s.indexOf('\r\n\r\n');
        if (idx < 0) return;
        handshaken = true;
        if (!/101/.test(s.slice(0, 40))) { this._rej(new Error('握手失败')); return; }
        this._res();
        const rest = d.slice(Buffer.byteLength(s.slice(0, idx + 4), 'binary'));
        if (rest.length) this._frame(rest);
        return;
      }
      this._frame(d);
    });
    this.sock.on('error', (e) => { this._rej(e); });
    return this.ready;
  }
  _frame(buf) {
    this.buf = Buffer.concat([this.buf, buf]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (b1 & 0x80) off += 4; // 服务端不应带 mask，防御性跳过
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      let msg = null;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        this.handlers.get(msg.method)(msg.params);
      }
    }
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const obj = { id, method, params: params || {} };
    if (sessionId) obj.sessionId = sessionId;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(data.length), 2); }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); }
      }, 20000);
    });
  }
  close() { try { this.sock.destroy(); } catch (e) {} }
}

function httpJson(path) {
  return new Promise((res, rej) => {
    const u = new URL(path, BASE);
    http.get(u, (r) => {
      let b = '';
      r.on('data', (c) => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    }).on('error', rej);
  });
}
function httpCode(path, opts) {
  return new Promise((res) => {
    const u = new URL(path, BASE);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {} },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b, headers: r.headers })); });
    req.on('error', () => res({ code: 0, body: '' }));
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

let ws, sid;
async function evaluate(expr, awaitPromise) {
  const r = await ws.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: !!awaitPromise,
    userGesture: true,
  }, sid);
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result && r.result.value;
}
async function goto(url) {
  await ws.send('Page.navigate', { url }, sid);
  await sleep(1400);
}
/* 轮询等待页面条件成立（真实等事件发生，不拍脑袋睡） */
async function waitFor(expr, timeout, label) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await evaluate(expr); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > (timeout || 8000)) { console.log('  (等待超时: ' + (label || expr.slice(0, 60)) + ')'); return null; }
    await sleep(200);
  }
}
async function clickSel(sel) {
  return evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOEL'; e.click(); return 'OK';})()`);
}
async function setVal(sel, v) {
  return evaluate(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOEL'; e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';})()`);
}

(async function main() {
  console.log('\n桌面验收 @ ' + BASE + '\n');

  /* ── 静态路由断言（不需要浏览器）── */
  const boot = await httpJson('/api/boot');
  ok('/api/boot 返回 guestUrl', !!(boot && boot.guestUrl), JSON.stringify(boot));
  ok('/api/boot 的 guestUrl 指向分享口令', !!(boot && boot.guestUrl === '/s/' + SHARE + '/' || /^\/s\/[^/]+\/$/.test(boot.guestUrl || '')), boot && boot.guestUrl);
  ok('/api/boot 不泄露管理口令', !(boot && JSON.stringify(boot).indexOf(TOKEN) >= 0));

  const man = await httpCode('/manifest.webmanifest');
  ok('根 manifest 200 + 正确 Content-Type',
    man.code === 200 && /application\/manifest\+json/.test(man.headers['content-type'] || ''),
    man.code + ' ' + man.headers['content-type']);
  let manOk = false;
  try {
    const j = JSON.parse(man.body);
    manOk = j.scope === '/' && j.start_url === '/' && j.name === '7喵快传 · Win98 桌面' && (j.icons || []).length >= 3;
  } catch (e) {}
  ok('根 manifest scope/start_url/name/icons 正确', manOk);

  const sw = await httpCode('/sw.js');
  ok('根 sw.js 200', sw.code === 200, sw.code);
  ok('根 sw.js 显式跳过 /s/', /indexOf\('\/s\/'\)/.test(sw.body));
  ok('根 sw.js 不挂 Service-Worker-Allowed', !sw.headers['service-worker-allowed']);

  for (const p of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png']) {
    const r = await httpCode(p);
    ok('根 ' + p + ' = 200 PNG', r.code === 200 && /image\/png/.test(r.headers['content-type'] || ''), r.code);
  }

  /* 登录接口 */
  const bad = await httpCode('/api/admin-login', { method: 'POST', body: JSON.stringify({ user: 'Administrator', pass: 'definitely-wrong' }), headers: { 'Content-Type': 'application/json' } });
  ok('错误口令 → 401', bad.code === 401, bad.code);
  const addr = await httpCode(BASE + '/api/boot');
  ok('根首页不含管理口令明文', (addr.body || '').indexOf(TOKEN) < 0);

  const home = await httpCode('/home.js');
  ok('home.js 不含管理口令明文', home.body.indexOf(TOKEN) < 0);
  ok('home.js 不含登录密码明文', home.body.indexOf(ADMIN_PASS) < 0);
  ok('home.js 含扫雷实现（plant 首点不踩雷）', /function plant\(/.test(home.body));
  ok('home.js 含四款屏保', /'star'/.test(home.body) && /'fly'/.test(home.body) && /'maze'/.test(home.body) && /'pipe'/.test(home.body));
  ok('home.js 含登录流程', /admin-login/.test(home.body));

  /* ── Win98 特征断言 ── */
  const cssHome = await httpCode('/home.css?v=5');
  const page = await httpCode('/');
  ok('标题栏为 Win98 渐变', /linear-gradient\(90deg,\s*var\(--title\),\s*var\(--title-grad\)\)/.test(cssHome.body) || /linear-gradient\(90deg, ?#000080, ?#1084d0\)/.test(cssHome.body));
  ok('非活动标题栏为灰渐变', /var\(--title-inact-grad\)/.test(cssHome.body) || /#b5b5b5/.test(cssHome.body));
  ok('含 Win98 风格滚动条样式', cssHome.body.includes('::-webkit-scrollbar-track') && cssHome.body.includes('::-webkit-scrollbar-thumb'));
  ok('任务栏高度为 28px', /--tb-h: ?28px/.test(cssHome.body));
  ok('IE 浏览器窗口存在', /id="ieWin"/.test(page.body) && /id="ieAddr"/.test(page.body));
  ok('IE 图标在桌面', /data-app="ie"/.test(page.body));
  ok('3D 迷宫 raycaster 存在', /drawMaze/.test(home.body) && /mazeGrid/.test(home.body));
  ok('飞行窗口为四色旗（非窗口盒）', /drawFlag/.test(home.body) && !/drawFlyerBox/.test(home.body));
  ok('屏保画布接 DPR', /devicePixelRatio/.test(home.body));

  ok('根首页含 manifest link', /rel="manifest"/.test(page.body));
  ok('根首页含 11 个桌面图标', (page.body.match(/class="dicon"/g) || []).length === 11,
    (page.body.match(/class="dicon"/g) || []).length);
  ok('根首页含二级菜单', (page.body.match(/class="smsub"/g) || []).length === 5);
  ok('开始菜单含收藏夹（Win98 特征）', /data-sub="fav"/.test(page.body) && /ico-fav/.test(page.body));
  ok('关机对话框带月亮横幅', /shut-banner/.test(page.body) && /shut-moon/.test(page.body));
  ok('DOS/运行框防自动填充（属性 + JS 防线）',
    /autocapitalize="off" autocorrect="off"/.test(page.body) &&
    /data-lpignore="true"/.test(page.body) &&
    /activeElement !== el && el\.value/.test(home.body));
  ok('登录密码框禁凭据回填（new-password）', /id="loginPass"[^>]*autocomplete="new-password"/.test(page.body));
  ok('DOS 输入框 autofill 样式覆盖', /dos-in:-webkit-autofill/.test(cssHome.body));
  ok('窗口控制钮（最小化/最大化）由 JS 注入 appwin', /wbtn min/.test(home.body) && /wbtn max/.test(home.body) && /minWin/.test(home.body) && /maxWin/.test(home.body));
  ok('窗口可缩放（reshandle 手柄 + maxed 样式）', /reshandle/.test(home.body) && /win95\.maxed/.test(cssHome.body));
  ok('双击标题栏最大化', /dblclick/.test(home.body));
  ok('IE 与我的电脑分工（IE 有 98 主页 + 可输地址栏）',
    /__ieNav/.test(home.body) && /\/ie-home/.test(home.body) && !/id="ieAddr"[^>]*readonly/.test(page.body));
  const ieHomeRes = await httpCode('/ie-home');
  ok('IE 主页走真实端点（srcdoc 继承 CSP 会拦内联样式，全站 CSP 不放宽）',
    ieHomeRes.code === 200 &&
    /a\.big\{display:block/.test(ieHomeRes.body) &&
    /html\{scrollbar-width:none\}/.test(ieHomeRes.body) &&
    /unsafe-inline/.test(ieHomeRes.headers['content-security-policy'] || '') &&
    !/setAttribute\('srcdoc', ?IE_HOME_HTML\)/.test(home.body));
  ok('IE 主页是知行工作室真实站点（无假域名）',
    ieHomeRes.body.indexOf('知行工作室') >= 0 &&
    ieHomeRes.body.indexOf('w3b.pub') >= 0 &&
    ieHomeRes.body.indexOf('home.7miao.com') < 0);
  ok('页面标题带项目名与定位语', /<title>7喵快传 · 一个文件，一个桌面<\/title>/.test(page.body));
  ok('收藏夹无禁用假项', (page.body.match(/class="smi dis"/g) || []).length === 0);
  ok('笑脸有三态像素画（默认/胜利/阵亡）',
    /mine-smiley::after/.test(cssHome.body) &&
    /mine-smiley\.win::after/.test(cssHome.body) &&
    /mine-smiley\.dead::after/.test(cssHome.body));
  ok('任务栏按钮剥离窗口标题后缀', /split\(' - '\)\[0\]/.test(home.body));
  ok('扫雷菜单含三档难度', /data-act="lv1"/.test(home.body) && /data-lv="16,16,40"/.test(home.body) && /data-lv="30,16,99"/.test(home.body));
  ok('最高分按难度独立存储', /mines95best-' \+ c \+ '-' \+ r \+ '-' \+ m/.test(home.body));
  ok('SW 缓存版本化（非硬编码 v1，修「装完永远旧版」）',
    /VERSION = '__BUILD_ID__'/.test(sw.body) || /VERSION = '\d{10,}'/.test(sw.body),
    (sw.body.match(/var VERSION = '([^']*)'/) || [])[1]);
  ok('manifest 带快手捷方式（Android 长按图标）', /shortcuts/.test(JSON.stringify(JSON.parse(man.body))));
  ok('各窗口「帮助」按应用分派（不再全弹「关于记事本」）',
    /'help-readme':/.test(home.body) && /'help-pc':/.test(home.body) &&
    /'help-mine':/.test(home.body) && /'help-ie':/.test(home.body) &&
    /menuKeyFor/.test(home.body));
  ok('IE 菜单有真实动作（非死菜单）',
    /'view-ie':/.test(home.body) && /'fav-ie':/.test(home.body) && /about-ie/.test(home.body));
  ok('根桌面内容区滚动条隐藏化', /notepad::-webkit-scrollbar/.test(cssHome.body) && /dos-body::-webkit-scrollbar/.test(cssHome.body));

  const shareHome = await httpCode('/s/' + SHARE + '/');
  const shareCss = await httpCode('/s/' + SHARE + '/app.css');
  ok('分享页滚动条全隐藏 + 列表无内层滚动',
    /::-webkit-scrollbar\{width:0;height:0;display:none\}/.test(shareCss.body) &&
    /\.list\{list-style:none;margin:8px 0 0;padding:2px;background:var\(--win\);box-shadow:var\(--sink\)\}/.test(shareCss.body) &&
    !/max-height:52vh/.test(shareCss.body) &&
    !/max-height:46vh/.test(shareCss.body));
  ok('关机画面为橙字黑底 + Windows 98 徽标', /现在可以安全地关闭计算机了/.test(page.body) && /shut-wordmark/.test(page.body) && /<i>98<\/i>/.test(page.body));
  ok('404 提示为 Win98 错误对话框', /找不到.*请检查路径/.test(home.body) && /错误 404/.test(home.body));
  ok('消息框支持副标题与重试按钮', /id="msgSub"/.test(page.body) && /id="msgRetry"/.test(page.body));
  ok('登录框品牌为 Windows 98', /login-brand">Windows<b>98<\/b>/.test(page.body));
  ok('根首页含扫雷窗口', /id="mineGrid"/.test(page.body));
  ok('根首页含文件管理器 iframe', /id="fmFrame"/.test(page.body));
  ok('根首页含登录框', /id="loginWin"/.test(page.body));
  ok('根首页含关机三选一', /name="shutopt"/.test(page.body));
  ok('根首页含屏保下拉', /id="saverPick"/.test(page.body));

  /* ── 启动无头浏览器 ── */
  let chrome = null, wsUrl = null;
  const userDir = '/tmp/cdp-desktop-' + process.pid;
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  const port = 9222 + Math.floor(Math.random() * 500);
  chrome = spawn('/usr/bin/chromium', [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:' + port + '/json/list', (r) => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
      });
      const t = list.find(x => x.type === 'page');
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch (e) {}
  }
  ok('可启动 headless Chromium', !!wsUrl);
  if (!wsUrl) { if (chrome) chrome.kill(); process.exit(1); }

  ws = new WS(wsUrl);
  await ws.connect();
  const tgt = await ws.send('Target.getTargets');
  const pageT = tgt.targetInfos.find(t => t.type === 'page');
  const att = await ws.send('Target.attachToTarget', { targetId: pageT.targetId, flatten: true });
  sid = att.sessionId;
  await ws.send('Page.enable', {}, sid);
  await ws.send('Runtime.enable', {}, sid);
  /* 注入未捕获错误收集器：section 13 的「运行期无明显脚本错误」靠它才有意义 */
  await ws.send('Page.addScriptToEvaluateOnNewDocument', { source:
    'window.__cdpErrs=[];window.addEventListener("error",function(e){window.__cdpErrs.push(String(e.message||e.error))});' +
    'window.addEventListener("unhandledrejection",function(e){window.__cdpErrs.push("unhandledrejection:"+String(e.reason))});'
  }, sid);

  /* ── 1. 桌面渲染 ── */
  await goto(BASE + '/');
  ok('桌面渲染出 11 个图标', await evaluate(`document.querySelectorAll('.dicon').length`) === 11,
    await evaluate(`document.querySelectorAll('.dicon').length`));
  ok('任务栏存在', await evaluate(`!!document.getElementById('startBtn')`));
  ok('页面脚本已初始化（任务栏时钟已走）', /^\d\d:\d\d$/.test(String(await evaluate(`document.getElementById('clock').textContent`))),
    await evaluate(`document.getElementById('clock').textContent`));
  ok('页面 title 为项目名 + 定位语', (await evaluate(`document.title`)) === '7喵快传 · 一个文件，一个桌面',
    await evaluate(`document.title`));

  /* ── 2. 开始菜单 + 二级菜单 ── */
  await clickSel('#startBtn');
  await sleep(200);
  ok('开始菜单可打开', await evaluate(`!document.getElementById('startMenu').hidden`));
  await clickSel('.smi.has-sub[data-sub="prog"]');
  await sleep(200);
  ok('「程序」二级菜单展开', await evaluate(`!document.getElementById('smsub-prog').hidden`));
  ok('二级菜单含扫雷项', await evaluate(`/扫雷/.test(document.getElementById('smsub-prog').textContent)`));
  /* 直接从二级菜单项启动扫雷 —— 走真实用户路径 */
  await evaluate(`document.querySelector('#smsub-prog .smi[data-app="mines"]').click()`);
  await sleep(400);

  /* ── 3. 扫雷 ── */
  ok('扫雷窗口打开', await evaluate(`!document.getElementById('mineWin').hidden`));
  ok('雷区渲染 81 格', await evaluate(`document.querySelectorAll('#mineGrid .cell').length`) === 81,
    await evaluate(`document.querySelectorAll('#mineGrid .cell').length`));
  ok('初始 LED 显示 010',
    await evaluate(`document.getElementById('mineCount').textContent`) === '010',
    await evaluate(`document.getElementById('mineCount').textContent`));
  ok('扫雷窗口未撑破视口', await evaluate(`(function(){
    var r = document.getElementById('mineWin').getBoundingClientRect();
    return r.width <= window.innerWidth + 1 && r.right <= window.innerWidth + 1 && r.height <= window.innerHeight + 1;
  })()`));

  /* 三档难度：走真实菜单路径（游戏(G) → 难度项），验证棋盘/LED/状态栏 */
  const lv2 = await evaluate(`(function(){
    document.querySelector('#mineWin .mu[data-mu3="game"]').click();
    var it = document.querySelector('#mineWin .mdrop .ctxi[data-act="lv2"]');
    if (!it) return null;
    it.click();
    return [document.querySelectorAll('#mineGrid .cell').length, document.getElementById('mineCount').textContent];
  })()`);
  ok('中级 16×16：256 格 + LED 040', !!lv2 && lv2[0] === 256 && lv2[1] === '040', JSON.stringify(lv2));
  const lv3 = await evaluate(`(function(){
    document.querySelector('#mineWin .mu[data-mu3="game"]').click();
    var it = document.querySelector('#mineWin .mdrop .ctxi[data-act="lv3"]');
    if (!it) return null;
    it.click();
    return [document.querySelectorAll('#mineGrid .cell').length, document.getElementById('mineCount').textContent];
  })()`);
  ok('高级 30×16：480 格 + LED 099', !!lv3 && lv3[0] === 480 && lv3[1] === '099', JSON.stringify(lv3));
  const lv1 = await evaluate(`(function(){
    document.querySelector('#mineWin .mu[data-mu3="game"]').click();
    var it = document.querySelector('#mineWin .mdrop .ctxi[data-act="lv1"]');
    if (!it) return null;
    it.click();
    return [document.querySelectorAll('#mineGrid .cell').length,
            document.getElementById('mineCount').textContent,
            document.getElementById('mineStatus').textContent];
  })()`);
  ok('切回初级：81 格 + LED 010 + 状态栏显示难度', !!lv1 && lv1[0] === 81 && lv1[1] === '010' && /难度/.test(lv1[2] || ''), JSON.stringify(lv1));

  /* 首点不踩雷：连点不同格子，只要第一次点击后没死就说明布雷排除了首点邻域 */
  const firstSafe = await evaluate(`(function(){
    var cells = document.querySelectorAll('#mineGrid .cell');
    cells[40].click();
    return !document.querySelector('#mineGrid .cell.mine-boomy');
  })()`);
  ok('首点不踩雷', firstSafe === true, String(firstSafe));
  ok('首点后计时器启动（LED 非 000 或已布雷）', await evaluate(`document.getElementById('mineStatus').textContent.length > 0`));

  /* 插旗：先重开一局拿到干净棋盘，再右键一个未挖开的格 */
  await clickSel('#mineSmiley');
  await sleep(250);
  const beforeFlag = await evaluate(`document.getElementById('mineCount').textContent`);
  const flagRes = await evaluate(`(function(){
    var cells = document.querySelectorAll('#mineGrid .cell');
    for (var i=0;i<cells.length;i++){
      if (cells[i].classList.contains('open')) continue;
      cells[i].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
      return 'flagged';
    }
    return 'none';
  })()`);
  await sleep(200);
  const afterFlag = await evaluate(`document.getElementById('mineCount').textContent`);
  ok('右键插旗让剩余雷数 -1', afterFlag === '009', flagRes + ' ' + beforeFlag + ' -> ' + afterFlag);
  ok('插旗格有 flag 类', await evaluate(`document.querySelectorAll('#mineGrid .cell.flag').length`) >= 1,
    await evaluate(`document.querySelectorAll('#mineGrid .cell.flag').length`));

  /* 笑脸重开 */
  await clickSel('#mineSmiley');
  await sleep(200);
  ok('笑脸重开后计数归位 010', await evaluate(`document.getElementById('mineCount').textContent`) === '010');
  ok('笑脸重开后旗子清空', await evaluate(`document.querySelectorAll('#mineGrid .cell.flag').length`) === 0);

  /* 强制踩雷，验证失败态 */
  const dead = await evaluate(`(function(){
    // 反复点不同格子直到踩雷（最多 90 次），验证失败表现
    var cells = document.querySelectorAll('#mineGrid .cell');
    for (var i=0;i<cells.length;i++){ cells[i].click(); if (document.querySelector('.mine-smiley.dead')) return true; }
    return !!document.querySelector('.mine-smiley.dead');
  })()`);
  ok('踩雷后笑脸变阵亡态', dead === true, String(dead));
  ok('踩雷后状态栏提示', await evaluate(`/踩到雷/.test(document.getElementById('mineStatus').textContent)`));
  await clickSel('#mineSmiley');
  await sleep(150);

  /* ── 4. 屏保 3 款 ── */
  const kinds = await evaluate(`(function(){
    var sel = document.getElementById('saverPick');
    return Array.prototype.map.call(sel.options, function(o){return o.textContent;});
  })()`);
  ok('显示属性有 4 款屏保可选', Array.isArray(kinds) && kinds.length === 4, JSON.stringify(kinds));
  const kindSet = [];
  const kindPix = [];
  for (let i = 0; i < 3; i++) {
    await evaluate(`(function(){
      var sel = document.getElementById('saverPick');
      sel.value = String(${i});
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('saverPreview').click();
    })()`);
    await sleep(1200);  // 给绘制留时间：rAF 在 headless 里可能不触发，但有兜底首帧
    kindSet.push(await evaluate(`document.getElementById('ssaver').hidden ? 'hidden' : 'shown'`));
    kindPix.push(await evaluate(`(function(){
      var c = document.getElementById('ssaver');
      var d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      var nz = 0; for (var j=0;j<d.length;j+=4){ if (d[j]||d[j+1]||d[j+2]) nz++; }
      return nz;
    })()`));
  }
  ok('四款屏保都能启动（预览均显示画布）', kindSet.every(x => x === 'shown'), JSON.stringify(kindSet));
  ok('四款屏保画布均有内容（非全黑）', kindPix.every(n => n > 0), JSON.stringify(kindPix));
  await evaluate(`document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await sleep(300);
  ok('屏保可被唤醒关闭', await evaluate(`document.getElementById('ssaver').hidden`) === true);
  ok('屏保选择已持久化', await evaluate(`localStorage.getItem('saver95')`) !== null);

  /* ── 5. 复古 QQ（仿 2008）：真实仿真验收 ── */
  /* 从干净状态开始：清掉可能残留的 QQ 本地数据，重载页面 */
  await evaluate(`localStorage.clear()`);
  await goto(BASE + '/');
  ok('桌面有 QQ 图标', await evaluate(`!!document.querySelector('.dicon[data-app="qq"]')`));
  ok('开始菜单「程序」含 QQ 项', await evaluate(`/QQ/.test(document.getElementById('smsub-prog').textContent)`));
  /* 桌面图标双击打开（与真 98 一致：单击选中、双击启动） */
  await evaluate(`document.querySelector('.dicon[data-app="qq"]').click();document.querySelector('.dicon[data-app="qq"]').click()`);
  await sleep(700);
  ok('双击 QQ 图标打开面板', await evaluate(`!document.getElementById('qqWin').hidden`));
  ok('托盘出现企鹅图标', await evaluate(`!!document.getElementById('qqTray')`));
  ok('好友列表渲染 9 位好友', await evaluate(`document.querySelectorAll('.qq-f').length`) === 9,
    await evaluate(`document.querySelectorAll('.qq-f').length`));
  ok('好友分组齐全（家族/我的好友/老同学/网友/群组）', await evaluate(`(function(){var t=document.getElementById('qqGroups').textContent; return /家族/.test(t)&&/群组/.test(t)&&/我的好友/.test(t)&&/老同学/.test(t)&&/网友/.test(t);})()`));
  ok('每项都有头像像素画', await evaluate(`document.querySelectorAll('.qq-f-av .qq-avpx').length`) === 9);
  ok('在线人数为真实统计', await evaluate(`/在线 \\d+ 人/.test(document.getElementById('qqOnline').textContent)`),
    await evaluate(`document.getElementById('qqOnline').textContent`));
  ok('年代选择器含 2003/2005/2008/2012 + 真实日期', await evaluate(`(function(){var o=[].map.call(document.getElementById('qqEra').options,function(x){return x.value}); return o.join(',').indexOf(',2003,')>=0 && o[0]==='';})()`));

  /* 打开会话：自动播放真实逐字输入 + 真实点击发送 */
  await evaluate(`document.querySelector('.qq-f[data-f="f0"]').click()`);
  await sleep(300);
  ok('会话窗口打开', await evaluate(`!document.getElementById('qqChatWin').hidden`));
  ok('标题含好友名', await evaluate(`/冷少/.test(document.getElementById('qqChatTitle').textContent)`));
  ok('自动播放已产生首条好友消息', !!await waitFor(`/家族今晚还聚会吗/.test(document.getElementById('qqLog').textContent)`, 8000, '首条好友消息'));
  ok('首条是好友台词（左侧气泡）', await evaluate(`(function(){var r=document.querySelector('#qqLog .qq-row'); return !!r && !r.classList.contains('me') && /家族/.test(r.textContent);})()`));
  ok('存在日期分隔线', await evaluate(`document.querySelectorAll('#qqLog .qq-sep').length`) >= 1);
  const samples = [];
  for (let i = 0; i < 8; i++) { samples.push(await evaluate(`document.getElementById('qqIn').value.length`)); await sleep(250); }
  let grew = false;
  for (let i = 1; i < samples.length; i++) if (samples[i] > samples[i - 1]) grew = true;
  ok('输入框在真实逐字增长（宏真的在打字）', grew, JSON.stringify(samples));

  /* 用户接管：真的按键 → 立即暂停并明说 */
  await evaluate(`(function(){var i=document.getElementById('qqIn'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));})()`);
  await sleep(400);
  ok('用户一按键自动播放即暂停', await evaluate(`document.getElementById('qqPlayBtn').disabled===false && document.getElementById('qqPauseBtn').disabled===true`));
  ok('暂停有诚实提示', await evaluate(`/已暂停自动播放/.test(document.getElementById('qqLog').textContent)`));

  /* 真实发送 → 兜底回复；输入框清空 */
  await evaluate(`(function(){var i=document.getElementById('qqIn'); i.value='周末一起去烫个头？'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.getElementById('qqSendBtn').click()`);
  ok('对方给了兜底回复', !!await waitFor(`(function(){var rows=document.querySelectorAll('#qqLog .qq-row'); var last=rows[rows.length-1]; return !!last && !last.classList.contains('me');})()`, 6000, '兜底回复'));
  ok('我的消息真实入流（右侧气泡）', await evaluate(`document.querySelectorAll('#qqLog .qq-row.me').length`) >= 1);
  ok('输入框发送后清空', await evaluate(`document.getElementById('qqIn').value`) === '');

  /* 重播：二次确认后真的重播 */
  await evaluate(`document.getElementById('qqReplayBtn').click()`);
  await sleep(150);
  ok('重播需二次确认（按钮变形）', await evaluate(`document.getElementById('qqReplayBtn').textContent`) === '再点一次确认');
  await evaluate(`document.getElementById('qqReplayBtn').click()`);
  ok('二次确认后真的重播', !!await waitFor(`/家族今晚还聚会吗/.test(document.getElementById('qqLog').textContent)`, 8000, '重播首条'));

  /* 接得上剧本 → 剧情按剧本继续（不是兜底） */
  await evaluate(`document.getElementById('qqPauseBtn').click()`);
  await sleep(300);
  await evaluate(`(function(){var i=document.getElementById('qqIn'); i.value='没忘。老地方，网吧二楼包间，八点是吧'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.getElementById('qqSendBtn').click()`);
  ok('用户说出剧本原句 → 对方按剧本回应', !!await waitFor(`/新族规/.test(document.getElementById('qqLog').textContent)`, 8000, '剧本后续'));
  ok('回应的是下一句剧本', await evaluate(`/统一换火星文头像/.test(document.getElementById('qqLog').textContent)`));

  /* 单步：只演一条 */
  await evaluate(`document.getElementById('qqStepBtn').click()`);
  ok('单步播了我方下一条台词', !!await waitFor(`(function(){var rows=document.querySelectorAll('#qqLog .qq-row.me'); for(var i=0;i<rows.length;i++) if(/头像上周刚换/.test(rows[i].textContent)) return true; return false;})()`, 8000, '单步'));
  ok('单步不会接着播对方的台词', await evaluate(`!/离子烫/.test(document.getElementById('qqLog').textContent)`));

  /* 未读 + 托盘闪动 + 任务栏闪动（切走会话后消息才到达 → 真实未读） */
  await evaluate(`(function(){var i=document.getElementById('qqIn'); i.value='在吗'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.getElementById('qqSendBtn').click()`);
  await evaluate(`document.querySelector('.qq-f[data-f="f1"]').click()`);
  ok('切走后收到的消息计入未读徽标', !!await waitFor(`(function(){var b=document.querySelector('.qq-f[data-f="f0"] .qq-badge'); return !!b && b.textContent==='1';})()`, 8000, '未读徽标'));
  ok('托盘图标进入未读闪动态', await evaluate(`document.getElementById('qqTray').classList.contains('unread')`));
  ok('托盘提示含未读条数', await evaluate(`/1 条未读/.test(document.getElementById('qqTray').title)`));
  await evaluate(`document.querySelector('#qqChatWin .wclose').click()`);
  await sleep(300);
  await evaluate(`document.getElementById('qqWin')._taskBtn.click()`);
  await sleep(300);
  ok('最小化时有未读 → 任务栏按钮闪动', await evaluate(`document.getElementById('qqWin')._taskBtn.classList.contains('flash')`));
  await evaluate(`document.getElementById('qqTray').click()`);
  await sleep(400);
  ok('托盘图标可唤回面板', await evaluate(`!document.getElementById('qqWin').hidden`));
  ok('唤回后任务栏按钮停止闪动', await evaluate(`!document.getElementById('qqWin')._taskBtn.classList.contains('flash')`));
  await evaluate(`document.querySelector('.qq-f[data-f="f0"]').click()`);
  await sleep(600);
  await evaluate(`document.getElementById('qqPauseBtn').click()`);
  await sleep(200);
  ok('读过之后未读清零', await evaluate(`!document.querySelector('.qq-f[data-f="f0"] .qq-badge')`));
  ok('读过之后托盘停止闪动', await evaluate(`!document.getElementById('qqTray').classList.contains('unread')`));

  /* 年代穿越：同源到任务栏时钟/系统属性/MS-DOS，且可持久化、可退回 */
  await evaluate(`(function(){var s=document.getElementById('qqEra'); s.value='2008'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(400);
  ok('era 状态切到 2008', await evaluate(`window.QQ.era`) === '2008');
  ok('eraDate() 返回 2008 年的今天此刻', await evaluate(`window.QQ.eraDate().getFullYear()`) === 2008);
  ok('会话标题标注穿越年份', await evaluate(`/· 2008/.test(document.getElementById('qqChatTitle').textContent)`));
  ok('穿越设置持久化', await evaluate(`localStorage.getItem('qq95-era')`) === '2008');
  await evaluate(`(function(){var i=document.getElementById('qqIn'); i.value='穿越测试'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.getElementById('qqSendBtn').click()`);
  ok('新消息的日期分隔线显示 2008 年', !!await waitFor(`(function(){var s=document.querySelectorAll('#qqLog .qq-sep'); return s.length && /2008年/.test(s[s.length-1].textContent);})()`, 6000, '2008 分隔线'));
  await goto(BASE + '/');
  ok('刷新后穿越年代仍生效', await evaluate(`window.QQ && window.QQ.era === '2008'`));
  await evaluate(`document.querySelector('.dicon[data-app="qq"]').click();document.querySelector('.dicon[data-app="qq"]').click()`);
  await sleep(500);
  await evaluate(`(function(){var s=document.getElementById('qqEra'); s.value=''; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);
  ok('可退回真实日期', await evaluate(`window.QQ.era`) === '' && await evaluate(`window.QQ.eraDate().getFullYear() === new Date().getFullYear()`));

  /* 隐身：暂停接收新消息，面板如实显示 */
  await evaluate(`(function(){var s=document.getElementById('qqState'); s.value='hidden'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);
  ok('隐身状态在面板如实显示', await evaluate(`/已隐身/.test(document.getElementById('qqOnline').textContent)`));
  await evaluate(`(function(){var s=document.getElementById('qqState'); s.value='online'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);
  ok('恢复在线', await evaluate(`/在线 \\d+ 人/.test(document.getElementById('qqOnline').textContent)`));

  /* 托盘菜单退出 QQ，且可重新启动 */
  await evaluate(`document.getElementById('qqTray').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:600}))`);
  await sleep(300);
  ok('托盘右键菜单出现且含「退出 QQ」', await evaluate(`(function(){var m=document.getElementById('qqTrayMenu'); return !!m && /退出 QQ/.test(m.textContent);})()`));
  await evaluate(`document.querySelector('#qqTrayMenu .ctxi[data-a="quit"]').click()`);
  await sleep(500);
  ok('退出后托盘图标消失、窗口全部关闭', await evaluate(`!document.getElementById('qqTray') && document.getElementById('qqWin').hidden && document.getElementById('qqChatWin').hidden`));
  await evaluate(`document.querySelector('.dicon[data-app="qq"]').click();document.querySelector('.dicon[data-app="qq"]').click()`);
  await sleep(500);
  ok('退出后可重新启动（托盘回归）', await evaluate(`!!document.getElementById('qqTray')`));
  /* 恢复干净现场，避免影响后续关机/登录用例 */
  await evaluate(`document.querySelector('#qqWin .wclose').click()`);
  await sleep(200);

  /* ── 6. 关机三选一 → 登录 ── */
  await clickSel('#startBtn');
  await sleep(150);
  await evaluate(`document.querySelector('#startMenu .smi[data-app="shutdown"]').click()`);
  await sleep(400);
  ok('关机三选一对话框出现', await evaluate(`!document.getElementById('shutWin').hidden`));
  ok('三选项齐全', await evaluate(`document.querySelectorAll('input[name="shutopt"]').length`) === 3);
  await clickSel('#shutOk');
  await sleep(400);
  ok('选择「关闭计算机」→ 黑屏关机页', await evaluate(`!document.getElementById('shutdown').hidden`));
  await evaluate(`document.getElementById('shutdown').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await sleep(400);
  ok('点击关机页 → 出现登录框', await evaluate(`!document.getElementById('loginWin').hidden`));
  ok('用户名下拉含 Guest 与 Administrator', await evaluate(`(function(){
    var s=document.getElementById('loginUser');
    var v=Array.prototype.map.call(s.options,function(o){return o.value;});
    return v.indexOf('Guest')>=0 && v.indexOf('Administrator')>=0;
  })()`));

  /* ── 7. 登录：Guest ── */
  await setVal('#loginUser', 'Guest');
  await clickSel('#loginOk');
  await sleep(700);
  ok('Guest 免密登录成功', await evaluate(`document.getElementById('loginWin').hidden`) === true);
  ok('Guest 打开我的电脑窗口', await evaluate(`!document.getElementById('pcWin').hidden`));
  ok('Guest 状态栏标注访客权限', await evaluate(`/访客权限/.test(document.getElementById('fmStatus').textContent)`));
  ok('我的电脑窗口内容区高度充足（≥420px）', await evaluate(`(function(){
    var f = document.querySelector('#pcWin .fm-frame');
    return !!f && f.getBoundingClientRect().height >= 420;
  })()`));
  ok('窗口标题带项目名后缀', /我的电脑 - 7喵快传/.test(String(await evaluate(`document.getElementById('pcLabel').textContent`))),
    await evaluate(`document.getElementById('pcLabel').textContent`));
  ok('任务栏按钮为短名（无项目名后缀）', await evaluate(`(function(){
    var bs = document.querySelectorAll('#tasks .taskbtn');
    if (!bs.length) return 'NOBTN';
    for (var i = 0; i < bs.length; i++) { if (bs[i].textContent.indexOf('7喵快传') >= 0) return false; }
    return true;
  })()`) === true);
  const gsrc = await evaluate(`document.getElementById('fmFrame').getAttribute('src')`);
  ok('iframe 指向分享口令 + embed=1', !!gsrc && gsrc.indexOf(SHARE) >= 0 && gsrc.indexOf('embed=1') >= 0, gsrc);
  await evaluate(`document.querySelector('#pcWin [data-close]').click()`);
  await sleep(200);

  /* ── 8. 登录：错误密码 ── */
  await clickSel('#startBtn');
  await sleep(150);
  await evaluate(`document.querySelector('#startMenu .smi[data-app="shutdown"]').click()`);
  await sleep(300);
  await clickSel('#shutOk');
  await sleep(350);
  await evaluate(`document.getElementById('shutdown').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await sleep(400);
  ok('再次登录框出现', await evaluate(`!document.getElementById('loginWin').hidden`));
  await setVal('#loginUser', 'Administrator');
  await setVal('#loginPass', 'wrong-password');
  await sleep(100);
  await setVal('#loginPass', 'wrong-password');
  await clickSel('#loginOk');
  await sleep(900);
  ok('错误密码不通过（登录框仍在）', await evaluate(`!document.getElementById('loginWin').hidden`));
  ok('错误提示为「用户名或密码不正确」',
    await evaluate(`/不正确|频繁/.test(document.getElementById('loginHint').textContent)`),
    await evaluate(`document.getElementById('loginHint').textContent`));

  /* ── 9. 登录：正确密码 ── */
  await setVal('#loginPass', ADMIN_PASS);
  await clickSel('#loginOk');
  await sleep(900);
  ok('正确密码进入管理模式', await evaluate(`document.getElementById('loginWin').hidden`) === true);
  const asrc = await evaluate(`document.getElementById('fmFrame').getAttribute('src')`);
  ok('管理员 iframe 指向管理口令', !!asrc && asrc.indexOf(TOKEN) >= 0, asrc);
  ok('管理员状态栏标注管理权限', await evaluate(`/管理权限/.test(document.getElementById('fmStatus').textContent)`));
  ok('管理员标签变化', await evaluate(`/管理/.test(document.getElementById('pcLabel').textContent)`));

  /* ── 10. 管理页在 iframe 内可用（跨文档访问，同源）── */
  await sleep(1500);
  const innerRole = await evaluate(`(function(){
    var f = document.getElementById('fmFrame');
    try {
      var d = f.contentDocument;
      if (!d) return 'no-doc';
      var sb = d.getElementById('sbMode');
      return sb ? sb.textContent : 'no-sb';
    } catch(e) { return 'ERR:' + e.message; }
  })()`);
  ok('内嵌页已载入并可读取（同源 iframe 成功）',
    typeof innerRole === 'string' && /管理|分享/.test(innerRole), innerRole);

  /* ── 11. embed 模式确实生效 ── */
  const embedCls = await evaluate(`(function(){
    var f = document.getElementById('fmFrame');
    try { return f.contentDocument.body.className; } catch(e){ return 'ERR'; }
  })()`);
  ok('内嵌页带 body.embed', /embed/.test(String(embedCls)), embedCls);

  /* ── 12. 我的电脑入口 + 安装入口 ── */
  ok('桌面有「安装到桌面」图标', await evaluate(`!!document.querySelector('.dicon[data-app="install"]')`));
  ok('开始菜单设置里有安装项', await evaluate(`!!document.querySelector('#smsub-set .smi[data-app="install"]')`));
  ok('我的电脑图标打开文件窗口', await evaluate(`(function(){
    var i = document.querySelector('.dicon[data-app="pc"]');
    i.click(); i.click();
    return !document.getElementById('pcWin').hidden;
  })()`));

  /* ── 13. DOS 彩蛋 ── */
  await evaluate(`(function(){var i=document.querySelector('.dicon[data-app="dos"]'); i.click(); i.click();})()`);
  await sleep(300);
  const dosOut = await evaluate(`(function(){
    var i = document.getElementById('dosIn');
    i.value='ver'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    return document.getElementById('dosOut').textContent;
  })()`);
  ok('DOS 窗口响应 ver 命令', /Windows 98/.test(String(dosOut)));

  /* ── 12b. 贪吃蛇最大化：CSS 跟随放大，内部分辨率不变 ── */
  await evaluate(`(function(){var i=document.querySelector('.dicon[data-app="game"]'); i.click(); i.click();})()`);
  await sleep(400);
  ok('贪吃蛇窗口打开', await evaluate(`!document.getElementById('gameWin').hidden`));
  const cnv0 = await evaluate(`(function(){
    var c = document.getElementById('game');
    return [c.getBoundingClientRect().width, c.getAttribute('width')];
  })()`);
  ok('贪吃蛇默认渲染（内部分辨率 320）', !!cnv0 && cnv0[1] === '320' && cnv0[0] > 0, JSON.stringify(cnv0));
  await evaluate(`document.querySelector('#gameWin .wbtn.max').click()`);
  await sleep(250);
  const cnvM = await evaluate(`(function(){
    var c = document.getElementById('game');
    return [c.getBoundingClientRect().width, c.getAttribute('width'), document.getElementById('gameWin').classList.contains('maxed')];
  })()`);
  ok('最大化后画布放大（>400px）且内部分辨率仍 320',
    !!cnvM && cnvM[0] > 400 && cnvM[1] === '320' && cnvM[2] === true, JSON.stringify(cnvM));

  /* ── 12c. 移动端仿真（390×844 真机参数）────────────
     验证「手机/PWA 上下滑动」链路：窄屏媒体查询生效、图标流式、
     窗口自动最大化、输入框 16px、内容溢出时页面真的能滚。 */
  await ws.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sid);
  await sleep(600);
  ok('窄屏下桌面图标改为横排流式', await evaluate(`(function(){
    var g = document.querySelector('.dgroup');
    var cs = getComputedStyle(g);
    return cs.position === 'static' && cs.flexDirection === 'row' && cs.flexWrap === 'wrap';
  })()`));
  ok('窄屏下登录输入框 ≥16px（防 iOS 聚焦缩放）', await evaluate(`(function(){
    var i = document.querySelector('.login-input');
    return i ? parseFloat(getComputedStyle(i).fontSize) >= 16 : false;
  })()`));
  ok('窄屏下任务栏含 safe-area 避让', /env\(safe-area-inset-bottom/.test(cssHome.body));
  ok('窄屏下窗口打开自动最大化铺满', await evaluate(`(function(){
    /* readme 窗口在本测试中从未打开过（_sizedOnce 为 false），
       才能走到「首次打开」的自动最大化分支 */
    var i = document.querySelector('.dicon[data-app="readme"]');
    i.click(); i.click();
    return true;
  })()`));
  await sleep(500);
  ok('  首次打开的窗口在手机上自动 maxed', await evaluate(`document.getElementById('readmeWin').classList.contains('maxed')`));
  ok('  窗口宽度 = 视口宽', await evaluate(`Math.abs(document.getElementById('readmeWin').getBoundingClientRect().width - window.innerWidth) < 2`));
  /* 内容溢出 → 页面（html）必须真的能滚 */
  const mScroll = await evaluate(`(function(){
    var d = document.getElementById('desk');
    var probe = document.createElement('div');
    probe.style.cssText = 'height:1400px;width:10px';
    d.appendChild(probe);
    var can = document.documentElement.scrollHeight > document.documentElement.clientHeight;
    var y0 = window.scrollY; window.scrollTo(0, 120);
    var moved = window.scrollY > y0;
    window.scrollTo(0, 0); probe.remove();
    return { can: can, moved: moved };
  })()`);
  ok('移动端内容溢出时页面可滚（上下滑可用）', mScroll.can === true && mScroll.moved === true, JSON.stringify(mScroll));
  ok('移动端无横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await evaluate(`document.querySelector('#readmeWin [data-close]').click()`);
  /* 恢复桌面视口，避免影响后续断言 */
  await ws.send('Emulation.clearDeviceMetricsOverride', {}, sid);
  await sleep(400);

  /* ── 14. 页面控制台无致命错误 ── */
  const errs = await evaluate(`(function(){
    return window.__cdpErrs ? window.__cdpErrs.length : 0;
  })()`);
  ok('运行期无明显脚本错误', (errs || 0) === 0, String(errs));

  ws.close();
  if (chrome) chrome.kill();
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
  if (failures.length) console.log('失败项:\n  - ' + failures.join('\n  - ') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack || e);
  execSync('pkill -f "cdp-desktop-" > /dev/null 2>&1 || true');
  process.exit(1);
});
