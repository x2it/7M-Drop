#!/usr/bin/env node
'use strict';

/**
 * 7喵快传 · 单文件零依赖文件中转服务器
 *
 * 用法:
 *   node server.js                          # 管理/分享口令均随机生成
 *   PORT=9000 TTL_HOURS=6 node server.js
 *   TOKEN=mysecret node server.js           # 固定管理口令
 *   SHARE_TOKEN=guest node server.js        # 固定分享口令（不能删除）
 *   SHARE_TOKEN=same node server.js         # 退回单口令模式
 *
 * 环境变量:
 *   PORT              监听端口              默认 8080
 *   HOST              监听地址              默认 ::（IPv4+IPv6 双栈，别改成 0.0.0.0）
 *   TOKEN             管理口令（可删除）     默认随机生成
 *   SHARE_TOKEN       分享口令（不能删除）   默认随机生成；same = 与管理口令相同
 *   GUEST_UPLOAD      访客能否上传          默认 1；设 0 则只能下载
 *   GUEST_LIST        访客能否看列表/下载   默认 1；设 0 则只能上传（盲投）
 *   TTL_HOURS         文件保留小时数        默认 24（0 = 永久保留）
 *   MAX_MB            单文件大小上限(MB)    默认 2048
 *   MAX_TOTAL_MB      总容量上限(MB)        默认 5120；0 = 不限
 *   RATE_INIT_PER_MIN 每 IP 每分钟上传次数  默认 60；0 = 不限流
 *   DATA_DIR          数据目录              默认 ./data
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

// ───────────────────────────── 配置 ─────────────────────────────

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const PORT = Number(process.env.PORT || 8080);
// 默认 '::' 双栈：同时接受 IPv4 与 IPv6。绑 0.0.0.0 会让 localhost(::1) 连接被拒，
// 这会让部分隧道客户端（如 Serveo over SSH）报 502。
const HOST = process.env.HOST || '::';
const MAX_BYTES = Math.max(1, Number(process.env.MAX_MB || 2048)) * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const TTL_HOURS = Math.max(0, Number(process.env.TTL_HOURS ?? 24));
const CHUNK_SIZE = 8 * 1024 * 1024; // 客户端分片大小，低于 Cloudflare 免费版 100MB 请求上限

// ── 两级权限 ────────────────────────────────────────────────
// 管理口令：全部权限（含删除）。
// 分享口令：默认可看列表、下载、上传，但**不能删除** —— 由服务端强制，不是前端藏按钮。
//   设 SHARE_TOKEN=same 退回单口令模式；设 GUEST_UPLOAD=0 则访客只能下载；
//   设 GUEST_LIST=0 则访客只能上传（盲投，看不到也下不了已有文件）。
const MAX_TOTAL_BYTES = Math.max(0, Number(process.env.MAX_TOTAL_MB ?? 5120)) * 1024 * 1024;
const GUEST_UPLOAD = String(process.env.GUEST_UPLOAD ?? '1') !== '0';
const GUEST_LIST = String(process.env.GUEST_LIST ?? '1') !== '0';
const RATE_INIT_PER_MIN = Math.max(0, Number(process.env.RATE_INIT_PER_MIN ?? 60));
// 仅当反向代理不在本机、且你确认它会覆写 X-Forwarded-For 时才开。默认关闭。
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? '0') === '1';

let TOKEN = String(process.env.TOKEN || '').trim();
let autoToken = false;
if (!TOKEN) {
  TOKEN = crypto.randomBytes(5).toString('hex');
  autoToken = true;
}

let SHARE_TOKEN = String(process.env.SHARE_TOKEN || '').trim();
let autoShare = false;
let splitTokens = true;
if (SHARE_TOKEN.toLowerCase() === 'same') {
  splitTokens = false;
  SHARE_TOKEN = TOKEN;
} else if (!SHARE_TOKEN) {
  SHARE_TOKEN = crypto.randomBytes(5).toString('hex');
  autoShare = true;
}

const mbText = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

// ───────────────────────────── 状态 ─────────────────────────────

/** @type {Array<{id:string,name:string,size:number,type:string,time:number,expires:number,downloads:number,kind:'file'|'text'}>} */
let index = [];
/** @type {Map<string,{name:string,size:number,type:string,tmp:string,received:number,nextIndex:number,createdAt:number}>} */
const uploads = new Map();

const now = () => Math.floor(Date.now() / 1000);
const newId = () => crypto.randomBytes(9).toString('base64url');
const blobPath = (id) => path.join(FILES_DIR, id);

function expiryFor() {
  return TTL_HOURS > 0 ? now() + Math.round(TTL_HOURS * 3600) : 0;
}

function defaultTextName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '文本分享-' + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.txt';
}

// ───────────────────────── 索引持久化 ─────────────────────────

async function loadIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) index = parsed.filter((r) => r && typeof r.id === 'string');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[index] 读取失败，从空索引开始:', err.message);
    index = [];
  }
}

let saveChain = Promise.resolve();
function saveIndex() {
  saveChain = saveChain.then(async () => {
    const tmp = INDEX_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(index), 'utf8');
    await fsp.rename(tmp, INDEX_FILE);
  }).catch((err) => console.error('[index] 写入失败:', err.message));
  return saveChain;
}

// ───────────────────────────── 工具 ─────────────────────────────

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function roleFor(tok) {
  if (safeEqual(tok, TOKEN)) return 'admin';
  if (SHARE_TOKEN && safeEqual(tok, SHARE_TOKEN)) return 'guest';
  return null;
}

function perms(role) {
  const admin = role === 'admin';
  return {
    role,
    canList: admin || GUEST_LIST,
    canUpload: admin || GUEST_UPLOAD,
    canDelete: admin,
  };
}

function totalBytes() {
  return index.reduce((s, r) => s + (r.size || 0), 0);
}

/**
 * 识别客户端 IP，用于限流分桶。
 *
 * 这里曾经无条件信任 X-Forwarded-For，导致任何人伪造该头就能完全绕过限流
 * （已用实测复现：固定伪造值 60 次后触发 429，每次换伪造值则 20 次全部放行）。
 *
 * 现在的规则：
 *   - 对端是回环地址（127.0.0.1 / ::1）时，说明请求来自本机代理（如 cloudflared），
 *     此时才采信 XFF，并取**最右侧**一项 —— 那是最近的代理追加的真实来源。
 *   - 其余情况一律用 TCP 来源地址。外部攻击者不可能让对端变成回环地址，所以无法伪造。
 *   - TRUST_PROXY=1 供「代理不在本机」的部署显式开启，默认关闭。
 */
function clientIp(req) {
  const sock = (req.socket && req.socket.remoteAddress) || '';
  const isLoopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd && (TRUST_PROXY || isLoopback)) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return sock || 'unknown';
}

// 极简滑动窗口限流，只作用于 /api/init，防止脚本刷爆磁盘
const initHits = new Map();
function rateLimited(ip) {
  if (!RATE_INIT_PER_MIN) return false;
  const t = Date.now();
  const arr = (initHits.get(ip) || []).filter((x) => t - x < 60000);
  arr.push(t);
  initHits.set(ip, arr);
  return arr.length > RATE_INIT_PER_MIN;
}

function sanitizeName(input) {
  let s = String(input == null ? '' : input).replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\\/]+/g, '_').replace(/^[.\s]+/, '').trim();
  if (!s) s = 'unnamed';
  if (s.length > 160) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, Math.max(1, 160 - ext.length)) + ext;
  }
  return s;
}

function contentDisposition(name, inline) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return (
    (inline ? 'inline' : 'attachment') +
    '; filename="' + fallback + '"' +
    "; filename*=UTF-8''" + encodeURIComponent(name)
  );
}

function lookup(id) {
  if (!id) return null;
  return index.find((r) => r.id === id) || null;
}

// 统一的安全响应头。CSP 只给 HTML，且 frame-ancestors 用 'self' 而非 'none' ——
// 预览弹层里用 iframe 嵌自己（PDF/文本），用 'none' 会把预览打死。
const SEC_BASE = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};
const SEC_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; " +
  "base-uri 'self'; form-action 'none'; frame-ancestors 'self'";

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_BASE });
  res.end('404 Not Found');
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...SEC_BASE,
  });
  res.end(body);
}

function sendAsset(res, type, body) {
  const buf = Buffer.from(body, 'utf8');
  const head = {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
    ...SEC_BASE,
  };
  if (type.indexOf('text/html') === 0) head['Content-Security-Policy'] = SEC_CSP;
  res.writeHead(200, head);
  res.end(buf);
}

async function readJson(req, limit = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// ───────────────────────── 上传：初始化 ─────────────────────────

async function handleInit(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }

  const name = sanitizeName(body.name);
  const size = Number(body.size);
  const type = String(body.type || 'application/octet-stream').slice(0, 120);

  if (!Number.isFinite(size) || size < 0) return sendJson(res, 400, { error: 'size 无效' });
  if (size > MAX_BYTES) {
    return sendJson(res, 413, {
      error: '文件超过上限 ' + Math.round(MAX_BYTES / 1048576) + ' MB',
    });
  }
  if (MAX_TOTAL_BYTES) {
    const used = totalBytes();
    const inflight = Array.from(uploads.values()).reduce((s, u) => s + (u.size || 0), 0);
    if (used + inflight + size > MAX_TOTAL_BYTES) {
      return sendJson(res, 507, {
        error: '服务器存储已满（已用 ' + mbText(used) + '，上限 ' + mbText(MAX_TOTAL_BYTES) + '）',
      });
    }
  }

  const id = newId();
  const tmp = path.join(TMP_DIR, id + '.part');
  try {
    await fsp.writeFile(tmp, Buffer.alloc(0));
  } catch (err) {
    console.error('[init] 创建临时文件失败:', err.message);
    return sendJson(res, 500, { error: '服务器无法写入数据目录' });
  }

  uploads.set(id, {
    name, size, type, tmp,
    received: 0, nextIndex: 0, createdAt: Date.now(),
  });

  sendJson(res, 200, { uploadId: id, chunkSize: CHUNK_SIZE, maxBytes: MAX_BYTES });
}

// ───────────────────────── Agent 接口 ─────────────────────────

/** 依据请求头推断本站对外基址（兼容隧道/反向代理） */
function baseUrlFor(req, token) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0].trim();
  return proto + '://' + host + '/s/' + token + '/';
}

/**
 * 自描述元信息：Agent 只请求一次，就知道自己是谁、能做什么、
 * 上限多少、每个接口在哪。不用读文档、不用猜。
 */
function metaPayload(P, base) {
  return {
    service: '7喵快传',
    apiVersion: 1,
    role: P.role,
    baseUrl: base,
    shareUrl: (P.role === 'admin' && splitTokens)
      ? base.replace(/\/s\/[^/]+\/$/, '/s/' + SHARE_TOKEN + '/')
      : null,
    permissions: { canList: P.canList, canUpload: P.canUpload, canDelete: P.canDelete },
    limits: {
      maxMb: Math.round(MAX_BYTES / 1048576),
      maxTotalMb: MAX_TOTAL_BYTES ? Math.round(MAX_TOTAL_BYTES / 1048576) : 0,
      usedBytes: totalBytes(),
      ttlHours: TTL_HOURS,
      chunkSize: CHUNK_SIZE,
      rateInitPerMin: RATE_INIT_PER_MIN,
    },
    // Agent 最需要的两件事：一条命令传完，和拿到手就能用的链接
    quickstart: {
      uploadOneShot: 'curl -T <file> "' + base + 'api/put?name=<urlencoded-name>"',
      uploadStdin: 'curl --data-binary @- -H "X-File-Name: <base64url(name)>" "' + base + 'api/put"',
      listFiles: 'curl "' + base + 'api/list"',
    },
    endpoints: {
      meta: { method: 'GET', path: 'api/meta' },
      list: { method: 'GET', path: 'api/list' },
      put: { method: 'POST', path: 'api/put?name=<urlencoded>', body: 'raw bytes', note: '单请求上传，推荐 Agent 使用' },
      init: { method: 'POST', path: 'api/init', body: '{name,size,type}' },
      chunk: { method: 'POST', path: 'api/chunk?u=<uploadId>&i=<n>', body: 'raw bytes' },
      finish: { method: 'POST', path: 'api/finish', body: '{uploadId}' },
      text: { method: 'POST', path: 'api/text', body: '{text}' },
      delete: { method: 'POST', path: 'api/delete', body: '{id}', adminOnly: true },
      filePage: { method: 'GET', path: 'f/<id>', note: '分享用，打开先预览' },
      direct: { method: 'GET', path: 'd/<id>', note: '强制下载' },
      inline: { method: 'GET', path: 'v/<id>', note: 'inline 输出，给 img/video/iframe' },
    },
  };
}

