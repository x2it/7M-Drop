#!/usr/bin/env node
'use strict';

/**
 * 配额与限流回归测试
 * 用法: node quotatest.js [serverPath]
 *
 * 为什么单独一个实例：总配额要设成 1MB 才能触发边界，
 * 不能拿正在跑的生产实例做实验。这里自己起一个子进程，
 * 数据目录落在系统临时目录下，跑完连进程带数据一起清掉。
 *
 * 覆盖三件事：
 *   1. 文字分享受总配额约束（历史上 /api/put 有这道闸，/api/text 漏了）
 *   2. 文字分享受限流约束（漏限流时脚本可以不受约束地刷满磁盘）
 *   3. 分片上传 init 阶段就会撞上总配额
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const SERVER = path.resolve(process.argv[2] || path.join(__dirname, 'server.js'));
const PORT = Number(process.env.QUOTA_TEST_PORT || 3355);
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'quotaadm';
const MAX_TOTAL_MB = 1;          // 上限 1MB，便于快速逼近边界
const RATE_PER_MIN = 8;          // 放宽到够跑完功能用例，再单独验证限流

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function request(method, urlPath, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + urlPath, init);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应忽略 */ }
  return { status: res.status, json: json || {} };
}

const postText = (kb) => request('POST', '/s/' + TOKEN + '/api/text', { text: 'x'.repeat(Math.round(kb * 1024)) });

async function waitUp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/s/' + TOKEN + '/', { method: 'GET' });
      if (res.status) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

(async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), '7md-quota-'));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TOKEN,
      SHARE_TOKEN: 'quotaguest',
      DATA_DIR: dataDir,
      MAX_TOTAL_MB: String(MAX_TOTAL_MB),
      RATE_INIT_PER_MIN: String(RATE_PER_MIN),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stdout.write(String(d)));

  try {
    if (!(await waitUp(15000))) throw new Error('测试实例未在 15s 内启动');

    // 1. 文字分享受总配额约束：1MB 上限，400KB 写两次还能过，第三次应该被拒
    const first = await postText(400);
    ok('400KB 文字写入成功', first.status === 200, 'status=' + first.status);
    await postText(400);
    const third = await postText(400);
    ok('超出总配额后文字分享被拒 507', third.status === 507,
      'status=' + third.status + ' ' + JSON.stringify(third.json));

    // 2. 分片上传在 init 阶段就要撞上限（8MB > 1MB）
    const init = await request('POST', '/s/' + TOKEN + '/api/init', { name: 'big.bin', size: 8 * 1024 * 1024 });
    ok('分片 init 超总配额 -> 507', init.status === 507,
      'status=' + init.status + ' ' + JSON.stringify(init.json));

    // 3. 限流：连续请求远多于配额，必须出现 429
    let limited = 0;
    for (let i = 0; i < RATE_PER_MIN + 6; i++) {
      const r = await postText(0.2);
      if (r.status === 429) limited++;
    }
    ok('写接口触发限流 429', limited > 0, '429 次数=' + limited);
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('配额测试异常:', err.message);
  process.exit(1);
});
