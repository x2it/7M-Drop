'use strict';
/**
 * sweep 行为回归（真实 HTTP 实例，4 项）—— 用缩短的时间参数实测：
 *
 *   A. 活跃长上传不被误杀：分片上传持续 10s（> idle 3s），靠 lastAt 刷新存活，
 *      所有分片 200 且 finish 成功。回归点：sweep 曾按 createdAt 判过期，
 *      会把慢速大文件上传误 abort。
 *   B. 死会话被回收：发一片后停 6s（> idle），会话被 sweep abort，再发片 404。
 *   C. 孤儿 blob 回收：files/ 里不在索引、mtime 超保护期的文件被删；
 *      保护期内的新文件不误删。回归点：rename 后崩溃/写索引失败会永久泄漏。
 *   D. 下载计数防抖：下载 2 次，等过防抖窗口后 index.json 里 downloads=2。
 *
 * 实例用独立 DATA_DIR 与短 sweep 参数自起，不碰开发实例。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.tmpdir(), 'sweeptest-' + Date.now());
const PORT = Number(process.env.SWEEPTEST_PORT || 3210);
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'adm-test-token';
const SHARE = 'gst-test-token';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

const initUp = (name, size) => fetch(BASE + '/s/' + TOKEN + '/api/init', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: name, size: size, type: 'application/octet-stream' }),
}).then((r) => r.json());

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: DIR,
      TOKEN: TOKEN,
      SHARE_TOKEN: SHARE,
      SWEEP_IDLE_MS: '3000',
      SWEEP_INTERVAL_MS: '1500',
      SWEEP_ORPHAN_MS: '10000',
    }),
    stdio: 'ignore',
  });

  try {
    if (!(await waitUp())) {
      console.error('实例未在预期时间内起来');
      process.exit(1);
    }
    console.log('sweep 行为回归 → ' + BASE + '\n');

    // ── A. 活跃长上传不被误杀 ──
    const init = await initUp('long.bin', 10240);
    ok('init 成功', !!init.uploadId, JSON.stringify(init));
    let allChunkOk = true;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(BASE + '/s/' + TOKEN + '/api/chunk?u=' + init.uploadId + '&i=' + i, {
        method: 'POST',
        body: 'A'.repeat(1024),
      });
      if (r.status !== 200) {
        allChunkOk = false;
        console.log('   chunk ' + i + ' -> ' + r.status);
      }
      await sleep(1000); // 总耗时 ~10s > idle 3s，只有 lastAt 刷新才能全程存活
    }
    ok('活跃上传跨 idle 窗口所有分片 200（lastAt 防误杀）', allChunkOk);
    const fin = await fetch(BASE + '/s/' + TOKEN + '/api/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: init.uploadId }),
    });
    ok('长上传 finish 成功', fin.status === 200, 'status=' + fin.status);
    const finBody = fin.status === 200 ? await fin.json() : null;
    const fileId = finBody && finBody.item && finBody.item.id;

    // ── B. 死会话被回收 ──
    const init2 = await initUp('dead.bin', 2048);
    const c0 = await fetch(BASE + '/s/' + TOKEN + '/api/chunk?u=' + init2.uploadId + '&i=0', {
      method: 'POST',
      body: 'B'.repeat(1024),
    });
    ok('死会话首片 200', c0.status === 200, 'status=' + c0.status);
    await sleep(6000); // > idle 3s，sweep 每 1.5s 必跑到位
    const c1 = await fetch(BASE + '/s/' + TOKEN + '/api/chunk?u=' + init2.uploadId + '&i=1', {
      method: 'POST',
      body: 'B'.repeat(1024),
    });
    ok('空闲超会话被回收（再发片 404）', c1.status === 404, 'status=' + c1.status);

    // ── C. 孤儿 blob 回收与保护期 ──
    const filesDir = path.join(DIR, 'files');
    const oldOrphan = path.join(filesDir, 'orphan-old-' + Date.now());
    const newOrphan = path.join(filesDir, 'orphan-new-' + Date.now());
    fs.writeFileSync(oldOrphan, 'x');
    fs.writeFileSync(newOrphan, 'x');
    const past = (Date.now() - 60000) / 1000; // 60s 前 > orphan 保护期 10s
    fs.utimesSync(oldOrphan, past, past);
    await sleep(3500); // 覆盖 2 个 sweep 周期
    ok('老孤儿被回收', !fs.existsSync(oldOrphan));
    ok('新孤儿保护期内不误删', fs.existsSync(newOrphan));

    // ── D. 下载计数防抖后仍正确落盘 ──
    if (fileId) {
      await fetch(BASE + '/s/' + TOKEN + '/d/' + fileId);
      await fetch(BASE + '/s/' + TOKEN + '/d/' + fileId);
      await sleep(4000); // > 3s 防抖窗口
      const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
      const rec = idx.find((r) => r.id === fileId);
      ok('下载计数防抖后正确落盘（=2）', !!rec && rec.downloads === 2, 'downloads=' + (rec && rec.downloads));
      const dl = await fetch(BASE + '/s/' + TOKEN + '/d/' + fileId);
      const txt = await dl.text();
      ok('下载内容完整', txt === 'A'.repeat(10240), 'len=' + txt.length);
    }

    // ── E. 退出清理（SIGTERM）──
    // 制造：一个未 finish 的活跃会话（tmp 留有 .part）+ 一次下载
    // （计数进了内存、防抖窗口还没到）。SIGTERM 后：tmp 必须被清、
    // 计数必须 flush 进 index.json、进程必须退出。
    const init3 = await initUp('quit.bin', 8);
    await fetch(BASE + '/s/' + TOKEN + '/api/chunk?u=' + init3.uploadId + '&i=0', {
      method: 'POST',
      body: 'D'.repeat(8),
    });
    if (fileId) {
      await fetch(BASE + '/s/' + TOKEN + '/d/' + fileId);
    }
    const tmpDir = path.join(DIR, 'tmp');
    ok('退出前 tmp 有活跃会话残留', fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).length > 0);
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 5000);
    });
    ok('SIGTERM 后进程退出', child.exitCode !== null || child.signalCode !== null,
      'exitCode=' + child.exitCode + ' signal=' + child.signalCode);
    const tmpAfter = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    ok('退出后活跃会话的 tmp 被清理', tmpAfter.length === 0, JSON.stringify(tmpAfter));
    const idx2 = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
    const rec2 = idx2.find((r) => r.id === fileId);
    // D 场景一共下载 3 次（计数校验 2 次 + 内容完整性 1 次），E 场景再加 1 次 → 4
    ok('退出时 flush 下载计数（=4）', !!rec2 && rec2.downloads === 4, 'downloads=' + (rec2 && rec2.downloads));

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } finally {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})();
