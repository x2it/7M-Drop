#!/usr/bin/env node
'use strict';

/**
 * 7MD（7喵快传）· 命令行客户端（零依赖）
 *
 * 给人和 AI Agent 用。一条命令传完文件并拿到链接。
 *
 * 用法:
 *   node drop.js <文件...>                 上传，打印分享链接
 *   node drop.js - --name note.txt         从 stdin 读
 *   echo hi | node drop.js - --name a.txt
 *   node drop.js --list                    列出已有文件
 *   node drop.js --meta                    打印服务元信息
 *   node drop.js --rm <id>                 删除一个文件（需管理口令）
 *
 * 选项:
 *   --json           JSON 输出（Agent 用这个）
 *   --direct         输出直链（强制下载）而非分享页
 *   --quiet          只输出链接
 *   --url <base>     覆盖服务地址，形如 https://xxx.trycloudflare.com/s/<口令>/
 *   --token <口令>   只有地址没有口令时用
 *
 * 配置来源（优先级从高到低）: 命令行 > 环境变量 > drop.config.json
 * 环境变量: DROP_URL / DROP_TOKEN
 */

const fs = require('fs');
const path = require('path');

const CFG_FILE = path.join(__dirname, 'drop.config.json');
// Cloudflare 免费隧道单请求上限约 100MB，留点余量
const ONE_SHOT_LIMIT = 90 * 1024 * 1024;

// ── 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const files = [];
const opt = { json: false, direct: false, quiet: false, url: '', token: '', name: '', list: false, meta: false, rm: '' };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opt.json = true;
  else if (a === '--direct') opt.direct = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--list') opt.list = true;
  else if (a === '--meta') opt.meta = true;
  else if (a === '--rm') opt.rm = argv[++i] || '';
  else if (a === '--url') opt.url = argv[++i] || '';
  else if (a === '--token') opt.token = argv[++i] || '';
  else if (a === '--name') opt.name = argv[++i] || '';
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  else if (a.startsWith('--')) { die('未知参数: ' + a); }
  else files.push(a);
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
}
function die(msg) { console.error('错误: ' + msg); process.exit(1); }

// ── 配置 ────────────────────────────────────────────────
function loadConfig() {
  let url = opt.url || process.env.DROP_URL || '';
  let token = opt.token || process.env.DROP_TOKEN || '';

  if (!url && fs.existsSync(CFG_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
      url = c.url || '';
      token = token || c.token || '';
    } catch (e) { die('drop.config.json 解析失败: ' + e.message); }
  }
  if (!url) {
    die('没有服务地址。用 --url 指定，或设环境变量 DROP_URL，或创建 drop.config.json');
  }
  // 允许只给站点根地址 + token
  if (!/\/s\/[^/]+\/?$/.test(url)) {
    if (!token) die('地址里没有口令，请用 --token 指定，或把地址写成 .../s/<口令>/');
    url = url.replace(/\/+$/, '') + '/s/' + token + '/';
  }
  return url.replace(/\/+$/, '') + '/';
}

const BASE = loadConfig();

// ── HTTP 小工具 ─────────────────────────────────────────
async function get(pathname) {
  const r = await fetch(BASE + pathname, { cache: 'no-store' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

async function postJSON(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error((json && json.error) || ('HTTP ' + r.status));
  return json;
}

// ── 上传：单请求 ────────────────────────────────────────
async function putOneShot(buf, name) {
  const r = await fetch(BASE + 'api/put?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error((json && json.error) || ('HTTP ' + r.status));
  return json;
}

// ── 上传：分片（大文件） ────────────────────────────────
async function putChunked(buf, name, chunkSize, onProgress) {
  const init = await postJSON('api/init', {
    name, size: buf.length, type: 'application/octet-stream',
  });
  const cs = init.chunkSize || chunkSize || 8 * 1024 * 1024;
  let sent = 0;
  let i = 0;
  while (sent < buf.length) {
    const end = Math.min(sent + cs, buf.length);
    const r = await fetch(BASE + 'api/chunk?u=' + encodeURIComponent(init.uploadId) + '&i=' + i, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf.subarray(sent, end),
    });
    const t = await r.text();
    if (!r.ok) throw new Error('分片 ' + i + ' 失败: ' + t.slice(0, 120));
    sent = end;
    i++;
    if (onProgress) onProgress(sent / buf.length);
  }
  return postJSON('api/finish', { uploadId: init.uploadId });
}

// ── 主流程 ──────────────────────────────────────────────
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

async function readInput(spec) {
  if (spec !== '-') {
    const st = fs.statSync(spec);
    if (st.isDirectory()) die(spec + ' 是目录，本工具只处理单个文件');
    return { buf: fs.readFileSync(spec), name: opt.name || path.basename(spec) };
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  if (!opt.name) die('从 stdin 读取时必须用 --name 指定文件名');
  return { buf: Buffer.concat(chunks), name: opt.name };
}

(async () => {
  const meta = (await get('api/meta')).json;
  if (!meta) die('拿不到 api/meta，检查地址和口令是否正确');

  if (opt.meta) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  if (opt.list) {
    const list = await get('api/list');
    if (list.status !== 200) die((list.json && list.json.error) || ('HTTP ' + list.status));
    if (opt.json) { console.log(JSON.stringify(list.json)); return; }
    console.log('角色: ' + meta.role + '   文件数: ' + list.json.items.length);
    for (const it of list.json.items) {
      console.log('  ' + String(it.size).padStart(10) + '  ' + it.name + '   ' + BASE + 'f/' + it.id);
    }
    return;
  }

  if (opt.rm) {
    await postJSON('api/delete', { id: opt.rm });
    if (opt.json) console.log(JSON.stringify({ ok: true, deleted: opt.rm }));
    else console.log('已删除 ' + opt.rm);
    return;
  }

  if (!files.length) { printHelp(); process.exit(1); }
  if (meta.permissions && meta.permissions.canUpload === false) {
    die('当前链接没有上传权限（' + meta.role + '）');
  }

  const results = [];
  for (const spec of files) {
    const { buf, name } = await readInput(spec);
    const oneShot = buf.length <= ONE_SHOT_LIMIT;
    if (!opt.quiet && !opt.json) {
      process.stderr.write('上传 ' + name + ' (' + fmtSize(buf.length) + ')' +
        (oneShot ? ' …' : ' 分片模式 …') + '\n');
    }
    const res = oneShot
      ? await putOneShot(buf, name)
      : await putChunked(buf, name, meta.limits && meta.limits.chunkSize, (p) => {
        if (!opt.quiet && !opt.json) process.stderr.write('\r  ' + Math.round(p * 100) + '%   ');
      });
    if (!opt.quiet && !opt.json && !oneShot) process.stderr.write('\n');

    const url = opt.direct ? res.urls.direct : res.urls.page;
    results.push({
      ok: true,
      name: res.item.name,
      size: res.item.size,
      id: res.item.id,
      mode: oneShot ? 'one-shot' : 'chunked',
      url,
      page: res.urls.page,
      direct: res.urls.direct,
      inline: res.urls.inline,
    });
    if (!opt.json && !opt.quiet) console.log(url);
    else if (opt.quiet) console.log(url);
  }

  if (opt.json) console.log(JSON.stringify({ ok: true, service: meta.service, results }));
})().catch((e) => {
  if (opt.json) console.log(JSON.stringify({ ok: false, error: e.message }));
  else console.error('失败: ' + e.message);
  process.exit(1);
});