/**
 * 一次请求完成上传：POST /api/put?name=xxx（原始字节体）
 * 供命令行与 AI Agent 使用，省掉 init→chunk→finish 三步。
 * 单文件超过约 90MB 时仍建议走分片（分片能绕过 Cloudflare 免费版单请求上限）。
 */
async function handlePut(req, res, url, token) {
  let name = url.searchParams.get('name') || '';
  const b64 = req.headers['x-file-name'];
  if (!name && b64) {
    try { name = Buffer.from(String(b64), 'base64url').toString('utf8'); } catch { /* 忽略 */ }
  }
  name = sanitizeName(name || 'upload.bin');

  if (MAX_TOTAL_BYTES && totalBytes() >= MAX_TOTAL_BYTES) {
    return sendJson(res, 507, { error: '服务器存储已满' });
  }

  const id = newId();
  const tmp = path.join(TMP_DIR, id + '.part');
  // 配额余量先算一次，之后按累计字节 O(1) 判断，避免每收到一块都全量扫索引
  const room = MAX_TOTAL_BYTES ? Math.max(0, MAX_TOTAL_BYTES - totalBytes()) : Infinity;
  let size = 0;
  let tooBig = false;
  let overQuota = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) { tooBig = true; req.destroy(); }
    else if (size > room) { overQuota = true; req.destroy(); }
  });

  try {
    await pipeline(req, fs.createWriteStream(tmp));
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (tooBig) return sendJson(res, 413, { error: '文件超过上限 ' + Math.round(MAX_BYTES / 1048576) + ' MB' });
    if (overQuota) return sendJson(res, 507, { error: '服务器存储已满' });
    return sendJson(res, 400, { error: '上传中断' });
  }

  // 配额按「实收字节」复核，避免少报 size 绕过
  if (MAX_TOTAL_BYTES && totalBytes() + size > MAX_TOTAL_BYTES) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return sendJson(res, 507, { error: '服务器存储已满' });
  }

  try {
    await fsp.rename(tmp, blobPath(id));
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    console.error('[put] 落盘失败:', err.message);
    return sendJson(res, 500, { error: '保存失败' });
  }

  const rec = {
    id,
    name,
    size,
    type: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120),
    time: now(),
    expires: expiryFor(),
    downloads: 0,
    kind: 'file',
  };
  index.unshift(rec);
  await saveIndex();

  const base = baseUrlFor(req, token);
  sendJson(res, 200, {
    ok: true,
    item: rec,
    urls: {
      page: base + 'f/' + id,      // 分享给别人
      direct: base + 'd/' + id,    // 直接下载
      inline: base + 'v/' + id,    // 内联预览
    },
  });
}

// ───────────────────────── 上传：分片 ─────────────────────────

async function handleChunk(req, res, url) {
  const id = url.searchParams.get('u') || '';
  const idx = Number(url.searchParams.get('i'));
  const up = uploads.get(id);

  if (!up) return sendJson(res, 404, { error: '上传会话不存在或已过期' });
  if (!Number.isInteger(idx) || idx !== up.nextIndex) {
    return sendJson(res, 409, { error: '分片顺序错误', expect: up.nextIndex });
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared && up.received + declared > MAX_BYTES) {
    await abortUpload(id);
    return sendJson(res, 413, { error: '文件超过上限' });
  }

  // 总配额在 init 时只按「客户端声明的大小」检查，可以少报绕过：
  // 声明 1 字节再实灌几 MB，数据会落进 tmp 却不算配额。
  // 这里按实际写入量再兜一道，把 tmp 的占用也压在配额之内。
  if (MAX_TOTAL_BYTES) {
    let otherInflight = 0;
    for (const [k, v] of uploads) {
      if (k !== id) otherInflight += v.size || 0;
    }
    const projected = totalBytes() + otherInflight + up.received + declared;
    if (projected > MAX_TOTAL_BYTES) {
      await abortUpload(id);
      return sendJson(res, 507, { error: '服务器存储已满' });
    }
  }

  let received = 0;
  let tooBig = false;
  req.on('data', (c) => {
    received += c.length;
    if (up.received + received > MAX_BYTES) {
      tooBig = true;
      req.destroy();
    }
  });

  const ws = fs.createWriteStream(up.tmp, { flags: 'a' });
  try {
    await pipeline(req, ws);
  } catch {
    await abortUpload(id);
    return sendJson(res, tooBig ? 413 : 400, {
      error: tooBig ? '文件超过上限' : '上传中断',
    });
  }

  up.received += received;
  up.nextIndex += 1;
  sendJson(res, 200, { ok: true, received: up.received, next: up.nextIndex });
}

// ───────────────────────── 上传：完成 ─────────────────────────

async function handleFinish(req, res, token) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }

  const up = uploads.get(String(body.uploadId || ''));
  if (!up) return sendJson(res, 404, { error: '上传会话不存在或已过期' });

  if (up.size && up.received !== up.size) {
    // 注意：上传记录里没有 uploadId 字段，这里必须用请求里的 id。
    // 之前写成 up.uploadId 会退化成 undefined，导致临时文件删不掉、会话泄漏。
    await abortUpload(String(body.uploadId));
    return sendJson(res, 400, { error: '数据不完整，请重试' });
  }
  if (up.size > MAX_BYTES) {
    await abortUpload(String(body.uploadId));
    return sendJson(res, 413, { error: '文件超过上限' });
  }

  const id = String(body.uploadId);
  const finalPath = blobPath(id);
  try {
    await fsp.rename(up.tmp, finalPath);
  } catch (err) {
    console.error('[finish] 落盘失败:', err.message);
    await abortUpload(id);
    return sendJson(res, 500, { error: '保存失败' });
  }

  const rec = {
    id,
    name: up.name,
    size: up.received,
    type: up.type,
    time: now(),
    expires: expiryFor(),
    downloads: 0,
    kind: 'file',
  };
  index.unshift(rec);
  uploads.delete(id);
  await saveIndex();

  // 与 /api/put 保持一致的返回形状 —— 客户端不该因为走了分片就拿不到链接
  const base = baseUrlFor(req, token);
  sendJson(res, 200, {
    ok: true,
    item: rec,
    urls: {
      page: base + 'f/' + id,
      direct: base + 'd/' + id,
      inline: base + 'v/' + id,
    },
  });
}

async function abortUpload(id) {
  const up = uploads.get(id);
  uploads.delete(id);
  const target = up ? up.tmp : path.join(TMP_DIR, id + '.part');
  await fsp.rm(target, { force: true }).catch(() => {});
}

// ───────────────────────── 文字分享 ─────────────────────────

async function handleText(req, res, token) {
  let body;
  try {
    body = await readJson(req, MAX_TEXT_BYTES + 65536);
  } catch {
    return sendJson(res, 413, { error: '文本过大' });
  }

  const text = String(body.text == null ? '' : body.text);
  const buf = Buffer.from(text, 'utf8');
  if (!text.trim()) return sendJson(res, 400, { error: '内容为空' });
  if (buf.length > MAX_TEXT_BYTES) {
    return sendJson(res, 413, { error: '文本超过 ' + Math.round(MAX_TEXT_BYTES / 1024) + ' KB' });
  }

  const id = newId();
  await fsp.writeFile(blobPath(id), buf);

  const rec = {
    id,
    name: sanitizeName(body.name || defaultTextName()),
    size: buf.length,
    type: 'text/plain; charset=utf-8',
    time: now(),
    expires: expiryFor(),
    downloads: 0,
    kind: 'text',
  };
  index.unshift(rec);
  await saveIndex();
  const base = baseUrlFor(req, token);
  sendJson(res, 200, {
    ok: true,
    item: rec,
    urls: {
      page: base + 'f/' + id,
      direct: base + 'd/' + id,
      inline: base + 'v/' + id,
    },
  });
}

// ───────────────────────── 列表 / 删除 ─────────────────────────

function listPayload(P) {
  const p = P || perms('admin');
  const out = {
    role: p.role,
    canUpload: p.canUpload,
    canList: p.canList,
    canDelete: p.canDelete,
    ttlHours: TTL_HOURS,
    maxMb: Math.round(MAX_BYTES / 1048576),
    maxTotalMb: MAX_TOTAL_BYTES ? Math.round(MAX_TOTAL_BYTES / 1048576) : 0,
    usedBytes: totalBytes(),
    items: index.map((r) => ({
      id: r.id, name: r.name, size: r.size, type: r.type,
      time: r.time, expires: r.expires, downloads: r.downloads, kind: r.kind,
    })),
  };
  // 分享口令只回传给管理员，方便他一键把分享链接/二维码给出去
  if (p.role === 'admin' && splitTokens) out.shareToken = SHARE_TOKEN;
  return out;
}

async function handleDelete(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }
  const id = String(body.id || '');
  const rec = lookup(id);
  if (!rec) return sendJson(res, 404, { error: '文件不存在' });

  index = index.filter((r) => r.id !== id);
  await fsp.rm(blobPath(id), { force: true }).catch(() => {});
  await saveIndex();
  sendJson(res, 200, { ok: true });
}

// ───────────────────────── 下载 / 预览 ─────────────────────────

const DANGEROUS_TYPE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml)$/i;

async function serveBlob(req, res, rec, inline) {
  if (!rec) return notFound(res);

  const p = blobPath(rec.id);
  let stat;
  try {
    stat = await fsp.stat(p);
  } catch {
    return notFound(res);
  }

  let type = rec.type || 'application/octet-stream';
  // 防止上传的 HTML/SVG 在本人源上执行脚本
  if (inline && DANGEROUS_TYPE.test(type)) type = 'text/plain; charset=utf-8';
  if (rec.kind === 'text') type = 'text/plain; charset=utf-8';

  const headers = {
    'Content-Type': type,
    'Content-Disposition': contentDisposition(rec.name, Boolean(inline)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    ...SEC_BASE,
  };

  rec.downloads += 1;
  saveIndex();

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start;
      let end;
      if (m[1] === '') {
        const suffix = Number(m[2]);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? stat.size - 1 : Math.min(Number(m[2]), stat.size - 1);
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        return res.end();
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(p, { start, end }), res).catch(() => {});
    }
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(p), res).catch(() => {});
}

// ───────────────────────── 清理 ─────────────────────────

async function sweep() {
  if (initHits.size > 5000) initHits.clear();
  const t = now();
  const expired = index.filter((r) => r.expires > 0 && r.expires <= t);
  if (expired.length) {
    index = index.filter((r) => !(r.expires > 0 && r.expires <= t));
    for (const r of expired) await fsp.rm(blobPath(r.id), { force: true }).catch(() => {});
    await saveIndex();
    console.log('[sweep] 清理过期文件 ' + expired.length + ' 个');
  }

  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [id, up] of uploads) {
    if (up.createdAt < cutoff) await abortUpload(id);
  }

  try {
    const names = await fsp.readdir(TMP_DIR);
    const keep = new Set(Array.from(uploads.values()).map((u) => path.basename(u.tmp)));
    for (const n of names) {
      if (keep.has(n)) continue;
      const fp = path.join(TMP_DIR, n);
      const st = await fsp.stat(fp).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.rm(fp, { force: true }).catch(() => {});
    }
  } catch { /* tmp 目录可能不存在 */ }
}

