#!/usr/bin/env node
'use strict';

/**
 * 强制分享凭据闸门自测（REQUIRE_SHARECODE）
 *
 * 为什么单独起实例：闸门只在「配了 GATEWAY_SHARECODE + REQUIRE_SHARECODE=1」
 * 的环境下生效，不能拿正在跑的无闸门实例做实验。这里自己拉起两个子进程：
 *   开闸实例：断言无凭据一律 403，带凭据（?sharecode= / 网关头 / Cookie）放行
 *   关闸实例：断言默认行为不变（未设 REQUIRE_SHARECODE 时首页与 API 照常 200）
 * 数据目录落在系统临时目录，跑完连同进程一起清掉。
 *
 * 用法: node gatetest.js [起始端口]   （默认 18080，关闸实例用 18081）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const CODE = 'sc-gate-test';
const TOKEN = 'gate-admin';
const SHARE = 'gate-guest';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function boot(port, extraEnv) {
  const dataDir = path.join(os.tmpdir(), '7md-gate-' + port + '-' + Date.now());
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    TOKEN,
    SHARE_TOKEN: SHARE,
    TTL_HOURS: '1',
    MAX_TOTAL_MB: '50',
    DATA_DIR: dataDir,
  }, extraEnv || {});
  const child = spawn(process.execPath, [SERVER], { cwd: __dirname, env, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return { child, base, dataDir };
    } catch { /* 还没起来，继续等 */ }
    await sleep(250);
  }
  child.kill();
  throw new Error('实例启动超时: ' + base);
}
function stop(ctx) {
  try { ctx.child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(ctx.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function gateCookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  const m = /7mdsc=([^;]+)/.exec(raw);
  return m ? '7mdsc=' + m[1] : '';
}

(async function run() {
  const p1 = Number(process.argv[2] || 18080);
  const p2 = p1 + 1;
  const gate = await boot(p1, { GATEWAY_SHARECODE: CODE, REQUIRE_SHARECODE: '1' });
  const open = await boot(p2, { GATEWAY_SHARECODE: CODE });
  try {
    console.log('\n强制凭据闸门自测\n  开闸: ' + gate.base + '    关闸: ' + open.base + '\n');

    let r = await fetch(gate.base + '/');
    ok('无凭据访问首页被拒 (403)', r.status === 403, 'status=' + r.status);
    ok('拒绝页给出可读提示', /需要分享凭据/.test(await r.text()));

    r = await fetch(gate.base + '/?sharecode=' + CODE);
    const ck = gateCookieOf(r);
    ok('带 ?sharecode= 放行首页 (200)', r.status === 200, 'status=' + r.status);
    ok('校验通过后下发凭据 Cookie', /^7mdsc=/.test(ck), ck || '(无 Set-Cookie)');

    r = await fetch(gate.base + '/home.js');
    ok('无凭据访问静态资源被拒 (403)', r.status === 403, 'status=' + r.status);

    r = await fetch(gate.base + '/home.js', { headers: { cookie: ck } });
    ok('带 Cookie 可取静态资源 (200)', r.status === 200, 'status=' + r.status);

    r = await fetch(gate.base + '/s/' + SHARE + '/');
    ok('无凭据访问分享页被拒 (403)', r.status === 403, 'status=' + r.status);

    r = await fetch(gate.base + '/s/' + SHARE + '/', { headers: { 'x-wb-share-code': CODE } });
    ok('网关头 x-wb-share-code 放行 (200)', r.status === 200, 'status=' + r.status);

    r = await fetch(gate.base + '/s/' + SHARE + '/api/list');
    const apiStatus = r.status;
    const apiJson = await r.json().catch(() => ({}));
    ok('无凭据调 API 被拒 (403)', apiStatus === 403, 'status=' + apiStatus);
    ok('API 错误码为 sharecode_required', apiJson && apiJson.code === 'sharecode_required',
      apiJson && JSON.stringify(apiJson).slice(0, 120));

    r = await fetch(gate.base + '/s/' + SHARE + '/api/list', { headers: { 'x-wb-share-code': CODE } });
    ok('带凭据调 API 正常 (200)', r.status === 200, 'status=' + r.status);

    r = await fetch(gate.base + '/?sharecode=wrong-code');
    ok('错误 sharecode 被拒 (403)', r.status === 403, 'status=' + r.status);

    r = await fetch(gate.base + '/healthz');
    ok('/healthz 探活不受闸门限制 (200)', r.status === 200, 'status=' + r.status);

    r = await fetch(open.base + '/');
    ok('未开闸实例首页照常 (200)', r.status === 200, 'status=' + r.status);
    r = await fetch(open.base + '/s/' + SHARE + '/api/list');
    ok('未开闸实例 API 照常 (200)（默认行为不变）', r.status === 200, 'status=' + r.status);
  } finally {
    stop(gate);
    stop(open);
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自测异常: ' + (e && e.message));
  process.exit(1);
});