#!/usr/bin/env node
'use strict';
/* PWA 自测：manifest / sw.js / 图标 / CSP / 首页隔离
   用法: node pwtest.js [baseUrl] [口令]   （默认 http://127.0.0.1:8080，口令取 env TOKEN 或 wby6sg8pm0） */
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
const TOKEN = process.argv[3] || process.env.TOKEN || 'wby6sg8pm0';
const P = BASE + '/s/' + TOKEN;

let pass = 0, fail = 0;
function ok(n, c, e) {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e !== undefined ? '  -> ' + e : '')); }
}

(async function run() {
  console.log('\nPWA 自测 @ ' + P + '\n');

  /* 1. manifest */
  let r = await fetch(P + '/manifest.webmanifest');
  const manText = await r.text();
  let man = null;
  try { man = JSON.parse(manText); } catch (e) {}
  ok('manifest 返回 200', r.status === 200, 'status=' + r.status);
  ok('manifest Content-Type = application/manifest+json',
    /application\/manifest\+json/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  ok('manifest 是合法 JSON', !!man, manText.slice(0, 120));
  if (man) {
    ok('manifest.name = 7喵快传', man.name === '7喵快传', man.name);
    ok('manifest.scope 锁定本口令', man.scope === '/s/' + TOKEN + '/', man.scope);
    ok('manifest.start_url 锁定本口令', man.start_url === '/s/' + TOKEN + '/', man.start_url);
    ok('manifest.id 锁定本口令', man.id === '/s/' + TOKEN + '/', man.id);
    ok('manifest.display = standalone', man.display === 'standalone', man.display);
    ok('manifest.theme_color = #008080', man.theme_color === '#008080', man.theme_color);
    const icons = man.icons || [];
    ok('manifest 含 192x192 PNG 图标', icons.some(i => i.sizes === '192x192' && i.type === 'image/png'));
    ok('manifest 含 512x512 PNG 图标', icons.some(i => i.sizes === '512x512' && i.type === 'image/png'));
    ok('manifest 含 maskable 图标', icons.some(i => i.purpose === 'maskable'));
  }

  /* 2. sw.js */
  r = await fetch(P + '/sw.js');
  const swText = await r.text();
  ok('sw.js 返回 200', r.status === 200, 'status=' + r.status);
  ok('sw.js Content-Type 是 JS', /javascript/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  ok('sw.js 含 install/activate/fetch 三事件',
    /addEventListener\('install'/.test(swText) &&
    /addEventListener\('activate'/.test(swText) &&
    /addEventListener\('fetch'/.test(swText));
  ok('sw.js 不缓存 /api/ /v/ /d/（无 cache.put 于这些路径）',
    !/cache\.put\([^)]*\/(api|v|d)\//.test(swText));
  ok('sw.js 无 Service-Worker-Allowed 头（作用域不放宽）', !r.headers.get('service-worker-allowed'));

  /* 3. PNG 图标 */
  for (const p of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png']) {
    const ir = await fetch(P + p);
    const buf = Buffer.from(await ir.arrayBuffer());
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    ok(p + ' 可访问且为合法 PNG',
      ir.status === 200 && (ir.headers.get('content-type') || '').includes('image/png') && isPng,
      'status=' + ir.status + ' head=' + buf.slice(0, 4).toString('hex'));
    if (p === '/icons/icon-192.png') {
      ok('图标带长缓存头', /max-age=31536000/.test(ir.headers.get('cache-control') || ''), ir.headers.get('cache-control'));
    }
  }

  /* 4. CSP：放宽的两项到位，且核心约束未松动 */
  r = await fetch(P + '/');
  const html = await r.text();
  const csp = r.headers.get('content-security-policy') || '';
  ok('CSP 含 worker-src self', /worker-src 'self'/.test(csp), csp);
  ok('CSP 含 manifest-src self', /manifest-src 'self'/.test(csp), csp);
  ok('CSP script-src 仍为 self（无 unsafe-inline）',
    /script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp), csp);
  ok('CSP default-src 仍为 none', /default-src 'none'/.test(csp), csp);
  ok('HTML 含 manifest link', /rel="manifest"/.test(html));
  ok('HTML 含安装按钮', /id="tbInstall"/.test(html));

  /* 5. 根首页：Win95 桌面必须带 PWA 痕迹（manifest + 外链 home.js 内的 SW 注册） */
  r = await fetch(BASE + '/');
  const home = await r.text();
  ok('根首页含 manifest link', /rel="manifest"/.test(home));
  const homejs = await (await fetch(BASE + '/home.js?v=5')).text();
  ok('根 SW 注册存在（home.js 内）', /serviceWorker\.register\('\.\/sw\.js'/.test(homejs));

  /* 6. 常规回归：外壳资源仍可访问 */
  for (const p of ['/app.css', '/app.js', '/qr.js', '/favicon.ico']) {
    const sr = await fetch(P + p);
    ok('回归 ' + p + ' = 200', sr.status === 200, 'status=' + sr.status);
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