// ───────────────────────── 路由 ─────────────────────────

/**
 * 带 <base> 的首页 HTML。
 * 深路径（/s/<口令>/f/<id>）下，./app.js 这类相对地址会被解析到 /f/ 之下，
 * 拿到的是 HTML 而不是脚本，页面会整个失去行为。注入 <base> 修正。
 */
function pageHtml(token) {
  const safe = String(token).replace(/[^A-Za-z0-9._-]/g, '');
  return PAGE.replace('<head>', '<head>\n<base href="/s/' + safe + '/">');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(res);
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return notFound(res);
  const role = roleFor(m[1]);
  if (!role) return notFound(res);
  const P = perms(role);
  const rest = m[2] || '/';

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (rest === '/' || rest === '/index.html') return sendAsset(res, 'text/html; charset=utf-8', pageHtml(m[1]));
    // 文件页：同一个 SPA，客户端按路径自动打开对应文件的预览。
    // 分享链接与二维码指向这里，而不是 /d/<id>（那是强制下载的直链）。
    // 必须精确匹配 id，否则会把 /f/app.js 这类相对资源请求也吞成 HTML。
    if (/^\/f\/[A-Za-z0-9_-]+$/.test(rest)) {
      if (!P.canList) return notFound(res);
      return sendAsset(res, 'text/html; charset=utf-8', pageHtml(m[1]));
    }
    if (rest === '/app.css') return sendAsset(res, 'text/css; charset=utf-8', CSS);
    if (rest === '/app.js') return sendAsset(res, 'application/javascript; charset=utf-8', APP_JS);
    if (rest === '/qr.js') return sendAsset(res, 'application/javascript; charset=utf-8', QR_JS);
    if (rest === '/favicon.ico') return sendAsset(res, 'image/svg+xml', FAVICON);
    if (rest === '/api/list') {
      if (!P.canList) return sendJson(res, 403, { error: '当前链接没有查看列表的权限', ...P });
      return sendJson(res, 200, listPayload(P));
    }
    // 自描述元信息：Agent 的入口。不受 canList 限制，拿到链接就能自举。
    if (rest === '/api/meta') {
      return sendJson(res, 200, metaPayload(P, baseUrlFor(req, m[1])));
    }
    if (rest.startsWith('/d/')) {
      if (!P.canList) return notFound(res);
      return serveBlob(req, res, lookup(rest.slice(3)), false);
    }
    if (rest.startsWith('/v/')) {
      if (!P.canList) return notFound(res);
      return serveBlob(req, res, lookup(rest.slice(3)), true);
    }
    return notFound(res);
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    // curl -T / --upload-file 默认发 PUT，而 /api/put 正是它最自然的用法，
    // 所以这里一并接受；其余接口只收 POST。
    if (req.method === 'PUT' && rest !== '/api/put') return notFound(res);
    const isWrite = rest === '/api/put' || rest === '/api/init' || rest === '/api/chunk' ||
      rest === '/api/finish' || rest === '/api/text';
    if (isWrite && !P.canUpload) {
      return sendJson(res, 403, { error: '当前链接没有上传权限', ...P });
    }
    if (rest === '/api/put') {
      if (rateLimited(clientIp(req))) {
        return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
      }
      return handlePut(req, res, url, m[1]);
    }
    if (rest === '/api/init') {
      if (rateLimited(clientIp(req))) {
        return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
      }
      return handleInit(req, res);
    }
    if (rest === '/api/chunk') return handleChunk(req, res, url);
    if (rest === '/api/finish') return handleFinish(req, res, m[1]);
    if (rest === '/api/text') return handleText(req, res, m[1]);
    if (rest === '/api/delete') {
      if (!P.canDelete) {
        return sendJson(res, 403, { error: '只有管理链接可以删除文件', ...P });
      }
      return handleDelete(req, res);
    }
    return notFound(res);
  }

  return notFound(res);
}

// ───────────────────────── 前端 ─────────────────────────

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="theme-color" content="#008080">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="robots" content="noindex,nofollow">',
  '<title>7喵快传</title>',
  '<link rel="icon" href="./favicon.ico">',
  '<link rel="apple-touch-icon" href="./favicon.ico">',
  '<link rel="stylesheet" href="./app.css">',
  '</head>',
  '<body>',
  '<div class="desk">',
  '  <div class="window">',
  '',
  '    <div class="titlebar">',
  '      <span class="tb-title">7喵快传</span>',
  '      <button class="tb-mode" id="tbMode" type="button" title="查看当前链接的身份与权限">…</button>',
  '    </div>',
  '',
  '    <div class="win-body">',
  '',
  '      <div class="toolbar">',
  '        <button id="qrPage" type="button">二维码分享</button>',
  '        <button id="copyPage" type="button">复制本页链接</button>',
  '      </div>',
  '',
  '      <div id="drop" class="drop" tabindex="0" role="button" aria-label="选择要上传的文件">',
  '        <div class="drop-inner">',
  '          <div class="drop-title">拖入文件，或点击选择</div>',
  '          <div class="drop-sub">支持多选 · 可粘贴截图 · 手机可直接调相册</div>',
  '        </div>',
  '        <input id="file" type="file" multiple hidden>',
  '        <input id="media" type="file" accept="image/*,video/*" multiple hidden>',
  '      </div>',
  '',
  '      <div class="btnrow">',
  '        <button id="pickMedia" type="button">照片 / 视频</button>',
  '        <button id="pickFile" type="button">选择文件</button>',
  '        <button id="textToggle" type="button">发一段文字</button>',
  '      </div>',
  '',
  '      <div id="textPane" class="textpane" hidden>',
  '        <textarea id="textInput" rows="4" placeholder="粘贴文字、代码或链接，生成一个可分享的短链…"></textarea>',
  '        <div class="textpane-actions"><button id="textSend" type="button">生成链接</button></div>',
  '      </div>',
  '',
  '      <div id="queue" class="queue"></div>',
  '',
  '      <fieldset class="panel" id="filesPanel">',
  '        <legend>文件列表<span id="filesCount"></span></legend>',
  '        <div class="panel-tools"><button id="refresh" type="button">刷新</button></div>',
  '        <ul id="list" class="list"></ul>',
  '        <p id="empty" class="empty">还没有文件<span>上传后会出现在这里</span></p>',
  '      </fieldset>',
  '',
  '    </div>',
  '',
  '    <div class="statusbar">',
  '      <div class="sb-panel" id="sbMode">…</div>',
  '      <div class="sb-panel sb-mid" id="sbLimit">…</div>',
  '      <div class="sb-panel sb-mid" id="sbQuota">…</div>',
  '    </div>',
  '',
  '    <div class="footer">',
  '      <span>© 2026 <a href="https://w3b.pub" target="_blank" rel="noopener noreferrer">知行工作室</a></span>',
  '    </div>',
  '',
  '  </div>',
  '</div>',
  '',
  '<div id="viewer" class="mask viewer" hidden>',
  '  <div class="dialog viewer-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="viewerName">预览</span>',
  '      <button id="viewerClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div id="viewerBody" class="viewer-body"></div>',
  '    <div class="viewer-foot">',
  '      <button id="viewerPrev" type="button">◀ 上一个</button>',
  '      <a id="viewerDl" class="btn-like" download>下载</a>',
  '      <button id="viewerNext" type="button">下一个 ▶</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="qrModal" class="mask" hidden>',
  '  <div class="dialog qr-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="qrTitle">扫码打开</span>',
  '      <button id="qrClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <div class="qr-box"><canvas id="qrCanvas" width="560" height="560"></canvas></div>',
  '      <p id="qrUrl" class="qr-url"></p>',
  '      <button id="qrCopy" type="button" class="wide">复制链接</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="infoModal" class="mask" hidden>',
  '  <div class="dialog info-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title">链接与权限</span>',
  '      <button id="infoClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <div class="info-body">',
  '        <div class="info-row"><span class="info-k">当前身份</span><span class="info-v" id="infoRole">…</span></div>',
  '        <p class="info-note" id="infoNote"></p>',
  '        <ul class="perm-list" id="infoPerms"></ul>',
  '        <div class="info-row"><span class="info-k">单文件上限</span><span class="info-v" id="infoMax">…</span></div>',
  '        <div class="info-row"><span class="info-k">保留时长</span><span class="info-v" id="infoTtl">…</span></div>',
  '        <div class="info-row"><span class="info-k">已用容量</span><span class="info-v" id="infoQuota">…</span></div>',
  '      </div>',
  '      <div id="infoShareWrap" hidden>',
  '        <div class="info-label">分享链接（发给别人用这个）</div>',
  '        <div class="info-link" id="infoShareLink"></div>',
  '        <div class="info-btns">',
  '          <button id="infoCopyShare" type="button">复制</button>',
  '          <button id="infoQrShare" type="button">二维码</button>',
  '        </div>',
  '      </div>',
  '      <div class="info-label">Agent / 命令行入口（给 AI 用）</div>',
  '      <div class="info-link" id="infoAgentLink"></div>',
  '      <div class="info-btns"><button id="infoCopyAgent" type="button">复制自举地址</button></div>',
  '      <p class="info-note">把这个地址交给 AI，再让它运行下面这行，它就能传文件上来并把链接给你：</p>',
  '      <code class="info-code">node drop.js &lt;文件路径&gt;</code>',
  '      <div class="info-label">当前链接</div>',
  '      <div class="info-link" id="infoSelfLink"></div>',
  '      <div class="info-btns"><button id="infoCopySelf" type="button">复制当前链接</button></div>',
  '      <div class="dlg-foot"><button id="infoOk" class="wide" type="button">关闭</button></div>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="sheet" class="mask mask-bottom" hidden>',
  '  <div class="dialog sheet-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="sheetName">操作</span>',
  '      <button id="sheetClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div class="dlg-body sheet-body">',
  '      <button class="sheet-item" data-act="preview" type="button">预览</button>',
  '      <button class="sheet-item" data-act="download" type="button">下载</button>',
  '      <button class="sheet-item" data-act="copylink" type="button">复制分享链接（打开先看）</button>',
  '      <button class="sheet-item" data-act="copydirect" type="button">复制直链（直接下载）</button>',
  '      <button class="sheet-item" data-act="qr" type="button">二维码分享</button>',
  '      <button class="sheet-item" data-act="delete" type="button">删除</button>',
  '      <button class="sheet-item sheet-cancel" data-act="cancel" type="button">取消</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="toast" class="toast" hidden></div>',
  '',
  '<script src="./qr.js"></script>',
  '<script src="./app.js"></script>',
  '</body>',
  '</html>',
].join('\n');

const CSS = `
/* ── 90 年代 Windows 复古：全部立体感用 1px 线条（box-shadow）实现 ── */
*,*::before,*::after{box-sizing:border-box}
:root{
  --face:#c0c0c0; --hi:#ffffff; --lt:#dfdfdf; --sh:#808080; --dk:#0a0a0a;
  --title:#000080; --title2:#1084d0; --win:#ffffff; --text:#000000;
  --dis:#808080; --sel:#000080; --desk:#008080;
  --safe-t:env(safe-area-inset-top,0px);
  --safe-b:env(safe-area-inset-bottom,0px);
  --safe-l:env(safe-area-inset-left,0px);
  --safe-r:env(safe-area-inset-right,0px);
  --raise:inset -1px -1px var(--dk),inset 1px 1px var(--hi),inset -2px -2px var(--sh),inset 2px 2px var(--lt);
  --sink:inset 1px 1px var(--sh),inset -1px -1px var(--hi),inset 2px 2px var(--dk),inset -2px -2px var(--lt);
  --groove:inset 1px 1px var(--dk),inset -1px -1px var(--hi),inset 2px 2px var(--sh),inset -2px -2px var(--lt);
}
html{-webkit-text-size-adjust:100%}
html,body{margin:0;padding:0}
body{
  background:var(--desk);
  color:var(--text);
  min-height:100dvh;
  font:13px/1.45 "MS Sans Serif",Tahoma,"SimSun","宋体","Microsoft YaHei",sans-serif;
  -webkit-tap-highlight-color:transparent;
}
img,canvas,video{max-width:100%}
button,input,textarea,select{font-family:inherit}
[hidden]{display:none !important}

.desk{
  min-height:100dvh;
  padding:calc(14px + var(--safe-t)) calc(14px + var(--safe-r)) calc(14px + var(--safe-b)) calc(14px + var(--safe-l));
  display:flex;justify-content:center;align-items:flex-start;
}

.window{
  width:100%;max-width:820px;min-width:0;
  background:var(--face);
  box-shadow:var(--raise);
  padding:3px;
}
.titlebar{
  background:linear-gradient(90deg,var(--title),var(--title2));
  color:#fff;font-weight:700;font-size:12px;
  padding:3px 3px 3px 5px;
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  min-height:24px;
}
/* 不加 letter-spacing：原版 MS Sans Serif 没有字距，
   而且中文加字距后会明显显得松散 */
.tb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-mode{
  font-weight:400;font-size:11px;flex:none;border-radius:0;
  background:transparent;border:1px solid transparent;color:#fff;
  padding:2px 8px;min-height:19px;box-shadow:none;
}
.tb-mode:hover{background:rgba(255,255,255,.20);border-color:rgba(255,255,255,.40)}
.tb-mode:active{box-shadow:none;padding:2px 8px;background:rgba(255,255,255,.30)}
.tb-btn{
  width:19px;height:17px;min-height:0;padding:0;flex:none;
  display:grid;place-items:center;font-size:10px;font-weight:700;line-height:1;
  background:var(--face);color:var(--text);
  box-shadow:var(--raise);
}
.tb-btn:active{box-shadow:var(--sink)}

.win-body{padding:9px 8px 8px}

/* ── 按钮 ── */
button{
  background:var(--face);color:var(--text);border:0;border-radius:0;
  padding:6px 12px;min-height:32px;cursor:pointer;
  box-shadow:var(--raise);
  transition:none;
}
button:active{
  box-shadow:var(--sink);
  padding:7px 11px 5px 13px;
}
button:focus-visible{outline:1px dotted var(--dk);outline-offset:-4px}
button.wide{width:100%}

.toolbar{display:flex;gap:5px;margin-bottom:9px;min-width:0}
.toolbar button{flex:1;min-width:0;font-size:12px;padding:6px 8px;min-height:34px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btnrow{display:flex;gap:5px;margin-top:6px;min-width:0}
.btnrow button{flex:1;min-width:0;font-size:12px;min-height:38px;padding:6px 8px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 拖放区：下沉白底 + 内部虚线（线条化） ── */
.drop{
  background:var(--win);
  box-shadow:var(--sink);
  padding:4px;cursor:pointer;outline:none;
}
.drop:hover{background:#f4f4f4}
.drop:focus-visible{outline:1px dotted var(--dk);outline-offset:-8px}
.drop.over{background:#e8f0ff}
.drop.over .drop-inner{border-color:var(--title)}
.drop-inner{
  border:1px dashed var(--sh);
  padding:26px 14px;text-align:center;
}
.drop-title{font-size:14px;font-weight:700}
.drop-sub{color:#404040;font-size:11.5px;margin-top:5px}

.textpane{margin-top:6px;background:var(--face);box-shadow:var(--raise);padding:8px}
textarea{
  width:100%;background:var(--win);color:var(--text);border:0;border-radius:0;
  box-shadow:var(--sink);
  padding:7px;font:13px/1.5 "Courier New",Consolas,monospace;resize:vertical;
}
textarea:focus{outline:none}
.textpane-actions{display:flex;justify-content:flex-end;margin-top:7px}

/* ── 上传队列：经典分段进度条 ── */
.queue{margin-top:9px;display:flex;flex-direction:column;gap:5px}
.qitem{background:var(--face);box-shadow:var(--raise);padding:7px 9px}
.qtop{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}
.qname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qpct{flex:none;font-variant-numeric:tabular-nums;color:#303030}
.bar{
  height:16px;background:var(--win);box-shadow:var(--sink);
  padding:2px;
}
.bar>i{
  display:block;height:100%;width:0;
  background:repeating-linear-gradient(90deg,var(--title) 0 7px,transparent 7px 9px);
}
.qitem.err .bar>i{background:repeating-linear-gradient(90deg,#a00000 0 7px,transparent 7px 9px)}
.qmsg{color:#a00000;font-size:11.5px;margin-top:5px;word-break:break-all}

/* ── 分组框：列表容器 ── */
fieldset.panel{
  border:1px solid var(--sh);border-right-color:var(--hi);border-bottom-color:var(--hi);
  margin:12px 0 0;padding:9px 8px 8px;position:relative;
}
fieldset.panel legend{
  font-size:12px;font-weight:700;padding:0 6px;margin-left:2px;
}
#filesCount{font-weight:400;color:#404040;margin-left:5px}
.panel-tools{position:absolute;top:-2px;right:8px}
.panel-tools button{font-size:11.5px;padding:2px 9px;min-height:22px}
.panel-tools button:active{padding:3px 8px 1px 10px}

.list{list-style:none;margin:8px 0 0;padding:2px;background:var(--win);box-shadow:var(--sink);
  max-height:52vh;overflow:auto;overflow-x:hidden}
.row{
  display:flex;align-items:center;gap:9px;
  padding:7px 6px;
  border-bottom:1px dotted #b0b0b0;
}
.row:last-child{border-bottom:0}
.row.tappable{cursor:pointer}
.row:hover{background:var(--sel);color:#fff}
.row:hover .fsub{color:#d0d0d0}
.row:hover .ico{color:#fff}
.row:hover .row-more{color:#fff}

.ico{
  width:34px;height:30px;flex:none;display:grid;place-items:center;
  background:var(--win);box-shadow:var(--sink);
  font:700 9.5px/1 Tahoma,Arial,sans-serif;letter-spacing:.5px;color:var(--title);
  text-transform:uppercase;
}
.meta{min-width:0;flex:1}
.fname{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fsub{color:#505050;font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.row-more{
  width:30px;height:30px;min-height:0;padding:0;flex:none;
  display:grid;place-items:center;font-size:15px;line-height:1;
  background:var(--face);color:var(--text);box-shadow:var(--raise);
}
.row-more:active{box-shadow:var(--sink);padding:0}
.empty{color:#404040;font-size:12px;text-align:center;padding:20px 0;margin:0;
  display:flex;flex-direction:column;gap:3px}
.empty span{font-size:11px;color:var(--dis)}

/* ── 状态栏 ── */
.statusbar{display:flex;gap:3px;padding:3px 3px 3px}
.sb-panel{
  flex:1;min-width:0;
  padding:2px 6px;font-size:11px;
  background:var(--face);box-shadow:var(--sink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.sb-panel:first-child{flex:0 0 auto}

/* ── 页脚版权 ── */
.footer{
  padding:4px 6px 3px;text-align:center;
  font-size:11px;color:#505050;
}
.footer a{color:var(--title);text-decoration:underline}
.footer a:hover{color:#000}

/* ── 对话框通用 ── */
.mask{
  position:fixed;inset:0;z-index:80;
  display:flex;align-items:center;justify-content:center;
  padding:calc(12px + var(--safe-t)) calc(12px + var(--safe-r)) calc(12px + var(--safe-b)) calc(12px + var(--safe-l));
  background:rgba(0,0,0,.42);
}
.mask-bottom{align-items:flex-end}
.dialog{background:var(--face);box-shadow:var(--raise);padding:3px;max-height:100%;display:flex;flex-direction:column}
.dlg-body{padding:10px;overflow:auto}

/* ── 预览 ── */
/* 注意：这里必须叠在 .mask 上，单独写 .viewer 会丢掉 position:fixed，
   弹层会变成文档流里的普通块，表现为「点了没反应」。 */
.viewer{background:rgba(0,0,0,.74);z-index:85}
.viewer .viewer-dlg{width:min(920px,100%);height:min(88dvh,100%)}
.viewer-body{
  flex:1;min-height:0;background:#000;box-shadow:var(--sink);margin:3px;
  display:grid;place-items:center;overflow:auto;-webkit-overflow-scrolling:touch;
}
.viewer-body img{max-width:100%;max-height:100%;object-fit:contain}
.viewer-body video{max-width:100%;max-height:100%;background:#000}
.viewer-body iframe{width:100%;height:100%;border:0;background:#fff}
.viewer-body pre{
  margin:0;width:100%;height:100%;overflow:auto;background:var(--win);color:var(--text);
  padding:9px;font:12px/1.6 "Courier New",Consolas,monospace;
  white-space:pre-wrap;word-break:break-word;text-align:left;
  -webkit-overflow-scrolling:touch;
}
.audio-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;color:#d0d0d0;font-size:12px}
.audio-wrap .big{font:700 15px/1 Tahoma,sans-serif;letter-spacing:3px;color:#fff}
.audio-wrap audio{width:min(400px,78vw)}
.viewer-tip{color:#d0d0d0;font-size:12px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
.viewer-foot{display:flex;gap:5px;padding:5px}
.viewer-foot>*{flex:1;text-align:center}
.btn-like{
  display:flex;align-items:center;justify-content:center;
  background:var(--face);color:var(--text);text-decoration:none;
  padding:6px 12px;min-height:32px;font-size:13px;box-shadow:var(--raise);cursor:pointer;
}
.btn-like:active{box-shadow:var(--sink);padding:7px 11px 5px 13px}

/* ── 二维码 ── */
.qr-dlg{width:min(360px,100%)}
.qr-box{background:var(--win);box-shadow:var(--sink);padding:10px;display:grid;place-items:center}
.qr-box canvas{width:100%;max-width:270px;height:auto;display:block;image-rendering:pixelated}
.qr-url{
  font:11px/1.5 "Courier New",Consolas,monospace;color:#303030;
  margin:10px 0;word-break:break-all;text-align:center;
  max-height:56px;overflow:auto;
}

/* ── 链接与权限 ── */
.info-dlg{width:min(430px,100%)}
.info-body{background:var(--win);box-shadow:var(--sink);padding:9px 10px;margin-bottom:9px}
.info-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;
  padding:5px 0;border-bottom:1px dotted #cfcfcf}
.info-row:last-child{border-bottom:0}
.info-k{color:#404040;flex:none}
.info-v{font-weight:700;text-align:right;word-break:break-all}
.info-note{font-size:11.5px;color:#404040;margin:9px 0 6px;line-height:1.55}
.perm-list{list-style:none;margin:0;padding:0}
.perm-list li{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:4px 0}
.perm-yes{color:#006000}
.perm-no{color:#a00000}
.info-label{font-size:11.5px;color:#404040;margin:10px 0 4px}
.info-link{
  font:11px/1.5 "Courier New",Consolas,monospace;word-break:break-all;
  background:var(--win);box-shadow:var(--sink);padding:6px 7px;
  max-height:58px;overflow:auto;
}
.info-btns{display:flex;gap:5px;margin-top:6px}
.info-btns button{flex:1}
.info-code{
  display:block;font:11px/1.6 "Courier New",Consolas,monospace;
  background:var(--face);box-shadow:var(--sink);padding:5px 7px;margin-top:2px;
  word-break:break-all;
}
.dlg-foot{margin-top:12px}
.sb-panel.clickable{cursor:pointer}
.sb-panel.clickable:hover{background:#d4d4d4}

/* ── 操作面板 ── */
.sheet-dlg{width:min(420px,100%);margin-bottom:0}
.sheet-body{display:flex;flex-direction:column;gap:5px;padding:8px}
.sheet-item{width:100%;text-align:left;font-size:13px;padding:10px 12px;min-height:40px}
.sheet-item:active{padding:11px 11px 9px 13px}
.sheet-cancel{margin-top:3px;text-align:center}

/* ── 提示条 ── */
.toast{
  position:fixed;left:50%;bottom:calc(20px + var(--safe-b));transform:translateX(-50%);
  background:var(--face);color:var(--text);
  padding:8px 16px;font-size:12px;z-index:120;
  box-shadow:var(--raise);max-width:90vw;text-align:center;
}

@media (max-width:560px){
  .desk{padding:calc(7px + var(--safe-t)) calc(7px + var(--safe-r)) calc(7px + var(--safe-b)) calc(7px + var(--safe-l))}
  .win-body{padding:8px 7px 7px}
  .list{max-height:46vh}
  .sb-mid{display:none}
  .viewer .viewer-dlg{height:min(94dvh,100%)}
  .dialog{max-height:100%}
  .toolbar button,.btnrow button{font-size:11.5px;padding:6px 4px}
  .row-more{width:28px;height:28px}
  .ico{width:30px;height:27px;font-size:9px}
}
@media (hover:none){
  .row:hover{background:transparent;color:var(--text)}
  .row:hover .fsub{color:#505050}
  .row:hover .ico{color:var(--title)}
  .row:hover .row-more{color:var(--text)}
}
`;

const APP_JS = `
(function () {
  'use strict';

  // 注意：不能直接用整段 pathname —— 分享链接形如 /s/<口令>/f/<id>，
  // 用整段会把 API 前缀算错（/api/list 直接 404，列表加载不出来）。
  var BASE = (function () {
    var m = /^(\\/s\\/[^/]+)/.exec(location.pathname);
    return m ? m[1] : location.pathname.replace(/\\/+$/, '');
  })();
  var CHUNK_FALLBACK = 8 * 1024 * 1024;
  var CONCURRENCY = 3;

  var $ = function (id) { return document.getElementById(id); };
  var dropEl = $('drop'), fileInput = $('file'), mediaInput = $('media');
  var listEl = $('list'), emptyEl = $('empty'), queueEl = $('queue');
  var toastEl = $('toast'), filesCount = $('filesCount'), tbMode = $('tbMode');
  var sbMode = $('sbMode'), sbLimit = $('sbLimit'), sbQuota = $('sbQuota');

  var viewer = $('viewer'), viewerBody = $('viewerBody'), viewerName = $('viewerName'), viewerDl = $('viewerDl');
  var qrModal = $('qrModal'), qrCanvas = $('qrCanvas'), qrUrl = $('qrUrl'), qrTitle = $('qrTitle');
  var sheet = $('sheet'), sheetName = $('sheetName');

  var items = [];
  var pending = 0;
  var lastSig = '';
  var sheetItem = null;
  var viewList = [];
  var viewIndex = -1;
  var openedFromPath = false;
  var lastMeta = { maxMb: '-', ttlHours: 0, maxTotalMb: 0, usedBytes: 0 };
  var perm = { role: 'admin', canList: true, canUpload: true, canDelete: true };

  // ── 工具 ───────────────────────────────────────────────
  function b64url(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtTime(ts) {
    var d = new Date(ts * 1000), p = function (x) { return x < 10 ? '0' + x : '' + x; };
    var now = new Date();
    var y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-';
    return y + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtLeft(exp) {
    if (!exp) return '永久保留';
    var s = exp - Math.floor(Date.now() / 1000);
    if (s <= 0) return '已过期';
    if (s < 3600) return Math.ceil(s / 60) + ' 分钟后过期';
    if (s < 86400) return Math.ceil(s / 3600) + ' 小时后过期';
    return Math.ceil(s / 86400) + ' 天后过期';
  }
  function ext(name) {
    var i = String(name || '').lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }
  // 用文字类型标代替彩色 emoji —— 更贴合线条化风格
  function typeBadge(name, kind) {
    if (kind === 'text') return 'TXT';
    var e = ext(name);
    if (!e) return 'BIN';
    if (/^(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/.test(e)) return 'IMG';
    if (/^(mp4|mov|mkv|avi|webm|m4v|wmv)$/.test(e)) return 'VID';
    if (/^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(e)) return 'SND';
    if (e === 'pdf') return 'PDF';
    if (/^(docx?|rtf|odt)$/.test(e)) return 'DOC';
    if (/^(xlsx?|ods)$/.test(e)) return 'XLS';
    if (/^(pptx?|odp)$/.test(e)) return 'PPT';
    if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(e)) return 'ZIP';
    if (/^(exe|msi|apk|dmg|deb|rpm)$/.test(e)) return 'EXE';
    if (/^(csv|tsv)$/.test(e)) return 'CSV';
    if (e.length <= 4) return e.toUpperCase();
    // 扩展名过长（如 env.example / backup.20251004）时截断毫无意义，
    // 改用文件名本身的前三个字母，例如 env.example -> ENV
    var base = String(name || '').replace(/^.*[\\/]/, '').replace(/^[.\\s]+/, '');
    var head = base.replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
    return (head || 'BIN').toUpperCase();
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }
  function copy(text, label) {
    var done = function () { toast((label || '已复制') + ' 到剪贴板'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }
  function absUrl(rel) { return location.origin + BASE + rel; }
  function fileUrl(it) { return absUrl('/d/' + it.id); }
  function viewUrl(it) { return absUrl('/v/' + it.id); }
  // 分享用的「文件页」：打开先预览，页面内有下载按钮。
  // 对图片/PDF 这类文件，直接把 /d/ 直链发出去会强制下载，体验很差。
  function filePageUrl(it) { return absUrl('/f/' + it.id); }

  // ── 预览类型判定（与服务端的 inline 降级保持一致）─────
  function previewKind(it) {
    if (it.kind === 'text') return 'text';
    var t = String(it.type || '').toLowerCase();
    var e = ext(it.name);
    if (t.indexOf('image/') === 0) return e === 'svg' ? 'text' : 'image';
    if (t.indexOf('video/') === 0) return 'video';
    if (t.indexOf('audio/') === 0) return 'audio';
    if (t.indexOf('application/pdf') === 0) return 'pdf';
    if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(e)) return 'image';
    if (/^(mp4|webm|mov|m4v|ogv)$/.test(e)) return 'video';
    if (/^(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (/^(txt|md|markdown|json|js|mjs|ts|jsx|tsx|css|scss|html|htm|xml|yml|yaml|log|csv|tsv|ini|conf|cfg|env|sh|bash|bat|ps1|py|java|c|h|cpp|cs|go|rs|rb|php|sql|svg|toml)$/.test(e)) return 'text';
    return 'none';
  }

  // ── 列表 ───────────────────────────────────────────────
  function load() {
    return fetch(BASE + '/api/list', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        items = d.items || [];
        lastMeta = d;
        if (d.role) perm = d;
        applyPerms();
        tbMode.textContent = perm.role === 'guest' ? '分享模式' : '管理模式';
        sbMode.textContent = perm.role === 'guest' ? '分享模式 · 不可删除' : '管理模式';
        sbLimit.textContent = '单文件 ' + d.maxMb + ' MB · ' +
          (d.ttlHours > 0 ? '保留 ' + d.ttlHours + ' 小时' : '永久保留');
        sbQuota.textContent = d.maxTotalMb
          ? '已用 ' + fmtSize(d.usedBytes || 0) + ' / ' + d.maxTotalMb + ' MB'
          : '已用 ' + fmtSize(d.usedBytes || 0);
        filesCount.textContent = items.length ? '(' + items.length + ')' : '';
        var sig = JSON.stringify(items);
        if (sig !== lastSig) { lastSig = sig; render(); }
        maybeOpenInitialFile();
      })
      .catch(function () { sbMode.textContent = '连接中断，重试中…'; });
  }

  // 从 /f/<id> 分享链接进来时，自动打开该文件的预览
  function maybeOpenInitialFile() {
    if (openedFromPath) return;
    var m = /\\/f\\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
    if (!m) return;
    var want = m[1];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === want) {
        openedFromPath = true;
        openViewer(items[i]);
        return;
      }
    }
  }

  // 按当前口令的权限裁剪界面（真正的拦截在服务端）
  function applyPerms() {
    var canList = perm.canList !== false;
    var canUpload = perm.canUpload !== false;
    var panel = $('filesPanel');
    var tb = $('textPane');
    if (panel) panel.hidden = !canList;
    if (tb) tb.hidden = true;
    document.querySelectorAll('.btnrow button, .drop').forEach(function (el) {
      el.hidden = !canUpload;
    });
    document.body.setAttribute('data-role', perm.role || 'guest');
  }

  function render() {
    listEl.textContent = '';
    emptyEl.hidden = items.length > 0;
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'row';

      var ico = document.createElement('div');
      ico.className = 'ico';
      ico.textContent = typeBadge(it.name, it.kind);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var nm = document.createElement('div');
      nm.className = 'fname';
      nm.textContent = it.name;
      nm.title = it.name;
      var sub = document.createElement('div');
      sub.className = 'fsub';
      [fmtSize(it.size), fmtTime(it.time), fmtLeft(it.expires)].forEach(function (s) {
        var sp = document.createElement('span');
        sp.textContent = s;
        sub.appendChild(sp);
      });
      meta.appendChild(nm); meta.appendChild(sub);

      var more = document.createElement('button');
      more.className = 'row-more';
      more.type = 'button';
      more.textContent = '⋯';
      more.setAttribute('aria-label', '更多操作');
      more.addEventListener('click', function (e) { e.stopPropagation(); openSheet(it); });

      li.appendChild(ico); li.appendChild(meta); li.appendChild(more);

      // 点整行一律进预览；不支持预览的类型在预览里给下载入口，
      // 这样「点一下」的行为始终一致，不会有时弹预览、有时弹操作面板
      li.classList.add('tappable');
      li.addEventListener('click', function () { openViewer(it); });
      listEl.appendChild(li);
    });
  }

  // ── 操作面板 ───────────────────────────────────────────
  function openSheet(it) {
    sheetItem = it;
    sheetName.textContent = it.name;
    sheet.querySelector('[data-act="preview"]').hidden = previewKind(it) === 'none';
    sheet.querySelector('[data-act="delete"]').hidden = perm.canDelete !== true;
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; sheetItem = null; }

  sheet.addEventListener('click', function (e) {
    if (e.target === sheet) return closeSheet();
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn || !sheetItem) return;
    var it = sheetItem;
    var act = btn.getAttribute('data-act');
    if (act === 'cancel') return closeSheet();
    closeSheet();
    if (act === 'preview') openViewer(it);
    else if (act === 'download') location.href = fileUrl(it);
    else if (act === 'copylink') copy(filePageUrl(it), '分享链接');
    else if (act === 'copydirect') copy(fileUrl(it), '直链');
    else if (act === 'qr') openQR(filePageUrl(it), it.name + ' · 打开先看，可下载');
    else if (act === 'delete') remove(it);
  });
  $('sheetClose').addEventListener('click', closeSheet);

  // ── 预览 ───────────────────────────────────────────────
  function openViewer(it) {
    // 全部文件都进预览（不支持的会显示下载入口），保证左右切换连续
    viewList = items.slice();
    viewIndex = viewList.findIndex(function (x) { return x.id === it.id; });
    if (viewIndex < 0) { viewList = [it]; viewIndex = 0; }
    paintViewer();
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeViewer() {
    viewer.hidden = true;
    viewerBody.textContent = '';
    document.body.style.overflow = '';
    // 若是从分享链接 /f/<id> 进来的，关掉后把地址还原成文件列表页
    if (openedFromPath) {
      openedFromPath = false;
      try { history.replaceState(null, '', BASE + '/'); } catch (e) { /* 忽略 */ }
    }
  }
  function stepViewer(delta) {
    if (viewList.length < 2) return;
    viewIndex = (viewIndex + delta + viewList.length) % viewList.length;
    paintViewer();
  }
  function paintViewer() {
    var it = viewList[viewIndex];
    if (!it) return;
    var kind = previewKind(it);
    viewerName.textContent = it.name;
    viewerDl.setAttribute('href', fileUrl(it));
    viewerDl.setAttribute('download', it.name);
    viewerBody.textContent = '';

    var multi = viewList.length > 1;
    $('viewerPrev').hidden = !multi;
    $('viewerNext').hidden = !multi;

    if (kind === 'image') {
      var img = document.createElement('img');
      img.src = viewUrl(it); img.alt = it.name;
      viewerBody.appendChild(img);
    } else if (kind === 'video') {
      var v = document.createElement('video');
      v.src = viewUrl(it); v.controls = true; v.autoplay = true;
      v.playsInline = true; v.setAttribute('playsinline', '');
      viewerBody.appendChild(v);
    } else if (kind === 'audio') {
      var wrap = document.createElement('div');
      wrap.className = 'audio-wrap';
      var big = document.createElement('div');
      big.className = 'big'; big.textContent = 'AUDIO';
      var label = document.createElement('div');
      label.textContent = it.name;
      var a = document.createElement('audio');
      a.src = viewUrl(it); a.controls = true; a.autoplay = true;
      wrap.appendChild(big); wrap.appendChild(label); wrap.appendChild(a);
      viewerBody.appendChild(wrap);
    } else if (kind === 'pdf') {
      var fr = document.createElement('iframe');
      fr.src = viewUrl(it); fr.title = it.name;
      viewerBody.appendChild(fr);
    } else if (kind === 'text') {
      var pre = document.createElement('pre');
      pre.textContent = '加载中…';
      viewerBody.appendChild(pre);
      var wantId = it.id;
      // 大文本不要整份拉进 DOM：超过 1MB 只取前 1MB（走 Range），并明确提示已截断
      var LIMIT = 1024 * 1024;
      var truncated = it.size > LIMIT;
      fetch(viewUrl(it), {
        cache: 'no-store',
        headers: truncated ? { Range: 'bytes=0-' + (LIMIT - 1) } : {},
      })
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          if (viewIndex >= 0 && viewList[viewIndex] && viewList[viewIndex].id === wantId) {
            pre.textContent = txt + (truncated
              ? '\\n\\n────────\\n（文件较大，仅预览前 1 MB，完整内容请点上方「下载」）'
              : '');
          }
        })
        .catch(function () { pre.textContent = '读取失败'; });
    } else {
      var tip = document.createElement('div');
      tip.className = 'viewer-tip';
      var t1 = document.createElement('div');
      t1.textContent = '这个类型暂不支持在线预览';
      var t2 = document.createElement('a');
      t2.className = 'btn-like';
      t2.setAttribute('href', fileUrl(it));
      t2.setAttribute('download', it.name);
      t2.textContent = '下载文件';
      tip.appendChild(t1); tip.appendChild(t2);
      viewerBody.appendChild(tip);
    }
  }

  $('viewerClose').addEventListener('click', closeViewer);
  $('viewerPrev').addEventListener('click', function () { stepViewer(-1); });
  $('viewerNext').addEventListener('click', function () { stepViewer(1); });
  viewer.addEventListener('click', function (e) {
    if (e.target === viewer) closeViewer();
  });

  // ── 二维码 ─────────────────────────────────────────────
  function openQR(text, title) {
    qrTitle.textContent = title || '扫码打开';
    qrUrl.textContent = text;
    drawQR(text);
    qrModal.hidden = false;
  }
  function drawQR(text) {
    var cv = qrCanvas;
    var size = cv.width;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
      try {
        if (window.QRCode.toCanvas(cv, text, 'M') !== false) return;
      } catch (e) { /* 落到下面的失败提示 */ }
    }
    ctx.fillStyle = '#000000';
    ctx.font = '700 22px Tahoma,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('二维码生成失败', size / 2, size / 2);
  }
  $('qrClose').addEventListener('click', function () { qrModal.hidden = true; });
  qrModal.addEventListener('click', function (e) { if (e.target === qrModal) qrModal.hidden = true; });
  $('qrCopy').addEventListener('click', function () { copy(qrUrl.textContent, '链接'); });

  function sharePageUrl() {
    if (!perm.shareToken) return location.href;
    var parts = BASE.split('/');
    parts[parts.length - 1] = perm.shareToken;
    return location.origin + parts.join('/') + '/';
  }
  // 管理员点二维码时给的是「分享链接」——避免把管理链接扫出去，那等于把删除权一起给了
  $('qrPage').addEventListener('click', function () {
    if (perm.role === 'admin' && perm.shareToken) {
      openQR(sharePageUrl(), '分享链接 · 可上传下载，不能删除');
    } else if (perm.role === 'admin') {
      openQR(location.href, '本页链接 · 含删除权限，谨慎分享');
    } else {
      openQR(location.href, '分享链接 · 扫码打开');
    }
  });

  // ── 链接与权限（点标题栏右侧的身份标签）─────────────────
  function openInfo() {
    var guest = perm.role === 'guest';
    $('infoRole').textContent = guest ? '分享模式（访客）' : '管理模式（管理员）';
    $('infoNote').textContent = guest
      ? '你打开的是分享链接：可以浏览、预览、上传，但删不掉任何文件——这是服务端强制的，不是前端把按钮藏起来了。'
      : '你打开的是管理链接：拥有全部权限，包括删除。只给自己用，不要发出去。要给别人就发下面那条分享链接。';

    var pl = $('infoPerms');
    pl.textContent = '';
    [
      ['浏览文件列表', perm.canList !== false],
      ['下载与在线预览', perm.canList !== false],
      ['上传文件', perm.canUpload !== false],
      ['删除文件', perm.canDelete === true],
    ].forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('span');
      a.textContent = r[0];
      var b = document.createElement('b');
      b.className = r[1] ? 'perm-yes' : 'perm-no';
      b.textContent = r[1] ? '允许' : '禁止';
      li.appendChild(a); li.appendChild(b);
      pl.appendChild(li);
    });

    $('infoMax').textContent = (lastMeta.maxMb || '-') + ' MB';
    $('infoTtl').textContent = lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久';
    $('infoQuota').textContent = lastMeta.maxTotalMb
      ? fmtSize(lastMeta.usedBytes || 0) + ' / ' + lastMeta.maxTotalMb + ' MB'
      : fmtSize(lastMeta.usedBytes || 0);

    if (perm.role === 'admin' && perm.shareToken) {
      $('infoShareWrap').hidden = false;
      $('infoShareLink').textContent = sharePageUrl();
    } else {
      $('infoShareWrap').hidden = true;
    }
    $('infoSelfLink').textContent = location.href;
    // Agent 自举地址：一次请求自描述所有端点，是给 AI 用的唯一入口
    $('infoAgentLink').textContent = absUrl('/api/meta');
    $('infoModal').hidden = false;
  }
  function closeInfo() { $('infoModal').hidden = true; }

  $('tbMode').addEventListener('click', openInfo);
  $('sbMode').classList.add('clickable');
  $('sbMode').title = '查看当前链接的身份与权限';
  $('sbMode').addEventListener('click', openInfo);
  $('infoClose').addEventListener('click', closeInfo);
  $('infoOk').addEventListener('click', closeInfo);
  $('infoModal').addEventListener('click', function (e) {
    if (e.target === $('infoModal')) closeInfo();
  });
  $('infoCopySelf').addEventListener('click', function () { copy(location.href, '当前链接'); });
  $('infoCopyAgent').addEventListener('click', function () { copy($('infoAgentLink').textContent, 'Agent 自举地址'); });
  $('infoCopyShare').addEventListener('click', function () { copy($('infoShareLink').textContent, '分享链接'); });
  $('infoQrShare').addEventListener('click', function () {
    closeInfo();
    openQR($('infoShareLink').textContent, '分享链接 · 可上传下载，不能删除');
  });

  // ── 删除 ───────────────────────────────────────────────
  function remove(it) {
    if (!confirm('确定删除「' + it.name + '」？删除后无法恢复。')) return;
    fetch(BASE + '/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: it.id }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || '删除失败');
        return j;
      });
    }).then(function () { toast('已删除'); lastSig = ''; load(); })
      .catch(function (e) { toast(e.message || '删除失败'); });
  }

  // ── 上传 ───────────────────────────────────────────────
  function sendChunk(id, i, blob, onProg) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + '/api/chunk?u=' + encodeURIComponent(id) + '&i=' + i);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProg(e.loaded); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('分片 ' + (i + 1) + ' 失败 (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('网络错误，请检查连接')); };
      xhr.onabort = function () { reject(new Error('已取消')); };
      xhr.send(blob);
    });
  }

  function uploadFile(file, ui) {
    var chunk = CHUNK_FALLBACK;
    return fetch(BASE + '/api/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('初始化失败 HTTP ' + r.status));
        return j;
      });
    }).then(function (info) {
      if (info.chunkSize) chunk = info.chunkSize;
      var total = file.size, sent = 0;
      function step(i) {
        if (sent >= total) return Promise.resolve();
        var start = i * chunk;
        var end = Math.min(start + chunk, total);
        return sendChunk(info.uploadId, i, file.slice(start, end), function (loaded) {
          ui.progress((sent + loaded) / (total || 1));
        }).then(function () {
          sent = end;
          ui.progress(total ? sent / total : 1);
          return step(i + 1);
        });
      }
      return step(0).then(function () {
        return fetch(BASE + '/api/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: info.uploadId }),
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error(j.error || ('完成失败 HTTP ' + r.status));
            return j;
          });
        });
      });
    });
  }

  function makeQueueItem(name) {
    var el = document.createElement('div');
    el.className = 'qitem';
    var top = document.createElement('div');
    top.className = 'qtop';
    var nm = document.createElement('div'); nm.className = 'qname'; nm.textContent = name; nm.title = name;
    var pct = document.createElement('div'); pct.className = 'qpct'; pct.textContent = '0%';
    top.appendChild(nm); top.appendChild(pct);
    var bar = document.createElement('div'); bar.className = 'bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);
    el.appendChild(top); el.appendChild(bar);
    queueEl.appendChild(el);
    return {
      progress: function (v) {
        var p = Math.max(0, Math.min(1, v));
        fill.style.width = (p * 100).toFixed(1) + '%';
        pct.textContent = Math.round(p * 100) + '%';
      },
      done: function () {
        pct.textContent = '完成';
        setTimeout(function () { el.remove(); }, 1400);
      },
      fail: function (msg) {
        el.classList.add('err');
        pct.textContent = '失败';
        var m = document.createElement('div'); m.className = 'qmsg'; m.textContent = msg;
        el.appendChild(m);
        setTimeout(function () { el.remove(); }, 7000);
      },
    };
  }

  function enqueue(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return f && typeof f.size === 'number'; });
    if (!list.length) return;
    if (perm.canUpload === false) { toast('当前链接没有上传权限'); return; }
    var i = 0;
    function worker() {
      if (i >= list.length) return Promise.resolve();
      var file = list[i++];
      var ui = makeQueueItem(file.name);
      return uploadFile(file, ui)
        .then(function () { ui.done(); pending--; lastSig = ''; load(); })
        .catch(function (e) { ui.fail(e.message || '上传失败'); pending--; })
        .then(worker);
    }
    var runners = [];
    for (var k = 0; k < Math.min(CONCURRENCY, list.length); k++) { pending++; runners.push(worker()); }
    Promise.all(runners).then(function () { lastSig = ''; load(); });
  }

  // ── 交互绑定 ───────────────────────────────────────────
  dropEl.addEventListener('click', function () { fileInput.click(); });
  dropEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  $('pickFile').addEventListener('click', function () { fileInput.click(); });
  $('pickMedia').addEventListener('click', function () { mediaInput.click(); });
  fileInput.addEventListener('change', function () { enqueue(fileInput.files); fileInput.value = ''; });
  mediaInput.addEventListener('change', function () { enqueue(mediaInput.files); mediaInput.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add('over'); });
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
  });
  window.addEventListener('paste', function (e) {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) enqueue(files);
  });

  $('refresh').addEventListener('click', function () { lastSig = ''; load(); });
  $('copyPage').addEventListener('click', function () { copy(location.href, '本页链接'); });

  $('textToggle').addEventListener('click', function () {
    var pane = $('textPane');
    pane.hidden = !pane.hidden;
    if (!pane.hidden) $('textInput').focus();
  });

  $('textSend').addEventListener('click', function () {
    var ta = $('textInput');
    var text = ta.value;
    if (!text.trim()) { toast('内容为空'); return; }
    fetch(BASE + '/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
      .then(function () { ta.value = ''; $('textPane').hidden = true; toast('已生成文字链接'); lastSig = ''; load(); })
      .catch(function (e) { toast(e.message || '失败'); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!viewer.hidden) return closeViewer();
      if (!$('infoModal').hidden) return closeInfo();
      if (!qrModal.hidden) return void (qrModal.hidden = true);
      if (!sheet.hidden) return closeSheet();
    }
    if (!viewer.hidden && viewList.length > 1) {
      if (e.key === 'ArrowLeft') stepViewer(-1);
      if (e.key === 'ArrowRight') stepViewer(1);
    }
  });

  load();
  setInterval(function () {
    if (!pending && viewer.hidden && sheet.hidden && qrModal.hidden && $('infoModal').hidden) load();
  }, 5000);
})();
`;

// 由 build 脚本注入 qr.js 的完整源码（已用真实解码器 jsQR 验证：11/11 通过）
const QR_JS = `/*!
 * qr.js - Pure JavaScript QR Code encoder (UMD, zero runtime dependencies)
 *
 * Usage:
 *   var qr = QRCode.encode(text, 'M');   // -> { size: N, modules: Uint8Array }
 *   QRCode.toCanvas(canvasEl, text, 'M');// browser only, optional
 *
 * Implements ISO/IEC 18004: byte mode, versions 1..40, EC levels L/M/Q/H,
 * Reed-Solomon over GF(256), block interleaving, finder/separator/timing/
 * alignment patterns, dark module, BCH format & version information, and
 * all 8 data masks with standard penalty-based selection.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.QRCode = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : null), function () {
  'use strict';

  /* =====================================================================
   * Version data
   *   EC codewords per block, and number of blocks, indexed
   *   [version - 1][0..3] where 0 = L, 1 = M, 2 = Q, 3 = H.
   * ===================================================================== */
  var EC_CODEWORDS_PER_BLOCK = [
    [7, 10, 13, 17], [10, 16, 22, 28], [15, 26, 18, 22], [20, 18, 26, 16],
    [26, 24, 18, 22], [18, 16, 24, 28], [20, 18, 18, 26], [24, 22, 22, 26],
    [30, 22, 20, 24], [18, 26, 24, 28], [20, 30, 28, 24], [24, 22, 26, 28],
    [26, 22, 24, 22], [30, 24, 20, 24], [22, 24, 30, 24], [24, 28, 24, 30],
    [28, 28, 28, 28], [30, 26, 28, 28], [28, 26, 26, 26], [28, 26, 30, 28],
    [28, 26, 28, 30], [28, 28, 30, 24], [30, 28, 30, 30], [30, 28, 30, 30],
    [26, 28, 30, 30], [28, 28, 28, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30]
  ];

  var NUM_ERROR_CORRECTION_BLOCKS = [
    [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 2, 2], [1, 2, 2, 4],
    [1, 2, 4, 4], [2, 4, 4, 4], [2, 4, 6, 5], [2, 4, 6, 6],
    [2, 5, 8, 8], [4, 5, 8, 8], [4, 5, 8, 11], [4, 8, 10, 11],
    [4, 9, 12, 16], [4, 9, 16, 16], [6, 10, 12, 18], [6, 10, 17, 16],
    [6, 11, 16, 19], [6, 13, 18, 21], [7, 14, 21, 25], [8, 16, 20, 25],
    [8, 17, 23, 25], [9, 17, 23, 34], [9, 18, 25, 30], [10, 20, 27, 32],
    [12, 21, 29, 35], [12, 23, 34, 37], [12, 25, 34, 40], [13, 26, 35, 42],
    [14, 28, 38, 45], [15, 29, 40, 48], [16, 31, 43, 51], [17, 33, 45, 54],
    [18, 35, 48, 57], [19, 37, 51, 60], [19, 38, 53, 63], [20, 40, 56, 66],
    [21, 43, 59, 70], [22, 45, 62, 74], [24, 47, 65, 77], [25, 49, 68, 81]
  ];

  /* Alignment pattern centre coordinates per version (ISO/IEC 18004 Annex E). */
  var ALIGNMENT_PATTERN_POSITIONS = [
    [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
  ];

  var EC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  /* Format information uses a different 2-bit ordering: M, L, H, Q. */
  var EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /* =====================================================================
   * GF(256), primitive polynomial 0x11D
   * ===================================================================== */
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function initGaloisField() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = x << 1;
      if (x & 0x100) { x = x ^ 0x11D; }
    }
    for (var j = 255; j < 512; j++) { GF_EXP[j] = GF_EXP[j - 255]; }
    GF_LOG[0] = 0;
  }());

  function gfMul(a, b) {
    if (a === 0 || b === 0) { return 0; }
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /* Reed-Solomon generator polynomial of the given degree, highest first. */
  function rsGeneratorPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1);
      for (var k = 0; k < next.length; k++) { next[k] = 0; }
      for (var i = 0; i < poly.length; i++) {
        next[i] = next[i] ^ poly[i];
        next[i + 1] = next[i + 1] ^ gfMul(poly[i], GF_EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  /* Reed-Solomon remainder of data (returns 'degree' check codewords). */
  function rsRemainder(data, degree) {
    var gen = rsGeneratorPoly(degree);
    var res = new Array(degree);
    for (var i = 0; i < degree; i++) { res[i] = 0; }
    for (var k = 0; k < data.length; k++) {
      var factor = (data[k] ^ res[0]) & 0xFF;
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < degree; j++) {
          res[j] = res[j] ^ gfMul(gen[j + 1], factor);
        }
      }
    }
    return res;
  }

  /* =====================================================================
   * UTF-8 encoder (no TextEncoder dependency)
   * ===================================================================== */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          i++;
        }
      }
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0x10000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        out.push(
          0xF0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3F),
          0x80 | ((c >> 6) & 0x3F),
          0x80 | (c & 0x3F)
        );
      }
    }
    return out;
  }

  /* =====================================================================
   * Bit buffer
   * ===================================================================== */
  function appendBits(buf, value, length) {
    for (var i = length - 1; i >= 0; i--) {
      buf.push((value >>> i) & 1);
    }
  }

  /* =====================================================================
   * Capacity helpers
   * ===================================================================== */
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) { result -= 36; }
    }
    return result;
  }

  function numDataCodewords(ver, ecIndex) {
    return Math.floor(numRawDataModules(ver) / 8)
      - EC_CODEWORDS_PER_BLOCK[ver - 1][ecIndex]
      * NUM_ERROR_CORRECTION_BLOCKS[ver - 1][ecIndex];
  }

  function characterCountBits(ver) {
    return ver < 10 ? 8 : 16;
  }

  /* =====================================================================
   * Codeword construction: segment + pad + RS + interleave
   * ===================================================================== */
  function buildCodewords(data, ver, ecIndex) {
    var bits = [];
    appendBits(bits, 4, 4);                 /* byte mode indicator 0100 */
    appendBits(bits, data.length, characterCountBits(ver));
    for (var i = 0; i < data.length; i++) {
      appendBits(bits, data[i], 8);
    }

    var dataCapacityBits = numDataCodewords(ver, ecIndex) * 8;
    var terminator = Math.min(4, dataCapacityBits - bits.length);
    if (terminator > 0) { appendBits(bits, 0, terminator); }
    appendBits(bits, 0, (8 - bits.length % 8) % 8);

    var padByte = 0xEC;
    while (bits.length < dataCapacityBits) {
      appendBits(bits, padByte, 8);
      padByte = padByte === 0xEC ? 0x11 : 0xEC;
    }

    var dataCodewords = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) { byteVal = (byteVal << 1) | bits[b + k]; }
      dataCodewords.push(byteVal);
    }

    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver - 1][ecIndex];
    var ecLen = EC_CODEWORDS_PER_BLOCK[ver - 1][ecIndex];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var totalBlocks = numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / totalBlocks);
    var numShortBlocks = totalBlocks - (rawCodewords % totalBlocks);

    var blocks = [];
    var offset = 0;
    for (var bi = 0; bi < totalBlocks; bi++) {
      var len = shortBlockLen - ecLen + (bi < numShortBlocks ? 0 : 1);
      var dat = dataCodewords.slice(offset, offset + len);
      offset += len;
      blocks.push({ data: dat, ec: rsRemainder(dat, ecLen) });
    }

    var result = [];
    var maxDataLen = shortBlockLen - ecLen + 1;
    for (var c = 0; c < maxDataLen; c++) {
      for (var t = 0; t < totalBlocks; t++) {
        var blk = blocks[t];
        if (c < blk.data.length) { result.push(blk.data[c]); }
      }
    }
    for (var c2 = 0; c2 < ecLen; c2++) {
      for (var t2 = 0; t2 < totalBlocks; t2++) {
        result.push(blocks[t2].ec[c2]);
      }
    }
    return result;
  }

  /* =====================================================================
   * Matrix construction
   * ===================================================================== */
  function createMatrix(ver) {
    var size = ver * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var i = 0; i < size * size; i++) {
      modules.push(0);
      isFunction.push(0);
    }
    return { size: size, modules: modules, isFunction: isFunction };
  }

  function setFunc(m, x, y, dark) {
    m.modules[y * m.size + x] = dark ? 1 : 0;
    m.isFunction[y * m.size + x] = 1;
  }

  function drawFunctionPatterns(m, ver, ecIndex) {
    var size = m.size;
    var i, j;

    /* Timing patterns */
    for (i = 0; i < size; i++) {
      setFunc(m, 6, i, i % 2 === 0);
      setFunc(m, i, 6, i % 2 === 0);
    }

    /* Finder patterns + separators (drawn by clearing a 9x9 region) */
    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var x = cx + dx;
          var y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) { continue; }
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunc(m, x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    /* Alignment patterns */
    var pos = ALIGNMENT_PATTERN_POSITIONS[ver - 1];
    var n = pos.length;
    if (n > 0) {
      for (i = 0; i < n; i++) {
        for (j = 0; j < n; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) {
            continue;
          }
          var ax = pos[j];
          var ay = pos[i];
          for (var dy2 = -2; dy2 <= 2; dy2++) {
            for (var dx2 = -2; dx2 <= 2; dx2++) {
              setFunc(m, ax + dx2, ay + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
            }
          }
        }
      }
    }

    /* Reserve format information areas (values written later). */
    for (i = 0; i <= 8; i++) {
      if (i !== 6) { setFunc(m, 8, i, false); }
      if (i !== 6) { setFunc(m, i, 8, false); }
    }
    for (i = 0; i < 8; i++) {
      setFunc(m, 8, size - 1 - i, false);
      setFunc(m, size - 1 - i, 8, false);
    }

    /* Dark module */
    setFunc(m, 8, size - 8, true);

    /* Version information (versions 7 and above) */
    if (ver >= 7) {
      var rem = ver;
      for (i = 0; i < 12; i++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      }
      var bitsV = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (bitsV >>> i) & 1;
        var a = size - 11 + i % 3;
        var b = Math.floor(i / 3);
        setFunc(m, a, b, bit);
        setFunc(m, b, a, bit);
      }
    }

    /* Dummy format information so that all reserved modules are marked. */
    drawFormatBits(m, EC_FORMAT_BITS[['L', 'M', 'Q', 'H'][ecIndex]], 0);
  }

  function drawFormatBits(m, ecBits, mask) {
    var data = (ecBits << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    var bits = ((data << 10) | rem) ^ 0x5412;
    var size = m.size;
    var k;

    /* Bit i is placed with i = 0 as the least significant bit of the
       15-bit sequence, matching the standard's numbering order. */

    /* Copy 1: vertical strip in the top-left, then down the bottom-left. */
    for (k = 0; k < 8; k++) {
      var vy = (k < 6) ? k : (k + 1);          /* skip the timing row 6 */
      setFunc(m, 8, vy, ((bits >>> k) & 1) !== 0);
    }
    for (k = 8; k < 15; k++) {
      setFunc(m, 8, size - 15 + k, ((bits >>> k) & 1) !== 0);
    }

    /* Copy 2: horizontal strip in the bottom-left, then the top-right. */
    for (k = 0; k < 8; k++) {
      setFunc(m, size - 1 - k, 8, ((bits >>> k) & 1) !== 0);
    }
    for (k = 8; k < 15; k++) {
      var hx = (k === 8) ? 7 : (14 - k);       /* skip the timing column 6 */
      setFunc(m, hx, 8, ((bits >>> k) & 1) !== 0);
    }

    /* Dark module, always dark. */
    setFunc(m, 8, size - 8, true);
  }

  function drawCodewords(m, codewords) {
    var size = m.size;
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var right = size - 1;
    while (right >= 1) {
      if (right === 6) { right = 5; }
      for (var vert = 0; vert < size; vert++) {
        for (var c = 0; c < 2; c++) {
          var x = right - c;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? (size - 1 - vert) : vert;
          var idx = y * size + x;
          if (!m.isFunction[idx] && bitIndex < totalBits) {
            m.modules[idx] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
        }
      }
      right -= 2;
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      default: return false;
    }
  }

  function applyMask(m, mask) {
    var size = m.size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var idx = y * size + x;
        if (m.isFunction[idx]) { continue; }
        if (maskBit(mask, x, y)) { m.modules[idx] = m.modules[idx] ^ 1; }
      }
    }
  }

  /* =====================================================================
   * Mask penalty scoring (ISO/IEC 18004 section 8.8.2)
   * ===================================================================== */
  function penaltyScore(modules, size) {
    var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;
    var result = 0;
    var x, y, i;

    /* N1: runs of same-colour modules in rows and columns */
    for (y = 0; y < size; y++) {
      var runColor = modules[y * size];
      var runLen = 1;
      for (x = 1; x < size; x++) {
        var c = modules[y * size + x];
        if (c === runColor) {
          runLen++;
          if (runLen === 5) { result += PENALTY_N1; }
          else if (runLen > 5) { result += 1; }
        } else {
          runColor = c;
          runLen = 1;
        }
      }
    }
    for (x = 0; x < size; x++) {
      var runColor2 = modules[x];
      var runLen2 = 1;
      for (y = 1; y < size; y++) {
        var c2 = modules[y * size + x];
        if (c2 === runColor2) {
          runLen2++;
          if (runLen2 === 5) { result += PENALTY_N1; }
          else if (runLen2 > 5) { result += 1; }
        } else {
          runColor2 = c2;
          runLen2 = 1;
        }
      }
    }

    /* N2: 2x2 blocks of same colour */
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var a = modules[y * size + x];
        if (a === modules[y * size + x + 1] &&
            a === modules[(y + 1) * size + x] &&
            a === modules[(y + 1) * size + x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    /* N3: finder-like 1:1:3:1:1 patterns flanked by 4 light modules on at
       least one side.  Scanned as a single 11-module window so that a pattern
       with light space on BOTH sides is still penalised exactly once.
       The two legal windows are 0000 1011101 and 1011101 0000. */
    var PATTERN_A = 0x05D;   /* 00001011101 */
    var PATTERN_B = 0x5D0;   /* 10111010000 */
    for (y = 0; y < size; y++) {
      var bits = 0;
      var x2;
      for (x2 = 0; x2 < size; x2++) {
        bits = ((bits << 1) | modules[y * size + x2]) & 0x7FF;
        if (x2 >= 10 && (bits === PATTERN_A || bits === PATTERN_B)) {
          result += PENALTY_N3;
        }
      }
    }
    for (x = 0; x < size; x++) {
      var vbits = 0;
      var y2;
      for (y2 = 0; y2 < size; y2++) {
        vbits = ((vbits << 1) | modules[y2 * size + x]) & 0x7FF;
        if (y2 >= 10 && (vbits === PATTERN_A || vbits === PATTERN_B)) {
          result += PENALTY_N3;
        }
      }
    }

    /* N4: deviation of the dark-module proportion from 50%, in 5% steps.
       Integer arithmetic avoids the floating-point ambiguity of the
       "nearest 5%" wording: k = |ceil(darkPercent / 5) - 10|. */
    var dark = 0;
    for (i = 0; i < modules.length; i++) { dark += modules[i]; }
    var total = size * size;
    var k = Math.abs(Math.ceil(dark * 100 / total / 5) - 10);
    result += k * PENALTY_N4;
    return result;
  }

  /* =====================================================================
   * Core encode
   * ===================================================================== */
  function buildMatrix(text, ecLevel) {
    var key = (ecLevel === undefined || ecLevel === null) ? 'M' : String(ecLevel).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(EC_LEVEL_INDEX, key)) {
      throw new Error('Invalid error correction level: ' + ecLevel + ' (expected L, M, Q or H)');
    }
    var ecIndex = EC_LEVEL_INDEX[key];
    var str = String(text);
    var data = utf8Bytes(str);

    var ver = 0;
    for (var v = 1; v <= 40; v++) {
      var capacityBits = numDataCodewords(v, ecIndex) * 8;
      var neededBits = 4 + characterCountBits(v) + data.length * 8;
      if (neededBits <= capacityBits) { ver = v; break; }
    }
    if (ver === 0) {
      throw new Error('Data too long: ' + data.length + ' UTF-8 bytes exceed the capacity of version 40 at level ' + key);
    }

    var codewords = buildCodewords(data, ver, ecIndex);

    var best = null;
    var bestPenalty = Infinity;
    var bestMask = -1;
    for (var mask = 0; mask < 8; mask++) {
      var m = createMatrix(ver);
      drawFunctionPatterns(m, ver, ecIndex);
      drawCodewords(m, codewords);
      drawFormatBits(m, EC_FORMAT_BITS[key], mask);
      applyMask(m, mask);
      var penalty = penaltyScore(m.modules, m.size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = m;
        bestMask = mask;
      }
    }

    return {
      size: best.size,
      modules: Uint8Array.from(best.modules),
      version: ver,
      ecLevel: key,
      mask: bestMask,
      penalty: bestPenalty
    };
  }

  /* =====================================================================
   * Public API
   * ===================================================================== */
  function encode(text, ecLevel) {
    var r = buildMatrix(text, ecLevel);
    return { size: r.size, modules: r.modules };
  }

  function encodeFull(text, ecLevel) {
    return buildMatrix(text, ecLevel);
  }

  function toCanvas(canvas, text, ecLevel, options) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('toCanvas requires a canvas element');
    }
    var opts = options || {};
    var quietZone = (opts.quietZone === undefined) ? 4 : opts.quietZone;
    var scale = opts.scale;
    var r = buildMatrix(text, ecLevel);
    var size = r.size;
    var totalModules = size + quietZone * 2;
    if (!scale || scale < 1) {
      scale = Math.max(1, Math.floor((opts.size || 256) / totalModules));
    }
    var pixelSize = totalModules * scale;

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    if (canvas.style) {
      canvas.style.width = pixelSize + 'px';
      canvas.style.height = pixelSize + 'px';
    }

    var ctx = canvas.getContext('2d');
    if (!ctx) { throw new Error('Unable to obtain a 2D canvas context'); }
    if ('imageSmoothingEnabled' in ctx) { ctx.imageSmoothingEnabled = false; }
    if ('webkitImageSmoothingEnabled' in ctx) { ctx.webkitImageSmoothingEnabled = false; }
    if ('mozImageSmoothingEnabled' in ctx) { ctx.mozImageSmoothingEnabled = false; }
    if ('msImageSmoothingEnabled' in ctx) { ctx.msImageSmoothingEnabled = false; }

    ctx.fillStyle = opts.lightColor || '#FFFFFF';
    ctx.fillRect(0, 0, pixelSize, pixelSize);

    ctx.fillStyle = opts.darkColor || '#000000';
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (r.modules[y * size + x]) {
          /* Integer-aligned rects keep every module perfectly crisp. */
          ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
        }
      }
    }
    return canvas;
  }

  return {
    encode: encode,
    encodeFull: encodeFull,
    toCanvas: toCanvas,
    utf8Bytes: utf8Bytes
  };
}));`;

const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" fill="#008080"/>' +
  '<rect x="3" y="4" width="26" height="24" fill="#c0c0c0"/>' +
  '<rect x="3" y="4" width="26" height="5" fill="#000080"/>' +
  '<rect x="4" y="5" width="24" height="3" fill="none"/>' +
  '<rect x="5" y="12" width="22" height="14" fill="#ffffff"/>' +
  '<rect x="5" y="12" width="22" height="14" fill="none" stroke="#808080" stroke-width="1"/>' +
  '<path d="M9 16h12M9 19h12M9 22h7" stroke="#000080" stroke-width="1.4"/>' +
  '<rect x="24" y="5" width="4" height="3" fill="#c0c0c0" stroke="#000" stroke-width="0.7"/>' +
  '</svg>';

// ───────────────────────── 启动 ─────────────────────────

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[error]', req.method, req.url, '-', err && err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('server error');
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function listenOn(host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, host);
  });
}

(async function main() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await loadIndex();
  await sweep();
  setInterval(() => { sweep().catch(() => {}); }, 60 * 1000);

  let bound = HOST;
  try {
    await listenOn(HOST);
  } catch (err) {
    if (HOST === '::') {
      console.warn('[listen] IPv6 双栈绑定失败 (' + err.code + ')，回退到仅 IPv4');
      bound = '0.0.0.0';
      await listenOn(bound);
    } else {
      throw err;
    }
  }

  const adminUrl = 'http://localhost:' + PORT + '/s/' + TOKEN + '/';
  const shareUrl = 'http://localhost:' + PORT + '/s/' + SHARE_TOKEN + '/';
  const guest = [];
  if (GUEST_LIST) guest.push('看列表', '下载');
  if (GUEST_UPLOAD) guest.push('上传');
  console.log('');
  console.log('  7喵快传 已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log('  管理链接 : ' + adminUrl);
  console.log('            口令 ' + TOKEN + (autoToken ? '  (本次随机生成)' : '') + '   ← 只有这个能删文件');
  if (splitTokens) {
    console.log('  分享链接 : ' + shareUrl);
    console.log('            口令 ' + SHARE_TOKEN + (autoShare ? '  (本次随机生成)' : '') +
      '   ← 发给别人，权限: ' + (guest.length ? guest.join(' / ') : '仅访问首页'));
  } else {
    console.log('  分享链接 : 与管理链接相同（SHARE_TOKEN=same，单口令模式）');
  }
  console.log('  ─────────────────────────────────────────────');
  console.log('  监听     : ' + bound + ':' + PORT + (bound === '::' ? '   (IPv4 + IPv6 双栈)' : '   (仅 IPv4)'));
  console.log('  数据目录 : ' + DATA_DIR);
  console.log('  保留时长 : ' + (TTL_HOURS > 0 ? TTL_HOURS + ' 小时' : '永久'));
  console.log('  单文件上限: ' + Math.round(MAX_BYTES / 1048576) + ' MB');
  console.log('  总容量上限: ' + (MAX_TOTAL_BYTES ? mbText(MAX_TOTAL_BYTES) : '不限') +
    (MAX_TOTAL_BYTES ? '（当前已用 ' + mbText(totalBytes()) + '）' : ''));
  if (RATE_INIT_PER_MIN) console.log('  上传限流  : 每 IP 每分钟 ' + RATE_INIT_PER_MIN + ' 次');
  console.log('  ─────────────────────────────────────────────');
  console.log('  © 2026 知行工作室 · https://w3b.pub');
  console.log('');
})();

process.on('SIGINT', () => { console.log('\n正在退出…'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
