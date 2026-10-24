#!/usr/bin/env node
'use strict';

/**
 * 7喵快传（npm 包名 7md）· 一个文件，一个桌面
 * 单文件零依赖自托管文件中转服务，带一套能装进手机的 Win98 桌面。
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
 *   MAX_MB            单文件大小上限（MB）    默认 2048
 *   MAX_TOTAL_MB      总容量上限（MB）        默认 5120；0 = 不限
 *   RATE_INIT_PER_MIN 每 IP 每分钟上传次数  默认 60；0 = 不限流
 *   DATA_DIR          数据目录              默认 ./data
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

// ───────────────────────────── 配置 ─────────────────────────────

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const PORT = Number(process.env.PORT || 8080);
// 前端外壳版本号：随服务启动时间变化，用于 Service Worker 的缓存名。
// 每次重启都换名 → 旧外壳缓存被 activate 清掉 → 用户不会「装完永远旧版」。
const SHELL_VERSION = (process.env.SHELL_VERSION || String(Date.now()));
// 默认 '::' 双栈：同时接受 IPv4 与 IPv6。绑 0.0.0.0 会让 localhost(::1) 连接被拒，
// 这会让部分隧道客户端（如 Serveo over SSH）报 502。
const HOST = process.env.HOST || '::';
const MAX_BYTES = Math.max(1, Number(process.env.MAX_MB || 2048)) * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const TTL_HOURS = Math.max(0, Number(process.env.TTL_HOURS ?? 24));
const CHUNK_SIZE = 8 * 1024 * 1024; // 客户端分片大小，低于 Cloudflare 免费版 100MB 请求上限
// sweep 可调参数：默认值就是线上行为，测试可用更短的值实测
// 「活跃中的长上传不被误杀」与「孤儿文件被回收」。
//   idle    上传会话多久无活动视为死会话（期间每收到一个分片都会刷新）
//   interval sweep 运行周期
//   orphan  files/ 里不在索引的文件的 mtime 保护期，超过才回收
const SWEEP_IDLE_MS = Math.max(1000, Number(process.env.SWEEP_IDLE_MS ?? 2 * 3600 * 1000));
const SWEEP_INTERVAL_MS = Math.max(1000, Number(process.env.SWEEP_INTERVAL_MS ?? 60 * 1000));
const SWEEP_ORPHAN_MS = Math.max(1000, Number(process.env.SWEEP_ORPHAN_MS ?? 6 * 3600 * 1000));

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

// 桌面「登录 Windows 98」的 Administrator 通行口令。
// 与 TOKEN 是两个独立的东西：TOKEN 是 /s/<口令>/ 的路径凭据，
// ADMIN_PASS 只是仿真桌面登录框的口令。校验一律走服务端，前端源码里不出现明文。
// 生产环境务必通过环境变量 ADMIN_PASS 覆盖默认值；未设置时沿用内置默认，
// 并在启动时打印告警，避免"裸口令裸奔"。
const ADMIN_PASS = String(process.env.ADMIN_PASS || '@8688991230');
const ADMIN_PASS_IS_DEFAULT = !process.env.ADMIN_PASS;

const mbText = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

// ───────────────────────────── 状态 ─────────────────────────────

/** @type {Array<{id:string,name:string,size:number,type:string,time:number,expires:number,downloads:number,kind:'file'|'text'}>} */
let index = [];
/** @type {Map<string,{name:string,size:number,type:string,tmp:string,received:number,nextIndex:number,createdAt:number,lastAt:number}>} */
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

// 下载计数防抖：serveBlob 每被下载一次就全量重写 index.json，
// 热门文件被频繁预览时这是纯浪费。计数先只落内存，3 秒内合并成一次落盘；
// sweep 与退出路径都会强制 flush，计数不会丢。
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; saveIndex(); }, 3000);
  if (flushTimer.unref) flushTimer.unref();
}
function flushIndexNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  return saveIndex();
}

// ───────────────────────────── 工具 ─────────────────────────────

function safeEqual(a, b) {
  // 先各自哈希成定长摘要再比较：直接比 Buffer 时长度不等会在到达 timingSafeEqual
  // 之前就返回，口令长度因此可被逐字节猜出来（典型的长度侧信道）。
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
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

// 并发写入字节账本：只统计"已进 tmp 但还没算进 index"的字节。
// 之前每个请求都在开头单独算一次配额余量，并发上传时大家看到的是同一份余量，
// 于是 N 个请求可以各自写满整块空间（典型的检查-使用时间差）。
// 现在把在途字节集中记账，判断时用「已落盘 + 所有在途」一起比总配额。
const inflightBytes = new Map();
function totalInflight() {
  let s = 0;
  for (const v of inflightBytes.values()) s += v;
  return s;
}
function otherInflight(selfKey) {
  let s = 0;
  for (const [k, v] of inflightBytes) if (k !== selfKey) s += v;
  return s;
}
function quotaRoomFor(selfKey) {
  if (!MAX_TOTAL_BYTES) return Infinity;
  return Math.max(0, MAX_TOTAL_BYTES - totalBytes() - otherInflight(selfKey));
}

// 登录口令限流：比 init 严格得多（每分钟 5 次）。
// 登录框必须防暴力猜解 —— 这是本项目唯一一处"靠人记的短口令"。
const LOGIN_PER_MIN = 5;
const loginHits = new Map();
function loginRateLimited(ip) {
  const t = Date.now();
  const arr = (loginHits.get(ip) || []).filter((x) => t - x < 60000);
  arr.push(t);
  loginHits.set(ip, arr);
  if (loginHits.size > 5000) loginHits.clear();
  return arr.length > LOGIN_PER_MIN;
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
  "worker-src 'self'; manifest-src 'self'; " +
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

function sendAsset(res, type, body, code = 200) {
  const buf = Buffer.from(body, 'utf8');
  const head = {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
    ...SEC_BASE,
  };
  if (type.indexOf('text/html') === 0) head['Content-Security-Policy'] = SEC_CSP;
  res.writeHead(code, head);
  res.end(buf);
}

/** 二进制资源（PNG 图标）：不能用 sendAsset（utf8 转换会损坏字节），且可长缓存 */
function sendBinary(res, type, buf, code = 200) {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...SEC_BASE,
  });
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
    // 在途字节统一从 shared ledger 读：它同时覆盖分片上传和并发 put，
    // 只看 uploads.size 会漏掉已经实收但还没写满声明大小的会话。
    if (used + totalInflight() + size > MAX_TOTAL_BYTES) {
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
    received: 0, nextIndex: 0, createdAt: Date.now(), lastAt: Date.now(),
  });
  // 会话一建立就占账本：从此刻起它写的每个字节都不会被别的请求重复分配，
  // 直到 finish 入索引（那时 totalBytes 自然接管）或 abort 释放。
  inflightBytes.set('chunk:' + id, 0);

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
  const key = 'put:' + id;
  inflightBytes.set(key, 0);
  let size = 0;
  let tooBig = false;
  let overQuota = false;
  req.on('data', (c) => {
    size += c.length;
    inflightBytes.set(key, size);
    if (size > MAX_BYTES) { tooBig = true; req.destroy(); }
    // 每块都重算余量：并发的上传会持续抬高在途字节，开头算一次是不够的
    else if (size > quotaRoomFor(key)) { overQuota = true; req.destroy(); }
  });

  try {
    await pipeline(req, fs.createWriteStream(tmp));
  } catch {
    inflightBytes.delete(key);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (tooBig) return sendJson(res, 413, { error: '文件超过上限 ' + Math.round(MAX_BYTES / 1048576) + ' MB' });
    if (overQuota) return sendJson(res, 507, { error: '服务器存储已满' });
    return sendJson(res, 400, { error: '上传中断' });
  }

  // 配额按「实收字节」复核，避免少报 size 绕过
  if (MAX_TOTAL_BYTES && size > quotaRoomFor(key)) {
    inflightBytes.delete(key);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return sendJson(res, 507, { error: '服务器存储已满' });
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

  try {
    // rename → 入索引 → 存盘，这段窗口里字节还在数据目录却不在索引里
    //（totalBytes 只读索引），所以账本条目要一直留到 saveIndex 之后才释放，
    // 否则并发请求会把同一份余量重复分发出去。
    await fsp.rename(tmp, blobPath(id));
    index.unshift(rec);
    await saveIndex();
  } catch (err) {
    inflightBytes.delete(key);
    await fsp.rm(tmp, { force: true }).catch(() => {});
    console.error('[put] 落盘失败:', err.message);
    return sendJson(res, 500, { error: '保存失败' });
  }
  inflightBytes.delete(key);

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

  const ckey = 'chunk:' + id;
  inflightBytes.set(ckey, up.received);
  // 总配额在 init 时只按「客户端声明的大小」检查，可以少报绕过：
  // 声明 1 字节再实灌几 MB，数据会落进 tmp 却不算配额。
  // 这里用共享在途账本（含并发 put 字节）再兜一道，把 tmp 占用压在配额内。
  if (MAX_TOTAL_BYTES && up.received + declared > quotaRoomFor(ckey)) {
    await abortUpload(id);
    return sendJson(res, 507, { error: '服务器存储已满' });
  }

  // 上面两道闸门都依赖 content-length；分片客户端用 chunked 时不带该头，
  // declared === 0 会让它们整个失效。真正的拦截放在写入过程中：
  // 每收到一块就实时重算「单文件上限」和「总配额」，任一越界立即断流。
  const totalRoom = quotaRoomFor(ckey) - up.received;

  let received = 0;
  let tooBig = false;
  let quotaFull = false;
  req.on('data', (c) => {
    received += c.length;
    inflightBytes.set(ckey, up.received + received);
    if (up.received + received > MAX_BYTES) {
      tooBig = true;
      req.destroy();
    } else if (received > totalRoom) {
      quotaFull = true;
      req.destroy();
    }
  });

  const ws = fs.createWriteStream(up.tmp, { flags: 'a' });
  try {
    await pipeline(req, ws);
  } catch {
    await abortUpload(id);
    if (quotaFull) return sendJson(res, 507, { error: '服务器存储已满' });
    return sendJson(res, tooBig ? 413 : 400, {
      error: tooBig ? '文件超过上限' : '上传中断',
    });
  }

  up.received += received;
  up.nextIndex += 1;
  // 刷新最后活跃时间：sweep 按它判断会话是否过期。
  // 只用 createdAt 会把「慢速传了 2 小时的大文件」误判成死会话 abort 掉。
  up.lastAt = Date.now();
  // 这里不能释放账本：本片已写进 tmp、还没进索引，若此刻释放，
  // 下一片到来之前这段时间这份字节对配额完全隐形。留到 finish / abort 再清。
  inflightBytes.set(ckey, up.received);
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
  const fkey = 'chunk:' + id;
  inflightBytes.set(fkey, up.received);
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
  // 到这里字节才真正被 totalBytes 看见，此刻释放账本才算安全
  inflightBytes.delete(fkey);

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
  // 临时文件删了，账本上的占用也要一并释放，否则配额会「虚占」到重启
  inflightBytes.delete('chunk:' + id);
  const target = up ? up.tmp : path.join(TMP_DIR, id + '.part');
  await fsp.rm(target, { force: true }).catch(() => {});
}

// ───────────────────────── 文字分享 ─────────────────────────

async function handleText(req, res, token) {
  let body;
  try {
    body = await readJson(req, MAX_TEXT_BYTES + 65536);
  } catch (err) {
    // 之前这里一律回 413：请求体本就超限和「JSON 写坏了」被混成同一种错，
    // 客户端拿着 413 去重试一个永远不可能成功的畸形请求。此处按原因分开。
    const tooLarge = err && err.message === 'body too large';
    return sendJson(res, tooLarge ? 413 : 400, {
      error: tooLarge ? '文本过大' : '请求格式错误',
    });
  }

  const text = String(body.text == null ? '' : body.text);
  const buf = Buffer.from(text, 'utf8');
  if (!text.trim()) return sendJson(res, 400, { error: '内容为空' });
  if (buf.length > MAX_TEXT_BYTES) {
    return sendJson(res, 413, { error: '文本超过 ' + Math.round(MAX_TEXT_BYTES / 1024) + ' KB' });
  }

  // 总配额：/api/put 有这道闸，文字分享漏了 —— 存储上限形同虚设。
  if (MAX_TOTAL_BYTES && totalBytes() + buf.length > MAX_TOTAL_BYTES) {
    return sendJson(res, 507, {
      error: '服务器存储已满（已用 ' + mbText(totalBytes()) + '，上限 ' + mbText(MAX_TOTAL_BYTES) + '）',
    });
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
  scheduleFlush();

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

  const cutoff = Date.now() - SWEEP_IDLE_MS;
  for (const [id, up] of uploads) {
    if (up.lastAt < cutoff) await abortUpload(id);
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

  // 孤儿 blob 回收：rename 成功但还没进索引就崩溃、或写索引失败时，
  // 文件会留在 files/ 里却不在 index 中 —— 上面的过期清理只看索引，
  // 永远碰不到它，磁盘就这样一点点漏掉。这里按「不在索引 + mtime 超 6h」
  // 双条件回收；6h 保护期远大于「rename → 入索引」的正常窗口（<1s），
  // 绝不会误删正在落盘的文件。
  try {
    const live = new Set(index.map((r) => r.id));
    const blobs = await fsp.readdir(FILES_DIR);
    const nowMs = Date.now();
    let orphans = 0;
    for (const n of blobs) {
      if (live.has(n)) continue;
      const st = await fsp.stat(path.join(FILES_DIR, n)).catch(() => null);
      if (st && nowMs - st.mtimeMs > SWEEP_ORPHAN_MS) {
        await fsp.rm(path.join(FILES_DIR, n), { force: true }).catch(() => {});
        orphans++;
      }
    }
    if (orphans) console.log('[sweep] 清理孤儿文件 ' + orphans + ' 个');
  } catch { /* files 目录可能不存在 */ }
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

/**
 * 桌面启动配置。前端不内嵌任何口令，靠这个接口拿"该往哪儿开文件服务"。
 * 用接口而不是模板串替换：模板串替换要让 HOME_PAGE 变成函数，
 * 每次请求重新拼 4KB 字符串，且容易在手改文本时静默写坏。
 */
function bootPayload() {
  return {
    guestUrl: '/s/' + SHARE_TOKEN + '/',
    // 访客口令本来就印在服务端启动日志里、是发给别人用的，回传不构成泄露。
    // adminUrl 不回传：管理口令必须靠登录拿到。
    splitTokens,
    guestUpload: GUEST_UPLOAD,
    guestList: GUEST_LIST,
    ttlHours: TTL_HOURS,
    maxMb: Math.round(MAX_BYTES / 1048576),
  };
}

/**
 * 桌面登录框：Guest 无需口令，Administrator 校验服务端 ADMIN_PASS。
 *
 * 限流只累计**失败**次数。若把成功也计入配额，管理员自己连续登录几次
 * 就会把自己锁在门外（实测复现：连点 6 次后第 7 次正确口令也返回 429）。
 * 反暴力猜解的目标是"错很多次就冷却"，而不是"总次数封顶"。
 */
async function handleAdminLogin(req, res) {
  const ip = clientIp(req);
  let body;
  try {
    body = await readJson(req, 4096);
  } catch {
    return sendJson(res, 400, { ok: false, error: '请求格式错误' });
  }
  const user = String(body.user || 'guest').toLowerCase();
  const passOk = (user === 'administrator' || user === 'admin') &&
    safeEqual(String(body.pass || ''), ADMIN_PASS);

  if (passOk) {
    loginHits.delete(ip);   // 成功即清零，不留历史包袱
    return sendJson(res, 200, { ok: true, user: 'Administrator', url: '/s/' + TOKEN + '/' });
  }

  // 失败才计数：超限后再来也一样是 429（不泄露"口令对不对"）
  if (loginRateLimited(ip)) {
    return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 1 分钟后再试' });
  }
  sendJson(res, 401, { ok: false, error: '用户名或口令不正确' });
}

/**
 * PWA manifest。start_url/scope/id 必须是绝对路径：
 * manifest 内的相对 URL 以 manifest 自身 URL 为基准（与页面 <base> 无关），
 * 用绝对路径消除浏览器解析歧义；不同口令 = 不同应用 id，缓存天然隔离。
 */
function manifestJson(token) {
  const safe = String(token).replace(/[^A-Za-z0-9._-]/g, '');
  const root = '/s/' + safe + '/';
  return JSON.stringify({
    name: '7喵快传',
    short_name: '7喵快传',
    description: '一个文件，一个桌面 —— 单文件、零依赖的自托管文件中转服务',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: root,
    scope: root,
    id: root,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    theme_color: '#008080',
    background_color: '#008080',
    icons: [
      { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: './favicon.ico', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    /* 长按图标 → 直达文件列表或上传（Android；iOS 忽略此字段） */
    shortcuts: [
      { name: '看文件列表', short_name: '列表', url: root, description: '打开文件列表' },
      { name: '上传到桌面', short_name: '桌面', url: '/', description: '打开 Win98 桌面' },
    ],
  });
}

// ───────────────── 根路径欢迎页（Win95 像素风贪吃蛇）─────────────────
// 设计动机：裸域名访问曾是干巴巴的 404，观感像"网站坏了"。
// 首页给出与 /s/ 页面同风格的极简小游戏；未知路径依旧 404，防扫描不变。
// CSP 约束：script-src/style-src 均为 'self'，故 CSS/JS 必须外链
// （/home.css、/home.js），页面内不得内联 <script>/<style>。
// 以下三个字符串内不得出现反引号与 ${（同 qr.js 的内联纪律）。

const HOME_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#008080">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex,nofollow">
<title>7喵快传 · 一个文件，一个桌面</title>
<meta name="description" content="一个文件，一个桌面 —— 单文件、零依赖的自托管文件中转服务，带一套能装进手机的 Win98 桌面。">
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/home.css?v=6">
</head>
<body>
  <div id="desk">
    <div class="dgroup">
      <div class="dicon" data-app="pc" tabindex="0">
        <span class="ico ico-pc"></span><span class="dlabel">我的电脑</span>
      </div>
      <div class="dicon" data-app="mines" tabindex="0">
        <span class="ico ico-mine"></span><span class="dlabel">扫雷</span>
      </div>
      <div class="dicon" data-app="game" tabindex="0">
        <span class="ico ico-snake"></span><span class="dlabel">贪吃蛇</span>
      </div>
      <div class="dicon" data-app="saver" tabindex="0">
        <span class="ico ico-saver"></span><span class="dlabel">屏幕保护</span>
      </div>
      <div class="dicon" data-app="install" tabindex="0">
        <span class="ico ico-install"></span><span class="dlabel">安装到桌面</span>
      </div>
      <div class="dicon" data-app="readme" tabindex="0">
        <span class="ico ico-note"></span><span class="dlabel">readme.txt</span>
      </div>
      <div class="dicon" data-app="ie" tabindex="0">
        <span class="ico ico-ie"></span><span class="dlabel">IE 浏览器</span>
      </div>
      <div class="dicon" data-app="net" tabindex="0">
        <span class="ico ico-net"></span><span class="dlabel">网上邻居</span>
      </div>
      <div class="dicon" data-app="qq" tabindex="0">
        <span class="ico ico-qq"></span><span class="dlabel">QQ</span>
      </div>
      <div class="dicon" data-app="dos" tabindex="0">
        <span class="ico ico-dos"></span><span class="dlabel">MS-DOS</span>
      </div>
      <div class="dicon" data-app="trash" tabindex="0">
        <span class="ico ico-trash"></span><span class="dlabel">回收站</span>
      </div>
    </div>

    <div class="win95 appwin" id="gameWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon"></span>
        <span class="tb-text">Snake.exe</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="client">
        <div class="sunken">
          <canvas id="game" width="320" height="320"></canvas>
        </div>
        <div class="overlay" id="overlay">
          <div class="dlg">
            <div class="dlg-b">
              <div class="dlg-big" id="dlgBig">SNAKE</div>
              <div class="dlg-txt" id="dlgTxt">方向键 / WASD / 滑动屏幕 控制<br>吃苹果变长，别撞墙、别咬自己</div>
              <button class="btn95" id="btn">开始</button>
            </div>
          </div>
        </div>
      </div>
      <div class="statusbar">
        <span>得分 <b id="score">0</b></span>
        <span>最高 <b id="best">0</b></span>
        <span class="grow" id="status">就绪</span>
      </div>
    </div>

    <div class="win95 appwin" id="readmeWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-note-ico"></span>
        <span class="tb-text">readme.txt - 记事本</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="menubar">
        <span class="mu" data-mu="file">文件(F)</span>
        <span class="mu" data-mu="help">帮助(H)</span>
      </div>
      <div class="notepad">
        <pre>7喵快传 (7M-Drop)
═══════════════════════════

一个自托管的文件中转站，
跑在一台 1995 年的"电脑"上。

  · 双击「我的电脑」打开文件服务
  · 双击「扫雷」玩一局（游戏菜单可调难度）
  · 双击「QQ」打开复古 QQ，还能穿越回 2008
  · 开始菜单 → 关闭系统 可切换用户

  Guest 用户：看列表、下载、上传
  Administrator：额外可删除文件
    （桌面登录口令见服务端启动日志）

快捷操作：
  · 桌面右键 → 属性  换壁纸/屏保
  · 闲置一会儿会自动进屏保
  · 收藏夹 → 知行工作室 · 主页

───────────────────────────
官网 https://w3b.pub
© 2026 知行工作室 · MIT
本桌面为致敬 Windows 98 的
装饰性页面。</pre>
      </div>
    </div>

    <!-- ── 我的电脑 / 文件管理器：把分享页嵌成窗口内容 ── -->
    <div class="win95 appwin" id="pcWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-pc-ico"></span>
        <span class="tb-text" id="pcLabel">我的电脑 - 7喵快传</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="menubar">
        <span class="mu" data-mu2="file">文件(F)</span>
        <span class="mu" data-mu2="view">查看(V)</span>
        <span class="mu" data-mu2="help">帮助(H)</span>
      </div>
      <div class="fm-frame">
        <div class="fm-loading" id="fmLoading">正在打开文件服务…</div>
        <iframe id="fmFrame" title="文件服务" referrerpolicy="no-referrer" allow="fullscreen"></iframe>
      </div>
      <div class="statusbar">
        <span class="grow" id="fmStatus">就绪</span>
        <span class="grow2" id="fmWho">Guest</span>
      </div>
    </div>

    <!-- ── IE 浏览器 ── -->
    <div class="win95 appwin" id="ieWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-ie-ico"></span>
        <span class="tb-text">Internet Explorer - 知行工作室</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="menubar">
        <span class="mu">文件(F)</span>
        <span class="mu">编辑(E)</span>
        <span class="mu">查看(V)</span>
        <span class="mu">收藏(A)</span>
        <span class="mu">帮助(H)</span>
      </div>
      <div class="ie-toolbar">
        <button class="ie-btn" id="ieBack">后退</button>
        <button class="ie-btn" id="ieFwd">前进</button>
        <button class="ie-btn" id="ieRefresh">刷新</button>
        <button class="ie-btn" id="ieHome">主页</button>
      </div>
      <div class="ie-addrbar">
        <span class="ie-addr-label">地址(D)</span>
        <input id="ieAddr" class="ie-addr" autocomplete="off" spellcheck="false" aria-label="地址">
      </div>
      <div class="fm-frame">
        <div class="fm-loading" id="ieLoading">正在连接 Internet…</div>
        <iframe id="ieFrame" title="Internet Explorer" referrerpolicy="no-referrer"></iframe>
      </div>
      <div class="statusbar">
        <span class="grow" id="ieStatus">知行工作室 · Zhixing Studio</span>
      </div>
    </div>

    <!-- ── 扫雷 ── -->
    <div class="win95 narrowwin" id="mineWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-mine-ico"></span>
        <span class="tb-text">扫雷</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="menubar">
        <span class="mu" data-mu3="game">游戏(G)</span>
        <span class="mu" data-mu3="help">帮助(H)</span>
      </div>
      <div class="mine-client">
        <div class="mine-face">
          <div class="mine-panel mine-panel-l">
            <span class="led" id="mineCount">010</span>
          </div>
          <button class="mine-smiley" id="mineSmiley" aria-label="重新开始"></button>
          <div class="mine-panel mine-panel-r">
            <span class="led" id="mineTime">000</span>
          </div>
        </div>
        <div class="mine-grid sunken" id="mineGrid"></div>
        <div class="mine-foot">
          <button class="btn95" id="mineMode" type="button">模式：挖开</button>
        </div>
      </div>
      <div class="statusbar"><span class="grow" id="mineStatus">点击格子开始</span></div>
    </div>

    <!-- ── MS-DOS 提示符（彩蛋）── -->
    <div class="win95 appwin" id="dosWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-dos-ico"></span>
        <span class="tb-text">MS-DOS 提示符 - 7喵快传</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="dos-body" id="dosBody">
        <div class="dos-out" id="dosOut">Microsoft(R) Windows 98
   (C)Copyright Microsoft Corp 1981-1998.

7喵快传 (7M-Drop) · 知行工作室
输入 help 查看可用命令。</div>
        <div class="dos-line"><span class="dos-prompt">C:\\&gt;</span><input id="dosIn" class="dos-in" type="text" name="dos-cmd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" aria-label="DOS 命令"></div>
      </div>
    </div>

    <div class="win95 msgwin" id="msgWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text" id="msgTitle">提示</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="msgbody">
        <span class="micon info" id="msgIcon"></span>
        <div class="mtext-wrap">
          <div class="mtxt" id="msgText">…</div>
          <div class="msub" id="msgSub" hidden></div>
        </div>
      </div>
      <div class="msgbtn">
        <button class="btn95" id="msgOk">确定</button>
        <button class="btn95 btn-gap" id="msgRetry" hidden>重试</button>
      </div>
    </div>

    <!-- ── 关机：Windows 98 的关闭对话框 ── -->
    <div class="win95 smalldlg shutdlg" id="shutWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">关闭 Windows</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="dlg-pad">
        <div class="shut-banner">
          <div class="shut-moon"></div>
          <span>你想要做什么？</span>
        </div>
        <div class="shut-opts" id="shutOpts">
          <label class="radio-row"><input type="radio" name="shutopt" value="sleep"><span>将计算机转入休眠状态<em>（进入屏幕保护程序）</em></span></label>
          <label class="radio-row"><input type="radio" name="shutopt" value="off" checked><span>关闭计算机<em>（退出当前用户，返回登录界面）</em></span></label>
          <label class="radio-row"><input type="radio" name="shutopt" value="dos"><span>重新启动计算机并切换到 MS-DOS 方式<em>（打开 DOS 提示符窗口）</em></span></label>
        </div>
        <div class="msgbtn">
          <button class="btn95" id="shutOk">确定</button>
          <button class="btn95 btn-gap" id="shutCancel">取消</button>
          <button class="btn95 btn-gap" id="shutHelp">帮助</button>
        </div>
      </div>
    </div>

    <!-- ── 登录 Windows 98 ── -->
    <div class="win95 logindlg" id="loginWin" hidden>
      <div class="titlebar">
        <span class="tb-text">欢迎使用 Windows 98</span>
      </div>
      <div class="login-body">
        <div class="login-logo">
          <div class="winflag"></div>
          <div class="login-brand">Windows<b>98</b></div>
          <div class="login-sub">7喵快传 · 知行工作室</div>
        </div>
        <div class="login-form">
          <div class="login-hint" id="loginHint">键入用户名和口令以登录。</div>
          <div class="login-row">
            <span class="login-k">用户名(<u>U</u>):</span>
            <select id="loginUser" class="login-input">
              <option value="Guest">Guest</option>
              <option value="Administrator">Administrator</option>
            </select>
          </div>
          <div class="login-row">
            <span class="login-k">口令(<u>P</u>):</span>
            <input id="loginPass" class="login-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="Guest 可留空">
          </div>
          <div class="login-fine">
            <label><input type="checkbox" id="loginRemember"> 记住我的口令</label>
          </div>
        </div>
      </div>
      <div class="msgbtn login-btns">
        <button class="btn95" id="loginOk">确定</button>
        <button class="btn95 btn-gap" id="loginCancel">取消</button>
        <button class="btn95 btn-gap" id="loginHelp">帮助</button>
      </div>
    </div>

    <div class="startmenu" id="startMenu" hidden>
      <div class="sm-side">Windows<b>98</b></div>
      <div class="sm-list">
        <div class="smi has-sub" data-sub="prog"><span class="smi-ico ico-prog"></span>程序<span class="sm-arrow">▸</span></div>
        <div class="smi has-sub" data-sub="docs"><span class="smi-ico ico-docs"></span>文档<span class="sm-arrow">▸</span></div>
        <div class="smi has-sub" data-sub="fav"><span class="smi-ico ico-fav"></span>收藏夹<span class="sm-arrow">▸</span></div>
        <div class="smi has-sub" data-sub="set"><span class="smi-ico ico-set"></span>设置<span class="sm-arrow">▸</span></div>
        <div class="smi has-sub" data-sub="find"><span class="smi-ico ico-find"></span>查找<span class="sm-arrow">▸</span></div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="help"><span class="smi-ico ico-help"></span>帮助</div>
        <div class="smi" data-app="run"><span class="smi-ico ico-run"></span>运行…</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="shutdown"><span class="smi-ico ico-shut"></span>关闭系统…</div>
      </div>

      <div class="smsub" id="smsub-prog" hidden>
        <div class="smi" data-app="pc"><span class="smi-ico ico-pc"></span>我的电脑</div>
        <div class="smi" data-app="mines"><span class="smi-ico ico-mine"></span>扫雷</div>
        <div class="smi" data-app="game"><span class="smi-ico ico-snake"></span>贪吃蛇</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="dos"><span class="smi-ico ico-dos"></span>MS-DOS 提示符</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="qq"><span class="smi-ico ico-qq"></span>QQ</div>
      </div>
      <div class="smsub" id="smsub-docs" hidden>
        <div class="smi" data-app="readme"><span class="smi-ico ico-note"></span>readme.txt</div>
        <div class="smi" data-app="net"><span class="smi-ico ico-net"></span>网上邻居</div>
      </div>
      <div class="smsub" id="smsub-fav" hidden>
        <div class="smi" data-app="fav-w3b"><span class="smi-ico ico-fav"></span>知行工作室 · 主页</div>
        <div class="smi" data-app="fav-github"><span class="smi-ico ico-fav"></span>开源仓库 · GitHub</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="ie"><span class="smi-ico ico-ie"></span>7喵快传 · 文件服务</div>
      </div>
      <div class="smsub" id="smsub-set" hidden>
        <div class="smi" data-app="props"><span class="smi-ico ico-set"></span>显示属性</div>
        <div class="smi" data-app="saver"><span class="smi-ico ico-saver"></span>屏幕保护</div>
        <div class="smi" data-app="sysinfo"><span class="smi-ico ico-sys"></span>系统属性</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="install"><span class="smi-ico ico-install"></span>安装本应用到桌面</div>
      </div>
      <div class="smsub" id="smsub-find" hidden>
        <div class="smi" data-app="run"><span class="smi-ico ico-run"></span>按口令查找文件服务…</div>
      </div>
    </div>

    <div class="win95 smalldlg" id="runWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">运行</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="dlg-pad">
        <div class="run-row">
          <span class="micon info"></span>
          <span class="run-txt">输入口令（10 位）或完整链接，前往对应页面</span>
        </div>
        <div class="run-input-row">
          <span class="run-label">打开:</span>
          <input id="runInput" class="run-input" type="text" name="run-target" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" placeholder="/s/口令/ 或 https://...">
        </div>
        <div class="msgbtn">
          <button class="btn95" id="runGo">确定</button>
          <button class="btn95 btn-gap" id="runCancel">取消</button>
        </div>
      </div>
    </div>

    <div class="win95 smalldlg" id="sysWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">系统属性</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="dlg-pad">
        <div class="sys-grid" id="sysGrid"></div>
        <div class="msgbtn"><button class="btn95" id="sysOk">确定</button></div>
      </div>
    </div>

    <div class="win95 smalldlg" id="netWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">网络</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="dlg-pad">
        <div class="sys-grid" id="netGrid"></div>
        <div class="msgbtn"><button class="btn95" id="netOk">确定</button></div>
      </div>
    </div>

    <div class="win95 smalldlg" id="propWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">显示 属性</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="dlg-pad">
        <div class="prop-label">桌面颜色（点击立即生效，自动保存）</div>
        <div class="prop-swatches" id="swatches"></div>
        <div class="prop-label">屏幕保护程序</div>
        <div class="prop-row">
          <select id="saverPick" class="prop-select"></select>
          <button class="btn95" id="saverPreview" type="button">预览</button>
        </div>
        <div class="prop-row">
          <span class="prop-k">等待:</span>
          <select id="saverWait" class="prop-select">
            <option value="0">禁用</option>
            <option value="15000">15 秒</option>
            <option value="30000">30 秒</option>
            <option value="60000">1 分钟</option>
            <option value="300000">5 分钟</option>
          </select>
        </div>
        <div class="msgbtn"><button class="btn95" id="propOk">确定</button></div>
      </div>
    </div>

    <div class="ctxmenu" id="ctxMenu" hidden>
      <div class="ctxi" data-ctx="refresh">刷新</div>
      <div class="ctx-sep"></div>
      <div class="ctxi" data-ctx="props">属性</div>
    </div>

    <!-- ═══════════ QQ 面板（复刻 QQ 2008 正式版界面）═══════════ -->
    <div class="win95 appwin qqwin" id="qqWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tbqq"><span class="ico ico-qq ico-qq-s"></span></span>
        <span class="tb-text">QQ</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="qq-panel">
        <!-- 顶部个人区：头像 + 昵称 + 状态 + 个性签名（签名可点改，真实持久化） -->
        <div class="qq-top">
          <span class="qq-av" id="qqMyAv"></span>
          <span class="qq-me">
            <span class="qq-me-row">
              <span class="qq-me-name" id="qqMyName">7喵</span>
              <select id="qqState" class="qq-state-sel" aria-label="我的状态">
                <option value="online">在线</option>
                <option value="hidden">隐身</option>
              </select>
            </span>
            <span class="qq-me-sign" id="qqMySign" title="点击修改个性签名"></span>
          </span>
        </div>
        <!-- 查找联系人：真的按昵称/签名过滤下面的列表 -->
        <div class="qq-search">
          <span class="qq-sico"></span>
          <input id="qqFind" type="text" placeholder="查找联系人…" aria-label="查找联系人"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        </div>
        <!-- 三个 Tab：好友 / QQ群 / 最近联系人（真实切换） -->
        <div class="qq-tabs" id="qqTabs">
          <div class="qq-tab on" data-tab="friend"><span class="qq-tab-ico" id="qqTabIcoF"></span>好友</div>
          <div class="qq-tab" data-tab="group"><span class="qq-tab-ico" id="qqTabIcoG"></span>QQ群</div>
          <div class="qq-tab" data-tab="recent"><span class="qq-tab-ico" id="qqTabIcoR"></span>最近联系人</div>
        </div>
        <div class="qq-list" id="qqGroups"></div>
        <!-- 底部工具栏：主菜单（音效/年代穿越/退出） + 在线统计 -->
        <div class="qq-bar">
          <button class="qq-bar-btn" id="qqMenuBtn" title="主菜单" aria-label="主菜单">
            <span class="ico ico-qq ico-qq-s"></span>
          </button>
          <span class="qq-online" id="qqOnline">在线 0 人</span>
        </div>
        <!-- 主菜单弹出层：音效开关、年代穿越、退出 QQ（每一项都真实生效） -->
        <div class="qq-menu" id="qqMenu" hidden>
          <div class="qq-menu-lab">音效</div>
          <div class="qq-menu-row"><button class="btn95 qq-mini" id="qqSound">音效:开</button></div>
          <div class="qq-menu-sep"></div>
          <div class="qq-menu-lab">穿越年代（消息时间戳/时钟同源）</div>
          <div class="qq-menu-row">
            <select id="qqEra" class="qq-era" aria-label="穿越年代">
              <option value="">真实日期</option>
            </select>
          </div>
          <div class="qq-menu-sep"></div>
          <div class="qq-menu-row" id="qqReplayRow" data-a="replay">重播对话</div>
          <div class="qq-menu-sep"></div>
          <div class="qq-menu-row" id="qqQuitRow" data-a="quit">退出 QQ</div>
        </div>
      </div>
    </div>

    <!-- ═══════════ QQ 聊天窗口（复刻 QQ 2008）══════════ -->
    <div class="win95 appwin qqchatwin" id="qqChatWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tbqq"><span class="ico ico-qq ico-qq-s"></span></span>
        <span class="tb-text" id="qqChatTitle">与好友对话</span>
        <button class="wclose" data-close aria-label="关闭">×</button>
      </div>
      <div class="qq-chat">
        <!-- 对方信息区 -->
        <div class="qq-ch-head">
          <span class="qq-av" id="qqChatAv"></span>
          <span class="qq-ch-pear">
            <span class="qq-ch-name" id="qqChatName"></span>
            <span class="qq-ch-sign" id="qqChatSign"></span>
          </span>
        </div>
        <!-- 消息区（左）+ 对方资料栏（右），与真实 QQ2008 一致 -->
        <div class="qq-ch-main">
          <div class="qq-ch-log" id="qqLog"></div>
          <div class="qq-ch-side" id="qqChatSide"></div>
        </div>
        <div class="qq-typing" id="qqTyping" hidden><span class="qq-tdot"></span><span class="qq-tdot"></span><span class="qq-tdot"></span>对方正在输入…</div>
        <!-- 工具栏：字体 / 表情，均为 QQ2008 真实存在的按钮（不放任何播放控制） -->
        <div class="qq-ch-tools">
          <button class="qq-tool" id="qqFontBtn" title="切换字体大小" aria-label="切换字体大小">A</button>
          <button class="qq-tool" id="qqFaceBtn" title="表情" aria-label="插入表情">☺</button>
          <span class="spacer"></span>
        </div>
        <div class="qq-ch-input">
          <textarea id="qqIn" class="qq-in" rows="3" name="qq-msg" autocomplete="off"
                    autocapitalize="off" autocorrect="off" spellcheck="false"
                    data-1p-ignore data-lpignore="true" placeholder="说点什么…" aria-label="消息内容"></textarea>
        </div>
        <div class="qq-ch-foot">
          <button class="btn95" id="qqSendBtn">发送(S)</button>
          <button class="btn95" id="qqCloseBtn">关闭(C)</button>
        </div>
      </div>
    </div>

      </div>
    </div>
  </div>

  <div class="taskbar">
    <button class="btn95 startbtn" id="startBtn"><span class="winlogo"></span>开始</button>
    <div class="tb-sep"></div>
    <div class="tb-tasks" id="tasks"></div>
    <div class="tray"><span id="trayIcons"></span><span id="clock">--:--</span></div>
  </div>

  <canvas id="ssaver" hidden></canvas>
  <div id="shutdown" hidden>
    <div class="shut-stage">
      <div class="shut-logo">
        <div class="winflag big"></div>
        <div class="shut-wordmark">Microsoft <b>Windows</b><i>98</i></div>
      </div>
      <div class="shut-line">现在可以安全地关闭计算机了。</div>
      <div class="shut-line shut-small">（点击屏幕任意位置重新启动）</div>
    </div>
  </div>
  <div id="crash" hidden>
    <div class="crash-box">
      <div class="crash-title">Windows</div>
      <div class="crash-txt" id="crashTxt">该程序执行了非法操作，即将被关闭。</div>
      <div class="crash-txt crash-small">如果问题依然存在，请与程序供应商联系。</div>
      <div class="crash-btn"><button class="btn95" id="crashOk">关闭</button></div>
    </div>
  </div>
  <script src="/home.js?v=6"></script>
</body>
</html>
`;

const HOME_CSS = `* { margin: 0; padding: 0; box-sizing: border-box; }
/* 兜底：display:flex/grid 会覆盖 [hidden]，此处强制恢复（项目踩过的坑） */
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--desk1);
  font-family: "MS Sans Serif", "Microsoft Sans Serif", Tahoma, "Pixelated MS Sans Serif", "Microsoft YaHei", "PingFang SC", sans-serif;
  /* Win98 UI 基准字号：MS Sans Serif 8pt ≈ 11px（原 13px 偏大，密度不还原） */
  font-size: var(--ui-fs);
  color: #000;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
}
/* ═══════════════ Win98 系统配色变量（Windows 标准主题）═══════════════
   全部色值取自 Win98 官方系统色（GetSysColor / WIN.INI [colors]）。
   后续所有样式优先用变量；新增代码禁止硬编码色值。 */
:root {
  /* 3D 立体边四层（凸起 = 上左下右相反，凹陷互换） */
  --face: #c0c0c0;   /* ButtonFace / Scrollbar / Menu / ActiveBorder */
  --hi:   #ffffff;   /* ButtonHighlight / Window / CaptionText */
  --lt:   #dfdfdf;   /* 3D 内高光 */
  --sh:   #808080;   /* ButtonShadow / GrayText / InactiveTitle */
  --dk:   #0a0a0a;   /* ButtonDkShadow / WindowText */
  --win:  #ffffff;   /* 窗口客户区 */
  --hl:   #000080;   /* Highlight 选中背景 */
  --hl-text: #ffffff;
  /* 标题栏：Win98 相对 Win95 的核心改动 —— 纯色 → 水平渐变 */
  --title: #000080;            /* ActiveTitle（渐变左端） */
  --title-grad: #1084d0;       /* GradientActiveTitle（渐变右端，98 新增） */
  --title-inact: #808080;      /* InactiveTitle（渐变左端） */
  --title-inact-grad: #b5b5b5; /* GradientInactiveTitle（98 新增） */
  --title-inact-text: #c0c0c0;
  /* 桌面：底色 + 4px 棋盘格抖动（还原 CRT 低色深观感） */
  --desk1: #008080;
  --desk2: #007d7d;
  /* 几何（Win98 标准度量） */
  --tb-h: 28px;      /* 任务栏基础高度 */
  --taskbar-h: calc(var(--tb-h) + env(safe-area-inset-bottom, 0px)); /* 含底部安全区，最大化窗口用它让位 */
  --ui-fs: 11px;     /* MS Sans Serif 8pt ≈ 11px */
  --scroll-w: 16px;  /* 滚动条宽度 */
}
#desk {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background-image: repeating-conic-gradient(var(--desk1) 0% 25%, var(--desk2) 0% 50%);
  background-size: 4px 4px;
}

/* ═══════════════ Win98 滚动条 ═══════════════
   浏览器默认滚动条（Chrome 那条细灰条）在复古界面里极其违和，
   这是「多级滚动条看着丑」的根源。此处完整还原 Win98 滚动条：
   16px 宽、#c0c0c0 槽底 50% 棋盘格、四层立体边箭头按钮与滑块。 */
* { scrollbar-width: auto; scrollbar-color: var(--sh) var(--face); }
::-webkit-scrollbar { width: var(--scroll-w); height: var(--scroll-w); }
::-webkit-scrollbar-track {
  background-color: var(--face);
  /* Win98 轨道是 2px 灰白棋盘格 */
  background-image:
    linear-gradient(45deg, var(--hi) 25%, transparent 25%, transparent 75%, var(--hi) 75%),
    linear-gradient(45deg, var(--hi) 25%, transparent 25%, transparent 75%, var(--hi) 75%);
  background-size: 4px 4px;
  background-position: 0 0, 2px 2px;
}
::-webkit-scrollbar-thumb {
  background: var(--face);
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--hi),
              inset -2px -2px var(--sh), inset 2px 2px var(--lt);
}
::-webkit-scrollbar-thumb:active {
  box-shadow: inset -1px -1px var(--hi), inset 1px 1px var(--dk),
              inset -2px -2px var(--lt), inset 2px 2px var(--sh);
}
::-webkit-scrollbar-button {
  display: block;
  height: var(--scroll-w);
  width: var(--scroll-w);
  background-color: var(--face);
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--hi),
              inset -2px -2px var(--sh), inset 2px 2px var(--lt);
  background-repeat: no-repeat;
  background-position: center;
}
/* 上下箭头（细黑三角） */
::-webkit-scrollbar-button:vertical:decrement {
  background-image: linear-gradient(135deg, transparent 48%, #000 48%, #000 52%, transparent 52%);
}
::-webkit-scrollbar-button:vertical:increment {
  background-image: linear-gradient(-45deg, transparent 48%, #000 48%, #000 52%, transparent 52%);
}
/* 左右箭头 */
::-webkit-scrollbar-button:horizontal:decrement {
  background-image: linear-gradient(45deg, transparent 46%, #000 46%, #000 54%, transparent 54%);
}
::-webkit-scrollbar-button:horizontal:increment {
  background-image: linear-gradient(-135deg, transparent 46%, #000 46%, #000 54%, transparent 54%);
}
::-webkit-scrollbar-corner { background: var(--face); }
/* 双按钮（起始/结束各一个）——让箭头按钮成对出现，符合 Win98 */
::-webkit-scrollbar-button:vertical:start:increment,
::-webkit-scrollbar-button:vertical:end:decrement,
::-webkit-scrollbar-button:horizontal:start:increment,
::-webkit-scrollbar-button:horizontal:end:decrement { display: none; }

/* ───── 桌面图标 ───── */
.dgroup {
  position: absolute;
  left: 10px;
  top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dicon {
  width: 76px;
  padding: 5px 2px 3px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: default;
  border: 1px dotted transparent;
  outline: none;
}
.dicon:focus-visible { border-color: #fff; }
.ico {
  display: block;
  width: 32px;
  height: 32px;
  position: relative;
  flex: none;
}
.dlabel {
  font-size: 11px;
  line-height: 1.25;
  color: #fff;
  text-shadow: 1px 1px 0 #000;
  text-align: center;
  padding: 0 2px;
  max-width: 100%;
  overflow-wrap: break-word;
  white-space: normal;
}
.dicon.sel .dlabel { background: #000080; outline: 1px dotted #fff; }
.dicon.sel .ico { filter: brightness(.7) saturate(.6); }

/* ═════════════ Win98 桌面图标（16×16 字符画 → box-shadow，2px 网格）═════════════
   按原版 32×32 图标逐像素重绘：粗黑描边 + 多灰阶层 + 蓝色屏幕，256 色观感。
   注意：真 Win98 的桌面图标不带投影（投影是 XP 时代的），
   只给标签文字留 1px 硬阴影（对应 98 的「图标标签阴影」显示效果）。 */
.ico-pc::before, .ico-trash::before, .ico-net::before, .ico-mine::before, .ico-snake::before, .ico-saver::before, .ico-note::before, .ico-install::before, .ico-dos::before, .ico-trashfull::before, .ico-qq::before {
  content: "";
  position: absolute;
  left: 0; top: 0;
  width: 2px; height: 2px;
}
.ico-pc { background: none; }
.ico-pc::before { box-shadow: 2px 2px 0 #0a0a0a, 4px 2px 0 #0a0a0a, 6px 2px 0 #0a0a0a, 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 22px 2px 0 #0a0a0a, 2px 4px 0 #0a0a0a, 4px 4px 0 #ffffff, 6px 4px 0 #ffffff, 8px 4px 0 #ffffff, 10px 4px 0 #ffffff, 12px 4px 0 #ffffff, 14px 4px 0 #ffffff, 16px 4px 0 #ffffff, 18px 4px 0 #ffffff, 20px 4px 0 #ffffff, 22px 4px 0 #0a0a0a, 2px 6px 0 #0a0a0a, 4px 6px 0 #ffffff, 6px 6px 0 #1084d0, 8px 6px 0 #1084d0, 10px 6px 0 #1084d0, 12px 6px 0 #1084d0, 14px 6px 0 #1084d0, 16px 6px 0 #1084d0, 18px 6px 0 #1084d0, 20px 6px 0 #ffffff, 22px 6px 0 #0a0a0a, 2px 8px 0 #0a0a0a, 4px 8px 0 #ffffff, 6px 8px 0 #1084d0, 8px 8px 0 #1084d0, 10px 8px 0 #1084d0, 12px 8px 0 #1084d0, 14px 8px 0 #1084d0, 16px 8px 0 #1084d0, 18px 8px 0 #1084d0, 20px 8px 0 #ffffff, 22px 8px 0 #0a0a0a, 2px 10px 0 #0a0a0a, 4px 10px 0 #ffffff, 6px 10px 0 #1084d0, 8px 10px 0 #1084d0, 10px 10px 0 #1084d0, 12px 10px 0 #1084d0, 14px 10px 0 #1084d0, 16px 10px 0 #1084d0, 18px 10px 0 #1084d0, 20px 10px 0 #ffffff, 22px 10px 0 #0a0a0a, 2px 12px 0 #0a0a0a, 4px 12px 0 #ffffff, 6px 12px 0 #1084d0, 8px 12px 0 #1084d0, 10px 12px 0 #1084d0, 12px 12px 0 #1084d0, 14px 12px 0 #1084d0, 16px 12px 0 #1084d0, 18px 12px 0 #1084d0, 20px 12px 0 #ffffff, 22px 12px 0 #0a0a0a, 2px 14px 0 #0a0a0a, 4px 14px 0 #ffffff, 6px 14px 0 #1084d0, 8px 14px 0 #1084d0, 10px 14px 0 #1084d0, 12px 14px 0 #1084d0, 14px 14px 0 #1084d0, 16px 14px 0 #1084d0, 18px 14px 0 #1084d0, 20px 14px 0 #ffffff, 22px 14px 0 #0a0a0a, 2px 16px 0 #0a0a0a, 4px 16px 0 #ffffff, 6px 16px 0 #ffffff, 8px 16px 0 #ffffff, 10px 16px 0 #ffffff, 12px 16px 0 #ffffff, 14px 16px 0 #ffffff, 16px 16px 0 #ffffff, 18px 16px 0 #ffffff, 20px 16px 0 #ffffff, 22px 16px 0 #0a0a0a, 2px 18px 0 #0a0a0a, 4px 18px 0 #0a0a0a, 6px 18px 0 #0a0a0a, 8px 18px 0 #0a0a0a, 10px 18px 0 #0a0a0a, 12px 18px 0 #0a0a0a, 14px 18px 0 #0a0a0a, 16px 18px 0 #0a0a0a, 18px 18px 0 #0a0a0a, 20px 18px 0 #0a0a0a, 22px 18px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #0a0a0a, 12px 20px 0 #0a0a0a, 14px 20px 0 #0a0a0a, 16px 20px 0 #0a0a0a, 6px 22px 0 #0a0a0a, 8px 22px 0 #c0c0c0, 10px 22px 0 #c0c0c0, 12px 22px 0 #c0c0c0, 14px 22px 0 #c0c0c0, 16px 22px 0 #c0c0c0, 18px 22px 0 #0a0a0a, 2px 24px 0 #0a0a0a, 4px 24px 0 #0a0a0a, 6px 24px 0 #0a0a0a, 8px 24px 0 #0a0a0a, 10px 24px 0 #0a0a0a, 12px 24px 0 #0a0a0a, 14px 24px 0 #0a0a0a, 16px 24px 0 #0a0a0a, 18px 24px 0 #0a0a0a, 20px 24px 0 #0a0a0a, 22px 24px 0 #0a0a0a, 24px 24px 0 #0a0a0a, 26px 24px 0 #0a0a0a, 2px 26px 0 #0a0a0a, 4px 26px 0 #c0c0c0, 6px 26px 0 #c0c0c0, 8px 26px 0 #c0c0c0, 10px 26px 0 #c0c0c0, 12px 26px 0 #ffffff, 14px 26px 0 #c0c0c0, 16px 26px 0 #c0c0c0, 18px 26px 0 #c0c0c0, 20px 26px 0 #c0c0c0, 22px 26px 0 #c0c0c0, 24px 26px 0 #c0c0c0, 26px 26px 0 #0a0a0a, 2px 28px 0 #0a0a0a, 4px 28px 0 #0a0a0a, 6px 28px 0 #0a0a0a, 8px 28px 0 #0a0a0a, 10px 28px 0 #0a0a0a, 12px 28px 0 #0a0a0a, 14px 28px 0 #0a0a0a, 16px 28px 0 #0a0a0a, 18px 28px 0 #0a0a0a, 20px 28px 0 #0a0a0a, 22px 28px 0 #0a0a0a, 24px 28px 0 #0a0a0a, 26px 28px 0 #0a0a0a; }
.ico-trash { background: none; }
.ico-trash::before { box-shadow: 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 8px 4px 0 #0a0a0a, 10px 4px 0 #dfdfdf, 12px 4px 0 #dfdfdf, 14px 4px 0 #dfdfdf, 16px 4px 0 #dfdfdf, 18px 4px 0 #dfdfdf, 20px 4px 0 #dfdfdf, 22px 4px 0 #0a0a0a, 6px 6px 0 #0a0a0a, 8px 6px 0 #0a0a0a, 10px 6px 0 #0a0a0a, 12px 6px 0 #0a0a0a, 14px 6px 0 #0a0a0a, 16px 6px 0 #0a0a0a, 18px 6px 0 #0a0a0a, 20px 6px 0 #0a0a0a, 22px 6px 0 #0a0a0a, 24px 6px 0 #0a0a0a, 6px 8px 0 #0a0a0a, 8px 8px 0 #c0c0c0, 10px 8px 0 #c0c0c0, 12px 8px 0 #c0c0c0, 14px 8px 0 #c0c0c0, 16px 8px 0 #c0c0c0, 18px 8px 0 #c0c0c0, 20px 8px 0 #c0c0c0, 22px 8px 0 #0a0a0a, 6px 10px 0 #0a0a0a, 8px 10px 0 #0a0a0a, 10px 10px 0 #0a0a0a, 12px 10px 0 #0a0a0a, 14px 10px 0 #0a0a0a, 16px 10px 0 #0a0a0a, 18px 10px 0 #0a0a0a, 20px 10px 0 #0a0a0a, 22px 10px 0 #0a0a0a, 24px 10px 0 #0a0a0a, 8px 12px 0 #0a0a0a, 10px 12px 0 #ffffff, 12px 12px 0 #c0c0c0, 14px 12px 0 #ffffff, 16px 12px 0 #c0c0c0, 18px 12px 0 #ffffff, 20px 12px 0 #c0c0c0, 22px 12px 0 #0a0a0a, 8px 14px 0 #0a0a0a, 10px 14px 0 #c0c0c0, 12px 14px 0 #ffffff, 14px 14px 0 #c0c0c0, 16px 14px 0 #ffffff, 18px 14px 0 #c0c0c0, 20px 14px 0 #ffffff, 22px 14px 0 #0a0a0a, 8px 16px 0 #0a0a0a, 10px 16px 0 #ffffff, 12px 16px 0 #c0c0c0, 14px 16px 0 #ffffff, 16px 16px 0 #c0c0c0, 18px 16px 0 #ffffff, 20px 16px 0 #c0c0c0, 22px 16px 0 #0a0a0a, 8px 18px 0 #0a0a0a, 10px 18px 0 #c0c0c0, 12px 18px 0 #ffffff, 14px 18px 0 #c0c0c0, 16px 18px 0 #ffffff, 18px 18px 0 #c0c0c0, 20px 18px 0 #ffffff, 22px 18px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #ffffff, 12px 20px 0 #c0c0c0, 14px 20px 0 #ffffff, 16px 20px 0 #c0c0c0, 18px 20px 0 #ffffff, 20px 20px 0 #c0c0c0, 22px 20px 0 #0a0a0a, 8px 22px 0 #0a0a0a, 10px 22px 0 #c0c0c0, 12px 22px 0 #ffffff, 14px 22px 0 #c0c0c0, 16px 22px 0 #ffffff, 18px 22px 0 #c0c0c0, 20px 22px 0 #ffffff, 22px 22px 0 #0a0a0a, 10px 24px 0 #0a0a0a, 12px 24px 0 #ffffff, 14px 24px 0 #c0c0c0, 16px 24px 0 #ffffff, 18px 24px 0 #c0c0c0, 20px 24px 0 #ffffff, 22px 24px 0 #0a0a0a, 10px 26px 0 #0a0a0a, 12px 26px 0 #0a0a0a, 14px 26px 0 #0a0a0a, 16px 26px 0 #0a0a0a, 18px 26px 0 #0a0a0a, 20px 26px 0 #0a0a0a; }
.ico-net { background: none; }
.ico-net::before { box-shadow: 4px 2px 0 #0a0a0a, 6px 2px 0 #0a0a0a, 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 4px 4px 0 #0a0a0a, 6px 4px 0 #ffffff, 8px 4px 0 #ffffff, 10px 4px 0 #ffffff, 12px 4px 0 #ffffff, 14px 4px 0 #ffffff, 16px 4px 0 #ffffff, 18px 4px 0 #ffffff, 20px 4px 0 #0a0a0a, 4px 6px 0 #0a0a0a, 6px 6px 0 #ffffff, 8px 6px 0 #1084d0, 10px 6px 0 #1084d0, 12px 6px 0 #1084d0, 14px 6px 0 #1084d0, 16px 6px 0 #1084d0, 18px 6px 0 #ffffff, 20px 6px 0 #0a0a0a, 4px 8px 0 #0a0a0a, 6px 8px 0 #ffffff, 8px 8px 0 #1084d0, 10px 8px 0 #1084d0, 12px 8px 0 #1084d0, 14px 8px 0 #1084d0, 16px 8px 0 #1084d0, 18px 8px 0 #ffffff, 20px 8px 0 #0a0a0a, 4px 10px 0 #0a0a0a, 6px 10px 0 #ffffff, 8px 10px 0 #404040, 10px 10px 0 #404040, 12px 10px 0 #404040, 14px 10px 0 #404040, 16px 10px 0 #404040, 18px 10px 0 #ffffff, 20px 10px 0 #0a0a0a, 4px 12px 0 #0a0a0a, 6px 12px 0 #ffffff, 8px 12px 0 #ffffff, 10px 12px 0 #ffffff, 12px 12px 0 #ffffff, 14px 12px 0 #ffffff, 16px 12px 0 #ffffff, 18px 12px 0 #ffffff, 20px 12px 0 #0a0a0a, 4px 14px 0 #0a0a0a, 6px 14px 0 #0a0a0a, 8px 14px 0 #0a0a0a, 10px 14px 0 #0a0a0a, 12px 14px 0 #0a0a0a, 14px 14px 0 #0a0a0a, 16px 14px 0 #0a0a0a, 18px 14px 0 #0a0a0a, 20px 14px 0 #0a0a0a, 10px 16px 0 #0a0a0a, 12px 16px 0 #0a0a0a, 14px 16px 0 #0a0a0a, 16px 16px 0 #0a0a0a, 16px 18px 0 #0a0a0a, 18px 18px 0 #0a0a0a, 20px 18px 0 #0a0a0a, 22px 18px 0 #0a0a0a, 24px 18px 0 #0a0a0a, 26px 18px 0 #0a0a0a, 28px 18px 0 #0a0a0a, 30px 18px 0 #0a0a0a, 16px 20px 0 #0a0a0a, 18px 20px 0 #ffffff, 20px 20px 0 #ffffff, 22px 20px 0 #ffffff, 24px 20px 0 #ffffff, 26px 20px 0 #ffffff, 28px 20px 0 #ffffff, 30px 20px 0 #0a0a0a, 16px 22px 0 #0a0a0a, 18px 22px 0 #ffffff, 20px 22px 0 #1084d0, 22px 22px 0 #1084d0, 24px 22px 0 #1084d0, 26px 22px 0 #1084d0, 28px 22px 0 #ffffff, 30px 22px 0 #0a0a0a, 16px 24px 0 #0a0a0a, 18px 24px 0 #0a0a0a, 20px 24px 0 #0a0a0a, 22px 24px 0 #0a0a0a, 24px 24px 0 #0a0a0a, 26px 24px 0 #0a0a0a, 28px 24px 0 #0a0a0a, 8px 26px 0 #0a0a0a, 10px 26px 0 #0a0a0a, 20px 26px 0 #0a0a0a, 22px 26px 0 #0a0a0a, 8px 28px 0 #0a0a0a, 10px 28px 0 #0a0a0a; }
.ico-mine { background: none; }
.ico-mine::before { box-shadow: 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 16px 4px 0 #0a0a0a, 18px 4px 0 #0a0a0a, 20px 4px 0 #0a0a0a, 14px 6px 0 #0a0a0a, 16px 6px 0 #0a0a0a, 18px 6px 0 #0a0a0a, 8px 8px 0 #0a0a0a, 10px 8px 0 #0a0a0a, 12px 8px 0 #0a0a0a, 14px 8px 0 #0a0a0a, 16px 8px 0 #0a0a0a, 18px 8px 0 #0a0a0a, 20px 8px 0 #0a0a0a, 22px 8px 0 #0a0a0a, 6px 10px 0 #0a0a0a, 8px 10px 0 #0a0a0a, 10px 10px 0 #0a0a0a, 12px 10px 0 #0a0a0a, 14px 10px 0 #0a0a0a, 16px 10px 0 #0a0a0a, 18px 10px 0 #0a0a0a, 20px 10px 0 #0a0a0a, 22px 10px 0 #0a0a0a, 24px 10px 0 #0a0a0a, 4px 12px 0 #0a0a0a, 6px 12px 0 #0a0a0a, 8px 12px 0 #0a0a0a, 10px 12px 0 #0a0a0a, 12px 12px 0 #ffffff, 14px 12px 0 #ffffff, 16px 12px 0 #0a0a0a, 18px 12px 0 #0a0a0a, 20px 12px 0 #0a0a0a, 22px 12px 0 #0a0a0a, 24px 12px 0 #0a0a0a, 26px 12px 0 #0a0a0a, 4px 14px 0 #0a0a0a, 6px 14px 0 #0a0a0a, 8px 14px 0 #0a0a0a, 10px 14px 0 #ffffff, 12px 14px 0 #ffffff, 14px 14px 0 #0a0a0a, 16px 14px 0 #0a0a0a, 18px 14px 0 #0a0a0a, 20px 14px 0 #0a0a0a, 22px 14px 0 #0a0a0a, 24px 14px 0 #0a0a0a, 26px 14px 0 #0a0a0a, 4px 16px 0 #0a0a0a, 6px 16px 0 #0a0a0a, 8px 16px 0 #0a0a0a, 10px 16px 0 #0a0a0a, 12px 16px 0 #0a0a0a, 14px 16px 0 #0a0a0a, 16px 16px 0 #0a0a0a, 18px 16px 0 #0a0a0a, 20px 16px 0 #0a0a0a, 22px 16px 0 #0a0a0a, 24px 16px 0 #0a0a0a, 26px 16px 0 #0a0a0a, 4px 18px 0 #0a0a0a, 6px 18px 0 #0a0a0a, 8px 18px 0 #0a0a0a, 10px 18px 0 #0a0a0a, 12px 18px 0 #0a0a0a, 14px 18px 0 #0a0a0a, 16px 18px 0 #0a0a0a, 18px 18px 0 #0a0a0a, 20px 18px 0 #0a0a0a, 22px 18px 0 #0a0a0a, 24px 18px 0 #0a0a0a, 26px 18px 0 #0a0a0a, 6px 20px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #0a0a0a, 12px 20px 0 #0a0a0a, 14px 20px 0 #0a0a0a, 16px 20px 0 #0a0a0a, 18px 20px 0 #0a0a0a, 20px 20px 0 #0a0a0a, 22px 20px 0 #0a0a0a, 24px 20px 0 #0a0a0a, 8px 22px 0 #0a0a0a, 10px 22px 0 #0a0a0a, 12px 22px 0 #0a0a0a, 14px 22px 0 #0a0a0a, 16px 22px 0 #0a0a0a, 18px 22px 0 #0a0a0a, 20px 22px 0 #0a0a0a, 22px 22px 0 #0a0a0a, 10px 24px 0 #0a0a0a, 12px 24px 0 #0a0a0a, 18px 24px 0 #0a0a0a, 20px 24px 0 #0a0a0a, 8px 26px 0 #0a0a0a, 10px 26px 0 #0a0a0a, 20px 26px 0 #0a0a0a, 22px 26px 0 #0a0a0a; }
.ico-snake { background: none; }
.ico-snake::before { box-shadow: 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 22px 2px 0 #0a0a0a, 8px 4px 0 #0a0a0a, 10px 4px 0 #00c800, 12px 4px 0 #00c800, 14px 4px 0 #00c800, 16px 4px 0 #00c800, 18px 4px 0 #00c800, 20px 4px 0 #00c800, 22px 4px 0 #00c800, 24px 4px 0 #0a0a0a, 2px 6px 0 #0a0a0a, 4px 6px 0 #0a0a0a, 6px 6px 0 #0a0a0a, 8px 6px 0 #0a0a0a, 10px 6px 0 #00c800, 12px 6px 0 #00c800, 14px 6px 0 #00c800, 16px 6px 0 #00c800, 18px 6px 0 #00c800, 20px 6px 0 #00c800, 22px 6px 0 #00c800, 24px 6px 0 #0a0a0a, 2px 8px 0 #0a0a0a, 4px 8px 0 #00c800, 6px 8px 0 #00c800, 8px 8px 0 #00c800, 10px 8px 0 #00c800, 12px 8px 0 #00c800, 14px 8px 0 #00c800, 16px 8px 0 #0a0a0a, 18px 8px 0 #0a0a0a, 20px 8px 0 #00c800, 22px 8px 0 #00c800, 24px 8px 0 #0a0a0a, 2px 10px 0 #0a0a0a, 4px 10px 0 #00c800, 6px 10px 0 #00c800, 8px 10px 0 #0a0a0a, 10px 10px 0 #0a0a0a, 12px 10px 0 #00c800, 14px 10px 0 #00c800, 16px 10px 0 #00c800, 18px 10px 0 #00c800, 20px 10px 0 #00c800, 22px 10px 0 #00c800, 24px 10px 0 #0a0a0a, 2px 12px 0 #0a0a0a, 4px 12px 0 #00c800, 6px 12px 0 #00c800, 8px 12px 0 #0a0a0a, 10px 12px 0 #0a0a0a, 12px 12px 0 #00c800, 14px 12px 0 #00c800, 16px 12px 0 #0a0a0a, 18px 12px 0 #0a0a0a, 20px 12px 0 #0a0a0a, 22px 12px 0 #0a0a0a, 24px 12px 0 #0a0a0a, 2px 14px 0 #0a0a0a, 4px 14px 0 #00c800, 6px 14px 0 #00c800, 8px 14px 0 #00c800, 10px 14px 0 #00c800, 12px 14px 0 #00c800, 14px 14px 0 #00c800, 16px 14px 0 #00c800, 18px 14px 0 #0a0a0a, 20px 14px 0 #d4000a, 22px 14px 0 #d4000a, 24px 14px 0 #d4000a, 26px 14px 0 #0a0a0a, 2px 16px 0 #0a0a0a, 4px 16px 0 #0a0a0a, 6px 16px 0 #0a0a0a, 8px 16px 0 #0a0a0a, 10px 16px 0 #00c800, 12px 16px 0 #00c800, 14px 16px 0 #00c800, 16px 16px 0 #00c800, 18px 16px 0 #0a0a0a, 20px 16px 0 #d4000a, 22px 16px 0 #ffffff, 24px 16px 0 #ffffff, 26px 16px 0 #d4000a, 28px 16px 0 #0a0a0a, 8px 18px 0 #0a0a0a, 10px 18px 0 #00c800, 12px 18px 0 #00c800, 14px 18px 0 #00c800, 16px 18px 0 #00c800, 18px 18px 0 #0a0a0a, 20px 18px 0 #d4000a, 22px 18px 0 #ffffff, 24px 18px 0 #ffffff, 26px 18px 0 #d4000a, 28px 18px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #0a0a0a, 12px 20px 0 #00c800, 14px 20px 0 #00c800, 16px 20px 0 #00c800, 18px 20px 0 #00c800, 20px 20px 0 #0a0a0a, 22px 20px 0 #d4000a, 24px 20px 0 #d4000a, 26px 20px 0 #0a0a0a, 12px 22px 0 #0a0a0a, 14px 22px 0 #00c800, 16px 22px 0 #00c800, 18px 22px 0 #00c800, 20px 22px 0 #00c800, 22px 22px 0 #0a0a0a, 24px 22px 0 #0a0a0a, 12px 24px 0 #0a0a0a, 14px 24px 0 #00c800, 16px 24px 0 #00c800, 18px 24px 0 #00c800, 20px 24px 0 #0a0a0a, 12px 26px 0 #0a0a0a, 14px 26px 0 #0a0a0a, 16px 26px 0 #0a0a0a, 18px 26px 0 #0a0a0a; }
.ico-saver { background: none; }
.ico-saver::before { box-shadow: 2px 2px 0 #0a0a0a, 4px 2px 0 #0a0a0a, 6px 2px 0 #0a0a0a, 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 22px 2px 0 #0a0a0a, 2px 4px 0 #0a0a0a, 4px 4px 0 #ffffff, 6px 4px 0 #ffffff, 8px 4px 0 #ffffff, 10px 4px 0 #ffffff, 12px 4px 0 #ffffff, 14px 4px 0 #ffffff, 16px 4px 0 #ffffff, 18px 4px 0 #ffffff, 20px 4px 0 #ffffff, 22px 4px 0 #0a0a0a, 2px 6px 0 #0a0a0a, 4px 6px 0 #ffffff, 6px 6px 0 #000080, 8px 6px 0 #000080, 10px 6px 0 #000080, 12px 6px 0 #ffffff, 14px 6px 0 #000080, 16px 6px 0 #000080, 18px 6px 0 #000080, 20px 6px 0 #000080, 22px 6px 0 #ffffff, 24px 6px 0 #0a0a0a, 2px 8px 0 #0a0a0a, 4px 8px 0 #ffffff, 6px 8px 0 #000080, 8px 8px 0 #ffffff, 10px 8px 0 #000080, 12px 8px 0 #000080, 14px 8px 0 #000080, 16px 8px 0 #ffffff, 18px 8px 0 #000080, 20px 8px 0 #000080, 22px 8px 0 #ffffff, 24px 8px 0 #0a0a0a, 2px 10px 0 #0a0a0a, 4px 10px 0 #ffffff, 6px 10px 0 #000080, 8px 10px 0 #000080, 10px 10px 0 #000080, 12px 10px 0 #ffffff, 14px 10px 0 #000080, 16px 10px 0 #000080, 18px 10px 0 #000080, 20px 10px 0 #000080, 22px 10px 0 #ffffff, 24px 10px 0 #0a0a0a, 2px 12px 0 #0a0a0a, 4px 12px 0 #ffffff, 6px 12px 0 #ffffff, 8px 12px 0 #ffffff, 10px 12px 0 #ffffff, 12px 12px 0 #ffffff, 14px 12px 0 #ffffff, 16px 12px 0 #ffffff, 18px 12px 0 #ffffff, 20px 12px 0 #ffffff, 22px 12px 0 #0a0a0a, 2px 14px 0 #0a0a0a, 4px 14px 0 #0a0a0a, 6px 14px 0 #0a0a0a, 8px 14px 0 #0a0a0a, 10px 14px 0 #0a0a0a, 12px 14px 0 #0a0a0a, 14px 14px 0 #0a0a0a, 16px 14px 0 #0a0a0a, 18px 14px 0 #0a0a0a, 20px 14px 0 #0a0a0a, 22px 14px 0 #0a0a0a, 8px 16px 0 #0a0a0a, 10px 16px 0 #0a0a0a, 12px 16px 0 #0a0a0a, 14px 16px 0 #0a0a0a, 16px 16px 0 #0a0a0a, 4px 18px 0 #0a0a0a, 6px 18px 0 #0a0a0a, 8px 18px 0 #0a0a0a, 10px 18px 0 #0a0a0a, 12px 18px 0 #0a0a0a, 14px 18px 0 #0a0a0a, 16px 18px 0 #0a0a0a, 18px 18px 0 #0a0a0a, 20px 18px 0 #0a0a0a, 22px 18px 0 #0a0a0a, 24px 18px 0 #0a0a0a, 4px 20px 0 #0a0a0a, 6px 20px 0 #c0c0c0, 8px 20px 0 #c0c0c0, 10px 20px 0 #c0c0c0, 12px 20px 0 #c0c0c0, 14px 20px 0 #c0c0c0, 16px 20px 0 #c0c0c0, 18px 20px 0 #c0c0c0, 20px 20px 0 #c0c0c0, 22px 20px 0 #c0c0c0, 24px 20px 0 #0a0a0a, 4px 22px 0 #0a0a0a, 6px 22px 0 #0a0a0a, 8px 22px 0 #0a0a0a, 10px 22px 0 #0a0a0a, 12px 22px 0 #0a0a0a, 14px 22px 0 #0a0a0a, 16px 22px 0 #0a0a0a, 18px 22px 0 #0a0a0a, 20px 22px 0 #0a0a0a, 22px 22px 0 #0a0a0a, 24px 22px 0 #0a0a0a, 8px 26px 0 #ffffff, 16px 26px 0 #ffffff, 10px 28px 0 #ffffff, 14px 28px 0 #ffffff, 12px 30px 0 #ffffff; }
.ico-note { background: none; }
.ico-note::before { box-shadow: 4px 2px 0 #0a0a0a, 6px 2px 0 #0a0a0a, 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 22px 2px 0 #0a0a0a, 4px 4px 0 #0a0a0a, 6px 4px 0 #ffffff, 8px 4px 0 #ffffff, 10px 4px 0 #ffffff, 12px 4px 0 #ffffff, 14px 4px 0 #ffffff, 16px 4px 0 #ffffff, 18px 4px 0 #ffffff, 20px 4px 0 #ffffff, 22px 4px 0 #0a0a0a, 24px 4px 0 #0a0a0a, 4px 6px 0 #0a0a0a, 6px 6px 0 #ffffff, 8px 6px 0 #ffffff, 10px 6px 0 #ffffff, 12px 6px 0 #ffffff, 14px 6px 0 #ffffff, 16px 6px 0 #ffffff, 18px 6px 0 #ffffff, 20px 6px 0 #ffffff, 22px 6px 0 #0a0a0a, 24px 6px 0 #ffffff, 26px 6px 0 #0a0a0a, 4px 8px 0 #0a0a0a, 6px 8px 0 #ffffff, 8px 8px 0 #ffffff, 10px 8px 0 #ffffff, 12px 8px 0 #ffffff, 14px 8px 0 #ffffff, 16px 8px 0 #ffffff, 18px 8px 0 #ffffff, 20px 8px 0 #ffffff, 22px 8px 0 #0a0a0a, 24px 8px 0 #0a0a0a, 26px 8px 0 #0a0a0a, 4px 10px 0 #0a0a0a, 6px 10px 0 #ffffff, 8px 10px 0 #ffffff, 10px 10px 0 #ffffff, 12px 10px 0 #ffffff, 14px 10px 0 #ffffff, 16px 10px 0 #ffffff, 18px 10px 0 #ffffff, 20px 10px 0 #ffffff, 22px 10px 0 #ffffff, 24px 10px 0 #ffffff, 26px 10px 0 #0a0a0a, 4px 12px 0 #0a0a0a, 6px 12px 0 #ffffff, 8px 12px 0 #000080, 10px 12px 0 #000080, 12px 12px 0 #000080, 14px 12px 0 #000080, 16px 12px 0 #000080, 18px 12px 0 #ffffff, 20px 12px 0 #ffffff, 22px 12px 0 #ffffff, 24px 12px 0 #ffffff, 26px 12px 0 #0a0a0a, 4px 14px 0 #0a0a0a, 6px 14px 0 #ffffff, 8px 14px 0 #ffffff, 10px 14px 0 #ffffff, 12px 14px 0 #ffffff, 14px 14px 0 #ffffff, 16px 14px 0 #ffffff, 18px 14px 0 #ffffff, 20px 14px 0 #ffffff, 22px 14px 0 #ffffff, 24px 14px 0 #ffffff, 26px 14px 0 #0a0a0a, 4px 16px 0 #0a0a0a, 6px 16px 0 #ffffff, 8px 16px 0 #000080, 10px 16px 0 #000080, 12px 16px 0 #000080, 14px 16px 0 #000080, 16px 16px 0 #000080, 18px 16px 0 #000080, 20px 16px 0 #ffffff, 22px 16px 0 #ffffff, 24px 16px 0 #ffffff, 26px 16px 0 #0a0a0a, 4px 18px 0 #0a0a0a, 6px 18px 0 #ffffff, 8px 18px 0 #ffffff, 10px 18px 0 #ffffff, 12px 18px 0 #ffffff, 14px 18px 0 #ffffff, 16px 18px 0 #ffffff, 18px 18px 0 #ffffff, 20px 18px 0 #ffffff, 22px 18px 0 #ffffff, 24px 18px 0 #ffffff, 26px 18px 0 #0a0a0a, 4px 20px 0 #0a0a0a, 6px 20px 0 #ffffff, 8px 20px 0 #000080, 10px 20px 0 #000080, 12px 20px 0 #000080, 14px 20px 0 #000080, 16px 20px 0 #000080, 18px 20px 0 #ffffff, 20px 20px 0 #ffffff, 22px 20px 0 #ffffff, 24px 20px 0 #ffffff, 26px 20px 0 #0a0a0a, 4px 22px 0 #0a0a0a, 6px 22px 0 #ffffff, 8px 22px 0 #ffffff, 10px 22px 0 #ffffff, 12px 22px 0 #ffffff, 14px 22px 0 #ffffff, 16px 22px 0 #ffffff, 18px 22px 0 #ffffff, 20px 22px 0 #ffffff, 22px 22px 0 #ffffff, 24px 22px 0 #ffffff, 26px 22px 0 #0a0a0a, 4px 24px 0 #0a0a0a, 6px 24px 0 #ffffff, 8px 24px 0 #000080, 10px 24px 0 #000080, 12px 24px 0 #000080, 14px 24px 0 #000080, 16px 24px 0 #ffffff, 18px 24px 0 #ffffff, 20px 24px 0 #ffffff, 22px 24px 0 #ffffff, 24px 24px 0 #ffffff, 26px 24px 0 #0a0a0a, 4px 26px 0 #0a0a0a, 6px 26px 0 #0a0a0a, 8px 26px 0 #0a0a0a, 10px 26px 0 #0a0a0a, 12px 26px 0 #0a0a0a, 14px 26px 0 #0a0a0a, 16px 26px 0 #0a0a0a, 18px 26px 0 #0a0a0a, 20px 26px 0 #0a0a0a, 22px 26px 0 #0a0a0a, 24px 26px 0 #0a0a0a, 26px 26px 0 #0a0a0a; }
.ico-install { background: none; }
.ico-install::before { box-shadow: 2px 2px 0 #0a0a0a, 4px 2px 0 #0a0a0a, 6px 2px 0 #0a0a0a, 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 22px 2px 0 #0a0a0a, 2px 4px 0 #0a0a0a, 4px 4px 0 #ffffff, 6px 4px 0 #ffffff, 8px 4px 0 #ffffff, 10px 4px 0 #ffffff, 12px 4px 0 #ffffff, 14px 4px 0 #ffffff, 16px 4px 0 #ffffff, 18px 4px 0 #ffffff, 20px 4px 0 #ffffff, 22px 4px 0 #0a0a0a, 2px 6px 0 #0a0a0a, 4px 6px 0 #ffffff, 6px 6px 0 #1084d0, 8px 6px 0 #1084d0, 10px 6px 0 #1084d0, 12px 6px 0 #1084d0, 14px 6px 0 #1084d0, 16px 6px 0 #1084d0, 18px 6px 0 #1084d0, 20px 6px 0 #ffffff, 22px 6px 0 #0a0a0a, 2px 8px 0 #0a0a0a, 4px 8px 0 #ffffff, 6px 8px 0 #1084d0, 8px 8px 0 #1084d0, 10px 8px 0 #00c800, 12px 8px 0 #00c800, 14px 8px 0 #00c800, 16px 8px 0 #1084d0, 18px 8px 0 #1084d0, 20px 8px 0 #ffffff, 22px 8px 0 #0a0a0a, 2px 10px 0 #0a0a0a, 4px 10px 0 #ffffff, 6px 10px 0 #1084d0, 8px 10px 0 #1084d0, 10px 10px 0 #00c800, 12px 10px 0 #00c800, 14px 10px 0 #00c800, 16px 10px 0 #1084d0, 18px 10px 0 #1084d0, 20px 10px 0 #ffffff, 22px 10px 0 #0a0a0a, 2px 12px 0 #0a0a0a, 4px 12px 0 #ffffff, 6px 12px 0 #1084d0, 8px 12px 0 #00c800, 10px 12px 0 #00c800, 12px 12px 0 #00c800, 14px 12px 0 #00c800, 16px 12px 0 #00c800, 18px 12px 0 #1084d0, 20px 12px 0 #ffffff, 22px 12px 0 #0a0a0a, 2px 14px 0 #0a0a0a, 4px 14px 0 #ffffff, 6px 14px 0 #1084d0, 8px 14px 0 #00c800, 10px 14px 0 #00c800, 12px 14px 0 #00c800, 14px 14px 0 #00c800, 16px 14px 0 #00c800, 18px 14px 0 #1084d0, 20px 14px 0 #ffffff, 22px 14px 0 #0a0a0a, 2px 16px 0 #0a0a0a, 4px 16px 0 #ffffff, 6px 16px 0 #1084d0, 8px 16px 0 #1084d0, 10px 16px 0 #00c800, 12px 16px 0 #00c800, 14px 16px 0 #00c800, 16px 16px 0 #1084d0, 18px 16px 0 #1084d0, 20px 16px 0 #ffffff, 22px 16px 0 #0a0a0a, 2px 18px 0 #0a0a0a, 4px 18px 0 #ffffff, 6px 18px 0 #ffffff, 8px 18px 0 #1084d0, 10px 18px 0 #1084d0, 12px 18px 0 #00c800, 14px 18px 0 #1084d0, 16px 18px 0 #1084d0, 18px 18px 0 #ffffff, 20px 18px 0 #ffffff, 22px 18px 0 #0a0a0a, 2px 20px 0 #0a0a0a, 4px 20px 0 #0a0a0a, 6px 20px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #0a0a0a, 12px 20px 0 #0a0a0a, 14px 20px 0 #0a0a0a, 16px 20px 0 #0a0a0a, 18px 20px 0 #0a0a0a, 20px 20px 0 #0a0a0a, 22px 20px 0 #0a0a0a, 8px 22px 0 #0a0a0a, 10px 22px 0 #0a0a0a, 12px 22px 0 #0a0a0a, 14px 22px 0 #0a0a0a, 16px 22px 0 #0a0a0a, 4px 24px 0 #0a0a0a, 6px 24px 0 #0a0a0a, 8px 24px 0 #0a0a0a, 10px 24px 0 #0a0a0a, 12px 24px 0 #0a0a0a, 14px 24px 0 #0a0a0a, 16px 24px 0 #0a0a0a, 18px 24px 0 #0a0a0a, 20px 24px 0 #0a0a0a, 4px 26px 0 #0a0a0a, 6px 26px 0 #c0c0c0, 8px 26px 0 #c0c0c0, 10px 26px 0 #c0c0c0, 12px 26px 0 #c0c0c0, 14px 26px 0 #c0c0c0, 16px 26px 0 #c0c0c0, 18px 26px 0 #c0c0c0, 20px 26px 0 #0a0a0a, 4px 28px 0 #0a0a0a, 6px 28px 0 #0a0a0a, 8px 28px 0 #0a0a0a, 10px 28px 0 #0a0a0a, 12px 28px 0 #0a0a0a, 14px 28px 0 #0a0a0a, 16px 28px 0 #0a0a0a, 18px 28px 0 #0a0a0a, 20px 28px 0 #0a0a0a; }
.ico-dos { background: none; }
.ico-dos::before { box-shadow: 2px 2px 0 #0a0a0a, 4px 2px 0 #0a0a0a, 6px 2px 0 #0a0a0a, 8px 2px 0 #0a0a0a, 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 22px 2px 0 #0a0a0a, 24px 2px 0 #0a0a0a, 26px 2px 0 #0a0a0a, 2px 4px 0 #0a0a0a, 4px 4px 0 #c0c0c0, 6px 4px 0 #c0c0c0, 8px 4px 0 #0a0a0a, 10px 4px 0 #0a0a0a, 12px 4px 0 #0a0a0a, 14px 4px 0 #0a0a0a, 16px 4px 0 #0a0a0a, 18px 4px 0 #0a0a0a, 20px 4px 0 #0a0a0a, 22px 4px 0 #0a0a0a, 24px 4px 0 #0a0a0a, 26px 4px 0 #c0c0c0, 28px 4px 0 #0a0a0a, 2px 6px 0 #0a0a0a, 4px 6px 0 #c0c0c0, 6px 6px 0 #0a0a0a, 8px 6px 0 #ffffff, 10px 6px 0 #ffffff, 12px 6px 0 #ffffff, 14px 6px 0 #ffffff, 16px 6px 0 #ffffff, 18px 6px 0 #ffffff, 20px 6px 0 #ffffff, 22px 6px 0 #ffffff, 24px 6px 0 #0a0a0a, 26px 6px 0 #c0c0c0, 28px 6px 0 #0a0a0a, 2px 8px 0 #0a0a0a, 4px 8px 0 #c0c0c0, 6px 8px 0 #0a0a0a, 8px 8px 0 #ffffff, 10px 8px 0 #ffffff, 12px 8px 0 #0a0a0a, 14px 8px 0 #0a0a0a, 16px 8px 0 #0a0a0a, 18px 8px 0 #0a0a0a, 20px 8px 0 #ffffff, 22px 8px 0 #ffffff, 24px 8px 0 #0a0a0a, 26px 8px 0 #c0c0c0, 28px 8px 0 #0a0a0a, 2px 10px 0 #0a0a0a, 4px 10px 0 #c0c0c0, 6px 10px 0 #0a0a0a, 8px 10px 0 #ffffff, 10px 10px 0 #ffffff, 12px 10px 0 #0a0a0a, 14px 10px 0 #0a0a0a, 16px 10px 0 #0a0a0a, 18px 10px 0 #0a0a0a, 20px 10px 0 #ffffff, 22px 10px 0 #ffffff, 24px 10px 0 #0a0a0a, 26px 10px 0 #c0c0c0, 28px 10px 0 #0a0a0a, 2px 12px 0 #0a0a0a, 4px 12px 0 #c0c0c0, 6px 12px 0 #0a0a0a, 8px 12px 0 #ffffff, 10px 12px 0 #ffffff, 12px 12px 0 #ffffff, 14px 12px 0 #ffffff, 16px 12px 0 #ffffff, 18px 12px 0 #ffffff, 20px 12px 0 #ffffff, 22px 12px 0 #ffffff, 24px 12px 0 #0a0a0a, 26px 12px 0 #c0c0c0, 28px 12px 0 #0a0a0a, 2px 14px 0 #0a0a0a, 4px 14px 0 #c0c0c0, 6px 14px 0 #0a0a0a, 8px 14px 0 #ffffff, 10px 14px 0 #0a0a0a, 12px 14px 0 #0a0a0a, 14px 14px 0 #0a0a0a, 16px 14px 0 #0a0a0a, 18px 14px 0 #0a0a0a, 20px 14px 0 #0a0a0a, 22px 14px 0 #ffffff, 24px 14px 0 #0a0a0a, 26px 14px 0 #c0c0c0, 28px 14px 0 #0a0a0a, 2px 16px 0 #0a0a0a, 4px 16px 0 #c0c0c0, 6px 16px 0 #0a0a0a, 8px 16px 0 #ffffff, 10px 16px 0 #0a0a0a, 12px 16px 0 #0a0a0a, 14px 16px 0 #0a0a0a, 16px 16px 0 #0a0a0a, 18px 16px 0 #0a0a0a, 20px 16px 0 #0a0a0a, 22px 16px 0 #ffffff, 24px 16px 0 #0a0a0a, 26px 16px 0 #c0c0c0, 28px 16px 0 #0a0a0a, 2px 18px 0 #0a0a0a, 4px 18px 0 #c0c0c0, 6px 18px 0 #0a0a0a, 8px 18px 0 #ffffff, 10px 18px 0 #ffffff, 12px 18px 0 #ffffff, 14px 18px 0 #ffffff, 16px 18px 0 #ffffff, 18px 18px 0 #ffffff, 20px 18px 0 #ffffff, 22px 18px 0 #ffffff, 24px 18px 0 #0a0a0a, 26px 18px 0 #c0c0c0, 28px 18px 0 #0a0a0a, 2px 20px 0 #0a0a0a, 4px 20px 0 #c0c0c0, 6px 20px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #0a0a0a, 12px 20px 0 #0a0a0a, 14px 20px 0 #0a0a0a, 16px 20px 0 #0a0a0a, 18px 20px 0 #0a0a0a, 20px 20px 0 #0a0a0a, 22px 20px 0 #0a0a0a, 24px 20px 0 #0a0a0a, 26px 20px 0 #c0c0c0, 28px 20px 0 #0a0a0a, 2px 22px 0 #0a0a0a, 4px 22px 0 #c0c0c0, 6px 22px 0 #c0c0c0, 8px 22px 0 #0a0a0a, 10px 22px 0 #0a0a0a, 12px 22px 0 #0a0a0a, 14px 22px 0 #0a0a0a, 16px 22px 0 #0a0a0a, 18px 22px 0 #0a0a0a, 20px 22px 0 #0a0a0a, 22px 22px 0 #0a0a0a, 24px 22px 0 #0a0a0a, 26px 22px 0 #c0c0c0, 28px 22px 0 #0a0a0a, 2px 24px 0 #0a0a0a, 4px 24px 0 #0a0a0a, 6px 24px 0 #0a0a0a, 8px 24px 0 #0a0a0a, 10px 24px 0 #0a0a0a, 12px 24px 0 #0a0a0a, 14px 24px 0 #0a0a0a, 16px 24px 0 #0a0a0a, 18px 24px 0 #0a0a0a, 20px 24px 0 #0a0a0a, 22px 24px 0 #0a0a0a, 24px 24px 0 #0a0a0a, 26px 24px 0 #0a0a0a; }
.ico-trashfull { background: none; }
.ico-trashfull::before { box-shadow: 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 20px 2px 0 #0a0a0a, 8px 4px 0 #0a0a0a, 10px 4px 0 #dfdfdf, 12px 4px 0 #dfdfdf, 14px 4px 0 #dfdfdf, 16px 4px 0 #dfdfdf, 18px 4px 0 #dfdfdf, 20px 4px 0 #dfdfdf, 22px 4px 0 #0a0a0a, 6px 6px 0 #0a0a0a, 8px 6px 0 #0a0a0a, 10px 6px 0 #0a0a0a, 12px 6px 0 #0a0a0a, 14px 6px 0 #0a0a0a, 16px 6px 0 #0a0a0a, 18px 6px 0 #0a0a0a, 20px 6px 0 #0a0a0a, 22px 6px 0 #0a0a0a, 24px 6px 0 #0a0a0a, 6px 8px 0 #0a0a0a, 8px 8px 0 #c0c0c0, 10px 8px 0 #c0c0c0, 12px 8px 0 #c0c0c0, 14px 8px 0 #c0c0c0, 16px 8px 0 #c0c0c0, 18px 8px 0 #c0c0c0, 20px 8px 0 #c0c0c0, 22px 8px 0 #0a0a0a, 6px 10px 0 #0a0a0a, 8px 10px 0 #0a0a0a, 10px 10px 0 #0a0a0a, 12px 10px 0 #0a0a0a, 14px 10px 0 #0a0a0a, 16px 10px 0 #0a0a0a, 18px 10px 0 #0a0a0a, 20px 10px 0 #0a0a0a, 22px 10px 0 #0a0a0a, 24px 10px 0 #0a0a0a, 8px 12px 0 #0a0a0a, 10px 12px 0 #ffffff, 12px 12px 0 #c0c0c0, 14px 12px 0 #ffffff, 16px 12px 0 #c0c0c0, 18px 12px 0 #ffffff, 20px 12px 0 #c0c0c0, 22px 12px 0 #0a0a0a, 8px 14px 0 #0a0a0a, 10px 14px 0 #c0c0c0, 12px 14px 0 #ffffff, 14px 14px 0 #c0c0c0, 16px 14px 0 #ffffff, 18px 14px 0 #c0c0c0, 20px 14px 0 #ffffff, 22px 14px 0 #0a0a0a, 8px 16px 0 #0a0a0a, 10px 16px 0 #ffffff, 12px 16px 0 #c0c0c0, 14px 16px 0 #ffffff, 16px 16px 0 #c0c0c0, 18px 16px 0 #ffffff, 20px 16px 0 #c0c0c0, 22px 16px 0 #0a0a0a, 8px 18px 0 #0a0a0a, 10px 18px 0 #c0c0c0, 12px 18px 0 #ffffff, 14px 18px 0 #c0c0c0, 16px 18px 0 #ffffff, 18px 18px 0 #c0c0c0, 20px 18px 0 #ffffff, 22px 18px 0 #0a0a0a, 8px 20px 0 #0a0a0a, 10px 20px 0 #ffffff, 12px 20px 0 #c0c0c0, 14px 20px 0 #ffffff, 16px 20px 0 #c0c0c0, 18px 20px 0 #ffffff, 20px 20px 0 #c0c0c0, 22px 20px 0 #0a0a0a, 8px 22px 0 #0a0a0a, 10px 22px 0 #c0c0c0, 12px 22px 0 #ffffff, 14px 22px 0 #c0c0c0, 16px 22px 0 #ffffff, 18px 22px 0 #c0c0c0, 20px 22px 0 #ffffff, 22px 22px 0 #0a0a0a, 10px 24px 0 #0a0a0a, 12px 24px 0 #ffffff, 14px 24px 0 #c0c0c0, 16px 24px 0 #ffffff, 18px 24px 0 #c0c0c0, 20px 24px 0 #ffffff, 22px 24px 0 #0a0a0a, 10px 26px 0 #0a0a0a, 12px 26px 0 #0a0a0a, 14px 26px 0 #0a0a0a, 16px 26px 0 #0a0a0a, 18px 26px 0 #0a0a0a, 20px 26px 0 #0a0a0a; }
.ico-ie { background: none; }
.ico-ie::before { box-shadow: 10px 2px 0 #0a0a0a, 12px 2px 0 #0a0a0a, 14px 2px 0 #0a0a0a, 16px 2px 0 #0a0a0a, 18px 2px 0 #0a0a0a, 6px 4px 0 #0a0a0a, 8px 4px 0 #0a0a0a, 10px 4px 0 #ffffff, 12px 4px 0 #ffffff, 14px 4px 0 #ffffff, 16px 4px 0 #ffffff, 18px 4px 0 #ffffff, 20px 4px 0 #0a0a0a, 22px 4px 0 #0a0a0a, 4px 6px 0 #0a0a0a, 6px 6px 0 #ffffff, 8px 6px 0 #ffffff, 10px 6px 0 #ffffff, 12px 6px 0 #ffffff, 14px 6px 0 #ffffff, 16px 6px 0 #ffffff, 18px 6px 0 #ffffff, 20px 6px 0 #ffffff, 22px 6px 0 #ffffff, 24px 6px 0 #0a0a0a, 2px 8px 0 #0a0a0a, 4px 8px 0 #ffffff, 6px 8px 0 #ffffff, 8px 8px 0 #ffffff, 10px 8px 0 #ffffff, 12px 8px 0 #ffffff, 14px 8px 0 #ffffff, 16px 8px 0 #ffffff, 18px 8px 0 #ffffff, 20px 8px 0 #ffffff, 22px 8px 0 #ffffff, 24px 8px 0 #ffffff, 26px 8px 0 #0a0a0a, 2px 10px 0 #0a0a0a, 4px 10px 0 #ffffff, 6px 10px 0 #ffffff, 8px 10px 0 #ffffff, 10px 10px 0 #ffffff, 12px 10px 0 #ffffff, 14px 10px 0 #ffffff, 16px 10px 0 #ffffff, 18px 10px 0 #ffffff, 20px 10px 0 #ffffff, 22px 10px 0 #ffffff, 24px 10px 0 #ffffff, 26px 10px 0 #0a0a0a, 2px 12px 0 #0a0a0a, 4px 12px 0 #ffffff, 6px 12px 0 #ffffff, 8px 12px 0 #ffffff, 10px 12px 0 #ffffff, 12px 12px 0 #ffffff, 14px 12px 0 #ffffff, 16px 12px 0 #ffffff, 18px 12px 0 #ffffff, 20px 12px 0 #ffffff, 22px 12px 0 #ffffff, 24px 12px 0 #ffffff, 26px 12px 0 #0a0a0a, 2px 14px 0 #0a0a0a, 4px 14px 0 #ffffff, 6px 14px 0 #ffffff, 8px 14px 0 #ffffff, 10px 14px 0 #ffffff, 12px 14px 0 #ffffff, 14px 14px 0 #ffffff, 16px 14px 0 #ffffff, 18px 14px 0 #ffffff, 20px 14px 0 #ffffff, 22px 14px 0 #ffffff, 24px 14px 0 #ffffff, 26px 14px 0 #0a0a0a, 2px 16px 0 #0a0a0a, 4px 16px 0 #ffffff, 6px 16px 0 #ffffff, 8px 16px 0 #ffffff, 10px 16px 0 #ffffff, 12px 16px 0 #ffffff, 14px 16px 0 #ffffff, 16px 16px 0 #ffffff, 18px 16px 0 #ffffff, 20px 16px 0 #ffffff, 22px 16px 0 #ffffff, 24px 16px 0 #ffffff, 26px 16px 0 #0a0a0a, 2px 18px 0 #0a0a0a, 4px 18px 0 #ffffff, 6px 18px 0 #ffffff, 8px 18px 0 #ffffff, 10px 18px 0 #ffffff, 12px 18px 0 #ffffff, 14px 18px 0 #ffffff, 16px 18px 0 #ffffff, 18px 18px 0 #ffffff, 20px 18px 0 #ffffff, 22px 18px 0 #ffffff, 24px 18px 0 #ffffff, 26px 18px 0 #0a0a0a, 2px 20px 0 #0a0a0a, 4px 20px 0 #ffffff, 6px 20px 0 #ffffff, 8px 20px 0 #ffffff, 10px 20px 0 #ffffff, 12px 20px 0 #ffffff, 14px 20px 0 #ffffff, 16px 20px 0 #ffffff, 18px 20px 0 #ffffff, 20px 20px 0 #ffffff, 22px 20px 0 #ffffff, 24px 20px 0 #ffffff, 26px 20px 0 #0a0a0a, 4px 22px 0 #0a0a0a, 6px 22px 0 #ffffff, 8px 22px 0 #ffffff, 10px 22px 0 #ffffff, 12px 22px 0 #ffffff, 14px 22px 0 #ffffff, 16px 22px 0 #ffffff, 18px 22px 0 #ffffff, 20px 22px 0 #ffffff, 22px 22px 0 #ffffff, 24px 22px 0 #0a0a0a, 6px 24px 0 #0a0a0a, 8px 24px 0 #0a0a0a, 10px 24px 0 #ffffff, 12px 24px 0 #ffffff, 14px 24px 0 #ffffff, 16px 24px 0 #ffffff, 18px 24px 0 #ffffff, 20px 24px 0 #0a0a0a, 22px 24px 0 #0a0a0a, 10px 26px 0 #0a0a0a, 12px 26px 0 #0a0a0a, 14px 26px 0 #0a0a0a, 16px 26px 0 #0a0a0a, 18px 26px 0 #0a0a0a; }

.ico-ie::after {
  content: "e";
  position: absolute;
  left: 5px; top: 4px;
  font: bold italic 22px Georgia, "Times New Roman", serif;
  color: #000080;
  text-shadow: 1px 1px 0 #ffd500;
}

.tb-note-ico { background: #fff; box-shadow: inset 0 0 0 2px #808080; }
.tb-note-ico::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 4px;
  width: 6px;
  height: 1.5px;
  background: #1971c2;
  box-shadow: 0 3px #1971c2, 0 6px #1971c2;
}
/* 这三个窗口的标题栏图标之前没有专属 ::after，于是统统退化成 .tb-icon 的绿色 LED 点，
   看着像「同一个图标」。补上各自的简易字形（风格从简，重在可辨识）。 */
.tb-pc-ico { background: #fff; box-shadow: inset 0 0 0 2px #808080; }
.tb-pc-ico::after {
  content: ""; position: absolute; left: 3px; top: 4px;
  width: 7px; height: 5px; background: #1971c2;
  box-shadow: 0 7px #1971c2, 0 12px #1971c2;
}
.tb-mine-ico { background: #c3c3c3; }
.tb-mine-ico::after {
  content: ""; position: absolute; left: 4px; top: 3px;
  width: 8px; height: 8px; border-radius: 50%;
  background: radial-gradient(#fff 0 1px, #000 2px);
  box-shadow: inset 0 0 0 1px #000;
}
.tb-dos-ico { background: #000; }
.tb-dos-ico::after {
  content: ">"; position: absolute; left: 2px; top: 0;
  font: bold 11px ui-monospace, monospace; color: #00d000;
}

/* ───── Win95 窗口公共 ───── */
.win95 {
  position: absolute;
  background: #c0c0c0;
  padding: 3px;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff;
}
.appwin {
  left: 50%;
  top: 42%;
  transform: translate(-50%, -50%);
  width: min(94vw, 470px);
}
/* 每窗口默认尺寸：宽度给足、内区高度用 min-height 保底，
   保证内容一打开就能正常施展（而不是挤成一小条再手动拉） */
#pcWin   { width: min(94vw, 560px); }
#pcWin .fm-frame { min-height: 420px; }
#ieWin   { width: min(94vw, 600px); }
#ieWin .fm-frame { min-height: 360px; }
#readmeWin { width: min(94vw, 520px); }
#readmeWin > .notepad { min-height: 420px; }
#dosWin  { width: min(94vw, 560px); }
#dosWin > .dos-body { min-height: 320px; }
#gameWin > .client { min-height: 300px; }
/* 窗口竖排：标题/菜单/状态栏固定，内容区 flex 撑满 —— 支持拖拽缩放 */
.win95.appwin { display: flex; flex-direction: column; }
.win95.appwin > .notepad,
.win95.appwin > .fm-frame,
.win95.appwin > .dos-body { flex: 1 1 auto; height: auto; }
.win95.appwin > .qq-panel,
.win95.appwin > .qq-chat { flex: 1 1 auto; height: auto; }
.win95.appwin > .notepad { min-height: 160px; }
.win95.appwin > .fm-frame { min-height: 180px; }
.win95.appwin > .dos-body { min-height: 220px; }
/* 最大化：铺满桌面，但为顶部状态栏与底部任务栏（含安全区）让位。
   之前只扣 --tb-h，没算 safe-area，PWA 全屏下底部会被 home 指示条/任务栏吃掉一截。 */
.win95.maxed {
  position: fixed !important;
  left: 0 !important;
  top: var(--safe-t) !important;
  width: 100vw !important;
  height: calc(100dvh - var(--safe-t) - var(--taskbar-h)) !important;
  transform: none !important;
}
/* 标题栏控制按钮：最小化 / 最大化（真 98 的 16×14 立体小钮） */
.wbtn {
  flex: none;
  width: 16px;
  height: 14px;
  padding: 0;
  border: none;
  background: var(--face);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--hi),
              inset -2px -2px var(--sh), inset 2px 2px var(--lt);
}
.wbtn:active {
  box-shadow: inset -1px -1px var(--hi), inset 1px 1px var(--dk),
              inset -2px -2px var(--lt), inset 2px 2px var(--sh);
}
.wbtn::after { content: ''; display: block; }
.wbtn.min::after { width: 6px; height: 2px; background: #000; margin: 0 3px 1px 0; }
.wbtn.max::after { width: 8px; height: 7px; border: 1px solid #000; border-top-width: 2px; background: var(--face); margin-bottom: 2px; }
/* 还原态：两个叠加小方块（前大后小） */
.wbtn.rest::after {
  width: 7px; height: 6px;
  border: 1px solid #000; border-top-width: 2px;
  background: var(--face);
  margin: 0 4px 2px 0;
  box-shadow: 3px -3px 0 0 var(--face), 3px -3px 0 1px #000 inset;
}
/* 右下角缩放手柄：Win98 经典斜纹握把 */
.reshandle {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 15px;
  height: 15px;
  cursor: nwse-resize;
  z-index: 6;
  touch-action: none;
  background:
    repeating-linear-gradient(135deg,
      var(--hi) 0 2px, var(--sh) 2px 4px, transparent 4px 7px)
    bottom right / 13px 13px no-repeat;
}
.reshandle::before {
  content: '';
  position: absolute;
  inset: 0;
}
.titlebar {
  display: flex;
  align-items: center;
  gap: 5px;
  /* Win98 核心改动：标题栏由纯色改为水平渐变（左端 ActiveTitle → 右端 GradientActiveTitle） */
  background: linear-gradient(90deg, var(--title), var(--title-grad));
  color: #fff;
  font-size: 12px;
  font-weight: bold;
  padding: 3px 4px;
  cursor: default;
  touch-action: none;
}
.titlebar .tb-text {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.tb-icon {
  flex: none;
  width: 16px;
  height: 16px;
  background: #000;
  box-shadow: inset 1px 1px 0 #6a6a6a;
  position: relative;
}
.tb-icon::after {
  content: "";
  position: absolute;
  width: 3px;
  height: 3px;
  background: #00d000;
  box-shadow: 3px 0 #00d000, 6px 0 #00d000, 9px 0 #00d000,
              0 3px #00d000, 6px 3px #00d000,
              0 6px #00d000, 3px 6px #00d000, 6px 6px #00d000,
              6px 9px #00d000, 9px 9px #00d000,
              12px 6px #e8394a;
}
.wclose {
  flex: none;
  font: inherit;
  font-size: 11px;
  font-weight: bold;
  line-height: 1;
  width: 16px;
  height: 14px;
  background: #c0c0c0;
  border: none;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff,
              inset -2px -2px #808080, inset 2px 2px #dfdfdf;
}
.wclose:active {
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
}
.menubar {
  display: flex;
  gap: 12px;
  padding: 3px 6px;
  font-size: 12px;
}
.notepad {
  background: #fff;
  margin: 0 3px 3px;
  padding: 8px 10px;
  min-height: 160px;
  overflow: auto;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
  /* 隐藏式滚动条：滚轮/触屏照常滚，不画难看的滚动条轨道 */
  scrollbar-width: none;
}
.notepad::-webkit-scrollbar, .notepad::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.notepad pre {
  font-family: "Courier New", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}

/* ───── 游戏区 ───── */
.client { position: relative; padding: 8px; }
.sunken {
  padding: 3px;
  background: #000;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
  /* 关键修复：凹陷框紧贴画布宽度（原为全宽 block，
     canvas 居中后左右露出大片黑底 = 用户看到的"额外黑边"） */
  width: fit-content;
  margin: 0 auto;
}
canvas#game {
  display: block;
  width: min(84vw, 52vh, 400px);
  height: auto;
  margin: 0 auto;
  background: #000;
  image-rendering: pixelated;
  touch-action: none;
}
/* 最大化：画布跟随窗口放大（内部分辨率 320 不变，CSS 缩放 + 像素风不糊） */
#gameWin.maxed canvas#game { width: min(70vh, 70vw, 640px); }
.overlay {
  position: absolute;
  inset: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.overlay.hide { display: none; }
.dlg {
  background: #c0c0c0;
  padding: 3px;
  min-width: 200px;
  max-width: 82%;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff,
              3px 3px 6px rgba(0,0,0,.35);
}
.dlg-b { padding: 14px 12px 12px; text-align: center; }
.dlg-big { font-size: 19px; font-weight: bold; letter-spacing: 3px; margin-bottom: 8px; }
.dlg-txt { font-size: 12px; line-height: 1.8; color: #222; margin-bottom: 12px; }
.btn95 {
  font: inherit;
  font-size: 12px;
  color: #000;
  background: #c0c0c0;
  border: none;
  padding: 6px 18px;
  min-width: 96px;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff,
              inset -2px -2px #808080, inset 2px 2px #dfdfdf;
}
.btn95:active {
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
}
.statusbar { display: flex; gap: 3px; padding: 0 3px 3px; font-size: 11px; }
.statusbar span {
  padding: 3px 7px;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #808080;
  white-space: nowrap;
}
.statusbar .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.statusbar b { font-weight: bold; }

/* ───── 消息框 ───── */
.msgwin {
  left: 50%;
  top: 38%;
  transform: translate(-50%, -50%);
  width: min(86vw, 340px);
  z-index: 500;
}
.msgbody {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 16px 14px 4px;
  font-size: var(--ui-fs);
  line-height: 1.7;
}
.mtext-wrap { flex: 1; min-width: 0; }
.mtxt { white-space: pre-line; }
.msub {
  white-space: pre-line;
  color: #404040;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid #dfdfdf;
  box-shadow: 0 -1px 0 #fff inset;
}
.micon {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  position: relative;
}
.micon.err { background: #e8394a; }
.micon.err::after {
  content: "×";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 13px;
  font-weight: bold;
}
.micon.info { background: #1971c2; }
.micon.info::after {
  content: "i";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  font-weight: bold;
  font-family: Georgia, serif;
  font-style: italic;
}
.msgbtn { text-align: center; padding: 2px 0 12px; }

/* ───── 任务栏 ───── */
.taskbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 800;
  display: flex;
  align-items: center;
  gap: 4px;
  /* Win98 标准任务栏高度 28px（原 34px 偏大） */
  height: var(--tb-h);
  padding: 2px 3px;
  background: var(--face);
  /* 真 98 的 3D 上移边：顶部 亮线(#fff) + 次亮(#dfdfdf)，无底部装饰 */
  box-shadow: inset 0 1px var(--hi), inset 0 2px var(--lt);
}
.startbtn {
  display: flex;
  align-items: center;
  font-weight: bold;
  font-size: 12px;
  /* 98 的「开始」按钮：左内边距给旗标留位，右侧略宽 */
  padding: 2px 7px 2px 5px;
  min-width: 0;
  height: 24px;
  letter-spacing: .2px;
}
/* Win98 开始按钮旗标：像素波浪四色旗（用 2px 网格 box-shadow 画）
   还原真 98 的「斜飘」旗：红/绿在上、蓝/黄在下，带黑描边与高光 */
.winlogo {
  position: relative;
  width: 18px;
  height: 18px;
  margin: 0 5px 0 0;
  flex: none;
  background: none;
}
.winlogo::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 2px;
  height: 2px;
  box-shadow:
    0px 0px 0 #d8232a,
    2px 0px 0 #d8232a,
    4px 0px 0 #d8232a,
    0px 2px 0 #d8232a,
    2px 2px 0 #ff6b6b,
    4px 2px 0 #d8232a,
    6px 2px 0 #d8232a,
    8px 2px 0 #1e9e28,
    10px 2px 0 #6fdd6f,
    0px 4px 0 #d8232a,
    2px 4px 0 #d8232a,
    4px 4px 0 #d8232a,
    6px 4px 0 #d8232a,
    8px 4px 0 #1e9e28,
    10px 4px 0 #1e9e28,
    12px 4px 0 #1e9e28,
    14px 4px 0 #1e9e28,
    0px 6px 0 #1657d6,
    2px 6px 0 #1657d6,
    4px 6px 0 #1657d6,
    6px 6px 0 #d8232a,
    8px 6px 0 #1e9e28,
    10px 6px 0 #1e9e28,
    12px 6px 0 #1e9e28,
    14px 6px 0 #1e9e28,
    0px 8px 0 #1657d6,
    2px 8px 0 #6f9dff,
    4px 8px 0 #1657d6,
    6px 8px 0 #1657d6,
    8px 8px 0 #f2c500,
    10px 8px 0 #ffe97a,
    12px 8px 0 #1e9e28,
    14px 8px 0 #1e9e28,
    0px 10px 0 #1657d6,
    2px 10px 0 #1657d6,
    4px 10px 0 #1657d6,
    6px 10px 0 #1657d6,
    8px 10px 0 #f2c500,
    10px 10px 0 #f2c500,
    12px 10px 0 #f2c500,
    14px 10px 0 #f2c500,
    6px 12px 0 #1657d6,
    8px 12px 0 #f2c500,
    10px 12px 0 #f2c500,
    12px 12px 0 #f2c500,
    14px 12px 0 #f2c500,
    12px 14px 0 #f2c500,
    14px 14px 0 #f2c500,
    -2px -2px 0 #0a0a0a,
    0px -2px 0 #0a0a0a,
    2px -2px 0 #0a0a0a,
    4px -2px 0 #0a0a0a,
    6px -2px 0 #0a0a0a,
    -2px 0px 0 #0a0a0a,
    6px 0px 0 #0a0a0a,
    8px 0px 0 #0a0a0a,
    10px 0px 0 #0a0a0a,
    12px 0px 0 #0a0a0a,
    -2px 2px 0 #0a0a0a,
    12px 2px 0 #0a0a0a,
    14px 2px 0 #0a0a0a,
    16px 2px 0 #0a0a0a,
    -2px 4px 0 #0a0a0a,
    16px 4px 0 #0a0a0a,
    -2px 6px 0 #0a0a0a,
    16px 6px 0 #0a0a0a,
    -2px 8px 0 #0a0a0a,
    16px 8px 0 #0a0a0a,
    -2px 10px 0 #0a0a0a,
    16px 10px 0 #0a0a0a,
    -2px 12px 0 #0a0a0a,
    0px 12px 0 #0a0a0a,
    2px 12px 0 #0a0a0a,
    4px 12px 0 #0a0a0a,
    16px 12px 0 #0a0a0a,
    4px 14px 0 #0a0a0a,
    6px 14px 0 #0a0a0a,
    8px 14px 0 #0a0a0a,
    10px 14px 0 #0a0a0a,
    16px 14px 0 #0a0a0a,
    10px 16px 0 #0a0a0a,
    12px 16px 0 #0a0a0a,
    14px 16px 0 #0a0a0a,
    16px 16px 0 #0a0a0a;
}
.tb-sep {
  width: 2px;
  height: 22px;
  box-shadow: inset 1px 0 #808080, inset -1px 0 #fff;
}
.tb-tasks { display: flex; gap: 3px; flex: 1; overflow: hidden; }
.taskbtn {
  font: inherit;
  font-size: 11px;
  max-width: 130px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: #c0c0c0;
  border: none;
  padding: 3px 8px;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff,
              inset -2px -2px #808080, inset 2px 2px #dfdfdf;
}
.tray {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  font-size: 11px;
  /* 98 托盘：下沉 + 右侧竖点阵（拖动手柄） */
  box-shadow: inset -1px -1px var(--hi), inset 1px 1px var(--sh);
}
/* 托盘右端竖点阵（两条 1px 竖线，真 98 的拖拽把手） */
.tray::after {
  content: '';
  flex: none;
  width: 2px;
  height: 14px;
  margin-left: 2px;
  box-shadow: inset 1px 0 var(--hi), inset -1px 0 var(--sh);
}

/* ───── 开始菜单 ───── */
.startmenu {
  position: absolute;
  left: 2px;
  bottom: calc(var(--tb-h) + 2px);
  z-index: 900;
  display: flex;
  background: var(--face);
  padding: 3px;
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--lt),
              inset -2px -2px var(--sh), inset 2px 2px #fff,
              4px -2px 8px rgba(0,0,0,.3);
}
.sm-side {
  width: 26px;
  background: linear-gradient(180deg, #1084d0,#000080);
  color: #c0c0c0;
  font-size: 15px;
  font-weight: bold;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  display: flex;
  align-items: center;
  padding: 6px 2px;
  letter-spacing: 1px;
}
.sm-side b { color: #fff; font-weight: normal; }
.sm-list { min-width: 168px; padding: 2px 0; }
.smi {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--ui-fs);
  padding: 6px 18px 6px 8px;
  cursor: default;
}
.smi:not(.dis):hover, .smi.open { background: var(--hl); color: var(--hl-text); }
.smi.dis { color: #808080; }
.sm-arrow { margin-left: auto; font-size: 10px; }
.smi-ico {
  width: 16px;
  height: 16px;
  overflow: hidden;
  position: relative;
  flex: none;
}
.smi-ico .ico { transform: scale(.5); transform-origin: 0 0; }
.smi-ico.ico-shut { background: #e8394a; box-shadow: inset 0 0 0 2px #9c2029; }
.sm-sep { height: 1px; margin: 3px 6px; background: #808080; box-shadow: 0 1px 0 #fff; }
.smi-ico.ico-run {
  background: #fff;
  box-shadow: inset 0 0 0 1px #1971c2;
}
.smi-ico.ico-run::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 6px;
  width: 5px;
  height: 2px;
  background: #1971c2;
  box-shadow: 0 3px #1971c2, 3px -3px 0 0 #f59f00;
}
.smi-ico.ico-help {
  background: #1971c2;
  border-radius: 50%;
}
.smi-ico.ico-help::after {
  content: "?";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font: bold 11px Tahoma, sans-serif;
}

/* ───── 窗口激活态（Win98：非激活标题栏为灰渐变，文字 #c0c0c0）───── */
.win95 .titlebar { background: linear-gradient(90deg, var(--title), var(--title-grad)); }
.win95.inactive .titlebar {
  background: linear-gradient(90deg, var(--title-inact), var(--title-inact-grad));
  color: var(--title-inact-text);
}
.taskbtn.on {
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
  font-weight: bold;
}

/* ───── 小对话框（运行/系统属性/网络/显示属性）───── */
.smalldlg {
  left: 50%;
  top: 40%;
  transform: translate(-50%, -50%);
  width: min(88vw, 380px);
  z-index: 600;
}
.dlg-pad { padding: 12px 12px 4px; }
.run-row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; }
.run-txt { font-size: 12px; line-height: 1.7; }
.run-input-row { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.run-label { font-size: 12px; flex: none; }
.run-input {
  flex: 1;
  min-width: 0;
  font: 12px "Courier New", monospace;
  padding: 5px 6px;
  border: none;
  background: #fff;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #808080,
              inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a;
}
.run-input:focus { outline: none; }
.btn-gap { margin-left: 8px; }
.sys-grid { display: flex; flex-direction: column; gap: 7px; margin-bottom: 10px; }
.sys-row { display: flex; gap: 8px; font-size: 12px; line-height: 1.55; }
.sys-k { flex: none; width: 62px; color: #404040; }
.sys-v { flex: 1; min-width: 0; overflow-wrap: break-word; }

/* ───── 显示属性：色块 ───── */
.prop-label { font-size: 12px; margin-bottom: 9px; }
.prop-swatches { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.swatch {
  width: 44px;
  height: 32px;
  cursor: default;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff,
              inset -2px -2px #808080, inset 2px 2px #dfdfdf;
  padding: 3px;
}
.swatch i {
  display: block;
  width: 100%;
  height: 100%;
}
.swatch.sel { outline: 2px dotted #000; outline-offset: -4px; }

/* ───── 桌面右键/长按菜单 ───── */
.ctxmenu {
  position: absolute;
  z-index: 950;
  min-width: 128px;
  background: #c0c0c0;
  padding: 3px;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff,
              3px 3px 6px rgba(0,0,0,.3);
}
.ctxi {
  font-size: 12px;
  padding: 6px 20px 6px 16px;
  cursor: default;
}
.ctxi:hover { background: #000080; color: #fff; }
.ctx-sep { height: 1px; margin: 3px 4px; background: #808080; box-shadow: 0 1px 0 #fff; }

/* ───── 记事本下拉菜单 ───── */
.menubar { position: relative; }
.mu { padding: 2px 7px; cursor: default; }
.mu:hover, .mu.open { background: #000080; color: #fff; }
.mdrop {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 50;
  min-width: 128px;
  background: #c0c0c0;
  padding: 3px;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff,
              3px 3px 6px rgba(0,0,0,.3);
}
.mdrop .ctxi { padding: 5px 22px 5px 14px; }
/* 扫雷难度菜单：当前档打 ●（其余透明占位防抖动），右侧灰字规格 */
.ctxi { display: flex; align-items: center; }
.ctxi .ctxk { margin-left: auto; padding-left: 14px; color: #808080; font-size: 11px; }
.ctxi[data-lv]::before { content: "●"; margin-right: 5px; visibility: hidden; }
.ctxi[data-lv].cur::before { visibility: visible; color: #000080; }
.ctxi[data-lv].cur { font-weight: bold; }

/* ───── 屏保 / 关机彩蛋 ───── */
#ssaver {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 9998;
  background: #000;
}
#shutdown {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: #000;
  color: #ffa000;
  font: bold 20px/1.6 "MS Sans Serif", Tahoma, "Microsoft YaHei", sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.shut-stage { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.shut-logo { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; }
.shut-wordmark {
  font-size: 26px;
  font-weight: bold;
  color: #c8c8c8;
  letter-spacing: .5px;
  text-align: left;
  line-height: 1.15;
}
.shut-wordmark b { display: block; color: #fff; font-size: 30px; }
.shut-wordmark i { font-style: normal; color: #c8c8c8; font-weight: normal; }
.shut-line {
  font-size: 20px;
  font-weight: bold;
  color: #ffa000;
  text-shadow: 0 0 2px rgba(255,160,0,.35);
}
.shut-small { font-size: 12px; font-weight: 400; color: #a06a00; margin-top: 4px; }

/* ───── 非法操作蓝屏风（假的，纯彩蛋）───── */
#crash {
  position: fixed;
  inset: 0;
  z-index: 9997;
  background: #0000aa;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 14px/1.7 "Courier New", monospace;
}
.crash-box { max-width: 520px; padding: 20px; }
.crash-title { background: #c0c0c0; color: #0000aa; display: inline-block; padding: 1px 8px; margin-bottom: 16px; }
.crash-txt { color: #c0c0c0; font-size: 13px; line-height: 1.6; margin-top: 4px; }
.crash-small { color: #c0c0ff; font-size: 12px; margin-top: 10px; }
.crash-btn { text-align: center; margin-top: 26px; }


/* ───── 开始菜单二级菜单 ───── */
.smi.has-sub { position: relative; }
.sm-arrow { margin-left: auto; padding-left: 12px; font-size: 10px; }
.smsub {
  position: absolute;
  left: calc(100% - 1px);
  top: 0;
  min-width: 168px;
  background: var(--face);
  padding: 3px;
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--lt),
              inset -2px -2px var(--sh), inset 2px 2px #fff,
              3px 3px 6px rgba(0,0,0,.3);
  z-index: 3;
}
.smsub .smi { padding-left: 8px; }
.smi-ico.ico-fav {
  background: #ffe066;
  box-shadow: inset 0 0 0 1px #a08000;
}

/* ───── 文件管理器（iframe 内嵌）───── */
/* ───── IE 浏览器窗口 ───── */
.ie-toolbar {
  display: flex;
  gap: 2px;
  padding: 2px 3px;
  background: var(--face);
}
.ie-btn {
  font-family: inherit;
  font-size: 11px;
  padding: 2px 8px;
  background: var(--face);
  color: #000;
  border: 0;
  cursor: default;
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--hi),
              inset -2px -2px var(--sh), inset 2px 2px var(--lt);
}
.ie-btn:active {
  box-shadow: inset -1px -1px var(--hi), inset 1px 1px var(--dk),
              inset -2px -2px var(--lt), inset 2px 2px var(--sh);
}
.ie-addrbar {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 3px;
  background: var(--face);
}
.ie-addr-label { font-size: 11px; white-space: nowrap; }
.ie-addr {
  flex: 1;
  min-width: 0;
  font-family: "Courier New", monospace;
  font-size: 11px;
  padding: 2px 4px;
  border: 0;
  background: var(--win);
  box-shadow: inset -1px -1px var(--hi), inset 1px 1px var(--sh),
              inset -2px -2px var(--lt), inset 2px 2px var(--dk);
}
/* 标题栏 IE 小图标：白底 + 蓝色 e */
.tb-ie-ico { background: var(--win); }
.tb-ie-ico::after {
  content: "e";
  position: absolute;
  left: 2px; top: 0;
  font: bold italic 12px Georgia, "Times New Roman", serif;
  color: var(--title);
}

.fm-frame { position: relative; height: 380px; min-height: 240px; background: #fff; }
/* iframe 绝对定位铺满：父级高度来自 min-height（height:auto）时，
   百分比高度会解析失败退回默认 150px，导致可视区被削掉一大截 */
.fm-frame iframe { display: block; position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.fm-loading {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #808080; background: #fff;
}
.fm-loading.done { display: none; }
.grow { flex: 1; min-width: 0; }
.grow2 { flex: none; }

/* ───── 扫雷 ───── */
.narrowwin { width: min(94vw, 300px); }
/* 扫雷窗口随网格内容自适应（初级窄、高级自动变宽），封顶 96vw；
   超宽时（窄屏玩高级）mine-client 横向内滚兜底 */
#mineWin { width: max-content; max-width: 96vw; min-width: 0; }
#mineWin .mine-client { overflow-x: auto; scrollbar-width: none; }
.mine-client { background: #c0c0c0; padding: 6px; box-shadow: inset 1px 1px #fff, inset -1px -1px #808080; }
.mine-face {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 5px; margin-bottom: 6px;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #808080,
              inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a;
}
.mine-panel { background: #000; padding: 1px 3px; }
.led {
  font: bold 20px/1.1 "Courier New", monospace;
  color: #ff0000; letter-spacing: 2px;
  text-shadow: 0 0 4px #ff0000;
}
.mine-smiley {
  width: 26px; height: 26px; min-height: 0; padding: 0;
  background: #c0c0c0; position: relative;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff,
              inset -2px -2px #808080, inset 2px 2px #dfdfdf;
}
.mine-smiley:active { box-shadow: inset 1px 1px #0a0a0a, inset -1px -1px #fff,
                                  inset 2px 2px #808080, inset -2px -2px #dfdfdf; }
/* 笑脸按钮：2px 像素点阵，原点钉在按钮中心 translate(-50%,-50%)，
   所有坐标成对（±x）→ 严格左右对称，三种状态不再有歪斜豁口 */
.mine-smiley::after {
  content: ""; position: absolute; left: 13px; top: 13px; width: 2px; height: 2px;
  transform: translate(-50%, -50%);
  background: transparent;
  box-shadow:
    /* 双眼 */ -4px -2px 0 #000, 4px -2px 0 #000,
    /* 微笑弧 */ -4px 2px 0 #000, -2px 4px 0 #000, 0 5px 0 #000,
                 2px 4px 0 #000, 4px 2px 0 #000;
}
/* 胜利：墨镜横条 + 开怀大笑 */
.mine-smiley.win::after {
  box-shadow:
    -6px -2px 0 #000, -4px -2px 0 #000, -2px -2px 0 #000,
     2px -2px 0 #000,  4px -2px 0 #000,  6px -2px 0 #000,
    -4px 3px 0 #000, -2px 4px 0 #000, 0 5px 0 #000,
     2px 4px 0 #000,  4px 3px 0 #000;
}
/* 阵亡：X 眼 + 撇嘴 */
.mine-smiley.dead::after {
  box-shadow:
    -6px -4px 0 #000, -4px -2px 0 #000, -2px -4px 0 #000, -6px 0 0 #000, -2px 0 0 #000,
     2px -4px 0 #000,  4px -2px 0 #000,  6px -4px 0 #000,  2px 0 0 #000,  6px 0 0 #000,
    -4px 5px 0 #000, -2px 4px 0 #000, 0 4px 0 #000, 2px 4px 0 #000, 4px 5px 0 #000;
}
.mine-grid {
  display: grid; gap: 0; background: #c0c0c0; padding: 4px;
  box-shadow: inset 1px 1px #808080, inset -1px -1px #fff,
              inset 2px 2px #0a0a0a, inset -2px -2px #dfdfdf;
  touch-action: manipulation;
}
.cell {
  /* 格子尺寸集中在一个变量上：难度切换 / 最大化放大 / 触屏加大都改它，
     数字、旗子、地雷的像素画全部用 calc 跟随，不会错位 */
  width: var(--cell, 28px); height: var(--cell, 28px);
  display: grid; place-items: center;
  font: bold calc(var(--cell, 28px) * 0.5)/1 "MS Sans Serif", Tahoma, sans-serif;
  background: #c0c0c0; cursor: default;
  box-shadow: inset -2px -2px #808080, inset 2px 2px #fff;
  position: relative;
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;
}
.cell.open {
  box-shadow: inset 1px 1px #808080;
  background: #c0c0c0;
}
.cell.flag::after {
  content: ""; position: absolute;
  left: calc(var(--cell, 28px) * 0.393); top: calc(var(--cell, 28px) * 0.214);
  border-left: calc(var(--cell, 28px) * 0.25) solid #ff0000;
  border-top: calc(var(--cell, 28px) * 0.1786) solid transparent;
  border-bottom: calc(var(--cell, 28px) * 0.1786) solid transparent;
  box-shadow: inset 0 0 0 0 transparent;
}
.cell.flag::before {
  content: ""; position: absolute;
  left: calc(var(--cell, 28px) * 0.2857); top: calc(var(--cell, 28px) * 0.214);
  width: calc(var(--cell, 28px) * 0.0714); height: calc(var(--cell, 28px) * 0.5);
  background: #000;
  box-shadow: calc(var(--cell, 28px) * -0.0714) calc(var(--cell, 28px) * 0.5) 0 1px #000,
              calc(var(--cell, 28px) * 0.0714) calc(var(--cell, 28px) * 0.5) 0 1px #000;
}
.cell.mine { background: #c0c0c0; }
.cell.mine-boomy { background: #ff0000; }
.cell.mine::after {
  content: ""; position: absolute;
  left: calc(var(--cell, 28px) * 0.3214); top: calc(var(--cell, 28px) * 0.3214);
  width: calc(var(--cell, 28px) * 0.2143); height: calc(var(--cell, 28px) * 0.2143);
  border-radius: 50%; background: #000;
  box-shadow: calc(var(--cell, 28px) * -0.1786) 0 #000, calc(var(--cell, 28px) * 0.1786) 0 #000,
              0 calc(var(--cell, 28px) * -0.1786) #000, 0 calc(var(--cell, 28px) * 0.1786) #000,
              calc(var(--cell, 28px) * -0.1429) calc(var(--cell, 28px) * -0.1429) #000,
              calc(var(--cell, 28px) * 0.1429) calc(var(--cell, 28px) * -0.1429) #000,
              calc(var(--cell, 28px) * -0.1429) calc(var(--cell, 28px) * 0.1429) #000,
              calc(var(--cell, 28px) * 0.1429) calc(var(--cell, 28px) * 0.1429) #000;
}
.cell.n1 { color: #0000ff; } .cell.n2 { color: #008000; }
.cell.n3 { color: #ff0000; } .cell.n4 { color: #000080; }
.cell.n5 { color: #800000; } .cell.n6 { color: #008080; }
.cell.n7 { color: #000000; } .cell.n8 { color: #808080; }
.mine-foot { margin-top: 6px; text-align: center; }
.mine-foot .btn95 { font-size: 11px; padding: 3px 10px; min-height: 24px; }
/* 最大化：网格居中铺开（格子尺寸由 JS fitCell 放大），面板呼吸感 */
#mineWin.maxed .mine-grid { width: max-content; margin: 0 auto; }
#mineWin.maxed .mine-client { padding: 12px; }
#mineWin.maxed .mine-face { margin-bottom: 10px; }

/* ───── MS-DOS ───── */
.dos-body {
  background: #000; color: #c0c0c0; padding: 6px 8px;
  font: 13px/1.45 "Courier New", "Lucida Console", monospace;
  min-height: 220px; overflow-y: auto;
  /* 隐藏式滚动条：DOS 里本就该一屏到底，轨道画出来反而假 */
  scrollbar-width: none;
}
.dos-body::-webkit-scrollbar, .dos-body::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.dos-out { white-space: pre-wrap; word-break: break-all; }
.dos-line { display: flex; align-items: baseline; }
.dos-prompt { flex: none; white-space: pre; }
.dos-in {
  flex: 1; min-width: 0; background: transparent; border: 0; color: #c0c0c0;
  font: inherit; padding: 0 0 0 2px; outline: none; caret-color: #c0c0c0;
}
/* 浏览器自动填充会以 !important 级样式强刷白底（:-webkit-autofill），
   无法直接覆盖 background —— 这里用 1000px 内阴影铺黑 + 文字色覆盖，
   把误填进命令行的凭据样式摁回 DOS 黑底灰字，至少观感不失真。 */
.dos-in:-webkit-autofill,
.dos-in:-webkit-autofill:hover,
.dos-in:-webkit-autofill:focus {
  -webkit-text-fill-color: #c0c0c0;
  -webkit-box-shadow: 0 0 0 1000px #000 inset;
  caret-color: #c0c0c0;
  border-radius: 0;
  transition: background-color 99999s ease-in-out 0s;
}
.dos-in:autofill {
  -webkit-text-fill-color: #c0c0c0;
  box-shadow: 0 0 0 1000px #000 inset;
}
/* 运行框同理：填充色统一回白底黑字，不出现淡黄/淡蓝浮层感 */
.run-input:-webkit-autofill,
.run-input:-webkit-autofill:hover,
.run-input:-webkit-autofill:focus {
  -webkit-text-fill-color: #000;
  -webkit-box-shadow: 0 0 0 1000px #fff inset;
  transition: background-color 99999s ease-in-out 0s;
}

/* ───── 关机对话框 / 登录框 ───── */
.shutdlg { width: min(92vw, 420px); }
.shut-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 4px 2px 12px; font-size: var(--ui-fs);
}
.shut-moon {
  flex: none; width: 32px; height: 32px; border-radius: 50%;
  background: radial-gradient(circle at 62% 38%, #ffe066 0 58%, #ffe066 60%, transparent 61%),
              radial-gradient(circle at 34% 32%, #ffe066 0 58%, #ffe066 60%, transparent 61%);
  background-size: 20px 20px, 14px 14px;
  background-position: 6px 6px, 2px 4px;
  background-repeat: no-repeat;
  background-color: #000080;
}
.shut-opts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.radio-row { display: flex; align-items: flex-start; gap: 7px; font-size: var(--ui-fs); cursor: default; line-height: 1.5; }
.radio-row input { flex: none; margin-top: 2px; }
.radio-row em { font-style: normal; color: #404040; }

.logindlg { width: min(92vw, 460px); }
.login-body { display: flex; gap: 16px; padding: 16px 14px; background: #c0c0c0; }
.login-logo {
  flex: none; width: 110px; display: flex; flex-direction: column;
  align-items: center; gap: 8px;
  border-right: 1px solid #808080; box-shadow: 1px 0 0 #fff;
  padding-right: 14px;
}
.login-brand { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
/* 原来的 9px + #808080 在手机屏上基本读不出来；
   深色到 #5a5a5a、字号到 10px，仍保持 98 的小注风格但看得清。 */
.login-sub { font-size: 10px; color: #5a5a5a; white-space: nowrap; letter-spacing: 0; }
.login-brand b { color: #008080; }
.winflag {
  width: 44px; height: 36px;
  background:
    linear-gradient(#ff0000, #ff0000) 0 0 / 20px 16px no-repeat,
    linear-gradient(#00c800, #00c800) 24px 0 / 20px 16px no-repeat,
    linear-gradient(#0000ff, #0000ff) 0 20px / 20px 16px no-repeat,
    linear-gradient(#ffff00, #ffff00) 24px 20px / 20px 16px no-repeat;
}
.winflag.big { width: 66px; height: 54px;
  background:
    linear-gradient(#ff0000, #ff0000) 0 0 / 30px 24px no-repeat,
    linear-gradient(#00c800, #00c800) 36px 0 / 30px 24px no-repeat,
    linear-gradient(#0000ff, #0000ff) 0 30px / 30px 24px no-repeat,
    linear-gradient(#ffff00, #ffff00) 36px 30px / 30px 24px no-repeat;
}
.login-form { flex: 1; min-width: 0; }
.login-hint { font-size: 12px; margin-bottom: 12px; }
.login-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.login-k { flex: none; width: 74px; font-size: 12px; }
.login-input {
  flex: 1; min-width: 0; font: 12px "MS Sans Serif", Tahoma, sans-serif;
  padding: 3px 5px; border: none; background: #fff; min-height: 22px;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #808080,
              inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a;
}
.login-input:focus { outline: none; }
.login-fine { font-size: 11.5px; margin-top: 10px; }
.login-fine input { vertical-align: -1px; }
.login-btns { justify-content: flex-end; padding: 4px 12px 12px; }
.login-hint.err { color: #a00000; font-weight: 700; }

/* ───── 显示属性：屏保下拉 ───── */
.prop-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.prop-k { font-size: 12px; flex: none; }
.prop-select {
  flex: 1; min-width: 0; font: 12px "MS Sans Serif", Tahoma, sans-serif;
  padding: 3px 4px; min-height: 24px; background: #fff;
  border: none; box-shadow: inset -1px -1px #fff, inset 1px 1px #808080,
              inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a;
}
.prop-select:focus { outline: none; }

/* ═══════════════ 复古 QQ（仿 2008）═══════════════
   企鹅图标与其它桌面图标同一套画法：16×16 像素 → box-shadow，2px 网格。
   面板/会话窗口一律用 Win98 的凸凹边框语言，点缀色取 QQ 经典蓝。
   好友头像不写死：由 JS 按 10×10 像素谱生成 box-shadow（见 QQ_JS）。 */
.ico-qq { background: none; }
.ico-qq::before { box-shadow: 14px 2px 0 #0a0a0a,16px 2px 0 #0a0a0a,18px 2px 0 #0a0a0a,20px 2px 0 #0a0a0a,10px 4px 0 #0a0a0a,12px 4px 0 #0a0a0a,14px 4px 0 #22262e,16px 4px 0 #22262e,18px 4px 0 #22262e,20px 4px 0 #22262e,22px 4px 0 #0a0a0a,24px 4px 0 #0a0a0a,8px 6px 0 #0a0a0a,10px 6px 0 #22262e,12px 6px 0 #22262e,14px 6px 0 #ffffff,16px 6px 0 #ffffff,18px 6px 0 #ffffff,20px 6px 0 #ffffff,22px 6px 0 #22262e,24px 6px 0 #22262e,26px 6px 0 #0a0a0a,6px 8px 0 #0a0a0a,8px 8px 0 #22262e,10px 8px 0 #22262e,12px 8px 0 #ffffff,14px 8px 0 #0a0a0a,16px 8px 0 #22262e,18px 8px 0 #22262e,20px 8px 0 #0a0a0a,22px 8px 0 #ffffff,24px 8px 0 #ffffff,26px 8px 0 #22262e,28px 8px 0 #22262e,30px 8px 0 #0a0a0a,6px 10px 0 #0a0a0a,8px 10px 0 #22262e,10px 10px 0 #22262e,12px 10px 0 #ffffff,14px 10px 0 #ffffff,16px 10px 0 #f8b800,18px 10px 0 #f8b800,20px 10px 0 #ffffff,22px 10px 0 #ffffff,24px 10px 0 #22262e,26px 10px 0 #22262e,28px 10px 0 #0a0a0a,6px 12px 0 #0a0a0a,8px 12px 0 #22262e,10px 12px 0 #22262e,12px 12px 0 #ffffff,14px 12px 0 #ffffff,16px 12px 0 #f8b800,18px 12px 0 #f8b800,20px 12px 0 #ffffff,22px 12px 0 #ffffff,24px 12px 0 #22262e,26px 12px 0 #22262e,28px 12px 0 #0a0a0a,8px 14px 0 #0a0a0a,10px 14px 0 #22262e,12px 14px 0 #22262e,14px 14px 0 #ffffff,16px 14px 0 #ffffff,18px 14px 0 #ffffff,20px 14px 0 #ffffff,22px 14px 0 #22262e,24px 14px 0 #22262e,26px 14px 0 #0a0a0a,10px 16px 0 #0a0a0a,12px 16px 0 #22262e,14px 16px 0 #22262e,16px 16px 0 #ffffff,18px 16px 0 #ffffff,20px 16px 0 #22262e,22px 16px 0 #22262e,24px 16px 0 #0a0a0a,8px 18px 0 #0a0a0a,10px 18px 0 #0a0a0a,12px 18px 0 #d82828,14px 18px 0 #d82828,16px 18px 0 #d82828,18px 18px 0 #d82828,20px 18px 0 #d82828,22px 18px 0 #d82828,24px 18px 0 #0a0a0a,26px 18px 0 #0a0a0a,10px 20px 0 #0a0a0a,12px 20px 0 #22262e,14px 20px 0 #22262e,16px 20px 0 #22262e,18px 20px 0 #22262e,20px 20px 0 #22262e,22px 20px 0 #22262e,24px 20px 0 #0a0a0a,6px 22px 0 #0a0a0a,8px 22px 0 #0a0a0a,10px 22px 0 #22262e,12px 22px 0 #22262e,14px 22px 0 #ffffff,16px 22px 0 #ffffff,18px 22px 0 #ffffff,20px 22px 0 #ffffff,22px 22px 0 #22262e,24px 22px 0 #22262e,26px 22px 0 #0a0a0a,28px 22px 0 #0a0a0a,6px 24px 0 #0a0a0a,8px 24px 0 #0a0a0a,10px 24px 0 #22262e,12px 24px 0 #ffffff,14px 24px 0 #ffffff,16px 24px 0 #ffffff,18px 24px 0 #ffffff,20px 24px 0 #ffffff,22px 24px 0 #ffffff,24px 24px 0 #22262e,26px 24px 0 #0a0a0a,28px 24px 0 #0a0a0a,6px 26px 0 #0a0a0a,8px 26px 0 #0a0a0a,10px 26px 0 #22262e,12px 26px 0 #22262e,14px 26px 0 #ffffff,16px 26px 0 #ffffff,18px 26px 0 #ffffff,20px 26px 0 #ffffff,22px 26px 0 #22262e,24px 26px 0 #22262e,26px 26px 0 #0a0a0a,28px 26px 0 #0a0a0a,10px 28px 0 #0a0a0a,12px 28px 0 #22262e,14px 28px 0 #22262e,16px 28px 0 #ffffff,18px 28px 0 #ffffff,20px 28px 0 #22262e,22px 28px 0 #22262e,24px 28px 0 #0a0a0a,8px 30px 0 #f8b800,10px 30px 0 #f8b800,12px 30px 0 #f8b800,14px 30px 0 #f8b800,18px 30px 0 #f8b800,20px 30px 0 #f8b800,22px 30px 0 #f8b800,24px 30px 0 #f8b800,10px 32px 0 #0a0a0a,12px 32px 0 #0a0a0a,14px 32px 0 #0a0a0a,18px 32px 0 #0a0a0a,20px 32px 0 #0a0a0a,22px 32px 0 #0a0a0a; }
/* 16px 场景（标题栏/托盘）：整幅缩半，省得再抄一遍几千字符 */
.ico-qq-s::before { transform: scale(.5); transform-origin: 0 0; }
.tbqq { background: none; box-shadow: none; }

/* ── 复古 QQ：按 QQ 2008 正式版真实界面复刻 ──
   取经典「蓝色经典」皮肤：窗口标题栏蓝渐变、好友列表纯白、
   分组栏浅蓝渐变、底部工具栏浅蓝；字体 Tahoma/宋体 12px。
   结构与真实一致：个人区 → 搜索框 → 分组 Tab → 好友列表（分组可折叠）
   → 底部工具栏。群在独立的「QQ群」Tab 里，与真实 QQ 一致。 */
.qqwin { left: auto; right: 14px; top: 14px; transform: none; width: min(94vw, 288px); }
.qq-panel {
  display: flex; flex-direction: column; min-height: 0;
  background: #f4f9fd; color: #10314c;
  font: 12px/1.4 Tahoma, "宋体", SimSun, "MS Sans Serif", sans-serif;
}
/* 顶部个人区：蓝渐变条 + 头像 + 昵称 + 状态 + 个性签名 */
.qq-top {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; color: #fff;
  background: linear-gradient(180deg, #6dc0f3 0%, #3d97d8 46%, #2b81c2 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .5);
}
.qq-av { flex: none; position: relative; width: 38px; height: 38px; background: #fff; box-shadow: 0 0 0 1px #fff, 0 0 0 2px #17639a; }
.qq-me { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.qq-me-row { display: flex; align-items: center; gap: 5px; }
.qq-me-name {
  flex: 1; min-width: 0; font-size: 13px; font-weight: bold; color: #fff;
  text-shadow: 0 1px 1px rgba(0, 52, 96, .55);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.qq-me-sign {
  font-size: 11px; color: #eaf6ff; cursor: text;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 状态下拉：真实 QQ 在昵称旁边，做成半透明的小选择框 */
.qq-state-sel {
  flex: none; font: 11px Tahoma, "宋体", sans-serif; color: #fff;
  padding: 1px 2px; background: rgba(255, 255, 255, .22); border: 1px solid rgba(255, 255, 255, .55);
  min-height: 18px; cursor: default;
}
.qq-state-sel option { color: #000; background: #fff; }
/* 搜索框行 */
.qq-search { display: flex; align-items: center; gap: 5px; padding: 5px 7px; background: #e9f3fb; border-bottom: 1px solid #b7d3e8; }
.qq-sico { flex: none; position: relative; width: 13px; height: 13px; }
.qq-sico::before {
  content: ''; position: absolute; left: 0; top: 0; width: 8px; height: 8px;
  border: 2px solid #4a7fa8; border-radius: 50%;
}
.qq-sico::after {
  content: ''; position: absolute; left: 7px; top: 8px; width: 6px; height: 2px;
  background: #4a7fa8; transform: rotate(45deg); transform-origin: 0 0;
}
.qq-search input {
  flex: 1; min-width: 0; height: 20px; font: 11px Tahoma, "宋体", sans-serif;
  padding: 1px 5px; color: #10314c; background: #fff; border: 1px solid #86aecd; box-shadow: none;
}
.qq-search input:focus { outline: none; border-color: #2b81c2; }
/* 分组 Tab：好友 / QQ群 / 最近联系人 */
.qq-tabs { display: flex; background: linear-gradient(180deg, #fbfdff, #e4eff9); border-bottom: 1px solid #b7d3e8; }
.qq-tab {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 3px 0 2px; font-size: 11px; color: #1d4e73; cursor: default;
  border-right: 1px solid #d3e3f2;
}
.qq-tab:last-child { border-right: none; }
.qq-tab:hover { background: #eef6fd; }
.qq-tab.on { color: #0b4f7d; font-weight: bold; background: linear-gradient(180deg, #fff, #e9f4fd); box-shadow: inset 0 -2px 0 #2e83c4; }
.qq-tab-ico { position: relative; width: 15px; height: 15px; }
/* 好友列表 */
.qq-list {
  flex: 1 1 auto; min-height: 150px; max-height: 48vh; overflow: auto;
  background: #fff; border-bottom: 1px solid #cfe1f0;
}
.qq-gname {
  display: flex; align-items: center; gap: 4px; padding: 2px 7px;
  font-size: 11px; font-weight: bold; color: #0d4a78; cursor: default;
  background: linear-gradient(180deg, #eaf4fc, #d7e9f8);
  border-top: 1px solid #fff; border-bottom: 1px solid #bcd8ee;
}
.qq-gtri { flex: none; width: 0; height: 0; border-left: 5px solid #2b6ea8; border-top: 4px solid transparent; border-bottom: 4px solid transparent; }
.qq-gname.fold .qq-gtri { border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid #2b6ea8; }
.qq-gnum { margin-left: auto; font-weight: normal; font-size: 10px; color: #4d7fa6; }
.qq-f { display: flex; align-items: center; gap: 7px; padding: 3px 7px; cursor: default; }
.qq-f:hover { background: #eaf5fe; }
.qq-f.sel { background: linear-gradient(180deg, #d9edfc, #c4e1f8); }
.qq-f-av { flex: none; position: relative; width: 20px; height: 20px; background: #fff; box-shadow: 0 0 0 1px #d3e3f1; }
.qq-f.off .qq-f-av { filter: grayscale(1); opacity: .5; }
.qq-f.off .qq-f-name { color: #8b98a5; }
.qq-f-main { flex: 1; min-width: 0; }
.qq-f-name { display: block; font-size: 12px; line-height: 1.35; color: #10314c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qq-f-sign { display: block; font-size: 11px; color: #8b98a5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qq-f.sel .qq-f-name { font-weight: bold; }
.qq-badge {
  flex: none; min-width: 16px; height: 15px; padding: 0 4px; background: #e60012; color: #fff;
  font-size: 10px; line-height: 15px; text-align: center; border-radius: 7px;
}
.qq-empty { padding: 20px 10px; text-align: center; font-size: 11px; color: #8b98a5; }
/* 底部工具栏 */
.qq-bar {
  display: flex; align-items: center; gap: 3px; padding: 3px 5px;
  background: linear-gradient(180deg, #f2f8fd, #e0ecf8); border-top: 1px solid #fff;
}
.qq-bar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 20px; background: none; border: 1px solid transparent; cursor: default;
}
.qq-bar-btn:hover { background: #d8ebfb; border-color: #8fb9d8; }
.qq-online { margin-left: auto; font-size: 10px; color: #4a7796; padding-right: 2px; }
/* 菜单弹出层（主菜单：音效 / 年代穿越 / 状态 / 退出） */
.qq-menu {
  position: absolute; z-index: 60; min-width: 150px; padding: 2px;
  background: #fff; border: 1px solid #8fa8bd; box-shadow: 2px 2px 0 rgba(0, 0, 0, .18);
  font: 12px/1.7 Tahoma, "宋体", sans-serif; color: #10314c;
}
.qq-menu-row { display: flex; align-items: center; gap: 6px; padding: 1px 8px; white-space: nowrap; }
.qq-menu-row:hover { background: #d8ebfb; }
.qq-menu-sep { height: 1px; margin: 3px 2px; background: #dde6ee; }
.qq-menu-lab { font-size: 10px; color: #7b8fa3; padding: 1px 8px; }

/* ── 聊天窗口：真实 QQ2008 布局 ──
   对方信息区 → 消息区（左）+ 资料栏（右）→ 工具栏 → 输入区 → 发送/关闭 */
.qqchatwin { width: min(94vw, 480px); }
.qq-chat {
  display: flex; flex-direction: column; min-height: 0;
  background: #eef5fb; color: #000;
  font: 12px/1.5 Tahoma, "宋体", SimSun, "MS Sans Serif", sans-serif;
}
.qq-ch-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  background: linear-gradient(180deg, #ffffff, #e9f3fb); border-bottom: 1px solid #b7d3e8;
}
.qq-ch-head .qq-av { width: 34px; height: 34px; box-shadow: 0 0 0 1px #fff, 0 0 0 2px #9dbdd8; }
.qq-ch-pear { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.qq-ch-name { font-size: 12px; font-weight: bold; color: #12518a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qq-ch-sign { font-size: 11px; color: #7b8fa3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qq-ch-main { display: flex; flex: 1 1 auto; min-height: 0; }
.qq-ch-log {
  flex: 1 1 auto; min-width: 0; min-height: 200px; max-height: 44vh; overflow: auto;
  background: #fff; padding: 8px 10px; border-right: 1px solid #cfe1f0;
}
.qq-ch-side {
  flex: none; width: 92px; padding: 8px 6px; overflow: auto;
  background: linear-gradient(180deg, #f8fbfe, #edf4fa);
}
.qq-ch-side .qq-av { display: block; width: 46px; height: 46px; margin: 0 auto 6px; box-shadow: 0 0 0 1px #fff, 0 0 0 2px #9dbdd8; }
.qq-ch-sname { font-size: 11px; font-weight: bold; color: #12518a; text-align: center; word-break: break-all; }
.qq-ch-srow { font-size: 10px; color: #7b8fa3; margin-top: 4px; line-height: 1.6; word-break: break-all; }
.qq-ch-srow b { color: #4a7796; font-weight: normal; }
/* 消息行：真实 QQ 格式 —— 「昵称 时间」一行，消息内容另起一行 */
.qq-row { margin: 0 0 8px; }
.qq-bhead { font-size: 11px; line-height: 1.5; }
.qq-bwho { font-weight: bold; color: #12518a; }
.qq-btime { margin-left: 6px; font-size: 10px; color: #9aa7b3; }
.qq-btxt { font-size: 12px; line-height: 1.65; color: #000; word-break: break-word; white-space: pre-wrap; }
.qq-sep { text-align: center; font-size: 10px; color: #93a3b2; margin: 4px 0 8px; }
.qq-sys { text-align: center; font-size: 11px; color: #8a6d1f; margin: 2px 0 6px; }
.qq-typing { display: flex; align-items: center; gap: 4px; padding: 2px 12px 4px; font-size: 11px; color: #7b8fa3; }
.qq-tdot { width: 4px; height: 4px; background: #7b8fa3; border-radius: 50%; animation: qqdot 1.1s ease-in-out infinite; }
.qq-tdot:nth-child(2) { animation-delay: .18s; }
.qq-tdot:nth-child(3) { animation-delay: .36s; }
@keyframes qqdot { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
/* 工具栏：字体 / 表情（均为 QQ2008 真实存在的按钮，不在聊天窗里放任何播放控制） */
.qq-ch-tools {
  display: flex; align-items: center; gap: 2px; padding: 3px 5px;
  background: linear-gradient(180deg, #f8fbfe, #e9f1f9); border-top: 1px solid #cfe1f0;
}
.qq-tool {
  min-width: 22px; height: 20px; padding: 0 4px; background: none; border: 1px solid transparent;
  font: 11px Tahoma, "宋体", sans-serif; color: #12518a; cursor: default;
}
.qq-tool:hover { background: #d8ebfb; border-color: #8fb9d8; }
.qq-tool.on { background: #cfe6fa; border-color: #7aa8cc; }
.qq-tool-sep { width: 1px; height: 14px; margin: 0 3px; background: #cfdde9; }
.qq-ch-tools .spacer { flex: 1; }
/* 输入区：真实 QQ2008 是较大的多行输入区 */
.qq-ch-input { padding: 3px 6px 4px; background: #fff; }
.qq-in {
  display: block; width: 100%; height: 54px; resize: none;
  font: 12px/1.6 Tahoma, "宋体", SimSun, sans-serif; color: #000;
  padding: 3px 5px; background: #fff; border: 1px solid #a8c4dc; box-shadow: none;
}
.qq-in:focus { outline: none; border-color: #2b81c2; }
/* 底部：发送(S) / 关闭(C)，与真实 QQ2008 一致 */
.qq-ch-foot {
  display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 4px 6px 6px;
  background: linear-gradient(180deg, #f2f8fd, #e6eff8); border-top: 1px solid #cfe1f0;
}
.qq-ch-foot .btn95 { font: 12px Tahoma, "宋体", sans-serif; min-height: 22px; padding: 2px 12px; }
/* 大字体模式（工具栏 A 按钮真实切换） */
.qq-ch-log.big { font-size: 14px; }
.qq-ch-log.big .qq-btxt { font-size: 14px; }
/* 表情面板：经典 QQ 默认表情，点一下真的插入 /微笑 这类文本代码 */
.qq-face {
  position: absolute; z-index: 60; width: 176px; padding: 4px;
  background: #fff; border: 1px solid #8fa8bd; box-shadow: 2px 2px 0 rgba(0, 0, 0, .18);
  display: flex; flex-wrap: wrap; gap: 2px;
}
.qq-face-i {
  width: 32px; height: 22px; font-size: 10px; line-height: 22px; text-align: center;
  color: #12518a; cursor: default; border: 1px solid transparent; overflow: hidden;
}
.qq-face-i:hover { background: #d8ebfb; border-color: #8fb9d8; }

/* 菜单里的年代下拉与小按钮 */
.qq-era {
  flex: 1; min-width: 0; font: 11px Tahoma, "宋体", sans-serif; color: #10314c;
  padding: 1px 3px; background: #fff; border: 1px solid #86aecd; min-height: 20px;
}
.qq-era:focus { outline: none; }
.qq-mini { font: 11px Tahoma, "宋体", sans-serif; padding: 1px 8px; min-height: 20px; }

/* 头像像素画：JS 现场生成 SVG data URI（img-src data: 在 CSP 白名单内），
   <img> 撑满容器，pixelated 保证像素感；容器多大画就多大 */
.qq-avimg {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  display: block; image-rendering: pixelated;
}

/* ── 托盘：QQ 启动后驻留，有未读时闪动 ── */
#trayIcons { display: flex; align-items: center; gap: 4px; }
.trayico { position: relative; width: 16px; height: 16px; cursor: default; }
.trayico.unread { animation: qqflash 1s steps(1) infinite; }
/* 任务栏按钮与托盘同步闪：真有未读时才闪，读完好停 */
.taskbtn.flash { animation: qqflash 1s steps(1) infinite; }
@keyframes qqflash { 50% { opacity: 0; } }


/* ───── 小屏适配 ───── */
@media (max-height: 560px) {
  canvas#game { width: min(78vw, 44vh, 400px); }
  .fm-frame { height: 62vh; }
  .dos-body { height: 200px; }
}
/* 触屏：放大扫雷格子到拇指可点，并给 3 秒长按插旗留出空间 */
@media (pointer: coarse) {
  :root { --cell: 32px; }
  .mine-smiley { width: 34px; height: 34px; }
  .mine-foot .btn95 { min-height: 34px; padding: 5px 14px; font-size: 12px; }
}

/* ═══════════════ 移动端深度适配 ═══════════════
   手机 / PWA（standalone）与桌面最大的区别：整页不能只靠绝对定位的仿真桌面，
   否则「上下滑动」在任何位置都无效（PWA 用户最容易感知的缺陷）。
   此处的原则：桌面空白区仍可滚（内容超出即可上下滑），
   窗口一律铺满做一个可滚的「页」，任务栏避让 iPhone 手势条。 */
@media (max-width: 640px) {
  /* 桌面本身不再锁死高度：绝对定位的 #desk 永远等于视口高度（scrollHeight 恒等于
     clientHeight），滚动永远不会触发。窄屏下改回文档流定位，让它随内容长高，
     由 html 承载滚动（#desk 自己不再 overflow:auto，否则会出现内外两级滚动条）。 */
  #desk {
    position: relative;
    inset: auto;
    min-height: calc(100dvh - var(--tb-h) - env(safe-area-inset-bottom, 0px));
    overflow: visible;
    overscroll-behavior-y: contain;
    padding: 6px 6px calc(var(--tb-h) + 14px + env(safe-area-inset-bottom, 0px));
  }
  /* 图标不再绝对定位，改为横排换行，天然参与滚动 */
  .dgroup {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 4px;
    padding: 2px 0 6px;
  }
  .dicon { width: 72px; }
  /* 窗口：初始铺满视口宽度（left:0 + right:0），但不用 !important 钉死——
     钉死了拖拽 JS 写的 inline left/top 永远不生效，手机上窗口就永远挪不动。
     拖动后 inline left 覆盖样式表 left，宽度仍由 width:96vw 兜底，不会散架。 */
  .win95 { max-width: 100vw !important; }
  .appwin, #pcWin, #ieWin, #dosWin, #readmeWin, #mineWin, #gameWin, #qqWin, #qqChatWin { left: 0; right: 0; }
  .qq-ch-side { display: none; }
  .fm-frame { height: auto; min-height: 62vh; }
  /* 任务栏避让 iPhone 底部手势条，并给「开始」按钮留触摸高度 */
  .taskbar {
    height: calc(var(--tb-h) + env(safe-area-inset-bottom, 0px));
    padding-bottom: calc(2px + env(safe-area-inset-bottom, 0px));
  }
  /* 输入类控件 ≥16px：iOS 聚焦时不会自动放大整页（<16px 必缩放） */
  .login-input, .run-input, .dos-in { font-size: 16px; }
  .login-input { min-height: 30px; }
  /* 弹层（登录 / 运行 / 消息框）在手机上留出安全边距 */
  .logindlg { width: min(94vw, 460px); }
}

/* PWA standalone：整页禁止橡皮筋与下拉刷新，滚动交给 #desk */
@media (display-mode: standalone) {
  html, body { overscroll-behavior: none; }
  #desk { overscroll-behavior-y: none; }
}

/* 窄屏 / 手机：body 不再锁死，交给 #desk 承载滚动 */
@media (max-width: 640px) {
  html, body { height: auto; min-height: 100%; overflow-y: auto; overscroll-behavior-y: none; }
  body { display: block; }
}

/* 超小屏（≤480px）：在 640 适配之上再收紧图标与弹层。
   放在 640 之后，使其在窄屏下以「更具体」的断点胜出。 */
@media (max-width: 480px) {
  .dgroup { left: 4px; top: 4px; gap: 2px; }
  .dicon { width: 68px; }
  .appwin, #pcWin, #ieWin, #dosWin, #readmeWin, #qqWin, #qqChatWin { width: 96vw; }
  #pcWin .fm-frame { min-height: 60vh; }
  #mineWin { width: 96vw; }
  canvas#game { width: min(86vw, 48vh, 400px); }
  .taskbar { height: var(--tb-h); }
  .taskbtn { max-width: 96px; }
  /* 扫雷：格子大小走 --cell 变量，9 列初级窄屏也放得下 */
  :root { --cell: 26px; }
  .fm-frame { height: 58vh; }
  .login-body { flex-direction: column; gap: 10px; }
  .login-logo { flex-direction: row; width: auto; border-right: 0; box-shadow: none;
                border-bottom: 1px solid #808080; padding: 0 0 10px; }
  .login-k { width: 66px; font-size: 11.5px; }
  .dos-body { height: 240px; }
}
`;

const HOME_JS = `(function () {
'use strict';

function $(id) { return document.getElementById(id); }
function p2(n) { return (n < 10 ? '0' : '') + n; }
/* 事件委托的安全取祖先：e.target 可能是 document / text node（无 closest），
   直接调 .closest() 会抛 TypeError 并中断该事件的后续处理。 */
function near(node, sel) {
  return node && typeof node.closest === 'function' ? node.closest(sel) : null;
}

/* ───────────── 启动配置（访客链接由服务端下发，前端不内嵌口令）───────────── */
var BOOT = { guestUrl: '/s/', splitTokens: true };
var isAdmin = false;      // 仅内存，不写 localStorage
var adminBase = null;

fetch('/api/boot', { cache: 'no-store' })
  .then(function (r) { return r.json(); })
  .then(function (d) { if (d && d.guestUrl) BOOT = d; })
  .catch(function () { /* 断网时用默认值，文件服务会如实报离线 */ });

/* ───────────── 时钟（整分对齐，不再肉眼可见地跳秒）───────────── */
function tickClock() {
  /* QQ 年代穿越：选过年份后，任务栏时钟显示「当年今日」的此刻 */
  var d = (window.QQ && window.QQ.eraDate()) || new Date();
  var hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  $('clock').textContent = hm;
  $('clock').title = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm;
}
tickClock();
(function clockLoop() {
  /* 睡到下一个整分再刷。原来固定 15s 一刷，页面上会看到分钟数延迟十几秒才变。 */
  var ms = 60000 - (Date.now() % 60000) + 40;
  setTimeout(function () { tickClock(); clockLoop(); }, ms);
})();

/* ───────────── 窗口管理 ───────────── */
var zTop = 10;
function bringTop(el) {
  zTop = zTop > 9000 ? 11 : zTop + 1;
  el.style.zIndex = zTop;
  /* 真 95 细节：激活窗口标题栏蓝色，其余灰色；任务栏按钮同步按下态 */
  document.querySelectorAll('.win95').forEach(function (w) {
    var bar = w.querySelector('.titlebar');
    if (!bar) return;
    if (w === el || w.hidden) { w.classList.remove('inactive'); }
    else { w.classList.add('inactive'); }
  });
  document.querySelectorAll('.taskbtn').forEach(function (b) {
    b.classList.toggle('on', b._win === el && !el.hidden);
  });
}
function setActiveTop() {
  var top = null;
  document.querySelectorAll('.win95').forEach(function (w) {
    if (!w.hidden && (!top || Number(w.style.zIndex || 0) > Number(top.style.zIndex || 0))) top = w;
  });
  if (top) bringTop(top);
  else {
    document.querySelectorAll('.win95').forEach(function (w) { w.classList.remove('inactive'); });
    document.querySelectorAll('.taskbtn').forEach(function (b) { b.classList.remove('on'); });
  }
}
function taskBtnFor(win) {
  var btn = win._taskBtn;
  if (btn) return btn;
  btn = document.createElement('button');
  btn.className = 'taskbtn';
  var t = win.querySelector('.tb-text');
  /* 标题栏带「 - 7喵快传」后缀，任务栏只显示短名（空栅格里放不下长标题） */
  btn.textContent = (t ? t.textContent : '窗口').split(' - ')[0];
  btn._win = win;
  btn.addEventListener('click', function () {
    if (win.hidden) { win.hidden = false; bringTop(win); }
    else if (String(win.style.zIndex) === String(zTop)) { win.hidden = true; setActiveTop(); }
    else { bringTop(win); }
    /* QQ 面板：最小化/还原的瞬间同步任务栏闪动，与托盘未读状态保持一致 */
    if (win.id === 'qqWin' && window.QQ && window.QQ.syncFlash) window.QQ.syncFlash();
  });
  $('tasks').appendChild(btn);
  win._taskBtn = btn;
  return btn;
}
function openWin(win) {
  var wasHidden = win.hidden;
  win.hidden = false;
  bringTop(win);
  taskBtnFor(win);
  /* 首次打开才做视口 clamp：CSS 给的默认尺寸在小屏上可能超出可用区；
     用户手动缩放/移动过（有内联尺寸）的窗口不再干预 */
  if (wasHidden && !win._sizedOnce && !win.style.height) {
    win._sizedOnce = true;
    /* 手机 / PWA：小窗挤压根本没法用（重排后空间更小），
       首次打开直接最大化，内容由窗口内部滚动承载 */
    if (isMobileView()) {
      if (!win.classList.contains('maxed')) maxWin(win);
    } else {
      clampWinSize(win);
    }
  }
}
/* 手机判定：窄视口或触屏优先 —— 用于「窗口一律铺满」策略 */
function isMobileView() {
  return window.innerWidth <= 640 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 900);
}
function clampWinSize(win) {
  /* 用 visualViewport 兜底：iOS 键盘弹出时 innerHeight 不变，
     会造成「clamp 之后仍被键盘遮住」的假象 */
  var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  var maxH = vh - 28;   /* 扣任务栏 */
  var r = win.getBoundingClientRect();
  if (r.height > maxH) win.style.height = maxH + 'px';
  if (r.width > window.innerWidth) win.style.width = window.innerWidth + 'px';
  if (r.top < 0) win.style.top = '4px';
}
function closeWin(win) {
  if (!win) return;
  win.hidden = true;
  if (win._taskBtn) { win._taskBtn.remove(); win._taskBtn = null; }
  if (win.id === 'gameWin' && game.state === 'run') game.pause();
  /* 扫雷同理：窗口藏起来但计时器还在跑，回来发现时间凭空多出几分钟 */
  if (win.id === 'mineWin' && typeof mines !== 'undefined' && mines) mines.stop();
  /* QQ 会话：关窗即停自动播放（否则打字宏会在后台窗口里继续跑） */
  if (win.id === 'qqChatWin' && window.QQ) window.QQ.stopPlay();
  setActiveTop();
}

/* 标题栏拖动（鼠标 + 触屏 pointer events） */
document.querySelectorAll('[data-drag]').forEach(function (bar) {
  bar.addEventListener('pointerdown', function (e) {
    if (near(e.target, 'button')) return;
    var win = bar.closest('.win95');
    bringTop(win);
    var rect = win.getBoundingClientRect();
    var ox = e.clientX - rect.left;
    var oy = e.clientY - rect.top;
    win.style.transform = 'none';
    /* 手机上页面本身可滚动：clientX/Y 是视口坐标，而窗口的 left/top 相对文档，
       必须把抓取时的滚动量补回去，否则滚动后拖拽会错位（桌面端滚动量为 0，不受影响） */
    var sx0 = window.scrollX, sy0 = window.scrollY;
    function mv(ev) {
      var x = Math.min(Math.max(ev.clientX - ox + sx0, 40 - rect.width), sx0 + document.documentElement.clientWidth - 40);
      var y = Math.min(Math.max(ev.clientY - oy + sy0, 0), document.documentElement.scrollHeight - 40);
      win.style.left = x + 'px';
      win.style.top = y + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    // pointercancel 必须一起监听：手机上系统手势、来电、下拉通知栏都会把它发出来，
    // 只听 pointerup 的话监听函数永远留在 window 上，窗口从此黏着手指跑。
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
});

/* 关闭按钮 */
document.querySelectorAll('[data-close]').forEach(function (b) {
  b.addEventListener('click', function () {
    closeWin(b.closest('.win95'));
  });
});

/* ───────────── 窗口控制：最小化 / 最大化 / 缩放（真 98 的窗口钮）───────────── */
function minWin(win) {
  win.hidden = true;
  /* QQ 面板最小化：有未读时任务栏按钮立刻进入闪动状态（不然要等下一条消息才闪） */
  if (win.id === 'qqWin' && window.QQ && window.QQ.syncFlash) window.QQ.syncFlash();
  setActiveTop();
}
function maxWin(win) {
  if (win.classList.contains('maxed')) {
    var r = win._restore || {};
    win.classList.remove('maxed');
    win.style.left = r.left || '';
    win.style.top = r.top || '';
    win.style.width = r.width || '';
    win.style.height = r.height || '';
  } else {
    win._restore = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
    win.style.left = '';
    win.style.top = '';
    win.style.width = '';
    win.style.height = '';
    win.classList.add('maxed');
  }
  /* 按钮的 aria-label/title 必须跟着状态走，否则读屏永远念「最大化」 */
  var mb = win.querySelector('.wbtn.max');
  if (mb) {
    var maxed = win.classList.contains('maxed');
    mb.setAttribute('aria-label', maxed ? '还原' : '最大化');
    mb.title = maxed ? '还原' : '最大化';
  }
  /* 扫雷最大化时格子同步放大（铺满大屏而不是原尺寸缩在角落） */
  if (win.id === 'mineWin') mines.fitCell(win.classList.contains('maxed'));
}
document.querySelectorAll('.win95.appwin, .win95.narrowwin').forEach(function (win) {
  var bar = win.querySelector('.titlebar');
  if (!bar || bar.querySelector('.wbtn')) return;
  var close = bar.querySelector('.wclose');
  var bmin = document.createElement('button');
  bmin.className = 'wbtn min';
  bmin.type = 'button';
  bmin.setAttribute('aria-label', '最小化');
  var bmax = document.createElement('button');
  bmax.className = 'wbtn max';
  bmax.type = 'button';
  bmax.setAttribute('aria-label', '最大化');
  if (close) { bar.insertBefore(bmax, close); bar.insertBefore(bmin, bmax); }
  else { bar.appendChild(bmin); bar.appendChild(bmax); }
  bmin.addEventListener('click', function () { minWin(win); });
  bmax.addEventListener('click', function () { maxWin(win); });
  /* 双击标题栏 = 最大化/还原（真 98 行为） */
  bar.addEventListener('dblclick', function (e) {
    if (near(e.target, 'button')) return;
    maxWin(win);
  });
  /* 右下角缩放手柄 */
  var grip = document.createElement('div');
  grip.className = 'reshandle';
  win.appendChild(grip);
  grip.addEventListener('pointerdown', function (e) {
    if (win.classList.contains('maxed')) return;
    e.preventDefault();
    e.stopPropagation();
    bringTop(win);
    var rect = win.getBoundingClientRect();
    var sx = e.clientX, sy = e.clientY, sw = rect.width, sh = rect.height;
    win.style.transform = 'none';
    if (!win.style.left) win.style.left = rect.left + 'px';
    if (!win.style.top) win.style.top = rect.top + 'px';
    function mv(ev) {
      var maxW = window.innerWidth - parseFloat(win.style.left) - 4;
      var maxH = window.innerHeight - parseFloat(win.style.top) - 4;
      win.style.width = Math.max(280, Math.min(sw + ev.clientX - sx, maxW)) + 'px';
      win.style.height = Math.max(170, Math.min(sh + ev.clientY - sy, maxH)) + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  /* 最大化状态下拖动 = 先还原再跟手（真 98 行为，不再是"禁拖"）。
     手机端窗口首次打开会自动最大化，若继续禁拖，手机上窗口就永远挪不动。
     这里在捕获阶段把还原做掉，随后的正常拖拽逻辑接管（此时已不处于 maxed）。 */
  bar.addEventListener('pointerdown', function (e) {
    if (win.classList.contains('maxed') && !near(e.target, 'button')) maxWin(win);
  }, true);
});

/* ───────────── 消息框 ───────────── */
function msgbox(title, text, kind, opt) {
  opt = opt || {};
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  $('msgIcon').className = 'micon ' + (kind || 'info');
  var sub = $('msgSub');
  if (opt.sub) { sub.textContent = opt.sub; sub.hidden = false; } else { sub.hidden = true; }
  var rt = $('msgRetry');
  if (opt.retry) { rt.hidden = false; rt.textContent = opt.retry; } else { rt.hidden = true; }
  var w = $('msgWin');
  w.hidden = false;
  bringTop(w);
  taskBtnFor(w);
}
$('msgOk').addEventListener('click', function () { closeWin($('msgWin')); });
$('msgRetry').addEventListener('click', function () {
  closeWin($('msgWin'));
  /* 重试 = 回到桌面并刷新文件服务窗口，等价于 98 里"重试"按钮的语义 */
  fmOpen(false);
});

/* ═════════════ 文件服务窗口（我的电脑）═════════════ */
/* 设计取舍：不再"跳转出去"，而是把分享页用 ?embed=1 嵌进窗口里。
   用户的原话是"链接难找、还得复制、想沉浸" —— 嵌进窗口正是对症的方案。
   一个 iframe 同时服务 Guest 和 Administrator，靠 src 不同区分权限，
   UI 完全复用分享页那一套（它已经是 95 风格），不重复造轮子。 */
var fmLoaded = false;

function fmOpen(admin) {
  var w = $('pcWin');
  var frame = $('fmFrame');
  var base = admin && adminBase ? adminBase : BOOT.guestUrl;
  var url = base + '?embed=1';
  if (frame.getAttribute('src') !== url) {
    frame.setAttribute('src', url);
    fmLoaded = false;
    $('fmLoading').classList.remove('done');
  }
  $('pcLabel').textContent = admin && adminBase ? '我的电脑 - 7喵快传 - 管理模式' : '我的电脑 - 7喵快传';
  $('fmWho').textContent = admin && adminBase ? 'Administrator' : 'Guest';
  $('fmStatus').textContent = admin && adminBase ? '管理权限：可删除文件' : '访客权限：可查看与上传';
  openWin(w);
  /* 兜底：iframe 的 load 事件在某些浏览器上对同源 embed 页不触发，
     3 秒后无论如何都收起遮罩，避免用户看到永恒的"正在打开"。 */
  setTimeout(function () { $('fmLoading').classList.add('done'); }, 3000);
}
$('fmFrame').addEventListener('load', function () {
  fmLoaded = true;
  $('fmLoading').classList.add('done');
});

/* ═════════════ IE 浏览器（主页 + 可输地址栏 + 真历史）═════════════
   与「我的电脑」刻意分工：我的电脑 = 文件管理器（直达文件页）；
   IE = 浏览器（先到 98 风格 Internet 主页，地址栏可输入，
   后退/前进/主页走 iframe 真历史），两者不再是同一个页面换皮。 */
var IE_HOME_URL = 'https://w3b.pub/';
var ieStarted = false;
/* 主页 HTML 由服务端 /ie-home 端点下发（IE_HOME_HTML 常量在服务端区）。
   不能用 srcdoc：srcdoc 文档继承父页严格 CSP（style-src 'self'），
   内联 <style> 与 <a onclick> 会被整个拦掉，页面退化成浏览器默认样式。 */

function ieShowLoading() {
  $('ieLoading').classList.remove('done');
  setTimeout(function () { $('ieLoading').classList.add('done'); }, 2500);
}
function ieGoHome() {
  var f = $('ieFrame');
  f.removeAttribute('srcdoc');
  f.setAttribute('src', '/ie-home');
  $('ieAddr').value = IE_HOME_URL;
  ieShowLoading();
}
/* 主页链接回调：path 为空 = 去文件服务 */
window.__ieNav = function (path) {
  var f = $('ieFrame');
  var url;
  if (!path) url = BOOT.guestUrl + '?embed=1';
  else if (path.indexOf('/s/') === 0 && path.indexOf('embed') < 0) url = path + '?embed=1';
  else url = path;
  f.removeAttribute('srcdoc');
  f.setAttribute('src', url);
  $('ieAddr').value = url.charAt(0) === '/' ? location.protocol + '//' + location.host + url : url;
  ieShowLoading();
};
function ieOpen() {
  var f = $('ieFrame');
  if (!ieStarted) {
    ieStarted = true;
    f.setAttribute('src', '/ie-home');
    $('ieAddr').value = IE_HOME_URL;
  }
  openWin($('ieWin'));
}
$('ieFrame').addEventListener('load', function () {
  $('ieLoading').classList.add('done');
  try {
    var loc = $('ieFrame').contentWindow.location;
    if (loc.pathname === '/ie-home' || loc.protocol === 'about:') { $('ieAddr').value = IE_HOME_URL; }
    else if (loc.pathname && loc.pathname.indexOf('/s/') === 0) {
      $('ieAddr').value = location.protocol + '//' + location.host + loc.pathname;
    }
  } catch (e) { /* 外网跨域：地址栏保持用户输入 */ }
});
$('ieBack').addEventListener('click', function () {
  try { $('ieFrame').contentWindow.history.back(); } catch (e) { /* 跨域忽略 */ }
});
$('ieFwd').addEventListener('click', function () {
  try { $('ieFrame').contentWindow.history.forward(); } catch (e) { /* 跨域忽略 */ }
});
$('ieRefresh').addEventListener('click', function () {
  var f = $('ieFrame');
  if (!f.getAttribute('src')) { ieGoHome(); return; }
  try { f.contentWindow.location.reload(); } catch (e) { ieShowLoading(); }
});
$('ieHome').addEventListener('click', ieGoHome);
$('ieAddr').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var v = $('ieAddr').value.trim();
  if (!v || v === IE_HOME_URL) { ieGoHome(); return; }
  if (/^https?:\\/\\//i.test(v)) {
    var p = null;
    try { p = new URL(v).pathname; } catch (err) { p = null; }
    if (p && p.indexOf('/s/') === 0) { window.__ieNav(p); return; }
    window.__ieNav(v);
    return;
  }
  if (v.charAt(0) === '/') { window.__ieNav(v); return; }
  if (/^[A-Za-z0-9._-]{6,40}$/.test(v)) { window.__ieNav('/s/' + v + '/'); return; }
  msgbox('Internet Explorer', '无法识别的地址。\\n可以输入 10 位口令、/s/口令/ 链接或完整网址。', 'err');
});

/* ═════════════ 扫雷 ═════════════ */
var mines = (function () {
  /* 真 98 三档难度：初级 9×9/10、中级 16×16/40、高级 30×16/99。
     列数/行数/雷数全部变量化，游戏菜单（游戏(G)）可随时切换。 */
  var cols = 9, rows = 9, minesCount = 10;
  var bestKey = 'mines95best-9-9-10';
  var grid = $('mineGrid');
  var elCount = $('mineCount'), elTime = $('mineTime');
  var smiley = $('mineSmiley'), elStatus = $('mineStatus'), modeBtn = $('mineMode');
  var cells = [];        // DOM 引用
  var mine = [];         // 是否布雷
  var open = [];         // 是否已挖开
  var flag = [];         // 是否插旗
  var planted = false, dead = false, won = false;
  var left = minesCount, secs = 0, timer = null;
  var flagMode = false;  // 触屏模式：true 时点击 = 插旗
  var best = 0;
  try { best = parseInt(localStorage.getItem(bestKey) || '0', 10) || 0; } catch (e) { best = 0; }

  function led(el, v) {
    // 仿真正 98 行为：旗插多了剩余数为负，数码管显示 "-05" 这样的值。
    // 之前被钳到 0，玩家多插的旗在计数上完全看不出来。
    v = Math.max(-99, Math.min(999, Math.trunc(v)));
    el.textContent = v < 0
      ? '-' + ('00' + Math.abs(v)).slice(-2)
      : ('00' + v).slice(-3);
  }
  function idx(x, y) { return y * cols + x; }

  function build() {
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', auto)';
    grid.innerHTML = '';
    cells = []; mine = []; open = []; flag = [];
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var d = document.createElement('div');
        d.className = 'cell';
        d.setAttribute('data-x', String(x));
        d.setAttribute('data-y', String(y));
        grid.appendChild(d);
        cells.push(d);
        mine.push(false); open.push(false); flag.push(false);
      }
    }
  }

  /* 首点不踩雷：布雷推迟到第一次挖开，且排除首点的 3×3 邻域。
     这是原版行为，也是扫雷最基本的公平性 —— 开局就被炸掉没人会玩第二次。 */
  function plant(sx, sy) {
    var banned = {};
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var nx = sx + dx, ny = sy + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) banned[idx(nx, ny)] = 1;
      }
    }
    var pool = [];
    for (var i = 0; i < cols * rows; i++) if (!banned[i]) pool.push(i);
    /* 极端情况兜底：可用格不足时放开限制 */
    if (pool.length < minesCount) { pool = []; for (var k = 0; k < cols * rows; k++) if (k !== idx(sx, sy)) pool.push(k); }
    for (var m = 0; m < minesCount && pool.length; m++) {
      var pick = Math.floor(Math.random() * pool.length);
      mine[pool[pick]] = true;
      pool.splice(pick, 1);
    }
    planted = true;
  }

  function around(i) {
    var x = i % cols, y = Math.floor(i / cols), out = [];
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) out.push(idx(nx, ny));
      }
    }
    return out;
  }
  function numAt(i) {
    var a = around(i), n = 0;
    for (var k = 0; k < a.length; k++) if (mine[a[k]]) n++;
    return n;
  }

  function paint(i) {
    var d = cells[i];
    d.className = 'cell' + (open[i] ? ' open' : '') + (flag[i] && !open[i] ? ' flag' : '');
    if (open[i]) {
      if (mine[i]) { d.className = 'cell open mine'; return; }
      var n = numAt(i);
      if (n) { d.className = 'cell open n' + n; d.textContent = String(n); }
      else d.textContent = '';
    } else {
      d.textContent = '';
    }
  }
  function paintAll() { for (var i = 0; i < cells.length; i++) paint(i); }

  function dig(i) {
    if (open[i] || flag[i]) return;
    if (mine[i]) { boom(i); return; }
    /* 迭代式展开连通区，避免大区域递归爆栈 */
    var stack = [i];
    while (stack.length) {
      var c = stack.pop();
      if (open[c] || flag[c]) continue;
      open[c] = true;
      paint(c);
      if (numAt(c) === 0) {
        var a = around(c);
        for (var k = 0; k < a.length; k++) if (!open[a[k]] && !mine[a[k]]) stack.push(a[k]);
      }
    }
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startTimer() {
    if (timer) return;
    timer = setInterval(function () {
      secs++;
      led(elTime, secs);
      if (secs >= 999) stopTimer();
    }, 1000);
  }

  function smileyFace(state) {
    smiley.className = 'mine-smiley' + (state === 'win' ? ' win' : state === 'dead' ? ' dead' : '');
  }

  function boom(i) {
    dead = true;
    stopTimer();
    open[i] = true;
    cells[i].className = 'cell open mine mine-boomy';
    for (var k = 0; k < cells.length; k++) {
      if (mine[k] && !flag[k]) { open[k] = true; paint(k); }
      else if (!mine[k] && flag[k]) { cells[k].textContent = '×'; cells[k].className = 'cell open'; }
    }
    smileyFace('dead');
    elStatus.textContent = '踩到雷了。点笑脸重来。';
  }

  function checkWin() {
    var opened = 0;
    for (var i = 0; i < cells.length; i++) if (open[i]) opened++;
    if (opened === cols * rows - minesCount) {
      won = true;
      stopTimer();
      for (var k = 0; k < cells.length; k++) {
        if (mine[k] && !flag[k]) { flag[k] = true; paint(k); }
      }
      led(elCount, 0);
      smileyFace('win');
      if (!best || secs < best) {
        best = secs;
        try { localStorage.setItem(bestKey, String(best)); } catch (e) {}
        elStatus.textContent = '全部排除！新纪录 ' + secs + ' 秒。';
      } else {
        elStatus.textContent = '全部排除！用时 ' + secs + ' 秒（最佳 ' + best + ' 秒）。';
      }
    }
  }

  function toggleFlag(i) {
    if (open[i] || dead || won) return;
    flag[i] = !flag[i];
    left += flag[i] ? -1 : 1;
    led(elCount, left);
    paint(i);
  }

  /* 数字格快捷展开：周围旗数等于该数字时，一次挖开其余邻格。
     原版就有这个行为，熟练玩家全靠它提速。 */
  function chord(i) {
    if (!open[i] || dead || won) return;
    var n = numAt(i);
    if (!n) return;
    var a = around(i), flags = 0, k;
    for (k = 0; k < a.length; k++) if (flag[a[k]]) flags++;
    if (flags !== n) return;
    for (k = 0; k < a.length; k++) if (!flag[a[k]] && !open[a[k]]) dig(a[k]);
    checkWin();
  }

  function reset() {
    stopTimer();
    planted = false; dead = false; won = false;
    left = minesCount; secs = 0;
    led(elCount, left); led(elTime, 0);
    smileyFace('ok');
    elStatus.textContent = '点击格子开始（首点必不踩雷）';
    build();
  }

  /* 切换难度（真 98 规格：初级 9×9/10、中级 16×16/40、高级 30×16/99）。
     格子尺寸按可用宽度自适应（高级 30 列窄窗口也放得下），
     每档难度独立记录最高分。 */
  function fitCell(maxed) {
    var avail = maxed ? window.innerWidth - 60 : Math.min(window.innerWidth * 0.96, 1000) - 30;
    var cap = maxed ? 44 : 28;
    var cell = Math.max(14, Math.min(cap, Math.floor(avail / cols)));
    grid.style.setProperty('--cell', cell + 'px');
  }
  function setLevel(c, r, m) {
    cols = c; rows = r; minesCount = m;
    bestKey = 'mines95best-' + c + '-' + r + '-' + m;
    try { best = parseInt(localStorage.getItem(bestKey) || '0', 10) || 0; } catch (e) { best = 0; }
    fitCell($('mineWin') && $('mineWin').classList.contains('maxed'));
    /* 用户手调过的窗口宽度失效，恢复 max-content 自适应 */
    var w = $('mineWin');
    if (w) w.style.width = '';
    reset();
    elStatus.textContent = '难度：' + c + '×' + r + ' · ' + m + ' 雷';
  }

  function tap(i) {
    if (dead || won) { reset(); return; }
    if (flagMode) { toggleFlag(i); return; }
    if (flag[i] || open[i]) { if (open[i]) chord(i); return; }
    if (!planted) { plant(i % cols, Math.floor(i / cols)); startTimer(); }
    dig(i);
    if (!dead) checkWin();
  }

  /* 事件绑定：一次委托，避免 81 个格子各挂 3 个监听 */
  var pressTimer = null, longPressed = false;
  grid.addEventListener('contextmenu', function (e) {
    var c = near(e.target, '.cell');
    if (!c) return;
    e.preventDefault();
    var i = idx(Number(c.getAttribute('data-x')), Number(c.getAttribute('data-y')));
    toggleFlag(i);
  });
  grid.addEventListener('pointerdown', function (e) {
    var c = near(e.target, '.cell');
    if (!c) return;
    if (e.pointerType === 'mouse') return;
    longPressed = false;
    var i = idx(Number(c.getAttribute('data-x')), Number(c.getAttribute('data-y')));
    pressTimer = setTimeout(function () { longPressed = true; toggleFlag(i); }, 400);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    grid.addEventListener(ev, function () { clearTimeout(pressTimer); });
  });
  grid.addEventListener('click', function (e) {
    var c = near(e.target, '.cell');
    if (!c) return;
    if (longPressed) { longPressed = false; return; }
    tap(idx(Number(c.getAttribute('data-x')), Number(c.getAttribute('data-y'))));
  });
  smiley.addEventListener('click', function () { smiley.blur(); reset(); });
  modeBtn.addEventListener('click', function () {
    flagMode = !flagMode;
    modeBtn.textContent = '模式：' + (flagMode ? '插旗' : '挖开');
    elStatus.textContent = flagMode ? '插旗模式：点格子放旗' : '挖开模式：点格子挖';
  });

  reset();
  return {
    reset: reset,
    /* 关窗时只停表、不重置：半局进度留着，回来还能接着玩 */
    stop: stopTimer,
    setLevel: setLevel,
    fitCell: fitCell,
    get dead() { return dead; },
    get level() { return { cols: cols, rows: rows, mines: minesCount }; },
    get state() { return { dead: dead, won: won, left: left, secs: secs, planted: planted }; }
  };
})();

/* ═════════════ MS-DOS 彩蛋 ═════════════ */
/* 防浏览器自动填充污染输入框：页面里有口令框（登录窗），
   移动端浏览器会把 DOS 命令行 / 运行框误判成用户名输入框，
   在页面加载时把保存的凭据灌进来（且发生在未聚焦状态）。
   真实用户不可能往未聚焦的框里打字 —— 发现即清空。 */
(function () {
  ['dosIn', 'runInput'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', function () {
      if (document.activeElement !== el && el.value) el.value = '';
    });
  });
})();
(function () {
  var out = $('dosOut'), inp = $('dosIn'), body = $('dosBody');
  var history = [], hp = -1;
  function echo(s) { out.textContent += '\\n' + s; body.scrollTop = body.scrollHeight; }
  function run(raw) {
    var line = raw.trim();
    echo('C:\\>' + raw);
    var cmd = line.toLowerCase();
    if (!cmd) return;
    history.push(line); hp = history.length;
    if (cmd === 'help' || cmd === '?') {
      echo('可用命令：\\n  dir      列出文件\\n  ver      版本信息\\n  cls      清屏\\n  date     当前日期\\n  time     当前时间\\n  echo     回显\\n  exit     关闭窗口');
    } else if (cmd === 'dir') {
      fetch('/api/boot').then(function (r) { return r.json(); }).then(function (d) {
        var u = (d && d.guestUrl) || '/s/';
        echo(' 驱动器 C 中的卷是 WIN95\\n 卷的序列号是 1995-0815\\n');
        echo(' C:\\ 的目录\\n');
        echo('读吧     <DIR>          07-14-95  9:50a');
        echo('.            <DIR>          07-14-95  9:50a');
        echo('..           <DIR>          07-14-95  9:50a');
        echo('文件服务      <DIR>          07-14-95 10:00a  -> ' + u);
        echo('        1 个文件             0 字节');
        echo('                          512,000 字节可用');
      }).catch(function () { echo('访问被拒绝。'); });
    } else if (cmd === 'ver') {
      echo('Windows 98 [版本 4.10.1998]\\n（网页仿真版 · 7喵快传）');
    } else if (cmd === 'cls') {
      out.textContent = 'Microsoft(R) Windows 98\\n   (C)Copyright Microsoft Corp 1981-1998.';
    } else if (cmd === 'date' || cmd === 'time') {
      /* 与任务栏时钟同源：QQ 穿越时同步显示当年的日期 */
      var dd = (window.QQ && window.QQ.eraDate()) || new Date();
      echo(dd.getFullYear() + '-' + p2(dd.getMonth() + 1) + '-' + p2(dd.getDate()) + ' ' +
           p2(dd.getHours()) + ':' + p2(dd.getMinutes()) + ':' + p2(dd.getSeconds()));
    } else if (cmd.indexOf('echo ') === 0) {
      echo(raw.trim().slice(5));
    } else if (cmd === 'exit') {
      closeWin($('dosWin'));
    } else if (cmd === 'win') {
      echo('Windows 已经在这个"电脑"里运行了。');
    } else {
      echo("错误的命令或文件名: '" + line + "'\\n输入 help 查看可用命令。");
    }
  }
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var v = inp.value; inp.value = ''; run(v); return; }
    if (e.key === 'ArrowUp' && history.length) {
      hp = Math.max(0, hp - 1); inp.value = history[hp] || ''; e.preventDefault();
    }
    if (e.key === 'ArrowDown' && history.length) {
      hp = Math.min(history.length, hp + 1); inp.value = history[hp] || ''; e.preventDefault();
    }
  });
  $('dosBody').addEventListener('click', function () { inp.focus(); });
})();

/* ═════════════ 应用启动 ═════════════ */
function openApp(name) {
  if (name === 'game') openWin($('gameWin'));
  else if (name === 'readme') openWin($('readmeWin'));
  else if (name === 'pc') fmOpen(false);
  else if (name === 'ie') ieOpen();
  else if (name === 'fav-w3b') window.open('https://w3b.pub/', '_blank', 'noopener');
  else if (name === 'fav-github') window.open('https://github.com/x2it/7M-Drop', '_blank', 'noopener');
  else if (name === 'qq') { if (window.QQ) window.QQ.openPanel(); }
  else if (name === 'net') { fillNet(); openWin($('netWin')); }
  else if (name === 'trash') msgbox('回收站', '回收站是空的。（文件的删除请以 Administrator 身份进行）', 'info');
  else if (name === 'mines') openWin($('mineWin'));
  else if (name === 'dos') { openWin($('dosWin')); setTimeout(function () { $('dosIn').focus(); }, 60); }
  else if (name === 'sysinfo') { fillSys(); openWin($('sysWin')); }
  else if (name === 'run') { var w = $('runWin'); w.hidden = false; bringTop(w); taskBtnFor(w); setTimeout(function () { $('runInput').focus(); }, 60); }
  else if (name === 'props') { openWin($('propWin')); markSwatch(); syncProp(); }
  /* 屏幕保护图标：直接预览屏保，而不是绕去"显示属性"对话框（之前点它会弹属性窗，名不副实） */
  else if (name === 'saver') { saver.start(true); }
  else if (name === 'install') doInstall(true);
  else if (name === 'help') openWin($('readmeWin'));
  else if (name === 'shutdown') openWin($('shutWin'));
}

/* ───────────── 运行：口令 / 链接跳转 ───────────── */
function runGo() {
  var v = $('runInput').value.trim();
  if (!v) return;
  var target = null;
  if (/^https?:\\/\\//i.test(v)) target = v;
  else if (/^\\/s\\/[A-Za-z0-9._-]+\\/$/.test(v)) target = v;
  else if (/^[A-Za-z0-9._-]{6,40}$/.test(v)) target = '/s/' + v + '/';
  if (!target) {
    msgbox('运行', '无法识别的地址。\\n可以输入 10 位口令，或 /s/口令/ 形式的链接。', 'err');
    return;
  }
  closeWin($('runWin'));
  msgbox('运行', '正在打开：' + target, 'info');
  setTimeout(function () { location.href = target; }, 400);
}
$('runGo').addEventListener('click', runGo);
$('runCancel').addEventListener('click', function () { closeWin($('runWin')); });
$('runInput').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') runGo();
});

/* ───────────── 系统属性（全部真实数据）───────────── */
function fillSys() {
  var nav = navigator;
  var rows = [
    ['系统', 'Microsoft Windows 98（网页仿真）'],
    ['处理器', (nav.hardwareConcurrency || '?') + ' 个逻辑核心'],
    ['内存', nav.deviceMemory ? '约 ' + nav.deviceMemory + ' GB' : '未提供'],
    ['显示', window.screen.width + ' × ' + window.screen.height + ' 像素'],
    ['语言', nav.language || '?'],
    ['身份', isAdmin ? 'Administrator（管理权限）' : 'Guest（访客权限）'],
    ['系统日期', (function () {
      var d = (window.QQ && window.QQ.eraDate()) || new Date();
      var s = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' +
              p2(d.getHours()) + ':' + p2(d.getMinutes());
      return window.QQ && window.QQ.era ? s + '（QQ 穿越至 ' + window.QQ.era + ' 年）' : s;
    })()],
    ['内核', (nav.userAgent.match(/(Chrome|Firefox|Safari|Edg)\\/[\\d.]+/) || ['未知浏览器'])[0]],
  ];
  $('sysGrid').innerHTML = rows.map(function (r) {
    return '<div class="sys-row"><span class="sys-k">' + r[0] + ':</span><span class="sys-v"></span></div>';
  }).join('');
  var vs = $('sysGrid').querySelectorAll('.sys-v');
  for (var i = 0; i < rows.length; i++) vs[i].textContent = rows[i][1];
}
$('sysOk').addEventListener('click', function () { closeWin($('sysWin')); });

/* ───────────── 网络信息（全部真实数据）───────────── */
function fillNet() {
  var con = navigator.connection;
  var rows = [
    ['主机', location.host],
    ['协议', location.protocol.replace(':', '').toUpperCase()],
    ['连接', navigator.onLine ? '已连接' : '离线'],
    ['线路', con && con.effectiveType ? con.effectiveType.toUpperCase() : '未知'],
    ['邻居', '仅发现本机（127.0.0.1）'],
  ];
  $('netGrid').innerHTML = rows.map(function (r) {
    return '<div class="sys-row"><span class="sys-k">' + r[0] + ':</span><span class="sys-v"></span></div>';
  }).join('');
  var vs = $('netGrid').querySelectorAll('.sys-v');
  for (var i = 0; i < rows.length; i++) vs[i].textContent = rows[i][1];
}
$('netOk').addEventListener('click', function () { closeWin($('netWin')); });

/* ───────────── 显示属性：换桌面颜色 + 屏保 ───────────── */
var SWATCHES = [
  ['青绿', '#008080', '#007d7d'],
  ['藏蓝', '#000080', '#00006d'],
  ['墨绿', '#036545', '#035f40'],
  ['茄紫', '#4a2b4a', '#452745'],
  ['石墨', '#3a3a3a', '#363636'],
];
function ls(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function applyDesk(i) {
  var s = SWATCHES[i];
  document.documentElement.style.setProperty('--desk1', s[1]);
  document.documentElement.style.setProperty('--desk2', s[2]);
  lsSet('desk95', String(i));
  markSwatch();
}
function markSwatch() {
  var cur = ls('desk95', '0');
  document.querySelectorAll('.swatch').forEach(function (s, i) {
    s.classList.toggle('sel', String(i) === cur);
  });
}
(function initSwatches() {
  var box = $('swatches');
  SWATCHES.forEach(function (s, i) {
    var d = document.createElement('div');
    d.className = 'swatch';
    d.title = s[0];
    d.innerHTML = '<i></i>';
    d.querySelector('i').style.background = s[1];
    d.addEventListener('click', function () { applyDesk(i); });
    box.appendChild(d);
  });
  var saved = parseInt(ls('desk95', '0'), 10) || 0;
  if (saved > 0 && saved < SWATCHES.length) applyDesk(saved);
})();

function syncProp() {
  $('saverPick').value = String(saver.pick());
  $('saverWait').value = String(saver.wait());
}
$('saverPick').addEventListener('change', function () {
  saver.setPick(Number($('saverPick').value));
  $('saverPreview').focus();
});
$('saverWait').addEventListener('change', function () {
  saver.setWait(Number($('saverWait').value));
});
$('saverPreview').addEventListener('click', function () {
  closeWin($('propWin'));
  saver.stop();
  saver.start(true);
});
$('propOk').addEventListener('click', function () { closeWin($('propWin')); });

/* ───────────── 桌面右键 / 长按菜单 ───────────── */
var ctxMenu = $('ctxMenu');
function showCtx(x, y) {
  ctxMenu.hidden = false;
  var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - mh - 40) + 'px';
  bringTopZ(ctxMenu);
}
function bringTopZ(el) { zTop = zTop > 9000 ? 11 : zTop + 1; el.style.zIndex = zTop; }
function hideCtx() { ctxMenu.hidden = true; }
$('desk').addEventListener('contextmenu', function (e) {
  if (near(e.target, '.win95') || near(e.target, '.dicon') || near(e.target, '.startmenu')) return;
  e.preventDefault();
  showCtx(e.clientX, e.clientY);
});
var lpTimer = null, lpPos = null;
$('desk').addEventListener('touchstart', function (e) {
  if (near(e.target, '.win95') || near(e.target, '.dicon') || near(e.target, '.startmenu')) return;
  var t = e.touches[0];
  lpPos = { x: t.clientX, y: t.clientY };
  lpTimer = setTimeout(function () { showCtx(lpPos.x, lpPos.y); }, 550);
}, { passive: true });
$('desk').addEventListener('touchmove', function () { clearTimeout(lpTimer); }, { passive: true });
$('desk').addEventListener('touchend', function () { clearTimeout(lpTimer); });
ctxMenu.addEventListener('click', function (e) {
  var it = near(e.target, '.ctxi');
  if (!it) return;
  hideCtx();
  if (it.getAttribute('data-ctx') === 'refresh') location.reload();
  else if (it.getAttribute('data-ctx') === 'props') openApp('props');
  else if (it.getAttribute('data-ctx') === 'saver') saver.start(true);
});
document.addEventListener('pointerdown', function (e) {
  if (!ctxMenu.hidden && !near(e.target, '.ctxmenu')) hideCtx();
});

/* ───────────── 窗口菜单（真下拉）─────────────
   设计：菜单内容按 **窗口 + 菜单名** 解析，不再全局共用一份。
   踩过的坑：早前所有窗口的「帮助」都渲染同一个 help 模板，
   结果记事本、我的电脑、扫雷点「帮助」全都弹「关于记事本」——
   典型的共用渲染器 + 硬编码内容串台。此处按 winId 分派。 */
var MENUS = {
  file: ['<div class="ctxi" data-act="quit">退出</div>'],
  view: ['<div class="ctxi" data-act="refresh">刷新</div>', '<div class="ctxi" data-act="admin">以管理员登录…</div>'],
  'game': [
    '<div class="ctxi" data-act="lv1" data-lv="9,9,10">初级<span class="ctxk">9×9 · 10 雷</span></div>',
    '<div class="ctxi" data-act="lv2" data-lv="16,16,40">中级<span class="ctxk">16×16 · 40 雷</span></div>',
    '<div class="ctxi" data-act="lv3" data-lv="30,16,99">高级<span class="ctxk">30×16 · 99 雷</span></div>',
    '<div class="ctx-sep"></div>',
    '<div class="ctxi" data-act="new">重新开局</div>',
    '<div class="ctxi" data-act="help2">玩法</div>'
  ],
  /* 记事本：唯一真正叫「记事本」的窗口 */
  'help-readme': ['<div class="ctxi" data-act="about-readme">关于记事本</div>'],
  /* 我的电脑 / 文件服务窗口 */
  'help-pc': ['<div class="ctxi" data-act="about-pc">关于文件服务</div>',
               '<div class="ctx-sep"></div>',
               '<div class="ctxi" data-act="admin">以管理员登录…</div>'],
  /* 扫雷 */
  'help-mine': ['<div class="ctxi" data-act="help2">玩法</div>',
                 '<div class="ctx-sep"></div>',
                 '<div class="ctxi" data-act="about-mine">关于扫雷</div>'],
  /* IE */
  'help-ie': ['<div class="ctxi" data-act="about-ie">关于 Internet Explorer</div>'],
  'file-ie': ['<div class="ctxi" data-act="ie-new">新窗口打开</div>',
               '<div class="ctx-sep"></div>',
               '<div class="ctxi" data-act="quit">关闭</div>'],
  'edit-ie': ['<div class="ctxi" data-act="ie-copy">复制地址</div>',
               '<div class="ctxi" data-act="ie-select">全选地址</div>'],
  'view-ie': ['<div class="ctxi" data-act="ie-refresh">刷新</div>',
               '<div class="ctxi" data-act="ie-stop">停止</div>',
               '<div class="ctx-sep"></div>',
               '<div class="ctxi" data-act="ie-source">查看主页源码</div>'],
  'fav-ie': ['<div class="ctxi" data-act="fav-w3b">知行工作室 · 官网<span class="ctxk">w3b.pub</span></div>',
              '<div class="ctxi" data-act="fav-github">开源仓库 · 源码<span class="ctxk">github.com/x2it/7M-Drop</span></div>',
              '<div class="ctx-sep"></div>',
              '<div class="ctxi" data-act="ie-home">IE 起始页</div>',
              '<div class="ctxi" data-act="ie-file">7喵快传 · 文件服务</div>'],
};
/* 按窗口 id 取菜单键：无 data-mu* 的菜单（IE）也能正确分派 */
function menuKeyFor(mu, win) {
  var base = mu.getAttribute('data-mu') || mu.getAttribute('data-mu2') || mu.getAttribute('data-mu3');
  var label = (mu.textContent || '').charAt(0);
  var keys = { '文': 'file', '查': 'view', '编': 'edit', '收': 'fav', '帮': 'help', '游': 'game' };
  base = base || keys[label] || '';
  var id = win ? win.id : '';
  if (base === 'help') {
    if (id === 'readmeWin') return 'help-readme';
    if (id === 'pcWin') return 'help-pc';
    if (id === 'mineWin') return 'help-mine';
    if (id === 'ieWin') return 'help-ie';
    return 'help-readme';
  }
  if (id === 'ieWin' && (base === 'file' || base === 'edit' || base === 'view' || base === 'fav')) {
    return base + '-ie';
  }
  return base;
}
document.querySelectorAll('.mu').forEach(function (mu) {
  mu.addEventListener('click', function (e) {
    e.stopPropagation();
    var win = mu.closest('.win95');
    var kind = menuKeyFor(mu, win);
    var old = mu.parentElement.querySelector('.mdrop');
    if (old) { old.remove(); mu.classList.remove('open'); return; }
    document.querySelectorAll('.mdrop').forEach(function (d) { d.remove(); });
    document.querySelectorAll('.mu.open').forEach(function (m) { m.classList.remove('open'); });
    var items = MENUS[kind];
    if (!items) return;                 /* 无内容的菜单不弹空壳 */
    var drop = document.createElement('div');
    drop.className = 'mdrop';
    drop.innerHTML = items.join('');
    /* 扫雷「游戏」菜单：给当前难度打上 ● 选中标记 */
    if (kind === 'game' && mines.level) {
      var lv = mines.level;
      drop.querySelectorAll('.ctxi[data-lv]').forEach(function (it) {
        var p = it.getAttribute('data-lv').split(',').map(Number);
        if (p[0] === lv.cols && p[1] === lv.rows && p[2] === lv.mines) it.classList.add('cur');
      });
    }
    mu.classList.add('open');
    mu.parentElement.appendChild(drop);
    drop.addEventListener('click', function (ev) {
      var act = ev.target.closest('.ctxi');
      if (!act) return;
      drop.remove();
      mu.classList.remove('open');
      var a = act.getAttribute('data-act');
      /* ── 通用 ── */
      if (a === 'quit') closeWin(mu.closest('.win95'));
      else if (a === 'admin') askAdmin();
      else if (a === 'refresh') {
        var rw = mu.closest('.win95');
        var rid = rw ? rw.id : '';
        if (rid === 'pcWin') { var rf = $('fmFrame'); if (rf) rf.setAttribute('src', rf.getAttribute('src')); }
        else if (rid === 'ieWin') { var ri = $('ieFrame'); if (ri) ri.setAttribute('src', ri.getAttribute('src')); }
        else if (rid === 'mineWin') mines.reset();
        else location.reload();
      }
      else if (a === 'new') mines.reset();
      else if (a === 'lv1' || a === 'lv2' || a === 'lv3') {
        var p = act.getAttribute('data-lv').split(',').map(Number);
        mines.setLevel(p[0], p[1], p[2]);
      }
      /* ── 各窗口自己的「关于」与帮助 ── */
      else if (a === 'about-readme') msgbox('关于记事本', 'Windows 98 记事本（网页仿真版）。\\n此处展示本站的 readme.txt。\\n菜单「文件 → 退出」可关闭窗口。', 'info');
      else if (a === 'about-pc') msgbox('关于文件服务', '我的电脑里嵌着 7喵快传 的文件服务页。\\n以访客身份浏览与上传；\\n菜单「查看 → 以管理员登录」可切换管理权限。', 'info');
      else if (a === 'about-mine') msgbox('关于扫雷', 'Windows 98 扫雷（网页仿真版）。\\n首点必不踩雷，三档难度，本地记录最高分。\\n右键或长按插旗。', 'info');
      else if (a === 'about-ie') msgbox('关于 Internet Explorer', 'Internet Explorer 5.0（网页仿真版）。\\n地址栏可输入口令 / 路径 / 网址，\\n前进后退走真实导航历史。', 'info');
      else if (a === 'help2') msgbox('扫雷玩法', '左键挖开，右键插旗。\\n数字表示周围 8 格的地雷数。\\n首点必不踩雷。\\n菜单「游戏」可切换三档难度。\\n触屏：长按插旗，或用下方「模式」按钮切换。', 'info');
      /* ── IE 专属 ── */
      else if (a === 'ie-refresh') { var ie = $('ieFrame'); if (ie) ie.setAttribute('src', ie.getAttribute('src')); }
      else if (a === 'ie-stop') { /* 仿真语义：本页加载即完成，无需真打断 */ }
      else if (a === 'ie-new') window.open($('ieAddr').value || '/', '_blank', 'noopener');
      else if (a === 'ie-copy') {
        var v = $('ieAddr').value || '';
        try { navigator.clipboard.writeText(v); msgbox('Internet Explorer', '地址已复制到剪贴板。\\n' + v, 'info'); }
        catch (err) { msgbox('Internet Explorer', '复制失败，请手动选择地址栏内容。', 'err'); }
      }
      else if (a === 'ie-select') { var ad = $('ieAddr'); ad.focus(); ad.select(); }
      else if (a === 'ie-source') window.open('/ie-home', '_blank', 'noopener');
      else if (a === 'ie-home') window.__ieNav(null);
      else if (a === 'ie-file') window.__ieNav(BOOT.guestUrl);
      else if (a === 'fav-w3b') window.open('https://w3b.pub/', '_blank', 'noopener');
      else if (a === 'fav-github') window.open('https://github.com/x2it/7M-Drop', '_blank', 'noopener');
    });
  });
});
document.addEventListener('pointerdown', function (e) {
  if (!near(e.target, '.menubar')) {
    document.querySelectorAll('.mdrop').forEach(function (d) { d.remove(); });
    document.querySelectorAll('.mu.open').forEach(function (m) { m.classList.remove('open'); });
  }
});

/* ───────────── 桌面图标：单击选中，再点打开（兼容双击/触屏） ───────────── */
var lastIcon = null, lastIconT = 0;
document.querySelectorAll('.dicon').forEach(function (ic) {
  /* 图标是纯 div，屏幕阅读器读不出它是可点的。
     role/aria-label 在运行时从标签文本取，新增图标不用再单独维护。 */
  ic.setAttribute('role', 'button');
  var lb = ic.querySelector('.dlabel');
  if (lb && lb.textContent) ic.setAttribute('aria-label', lb.textContent.trim());
  function activate() {
    document.querySelectorAll('.dicon.sel').forEach(function (o) { o.classList.remove('sel'); });
    ic.classList.add('sel');
  }
  ic.addEventListener('click', function () {
    var now = Date.now();
    if (lastIcon === ic && now - lastIconT < 450) {
      openApp(ic.getAttribute('data-app'));
      ic.classList.remove('sel');
      lastIcon = null;
    } else {
      activate();
      lastIcon = ic;
      lastIconT = now;
    }
  });
  ic.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      openApp(ic.getAttribute('data-app'));
    }
  });
});
document.getElementById('desk').addEventListener('pointerdown', function (e) {
  if (!near(e.target, '.dicon') && !near(e.target, '.win95') && !near(e.target, '.startmenu')) {
    document.querySelectorAll('.dicon.sel').forEach(function (o) { o.classList.remove('sel'); });
    lastIcon = null;
  }
});

/* ───────────── 开始菜单（含真二级菜单）───────────── */
var startMenu = $('startMenu');
function hideSubs() {
  document.querySelectorAll('.smsub').forEach(function (s) { s.hidden = true; });
  document.querySelectorAll('.smi.has-sub').forEach(function (s) { s.classList.remove('open'); });
}
$('startBtn').addEventListener('click', function (e) {
  e.stopPropagation();
  startMenu.style.zIndex = zTop + 5;
  startMenu.hidden = !startMenu.hidden;
  if (startMenu.hidden) hideSubs();
});
startMenu.addEventListener('click', function (e) {
  var sub = near(e.target, '.smi.has-sub');
  if (sub) {
    var id = 'smsub-' + sub.getAttribute('data-sub');
    var panel = $(id);
    var wasOpen = panel && !panel.hidden;
    hideSubs();
    if (panel && !wasOpen) {
      panel.hidden = false;
      sub.classList.add('open');
      panel.style.top = (sub.offsetTop - 3) + 'px';
    }
    return;
  }
  var item = near(e.target, '.smi');
  if (!item || item.classList.contains('dis')) return;
  var app = item.getAttribute('data-app');
  if (!app) return;
  startMenu.hidden = true;
  hideSubs();
  openApp(app);
});
document.addEventListener('pointerdown', function (e) {
  if (!startMenu.hidden && !near(e.target, '.startmenu') && !near(e.target, '#startBtn')) {
    startMenu.hidden = true;
    hideSubs();
  }
});

/* ═════════════ PWA：安装到桌面 ═════════════ */
var deferredPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  deferredPrompt = e;
  /* 首次访问且未以独立模式运行：只问一次，不反复骚扰 */
  if (!ls('ask95', '')) {
    lsSet('ask95', '1');
    setTimeout(function () {
      msgbox('安装', '要把这台"电脑"装到你的桌面上吗？\\n装好后可以像普通应用一样直接打开。\\n\\n想安装请再点一次「安装到桌面」图标。', 'info');
    }, 1200);
  }
});
function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function doInstall(manual) {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function (r) {
      if (r && r.outcome === 'accepted') msgbox('安装', '已开始安装。', 'info');
      deferredPrompt = null;
    }).catch(function () {});
    return;
  }
  if (standalone()) { if (manual) msgbox('安装', '已经以独立应用方式运行了。', 'info'); return; }
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    msgbox('安装到桌面', 'iOS 请点击浏览器底部的「分享」按钮，\\n然后选择「添加到主屏幕」。', 'info');
    return;
  }
  msgbox('安装到桌面', '当前浏览器没有提供一键安装入口。\\n可以试试 Chrome / Edge 的地址栏右侧安装图标，\\n或浏览器菜单里的「安装应用」。', 'info');
}
window.addEventListener('appinstalled', function () {
  deferredPrompt = null;
  msgbox('安装', '已安装到桌面。', 'info');
});

/* ═════════════ 关机三选一 → 登录 ═════════════ */
$('shutOk').addEventListener('click', function () {
  var v = 'off';
  document.querySelectorAll('input[name="shutopt"]').forEach(function (r) { if (r.checked) v = r.value; });
  closeWin($('shutWin'));
  if (v === 'sleep') {
    /* 真 95 里"休眠"就是直接黑屏进省电态，不弹登录 */
    saver.start(true);
    return;
  }
  if (v === 'dos') { openApp('dos'); return; }
  showShutdown();
});
$('shutCancel').addEventListener('click', function () { closeWin($('shutWin')); });
$('shutHelp').addEventListener('click', function () {
  msgbox('关闭 Windows', '休眠：进入屏幕保护程序。\\n关闭计算机：退出当前用户，回到登录界面。\\nMS-DOS 方式：打开 DOS 提示符窗口。', 'info');
});

var shutdownEl = $('shutdown');
function showShutdown() {
  shutdownEl.hidden = false;
  if (game.state === 'run') game.pause();
}
shutdownEl.addEventListener('pointerdown', function () {
  shutdownEl.hidden = true;
  wake();
  showLogin();
});

/* ───────────── 登录框 ───────────── */
var loginWin = $('loginWin');
function showLogin() {
  isAdmin = false;
  adminBase = null;
  $('loginUser').value = 'Guest';
  $('loginPass').value = '';
  $('loginHint').textContent = '键入用户名和口令以登录。';
  $('loginHint').className = 'login-hint';
  loginWin.hidden = false;
  bringTop(loginWin);
  setTimeout(function () { $('loginPass').focus(); }, 80);
}
function askAdmin() {
  $('loginUser').value = 'Administrator';
  $('loginHint').textContent = '请输入 Administrator 口令。';
  $('loginHint').className = 'login-hint';
  loginWin.hidden = false;
  bringTop(loginWin);
  $('loginPass').value = '';
  setTimeout(function () { $('loginPass').focus(); }, 80);
}
function loginFail(msg) {
  $('loginHint').textContent = msg;
  $('loginHint').className = 'login-hint err';
  $('loginPass').focus();
  $('loginPass').select();
}
function doLogin() {
  var user = $('loginUser').value;
  var pass = $('loginPass').value;
  if (user !== 'Administrator') {
    /* Guest 无需口令 —— 真 95 的访客账户就是这样，也不违背"不要复杂" */
    isAdmin = false; adminBase = null;
    loginWin.hidden = true;
    fmOpen(false);
    return;
  }
  if (!pass) { loginFail('请输入口令。'); return; }
  var btn = $('loginOk');
  btn.disabled = true;
  fetch('/api/admin-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: user, pass: pass }),
  }).then(function (r) {
    return r.json().then(function (j) { return { ok: r.ok, j: j }; });
  }).then(function (res) {
    btn.disabled = false;
    if (!res.ok || !res.j.ok) { loginFail((res.j && res.j.error) || '登录失败。'); return; }
    isAdmin = true;
    adminBase = res.j.url;
    loginWin.hidden = true;
    $('loginPass').value = '';
    fmOpen(true);
  }).catch(function () {
    btn.disabled = false;
    loginFail('无法连接服务器，请稍后重试。');
  });
}
$('loginOk').addEventListener('click', doLogin);
$('loginCancel').addEventListener('click', function () { loginWin.hidden = true; });
$('loginHelp').addEventListener('click', function () {
  msgbox('登录 Windows 98', 'Guest：无需口令，可查看、下载和上传文件。\\nAdministrator：需要密码，额外可以删除文件。\\n\\n密码由服务端保管，请查看启动日志。', 'info');
});
$('loginPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
$('loginUser').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginPass').focus(); });

/* ═════════════ 贪吃蛇 ═════════════ */
var game = (function () {
  var N = 20, CELL = 16;
  var cv = $('game');
  var ctx = cv.getContext('2d');
  var elScore = $('score');
  var elBest = $('best');
  var elStatus = $('status');
  var overlay = $('overlay');
  var dlgBig = $('dlgBig');
  var dlgTxt = $('dlgTxt');
  var btn = $('btn');

  var snake, dir, nextDir, food, score, speed, timer;
  var state = 'idle';
  var best = 0;
  try { best = parseInt(ls('snake95best', '0'), 10) || 0; } catch (e) { best = 0; }
  elBest.textContent = String(best);

  function setCell(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
  }
  function drawBoard() {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, N * CELL, N * CELL);
    ctx.fillStyle = '#161616';
    for (var i = 0; i <= N; i++) {
      ctx.fillRect(i * CELL, 0, 1, N * CELL);
      ctx.fillRect(0, i * CELL, N * CELL, 1);
    }
  }
  function draw() {
    drawBoard();
    ctx.fillStyle = '#e8394a';
    ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
    ctx.fillStyle = '#ffc4ca';
    ctx.fillRect(food.x * CELL + 4, food.y * CELL + 4, 3, 3);
    for (var i = snake.length - 1; i >= 0; i--) {
      setCell(snake[i].x, snake[i].y, i === 0 ? '#7dff5a' : '#00c818');
    }
  }
  function placeFood() {
    var occ = {}, free = [], x, y, i;
    for (i = 0; i < snake.length; i++) occ[snake[i].x + '_' + snake[i].y] = 1;
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      if (!occ[x + '_' + y]) free.push({ x: x, y: y });
    }
    food = free[Math.floor(Math.random() * free.length)];
    if (!food) food = { x: 0, y: 0 };
  }
  function hud(s) { elStatus.textContent = s; }
  function reset() {
    snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    dir = { x: 1, y: 0 };
    nextDir = dir;
    score = 0;
    speed = 160;
    elScore.textContent = '0';
    placeFood();
    draw();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, speed);
  }
  function stopTimer() { clearTimeout(timer); timer = null; }
  function tick() {
    if (state !== 'run') return;
    step();
    if (state === 'run') schedule();
  }
  function step() {
    dir = nextDir;
    var h = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (h.x < 0 || h.y < 0 || h.x >= N || h.y >= N) return gameOver();
    var willEat = (h.x === food.x && h.y === food.y);
    var lim = willEat ? snake.length : snake.length - 1;
    for (var i = 0; i < lim; i++) {
      if (snake[i].x === h.x && snake[i].y === h.y) return gameOver();
    }
    snake.unshift(h);
    if (willEat) {
      score++;
      elScore.textContent = String(score);
      if (score % 4 === 0 && speed > 80) speed -= 12;
      placeFood();
    } else {
      snake.pop();
    }
    draw();
  }
  function gameOver() {
    state = 'over';
    stopTimer();
    if (score > best) {
      best = score;
      lsSet('snake95best', String(best));
      elBest.textContent = String(best);
    }
    dlgBig.textContent = '游戏结束';
    dlgTxt.innerHTML = '得分 ' + score + ' &middot; 最高 ' + best;
    btn.textContent = '再来一局';
    overlay.classList.remove('hide');
    hud('结束');
  }
  function start() {
    reset();
    state = 'ready';
    overlay.classList.add('hide');
    hud('按方向键 / 滑动 开始');
  }
  function startRun() {
    state = 'run';
    hud('进行中');
    schedule();
  }
  function pause() {
    if (state === 'run') { state = 'pause'; stopTimer(); hud('已暂停'); }
    else if (state === 'pause') { state = 'run'; hud('进行中'); schedule(); }
  }
  function setDir(nx, ny) {
    if (state === 'idle' || state === 'over') start();
    if (state === 'ready') {
      if (!(nx === -dir.x && ny === -dir.y)) nextDir = { x: nx, y: ny };
      startRun();
      return;
    }
    if (state !== 'run') return;
    if (nx === -dir.x && ny === -dir.y) return;
    nextDir = { x: nx, y: ny };
  }

  var KEY = {
    'ArrowUp': [0, -1], 'ArrowDown': [0, 1], 'ArrowLeft': [-1, 0], 'ArrowRight': [1, 0],
    'w': [0, -1], 's': [0, 1], 'a': [-1, 0], 'd': [1, 0],
    'W': [0, -1], 'S': [0, 1], 'A': [-1, 0], 'D': [1, 0]
  };

  document.addEventListener('keydown', function (ev) {
    var d = KEY[ev.key];
    if (d) {
      if ($('gameWin').hidden) return;
      ev.preventDefault();
      setDir(d[0], d[1]);
      return;
    }
    if (ev.key === ' ' || ev.key === 'Enter') {
      if ($('gameWin').hidden) return;
      ev.preventDefault();
      if (state === 'run' || state === 'pause') pause();
      else if (state === 'ready') startRun();
      else start();
    }
  });

  btn.addEventListener('click', function () {
    btn.blur();
    start();
  });

  var tsx = 0, tsy = 0, tracking = false;
  cv.addEventListener('touchstart', function (ev) {
    var t = ev.changedTouches[0];
    tsx = t.clientX;
    tsy = t.clientY;
    tracking = true;
  }, { passive: true });
  cv.addEventListener('touchmove', function (ev) {
    if (!tracking) return;
    ev.preventDefault();
    var t = ev.changedTouches[0];
    var dx = t.clientX - tsx;
    var dy = t.clientY - tsy;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    tsx = t.clientX;
    tsy = t.clientY;
    if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 1 : -1, 0);
    else setDir(0, dy > 0 ? 1 : -1);
  }, { passive: false });
  cv.addEventListener('touchend', function (ev) {
    if (!tracking) return;
    tracking = false;
    var t = ev.changedTouches[0];
    var dx = t.clientX - tsx;
    var dy = t.clientY - tsy;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {
      if (state === 'pause') pause();
      else if (state === 'ready') startRun();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state === 'run') pause();
  });

  reset();

  return { get state() { return state; }, pause: pause };
})();

/* ═════════════ 屏保：3 款可切换 ═════════════ */
/* 用户反馈"只有黑色流星雨，有点丑，不够细腻"。
   所以这里做了三件事：
     1) 把星空从"方块雨"改成带径向渐变的圆点 + 色差，近亮远暗；
     2) 补两款 95 原厂的经典：飞行窗口、三维管道；
     3) 显示属性里能选，运行时按 ← → 也能切。 */
var saver = (function () {
  var KINDS = [
    { id: 'star', name: '星空' },
    { id: 'fly', name: '飞行窗口' },
    { id: 'maze', name: '三维迷宫' },
    { id: 'pipe', name: '三维管道' },
  ];
  var scv = $('ssaver');
  var sctx = scv.getContext('2d');
  var on = false, raf = null, kind = 0, waitMs = 30000;
  var lastAct = Date.now();
  var previewMode = false;
  var stars = [], flyers = [], pipes = [];
  var W = 0, H = 0;

  /* ── 持久化 ── */
  var savedKind = parseInt(ls('saver95', '0'), 10);
  if (!(savedKind >= 0 && savedKind < KINDS.length)) savedKind = 0;
  kind = savedKind;
  var savedWait = parseInt(ls('saver95wait', '30000'), 10);
  if (!(savedWait >= 0 && savedWait <= 600000)) savedWait = 30000;
  waitMs = savedWait;

  /* ── 下拉填充 ── */
  (function fillPicker() {
    var sel = $('saverPick');
    KINDS.forEach(function (k, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = k.name;
      sel.appendChild(o);
    });
  })();

  function size() {
    /* 高 DPI 适配：画布物理像素 = CSS 像素 × DPR（上限 2 保性能），
       绘制坐标系仍用 CSS 像素，线条粗细观感一致 */
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    scv.width = Math.round(W * dpr);
    scv.height = Math.round(H * dpr);
    scv.style.width = W + 'px';
    scv.style.height = H + 'px';
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ═════════ 星空 Starfield ═════════
     严格按 Win98 原版：纯白像素方块从中心加速飞出，近大方小，
     无渐变、无色差、无 glow。低透明残影保留（原版 CRT 上也有拖影）。 */
  function initStars() {
    stars = [];
    var targetPx = W * H * 42;
    var n = Math.min(1500, Math.max(90, Math.floor(targetPx / 2600)));
    for (var i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * 2 - 1,
        y: Math.random() * 2 - 1,
        z: Math.random(),
        pz: 0
      });
    }
  }
  function drawStars() {
    sctx.fillStyle = 'rgba(0,0,0,0.42)';
    sctx.fillRect(0, 0, W, H);
    var cx = W / 2, cy = H / 2, f = Math.max(W, H) * 0.5;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.pz = s.z;
      s.z -= 0.0045 + s.z * 0.012;
      if (s.z <= 0.02) {
        s.x = Math.random() * 2 - 1;
        s.y = Math.random() * 2 - 1;
        s.z = 1 + Math.random() * 0.3;
        s.pz = s.z;
      }
      var k = 0.55 / s.z;
      var px = cx + s.x * f * k;
      var py = cy + s.y * f * k;
      if (px < -8 || py < -8 || px > W + 8 || py > H + 8) {
        s.x = Math.random() * 2 - 1;
        s.y = Math.random() * 2 - 1;
        s.z = 1;
        continue;
      }
      /* 近处方块大（3px 级），远处缩到 1px；对齐整数像素保持硬边 */
      var depth = 1 - s.z;
      var bsz = Math.max(1, Math.round(depth * 3));
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(Math.round(px), Math.round(py), bsz, bsz);
    }
  }

  /* ═════════ 飞行窗口 Flying Windows ═════════
     原版与星空同一份代码，只是把白方块换成 Windows 四色旗精灵。
     此前画成"窗口盒子"是错的，现在重画为飘动的四色旗。 */
  function makeFlyer(big) {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      z: big ? 0.92 : Math.random() * 0.55 + 0.12,
      vz: 0.006 + Math.random() * 0.012,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5
    };
  }
  function initFlyers() {
    flyers = [];
    for (var i = 0; i < 6; i++) flyers.push(makeFlyer(i < 2));
  }
  /* 四色旗：红左上、绿右上、蓝左下、黄右下，平行四边形整体向右上飘 */
  function drawFlag(cx0, cy0, s) {
    if (s < 4) {
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(Math.round(cx0), Math.round(cy0), 2, 2);
      return;
    }
    var b = Math.max(1, s * 0.07);        // 块间黑缝
    var q = (s - b) / 2;                  // 每块边长
    var skew = s * 0.09;                  // 顶边右移量（飘动感；过大会散架）
    var FLAGC = [['#d4000a', 0, 0], ['#007c30', q + b, 0], ['#0050be', 0, q + b], ['#ffd500', q + b, q + b]];
    for (var i = 0; i < 4; i++) {
      var c = FLAGC[i];
      var x0 = cx0 - s / 2 + c[1];
      var y0 = cy0 - s / 2 + c[2];
      sctx.fillStyle = c[0];
      sctx.beginPath();
      sctx.moveTo(x0 + skew, y0);
      sctx.lineTo(x0 + skew + q, y0);
      sctx.lineTo(x0 + q, y0 + q);
      sctx.lineTo(x0, y0 + q);
      sctx.closePath();
      sctx.fill();
    }
  }
  function drawFlyers() {
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, W, H);
    for (var i = 0; i < flyers.length; i++) {
      var f = flyers[i];
      f.z += f.vz;
      f.x += f.vx * f.z * 2;
      f.y += f.vy * f.z * 2;
      if (f.z > 1.6) { flyers[i] = makeFlyer(false); continue; }
      drawFlag(f.x, f.y, f.z * Math.min(W, H) * 0.34);
    }
  }

  /* ═════════ 三维迷宫 3D Maze ═════════
     Wolfenstein 式光线投射（DDA）：红砖墙 + 灰天花板 + 棕木地板，
     相机沿左手规则自动走迷宫；走到终点格重新生成一座迷宫。
     2px 一列渲染，兼得性能与像素颗粒感。 */
  var MAZE_W = 15, MAZE_H = 15;
  var mazeGrid = [];
  var mCamX = 1.5, mCamY = 1.5, mAngle = 0;
  var mTargetDir = null;        // 决策出的目标方向（离散 0..3）
  var mLastCell = '';           // 上次决策所在的格子，防止重复决策
  var mGoal = { x: MAZE_W - 2, y: MAZE_H - 2 };
  var DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];

  function genMaze() {
    mazeGrid = [];
    for (var y = 0; y < MAZE_H; y++) {
      var row = [];
      for (var x = 0; x < MAZE_W; x++) row.push(1);
      mazeGrid.push(row);
    }
    var stack = [[1, 1]];
    mazeGrid[1][1] = 0;
    var holes = [[2, 0], [-2, 0], [0, 2], [0, -2]];
    while (stack.length) {
      var cur = stack[stack.length - 1];
      var nbs = [];
      for (var i = 0; i < 4; i++) {
        var nx = cur[0] + holes[i][0], ny = cur[1] + holes[i][1];
        if (nx > 0 && ny > 0 && nx < MAZE_W - 1 && ny < MAZE_H - 1 && mazeGrid[ny][nx] === 1) nbs.push([nx, ny]);
      }
      if (nbs.length) {
        var nb = nbs[Math.floor(Math.random() * nbs.length)];
        mazeGrid[(cur[1] + nb[1]) / 2][(cur[0] + nb[0]) / 2] = 0;
        mazeGrid[nb[1]][nb[0]] = 0;
        stack.push(nb);
      } else stack.pop();
    }
    mGoal = { x: MAZE_W - 2, y: MAZE_H - 2 };
    mazeGrid[mGoal.y][mGoal.x] = 0;
    /* 砸几个随机洞，减少死胡同的挫败感 */
    for (var k = 0; k < 8; k++) {
      var hx = 1 + Math.floor(Math.random() * (MAZE_W - 2));
      var hy = 1 + Math.floor(Math.random() * (MAZE_H - 2));
      mazeGrid[hy][hx] = 0;
    }
  }
  function initMaze() {
    genMaze();
    mCamX = 1.5; mCamY = 1.5; mAngle = 0;
    mTargetDir = null; mLastCell = '';
  }
  /* 左手规则：优先左转 → 直行 → 右转 → 掉头。每进入一个新格的中心才决策一次。 */
  function mazeThink() {
    var gx = Math.floor(mCamX), gy = Math.floor(mCamY);
    var key = gx + '_' + gy;
    if (key === mLastCell) return;
    var fx = mCamX - gx, fy = mCamY - gy;
    if (fx > 0.40 && fx < 0.60 && fy > 0.40 && fy < 0.60) {
      mLastCell = key;
      var curDir = ((Math.round(mAngle / (Math.PI / 2)) % 4) + 4) % 4;
      var order = [(curDir + 3) % 4, curDir, (curDir + 1) % 4, (curDir + 2) % 4];
      for (var i = 0; i < 4; i++) {
        var d = DIRS4[order[i]];
        if (mazeGrid[gy + d[1]] && mazeGrid[gy + d[1]][gx + d[0]] === 0) {
          mTargetDir = order[i];
          return;
        }
      }
    }
  }
  function mazeMove() {
    mazeThink();
    /* 平滑转向：把当前角推进到目标方向（离散 90°） */
    if (mTargetDir !== null) {
      var tAng = mTargetDir * (Math.PI / 2);
      var diff = tAng - mAngle;
      if (Math.abs(diff) > 0.03) { mAngle += (diff > 0 ? 1 : -1) * 0.055; return; }
      mAngle = tAng;
      mTargetDir = null;
    }
    /* 前进 + 分轴碰撞（身体半径 0.22） */
    var dvx = Math.cos(mAngle), dvy = Math.sin(mAngle);
    var spd = 0.045, r = 0.22;
    var nx = mCamX + dvx * spd, ny = mCamY + dvy * spd;
    if (mazeGrid[Math.floor(mCamY)] && mazeGrid[Math.floor(mCamY)][Math.floor(nx + (dvx >= 0 ? r : -r))] === 0) mCamX = nx;
    if (mazeGrid[Math.floor(ny + (dvy >= 0 ? r : -r))] && mazeGrid[Math.floor(ny + (dvy >= 0 ? r : -r))][Math.floor(mCamX)] === 0) mCamY = ny;
    /* 到达终点：重新生成 */
    if (Math.floor(mCamX) === mGoal.x && Math.floor(mCamY) === mGoal.y) {
      genMaze();
      mCamX = 1.5; mCamY = 1.5; mAngle = 0;
      mTargetDir = null; mLastCell = '';
    }
  }
  function drawMaze() {
    mazeMove();
    var halfH = Math.floor(H / 2);
    /* 天花板（石棉瓦灰）与地板（木棕） */
    sctx.fillStyle = '#6e6e6e';
    sctx.fillRect(0, 0, W, halfH);
    sctx.fillStyle = '#7a5230';
    sctx.fillRect(0, halfH, W, H - halfH);
    /* 地板扫描线：越远越密，制造纵深 */
    sctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (var sy = halfH + 4; sy < H; sy += Math.max(2, Math.floor((sy - halfH) / 14))) {
      sctx.fillRect(0, sy, W, 1);
    }
    var dirX = Math.cos(mAngle), dirY = Math.sin(mAngle);
    var planeX = -dirY * 0.66, planeY = dirX * 0.66;
    var step = 2;   // 2px 一列
    for (var col = 0; col < W; col += step) {
      var cameraX = 2 * col / W - 1;
      var rdx = dirX + planeX * cameraX;
      var rdy = dirY + planeY * cameraX;
      var mapX = Math.floor(mCamX), mapY = Math.floor(mCamY);
      var dX = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      var dY = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      var sX = rdx < 0 ? -1 : 1, sY = rdy < 0 ? -1 : 1;
      var sdX = (rdx < 0 ? (mCamX - mapX) : (mapX + 1 - mCamX)) * dX;
      var sdY = (rdy < 0 ? (mCamY - mapY) : (mapY + 1 - mCamY)) * dY;
      var side = 0, hit = 0, guard = 0;
      while (!hit && guard < 64) {
        if (sdX < sdY) { sdX += dX; mapX += sX; side = 0; }
        else { sdY += dY; mapY += sY; side = 1; }
        if (mazeGrid[mapY] && mazeGrid[mapY][mapX] === 1) hit = 1;
        guard++;
      }
      if (!hit) continue;
      var dist = side === 0 ? (sdX - dX) : (sdY - dY);
      dist = Math.max(0.08, dist);
      var lineH = Math.floor(H / dist);
      var y0 = Math.max(0, halfH - (lineH >> 1));
      var y1 = Math.min(H, halfH + (lineH >> 1));
      /* 红砖色：y 向墙面暗 30%，远处向黑雾衰减 */
      var fog = 1 / (1 + dist * 0.22);
      var base = side === 0 ? [176, 74, 56] : [120, 50, 38];
      var rr = Math.round(base[0] * fog);
      var gg = Math.round(base[1] * fog);
      var bb = Math.round(base[2] * fog);
      sctx.fillStyle = 'rgb(' + rr + ',' + gg + ',' + bb + ')';
      sctx.fillRect(col, y0, step, y1 - y0);
      /* 砖缝：按墙面 y 坐标画横线（每 0.5 世界单位一条） */
      if (lineH > 40) {
        sctx.fillStyle = 'rgba(0,0,0,0.30)';
        var wy = side === 0 ? (mCamY + dist * rdy) : (mCamX + dist * rdx);
        var wallX = (wy - Math.floor(wy));
        var brickRow = (side === 0 ? (mCamY + dist * rdy) : (mCamX + dist * rdx));
        var phase = (brickRow * 2) % 1;
        var seamY = y0 + lineH * (phase > 0.5 ? phase - 0.5 : phase) * 0.5;
        for (var by = seamY; by < y1; by += Math.max(8, lineH * 0.25)) {
          sctx.fillRect(col, Math.floor(by), step, 1);
        }
        void wallX;
      }
    }
    /* 接近终点时叠加半透明笑脸（原版终点物） */
    var gdx = mGoal.x + 0.5 - mCamX, gdy = mGoal.y + 0.5 - mCamY;
    var gd = Math.sqrt(gdx * gdx + gdy * gdy);
    if (gd < 3.2) {
      var a = Math.max(0.15, 1 - gd / 3.2) * 0.85;
      var gr = Math.max(24, H * 0.10 * (1.6 - gd / 3.2));
      sctx.save();
      sctx.globalAlpha = a;
      sctx.fillStyle = '#ffd500';
      sctx.beginPath();
      sctx.arc(W / 2, H / 2, gr, 0, Math.PI * 2);
      sctx.fill();
      sctx.fillStyle = '#0a0a0a';
      sctx.beginPath();
      sctx.arc(W / 2 - gr * 0.32, H / 2 - gr * 0.18, gr * 0.10, 0, Math.PI * 2);
      sctx.arc(W / 2 + gr * 0.32, H / 2 - gr * 0.18, gr * 0.10, 0, Math.PI * 2);
      sctx.fill();
      sctx.strokeStyle = '#0a0a0a';
      sctx.lineWidth = Math.max(2, gr * 0.08);
      sctx.beginPath();
      sctx.arc(W / 2, H / 2 + gr * 0.05, gr * 0.52, 0.25 * Math.PI, 0.75 * Math.PI);
      sctx.stroke();
      sctx.restore();
    }
  }

  /* ═════════ 三维管道 ═════════
     原版 Pipes 的观感来自"管道有直径、有高光、朝向随机"，而不是单纯的折线。
     这里用宽度随生命衰减的方块序列堆出管身，再叠一条 30% 白的高光条，
     就有了廉价但有效的圆柱感。转向时禁止掉头，否则管道会自己压在自己身上。 */
  var DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  var PIPE_STEP = 16;

  function newPipe() {
    /* 起点避开边缘，保证一出生就有可见段 */
    return {
      x: PIPE_STEP * (2 + Math.floor(Math.random() * Math.max(1, Math.floor(W / PIPE_STEP) - 4))) + PIPE_STEP / 2,
      y: PIPE_STEP * (2 + Math.floor(Math.random() * Math.max(1, Math.floor(H / PIPE_STEP) - 4))) + PIPE_STEP / 2,
      dir: Math.floor(Math.random() * 4),
      len: 0,
      max: 60 + Math.floor(Math.random() * 120),
      hue: Math.random(),
      pts: []
    };
  }
  function initPipes() {
    pipes = [];
    for (var i = 0; i < 3; i++) {
      var np = newPipe();
      /* 起始段先铺几格，避免"出生的那一帧只看到一个点" */
      for (var k = 0; k < 6; k++) growPipe(np, false);
      pipes.push(np);
    }
  }
  /* 前进一格。respawn=true 时越界就地重生（而不是丢弃 pts 变成空管道）。*/
  function growPipe(p, respawn) {
    if (p.len >= p.max) {
      var fresh = newPipe();
      p.x = fresh.x; p.y = fresh.y; p.dir = fresh.dir;
      p.len = 0; p.max = fresh.max; p.hue = fresh.hue; p.pts = [];
      return;
    }
    if (Math.random() < 0.22) {
      var opts = [0, 1, 2, 3].filter(function (d) { return (d + 2) % 4 !== p.dir; });
      p.dir = opts[Math.floor(Math.random() * opts.length)];
    }
    var dv = DIRS[p.dir];
    p.pts.push({ x: p.x, y: p.y, w: (1 - p.len / p.max) * 8 + 2.5 });
    p.x += dv[0] * PIPE_STEP;
    p.y += dv[1] * PIPE_STEP;
    p.len++;
    if (p.x < -PIPE_STEP || p.y < -PIPE_STEP || p.x > W + PIPE_STEP || p.y > H + PIPE_STEP) {
      if (respawn) {
        var f2 = newPipe();
        p.x = f2.x; p.y = f2.y; p.dir = f2.dir;
        p.len = 0; p.max = f2.max; p.hue = f2.hue; p.pts = [];
      }
    }
  }
  function drawPipes() {
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, W, H);
    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];
      for (var s = 0; s < 2; s++) growPipe(p, true);
      var pts = p.pts;
      /* 只画最近的 200 段：更早的自然淡出，代价是管道没有"拖尾无限长" */
      var head = Math.max(0, pts.length - 200);
      for (var k = head; k < pts.length; k++) {
        var q = pts[k];
        var life = k / Math.max(1, p.max);
        var lum = 70 + life * 150;
        var rr = Math.round(lum * (0.5 + p.hue * 0.5));
        var gg = Math.round(lum * 0.95);
        var bl = Math.round(lum);
        sctx.fillStyle = 'rgb(' + rr + ',' + gg + ',' + bl + ')';
        sctx.fillRect(Math.round(q.x - q.w / 2), Math.round(q.y - q.w / 2), Math.ceil(q.w), Math.ceil(q.w));
        /* 高光：左上的一条窄白，模拟圆柱受光面 */
        sctx.fillStyle = 'rgba(255,255,255,0.34)';
        sctx.fillRect(Math.round(q.x - q.w / 2), Math.round(q.y - q.w / 2), Math.max(1, Math.round(q.w * 0.28)), Math.ceil(q.w));
      }
      /* 头部亮块，让"正在生长"这件事可见 */
      var last = pts[pts.length - 1];
      if (last) {
        sctx.fillStyle = 'rgba(255,255,255,0.9)';
        sctx.fillRect(Math.round(last.x - 2), Math.round(last.y - 2), 4, 4);
      }
    }
  }

  var DRAW = { star: drawStars, fly: drawFlyers, maze: drawMaze, pipe: drawPipes };
  var INIT = { star: initStars, fly: initFlyers, maze: initMaze, pipe: initPipes };

  function loop() {
    if (!on) return;
    var k = KINDS[kind].id;
    (DRAW[k] || drawStars)();
    raf = requestAnimationFrame(loop);
  }

  function start(isPreview) {
    /* 已在运行就重启：预览按钮连点、或屏保中按 ← →（那边走 setKind）
       都可能出现"已经开着"的情况，静默 return 会让用户看到一屏全黑。*/
    if (on) { stop(); }
    on = true;
    previewMode = !!isPreview;   // 仅作标记，关闭条件与自动屏保一致
    size();
    (INIT[KINDS[kind].id] || initStars)();
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, W, H);
    scv.hidden = false;
    if (game.state === 'run') game.pause();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!on) return;
    on = false;
    previewMode = false;
    scv.hidden = true;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastAct = Date.now();
  }
  function setKind(i) {
    if (!(i >= 0 && i < KINDS.length)) return;
    kind = i;
    lsSet('saver95', String(i));
    if (on) {
      (INIT[KINDS[kind].id] || initStars)();
      sctx.fillStyle = '#000';
      sctx.fillRect(0, 0, W, H);
      (DRAW[KINDS[kind].id] || drawStars)();   // 立刻出一帧，不等 rAF
    }
  }

  /* ── 闲置检测 ── */
  function wake() {
      lastAct = Date.now();
    /* 预览和自动屏保都响应输入关闭。
       区别只在于：预览结束后立刻又会被"闲置"判定拉起来（lastAct 刚刷新，
       所以要等满 waitMs），这是正确行为，不需要额外分支。*/
    if (on) stop();
  }
  /* 注意 keydown 不在这里：键盘单独走下面那处，
     否则注册在前的 wake 会先把屏保关掉，方向键换款永远进不去。 */
  ['pointerdown', 'wheel', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, wake, { passive: true });
  });
  var mmT = 0;
  document.addEventListener('mousemove', function () {
    var n = Date.now();
    if (n - mmT > 400) { mmT = n; wake(); }
  }, { passive: true });

  /* 屏保运行时按 ← → 换一款（95 屏保的老习惯，也是隐藏彩蛋）。
     键盘只在这一处处理：方向键换款，其它键唤醒。 */
  document.addEventListener('keydown', function (e) {
    if (!on) { wake(); return; }
    if (e.key === 'ArrowRight') setKind((kind + 1) % KINDS.length);
    else if (e.key === 'ArrowLeft') setKind((kind + KINDS.length - 1) % KINDS.length);
    else { wake(); return; }
    e.preventDefault();
    lastAct = Date.now();
  });

  setInterval(function () {
    if (!on && !document.hidden && waitMs > 0 && Date.now() - lastAct > waitMs) start(false);
  }, 1500);
  window.addEventListener('resize', function () {
    if (on) { size(); (INIT[KINDS[kind].id] || initStars)(); }
  });

  return {
    start: start,
    stop: stop,
    wake: wake,
    setKind: setKind,
    setPick: setKind,
    pick: function () { return kind; },
    setWait: function (v) { waitMs = v; lsSet('saver95wait', String(v)); },
    wait: function () { return waitMs; },
    kindName: function () { return KINDS[kind].name; },
    isOn: function () { return on; },
  };
})();
function wake() { saver.wake(); }

/* ═════════════ 404 检测 ═════════════
   语义：HTTP 状态码仍是 404（对爬虫/监控正确），
   但视觉上给一枚 Win98 风格错误对话框，而不是干巴巴的白页。
   文案沿用真 98 的「找不到文件 / 请检查路径」句式。 */
if (document.body.classList.contains('nf')) {
  var nfPath = '';
  try { nfPath = decodeURIComponent(location.pathname); } catch (e) { nfPath = location.pathname; }
  msgbox(
    '提示',
    'Windows 找不到"' + nfPath + '"。\\n请检查路径是否正确，然后重试。',
    'err',
    {
      sub: '错误 404 · 请求的路径不存在或已失效。\\n可以从桌面图标或「开始」菜单继续浏览。',
      retry: '回到桌面'
    }
  );
}

/* ═════════════ 移动端：键盘弹出适配 ═════════════
   iOS/Android 聚焦输入框时键盘会遮住页面下半部，而桌面仿真整页不可滚，
   结果「输入框被键盘盖住、又滑不上来」。这里监听 visualViewport，
   键盘弹出时压缩桌面高度并把聚焦元素滚进可视区。 */
(function mobileKeyboardFit() {
  if (!window.visualViewport) return;
  var vv = window.visualViewport;
  function fit() {
    var obscured = window.innerHeight - vv.height;   /* 被键盘占掉的像素 */
    if (obscured > 80) {
      document.documentElement.style.setProperty('--kb-h', obscured + 'px');
      var el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        /* 尽量滚到可视区中上部，避免被键盘与任务栏两头夹住 */
        setTimeout(function () {
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
        }, 60);
      }
    } else {
      document.documentElement.style.removeProperty('--kb-h');
    }
  }
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
})();

/* ═════════════ PWA 快捷方式：/?app=mines 直接开局 ═════════════
   Android 上长按已安装图标会列出 manifest.shortcuts，这里接住 URL 参数。
   用 replaceState 抹掉参数，免得用户刷新又开一局。 */
(function deepLink() {
  var m = /[?&]app=([a-z]+)/.exec(location.search);
  if (!m) return;
  var app = m[1];
  setTimeout(function () {
    var icon = document.querySelector('.dicon[data-app="' + app + '"]');
    if (icon) openApp(app);
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }, 400);
})();

/* ═════════════ PWA：Service Worker 注册 ═════════════
   根页位于 /，'./sw.js' 解析为 /sw.js，作用域 ./ = 根。
   SW 注册是 beforeinstallprompt 触发的前提——没有它，
   「安装」按钮与「安装到桌面」图标永远收不到安装事件。 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .catch(function () { /* SW 失败不影响页面正常使用 */ });
  });
}

/* QQ 模块（见下方 QQ_JS）需要复用窗口管理原语，但两边各自是 IIFE，
   按既有约定（window.__ieNav）导出一个小 façade。 */
window.W98 = {
  openWin: openWin, closeWin: closeWin, bringTop: bringTop,
  taskBtnFor: taskBtnFor, msgbox: msgbox, tickClock: tickClock, fillSys: fillSys
};
})();
`;

/* ══════════════════════════════ 复古 QQ（仿 2008）══════════════════════════════
   本段由 _build.js 从 _qqsrc.js 自动内联，请勿手改；
   要改预设对话 / 逻辑，改 _qqsrc.js 后重跑 node _build.js。
   下发路径：/home.js = HOME_JS + QQ_JS。 */
const QQ_JS = `/* ═══════════════ 复古 QQ（仿 2008）· 数据 + 模块 ═══════════════
   第一原则（用户明确要求）：无假功能、无假数据、真实仿真。
   这里发生的每一件事都是真的：
     · 自动播放 = 真的逐字修改输入框 value、真的派发 input 事件、
       真的让发送按钮获得焦点并真的 click，消息真的进对话流；
     · 未读数 / 正在输入 / 头像灰掉 / 托盘与任务栏闪动 / 时间戳，
       全部由真实事件与真实时钟驱动，没有任何写死的装饰性数字；
     · 用户一旦真的打字或点发送，自动播放立即暂停并明说，
       用户发的消息真实入流，对方按剧本或兜底台词真实回复。
   年代穿越：era 为空 = 真实日期；选了年份后，任务栏时钟、系统属性、
   MS-DOS 的 date、本模块所有时间戳，统一按「当年今日的此刻」计算。
   真实文件的修改时间来自服务端 index.json，不参与伪造。

   ── 想自己加好玩的对话？改下面的 PRESETS 就行 ──
   script 是有序剧本：{ me: '我说的' } 与 { f: '对方说的' }（群聊用
   { g: '说话人', t: '内容' }）交替；fallback 是接不上时的兜底回复；
   k 挂在对方台词上，表示「用户输入含这些关键词就算接上剧本」。 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function closestEl(el, sel) {
    while (el && el !== document.body) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /* ─────────── 一、预设数据（自定义入口） ─────────── */
  var AV = {
    A: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    B: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hhssmmssh.', 'hhsssssshh', 'hhhsssshhh', 'hhccccccch', 'hcccccccch', '.cccccccc.'],
    C: ['cccccccccc', 'cccccccccc', 'chhssssshh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    D: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hkkkkkkkkh', 'hkkkkkkkkh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    /* 时钟：「最近联系人」Tab 的图标 */
    E: ['..kkkkkk..', '.kk....kk.', 'kk..hh..kk', 'kk..hh..kk', 'kk..hhhhkk', 'kk....hhkk', 'kk......kk', '.kk....kk.', '..kkkkkk..', '..........']
  };

  var PRESETS = {
    me: {
      name: '7喵',
      sign: '涐喟蕩漾，涐恠攵芾裡等哪囙兲。',
      av: 'A',
      pal: { h: '#2b2b2b', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' }
    },
    friends: [
      {
        name: '╰☆葬爱家族★冷少╮', sign: '家族不倒，葬爱到老。', group: '家族', era: 2005, on: true, qq: '4182637',
        av: 'D', pal: { h: '#3a2a1a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#2a2a34' },
        script: [
          { f: '在吗？家族今晚还聚会吗，别跟我说你又忘了。' },
          { me: '没忘。老地方，网吧二楼包间，八点是吧' },
          { f: '嗯。今晚有正事：新族规下来了，统一换火星文头像。' },
          { me: '……我头像上周刚换，怎么又换' },
          { f: '审美要跟上。你那杀马特刘海过时了，现在流行离子烫。' },
          { me: '离子烫多少钱' },
          { f: '网吧楼下阿强那儿三十块，报我名字送定型啫喱。' },
          { me: '行，下班我去烫一个' },
          { f: '对了，你空间日志今天访问量破三百了，评论区全在问背景音乐。' },
          { me: '那首飞向别人的床？' },
          { f: '换爱情买卖吧，现在全场都在放，不换就 out 了。', k: ['爱情买卖', '换'] },
          { me: '明天还要上课，先撤了' },
          { f: '去吧。族谱给你留了一页，周日晚记得来签到。' }
        ],
        fallback: ['呵呵，你说什么呢。', '家族的事，你不懂。', '先去洗个头，再说正事。', '嗯嗯，然后呢？', '这话咱线下聊，群里不方便。']
      },
      {
        name: '埖落灬晓', sign: '涐媞埖落灬晓，请不要再 call 涐。', group: '我的好友', era: 2008, on: true, qq: '5928416',
        av: 'B', pal: { h: '#1a1a1a', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#d88ab0' },
        script: [
          { f: '在吗？你看了我昨晚发的那篇日志没有。' },
          { me: '看了，就是那篇深夜请允许我最后一次堕落' },
          { f: '嗯。你说，人为什么长大以后，快乐就变得这么难。' },
          { me: '别想太多，早点睡' },
          { f: '睡不着的。一闭眼全是以前的事。你说喜欢的人最后怎么都变成了过客。' },
          { me: '会变才正常啊，我也变了很多' },
          { f: '你变得会安慰人了。以前的你，只会回一串省略号。' },
          { me: '那不是不知道怎么回嘛' },
          { f: '没关系。谢谢你今天愿意听我说这些。' },
          { me: '小事。明天你空间留言，我第一个去踩' },
          { f: '说定了。你要第一个来，还要带一朵玫瑰。', k: ['玫瑰', '第一个', '留言'] },
          { me: '带带带，玫瑰管够' },
          { f: '晚安，7喵。今天谢谢你。' }
        ],
        fallback: ['嗯……然后呢。', '你是不是也有心事。', '大人的世界，就这样吧。', '我不想懂，真的。']
      },
      {
        name: '回忆ㄨ童年', sign: '让我们回到那时的童年。', group: '同学', era: 2003, on: true, qq: '1036428',
        av: 'A', pal: { h: '#241a12', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' },
        script: [
          { f: '在吗？同学录我做好了，刚给你寄了一张。' },
          { me: '收到了！还是那种带香味的纸' },
          { f: '嗯，我挑了挺久。你填的最喜欢的明星是周杰伦？' },
          { me: '对啊，叶惠美那张专辑我天天听' },
          { f: '我写的是最大的愿望：考上重点高中。你说我们能考上吗。' },
          { me: '肯定能，你成绩那么好' },
          { f: '借你吉气。对了，毕业册上你给我写的留言，我看了三遍。' },
          { me: '写的什么还记得吗' },
          { f: '愿你永远像现在这样笑。就这一句，我记到现在。', k: ['笑', '愿你'] },
          { me: '那你现在还会那样笑吗' },
          { f: '会啊。只要你别忘了周末回同学录就行。' },
          { me: '忘不了。周末老地方，学校后门小卖部见' },
          { f: '好，我带新买的复读机，我们听晴天。' }
        ],
        fallback: ['呵呵，跟小时候一样。', '这事我记得，你再想想。', '周末见，不许爽约。', '同学录你填了吗？']
      },
      {
        name: '℡尐爺', sign: '尐爺涐兂所谓，呮媞涐恠迗崾郅溔糀。', group: '我的好友', era: 2008, on: false, qq: '8720415',
        av: 'C', pal: { h: '#d8b23a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#7a4a9a' },
        script: [
          { f: '涐看沵最近都不上线，是把涐忘了？' },
          { me: '没有，最近天天加班' },
          { f: '加班有加班费吗？我们网吧周末活动，包夜四十还送泡面。' },
          { me: '这么便宜，网速稳不稳' },
          { f: '电信三兆，劲舞团不卡。上次你那套连击还是我教的。' },
          { me: '那是我天赋好不好' },
          { f: '是手熟。周六夜机我给你留包厢，来不来？' },
          { me: '来，我带一个同学' },
          { f: '行，人多不好分机子，一个刚刚好。' },
          { me: '你最近还玩炫舞吗' },
          { f: '玩啊，涐的舞团今晚有活动，你要不要来蹭个连击？' },
          { me: '不了，我手残' },
          { f: '不存在的，我带你就说定在一起，主要手要快。' }
        ],
        fallback: ['芣袸炷，莪帶沵。', '你说你的，我听着呢。', '这事就这么定了。', '尐爷我无所谓。']
      },
      {
        name: '网吧网管小李', sign: '机子有问题请举手，我在吧台。', group: '网友', era: 2005, on: true, qq: '3360719',
        av: 'A', pal: { h: '#1a1a1a', s: '#e8bd8f', k: '#1a1a1a', m: '#8a5050', c: '#5a5a5a' },
        script: [
          { f: '在吗？三楼七号机耳机又没声音了，我过去看看。' },
          { me: '我在三号机，这边也接触不良' },
          { f: '老毛病，二楼那排机子都三四年了，将就用。' },
          { me: '昨晚是不是又有人通宵砍传奇' },
          { f: '可不是，打到早上六点，非说爆了屠龙，半个网吧都去围观。' },
          { me: '真爆了？' },
          { f: '爆个屁，是盗号的钓鱼。现在的骗子专盯中学生。' },
          { me: '那你多在群里提醒一下' },
          { f: '我每小时滚一次字幕：凡是要账号的都是骗子。听不听随他们。' },
          { me: '辛苦了李哥' },
          { f: '对了，你上周落在吧台的 U 盘我收着，明天来拿。' },
          { me: '谢了，明天补你一瓶可乐' },
          { f: '可乐就不用了，下次包夜给你算内部价。' }
        ],
        fallback: ['我在吧台，喊我一声。', '机子的事好说。', '现在的孩子，防骗意识得加强。', '知道了，我处理。']
      },
      {
        name: '毒鸡汤bot', sign: '今天也没有努力呢，真好。', group: '网友', era: 2012, on: true, qq: '1095732',
        av: 'C', pal: { h: '#d8b23a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a8a5a' },
        script: [
          { f: '朋友，你又打开手机了。说好的学习呢？' },
          { me: '我就歇五分钟' },
          { f: '五分钟前你也是这么说的。拖延是会上瘾的，年轻人。' },
          { me: '……你怎么知道' },
          { f: '我知道的还有很多。比如你现在正躺着，而且电量不到百分之二十。' },
          { me: '这你都能猜到' },
          { f: '因为五年前的你，也是这样一年一年熬过来的。喝口鸡汤：努力不一定会成功，但不努力一定很舒服。' },
          { me: '这汤有毒' },
          { f: '毒就对了，苦口良药。你上个月立的 flag 叫什么来着，早睡？' },
          { me: '别揭短' },
          { f: '好，说点正经的：你真正想做的事，今天做了一分钟没有？' },
          { me: '做了一点' },
          { f: '那就行。一天一分钟，一年也是六个多小时。' },
          { me: '你这算法是毒鸡汤门派的吧' },
          { f: '谢谢夸奖。明天记得再来，我每天都在。' }
        ],
        fallback: ['嗯，我听着。', '这碗汤你必须喝。', '别狡辩，我见得多了。', '明天会更好——大概吧。', '你努力的样子，连你自己都骗。']
      },
      {
        name: '家族群·葬爱基地', sign: '葬爱家族总部，进来就是一家人。', group: '我的QQ群', isGroup: true, era: 2008, on: true, qq: '1208337',
        members: ['家族管理·龙少', '葬爱家族·冷少', 'QQ炫舞家族·公主', '网吧网管小李', '℡尐爺'],
        av: 'D', pal: { h: '#2a2a34', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#a03030' },
        script: [
          { g: '家族管理·龙少', t: '今晚八点，家族全员火星文头像检查，别给我掉链子。' },
          { g: '葬爱家族·冷少', t: '收到，我挨个通知。' },
          { g: 'QQ炫舞家族·公主', t: '我刚换了新头像，「埖仺兲悾」，大家看看标不标准。' },
          { g: '家族管理·龙少', t: '标准。公主这审美，家族门面担当。' },
          { g: '网吧网管小李', t: '提醒一句：群里那个「家族秘书」加好友要礼物的，是骗子，别转钱。' },
          { g: '葬爱家族·冷少', t: '对，上周已经有人被骗 Q 币了。要礼物的直接踢。' },
          { g: '℡尐爺', t: '尐爷已经无所谓，请看我的新签名。' },
          { g: '家族管理·龙少', t: '尐爺你先把字打对，签名是给别人看的。' },
          { g: '℡尐爺', t: '你懂什么，这叫风格。' },
          { me: '刚下班，今晚聚会我准时到' },
          { g: '葬爱家族·冷少', t: '来了就好。老规矩，迟到罚一瓶可乐。' },
          { g: 'QQ炫舞家族·公主', t: '我带舞团的姐妹来围观，可以吗龙少。' },
          { g: '家族管理·龙少', t: '欢迎。人多热闹，但别刷屏，群邮件我还要看。' }
        ],
        fallback: ['收到。', '龙少说得对。', '＋1', '哈哈哈哈', '葬爱基地，永不言败。']
      },
      {
        name: 'QQ炫舞家族·公主', sign: '舞团招新，会连击的来。', group: '家族', era: 2008, on: false, qq: '7610495',
        av: 'B', pal: { h: '#6b3f1d', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#c03030' },
        script: [
          { f: '在吗？舞团周末有活动，来不来凑个人头。' },
          { me: '什么活动' },
          { f: '家族联谊赛，双人舞。我跟人组一队，你来当第二队。' },
          { me: '我手残，连击最高才 89' },
          { f: '89 可以了，我们舞团平均才 60。你来了就是主力。' },
          { me: '你这主力标准真低' },
          { f: '要求不高，会按空格就行。来了姐教你卡拍子。' },
          { me: '卡拍子是什么' },
          { f: '节奏到点前 0.1 秒按下去，判定直接 perfect。这个要练。' },
          { me: '听起来好玄学' },
          { f: '比玄学多一点，是肌肉记忆。周末来，我开个小房间单独教你。' },
          { me: '行，周末见' },
          { f: '对了，你游戏名还是 7喵 吗？我给你在舞团群挂个名。' }
        ],
        fallback: ['来嘛，就差你了。', '姐带你，怕什么。', 'perfect 的感觉，试过一次就上瘾。', '周末别忘了。']
      },
      {
        name: '老同学群·初三(2)班', sign: '常回群看看，同学录还在。', group: '我的QQ群', isGroup: true, era: 2003, on: false, qq: '4029116',
        members: ['班主任·王老师', '回忆ㄨ童年', '前排学霸', '后排睡神'],
        av: 'A', pal: { h: '#241a12', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#4a7a3a' },
        script: [
          { g: '班主任·王老师', t: '同学们，下周三下午同学会，能来的在群里接个龙。' },
          { g: '回忆ㄨ童年', t: '王老师好，我来！' },
          { g: '前排学霸', t: '我来。正好带相机，给大家拍照。' },
          { g: '后排睡神', t: '我……我尽量。那天要上班。' },
          { g: '班主任·王老师', t: '上班也来坐坐，二十年聚会不容易。' },
          { g: '前排学霸', t: '老师，您当年说「你们是我带过最差的一届」，还算数吗。' },
          { g: '班主任·王老师', t: '我说的是最差，但也最舍不得。你们都长大了。' },
          { g: '后排睡神', t: '老师您这话一说，我眼睛有点酸。' },
          { me: '老师，我一定到。我带瓜子。' },
          { g: '回忆ㄨ童年', t: '7喵 你来就热闹了，还是当年那个捣蛋鬼。' },
          { g: '班主任·王老师', t: '好，那就周三。地址我单独发你们，别忘了。' },
          { g: '前排学霸', t: '建议按当年的座位坐，王老师还坐讲台边。' },
          { g: '后排睡神', t: '同意！我再睡一次，就一次。' }
        ],
        fallback: ['王老师说得对。', '＋1', '必须来。', '青春啊。']
      }
    ]
  };

  /* ─────────── 二、状态与持久化 ─────────── */
  var LS = 'qq95-';
  var ERAS = ['2003', '2005', '2008', '2012'];
  var friends = [];
  var state = {
    era: '',            // '' = 真实日期；否则为穿越年份
    sound: true,
    status: 'online',   // online | hidden（隐身：暂停派发新消息）
    cur: null,          // 当前打开的好友 id
    lastCur: null,      // 最近打开过的好友 id（聊天窗关了也能重播）
    chats: {},          // id -> { pos, msgs: [{w,who,text,t}] }
    unread: {},         // id -> 未读数（真实收到且没看过的）
    presence: {},       // id -> 是否在线（头像/计数/派发候选都用真值）
    tab: 'friend',     // friend | group | recent —— 与真实 QQ 的三个 Tab 一致
    find: '',          // 查找联系人关键词（真的过滤列表）
    fold: {},          // 分组折叠状态（真实 QQ 点分组标题可折叠）
    playing: false,
    stepping: false,
    macroSend: false,   // 宏即将真实点击发送（发送路径据此区分来源）
    partial: null,      // 暂停时保留的半截输入 { text, i }
    started: false      // QQ 是否已启动（决定托盘图标与来信派发）
  };
  /* 两个定时器池：宏（播放）暂停只清自己的，不能把环境定时器
     （来信派发 / 在线状态 / 二次确认）一起杀死 */
  var macroTimers = [];
  var ambientTimers = [];
  var lastDay = '';

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(LS + k);
      localStorage.setItem(LS + k, v);
      return v;
    } catch (e) { return null; }
  }
  function after(ms, fn) { var t = setTimeout(fn, ms); macroTimers.push(t); return t; }
  function ambAfter(ms, fn) { var t = setTimeout(fn, ms); ambientTimers.push(t); return t; }
  function clearMacroTimers() { for (var i = 0; i < macroTimers.length; i++) clearTimeout(macroTimers[i]); macroTimers = []; }

  function chatRec(id) {
    if (!state.chats[id]) {
      var rec = { pos: 0, msgs: [] };
      var raw = store('chat-' + id);
      if (raw) {
        try {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') {
            rec.pos = o.pos || 0;
            rec.msgs = Array.isArray(o.msgs) ? o.msgs : [];
          }
        } catch (e) { /* 损坏的记录当作空记录，不假装有数据 */ }
      }
      state.chats[id] = rec;
    }
    return state.chats[id];
  }
  function saveChat(id) {
    var rec = state.chats[id];
    if (rec) store('chat-' + id, JSON.stringify({ pos: rec.pos, msgs: rec.msgs.slice(-120) }));
  }
  function saveUnread() { store('unread', JSON.stringify(state.unread)); }
  function friendById(id) {
    for (var i = 0; i < friends.length; i++) if (friends[i].id === id) return friends[i];
    return null;
  }
  function totalUnread() {
    var n = 0;
    for (var k in state.unread) if (state.unread.hasOwnProperty(k)) n += state.unread[k];
    return n;
  }

  /* ─────────── 三、时间（真实时钟 / 年代穿越同源） ─────────── */
  function eraDate() {
    var d = new Date();
    if (!state.era) return d;
    var y = parseInt(state.era, 10);
    var e = new Date(y, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    if (e.getMonth() !== d.getMonth()) {
      /* 2 月 29 日在非闰年年份会滚到 3 月 1 日，夹回 2 月 28 日 */
      e = new Date(y, d.getMonth(), 28, d.getHours(), d.getMinutes(), d.getSeconds());
    }
    return e;
  }
  function now() { return eraDate().getTime(); }
  function fmtTime(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(t) { var d = new Date(t); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

  /* 经典 QQ 默认表情的真实名称；插进输入框的是早期 QQ 的文本表情代码 /微笑 */
  var FACES = ['微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
    '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '酷', '冷汗', '抓狂', '吐',
    '偷笑', '愉快', '白眼', '傲慢', '饥饿', '困', '惊恐', '流汗', '憨笑', '奋斗',
    '咒骂', '疑问', '嘘', '晕', '疯了', '衰', '骷髅', '敲打', '再见', '擦汗',
    '抠鼻', '鼓掌', '糗大了', '坏笑', '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈',
    '快哭了', '阴险', '亲亲', '吓', '可怜'];

  /* ─────────── 四、头像像素画 ─────────── */
  /* 头像像素画的渲染通道：CSP 的 style-src 'self' 会静默丢弃 style 属性里的
     box-shadow，连 <style> 元素的 sheet 都不给（Chromium 实测，头像整块空白）。
     而 img-src 'self' data: 本来就在白名单里（为二维码放行），所以把像素谱
     现场画成 SVG 的 data URI，用 <img> 显示——完全合规、零文件、运行时生成。
     同一幅谱+调色板只编码一次，之后复用缓存。 */
  var avCache = {};
  function avHtml(who) {
    var key = who.av + '|' + who.pal.h + who.pal.s + who.pal.k + who.pal.m + who.pal.c;
    if (!avCache[key]) {
      var pat = AV[who.av] || AV.A, pal = who.pal, r = [];
      for (var y = 0; y < pat.length; y++)
        for (var x = 0; x < pat[y].length; x++) {
          var c = pal[pat[y].charAt(x)];
          if (c) r.push('<rect x="' + (x * 2) + '" y="' + (y * 2) + '" width="2" height="2" fill="' + c + '"/>');
        }
      var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' shape-rendering='crispEdges'>" + r.join('') + '</svg>';
      avCache[key] = 'data:image/svg+xml;base64,' + btoa(svg);
    }
    return '<img class="qq-avimg" src="' + avCache[key] + '" alt="" aria-hidden="true">';
  }

  /* ─────────── 五、音效（Web Audio 合成，零文件零依赖） ─────────── */
  /* CSP 的 media-src 'self' 不允许 data: 音频，只能用 OscillatorNode 现场合成。
     经典 QQ 消息音「滴滴」、发送轻响、好友上线敲门声，全部由真实事件触发。 */
  var actx = null;
  function ac() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!actx) actx = new C();
    if (actx.state === 'suspended' && actx.resume) actx.resume();
    return actx;
  }
  function tone(freq, delay, dur, type, vol) {
    var c = ac();
    if (!c) return;
    var t = c.currentTime + delay;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function sound(kind) {
    if (!state.sound) return;
    if (kind === 'msg') { tone(988, 0, 0.09, 'square', 0.06); tone(784, 0.11, 0.10, 'square', 0.06); }
    else if (kind === 'send') { tone(620, 0, 0.05, 'sine', 0.05); }
    else if (kind === 'knock') { tone(300, 0, 0.09, 'triangle', 0.08); tone(240, 0.13, 0.10, 'triangle', 0.08); }
    else if (kind === 'sys') { tone(440, 0, 0.06, 'sine', 0.05); }
  }
  function syncSound() { $('qqSound').textContent = '音效:' + (state.sound ? '开' : '关'); }
  function toggleSound() {
    state.sound = !state.sound;
    store('sound', state.sound ? '1' : '0');
    syncSound();
    if (state.sound) sound('sys');
  }

  /* ─────────── 六、面板渲染 ─────────── */
  /* 真实 QQ 的分组顺序；「陌生人」「黑名单」与真实 QQ 一样常驻（空的也显示） */
  var GROUPS = ['我的好友', '同学', '网友', '家族', '陌生人', '黑名单'];
  function matchKw(f, kw) {
    if (!kw) return true;
    return (f.name + ' ' + f.sign + ' ' + (f.qq || '')).toLowerCase().indexOf(kw) >= 0;
  }
  function friendRow(fr) {
    var u = state.unread[fr.id] || 0;
    var on = state.presence[fr.id] !== false;
    return '<div class="qq-f' + (on ? '' : ' off') + (state.cur === fr.id ? ' sel' : '') + '" data-f="' + fr.id + '" tabindex="0">' +
      '<span class="qq-f-av">' + avHtml(fr) + '</span>' +
      '<span class="qq-f-main">' +
      '<span class="qq-f-name">' + esc(fr.name) + '</span>' +
      '<span class="qq-f-sign">' + esc(fr.sign) + '</span>' +
      '</span>' +
      (u ? '<span class="qq-badge">' + (u > 99 ? '99+' : u) + '</span>' : '') +
      '</div>';
  }
  /* 分组标题：三角 + 名称 + 在线/总数（真实 QQ 的格式，点一下可折叠） */
  function secHtml(key, title, list, kw) {
    var fkey = key + '|' + title;
    var on = 0;
    for (var i = 0; i < list.length; i++) if (state.presence[list[i].id] !== false) on++;
    var fold = !!state.fold[fkey];
    var html = '<div class="qq-gname' + (fold ? ' fold' : '') + '" data-g="' + esc(fkey) + '" tabindex="0">' +
      '<span class="qq-gtri"></span>' + esc(title) +
      '<span class="qq-gnum">' + on + '/' + list.length + '</span></div>';
    if (fold) return html;
    for (var j = 0; j < list.length; j++) html += friendRow(list[j]);
    return html;
  }
  function emptyHtml(kw) {
    return '<div class="qq-empty">' + (kw ? '没有找到「' + esc(state.find) + '」' : '还没有联系人') + '</div>';
  }
  function renderPanel() {
    var box = $('qqGroups');
    var kw = (state.find || '').toLowerCase().replace(/^\\s+|\\s+$/g, '');
    var html = '', i, list;
    if (state.tab === 'group') {
      list = friends.filter(function (f) { return f.isGroup && matchKw(f, kw); });
      html = list.length ? secHtml('g', '我的QQ群', list, kw) : emptyHtml(kw);
    } else if (state.tab === 'recent') {
      /* 最近联系人：真的按最后一次交谈时间倒序（真实 QQ 就是这个规则） */
      var rec = [];
      for (i = 0; i < friends.length; i++) {
        var r = chatRec(friends[i].id);
        if (r.msgs.length) rec.push({ f: friends[i], t: r.msgs[r.msgs.length - 1].t });
      }
      rec.sort(function (a, b) { return b.t - a.t; });
      list = rec.map(function (x) { return x.f; }).filter(function (f) { return matchKw(f, kw); });
      html = list.length ? secHtml('r', '最近联系人', list, kw) : emptyHtml(kw);
    } else {
      var hit = 0;
      for (i = 0; i < GROUPS.length; i++) {
        list = friends.filter(function (f) { return !f.isGroup && f.group === GROUPS[i] && matchKw(f, kw); });
        if (!list.length && kw) continue;      /* 查找时只留命中的分组 */
        hit += list.length;
        html += secHtml('g' + i, GROUPS[i], list, kw);
      }
      if (kw && !hit) html = emptyHtml(kw);
    }
    box.innerHTML = html;
  }
  function renderOnline() {
    var n = 0;
    for (var i = 0; i < friends.length; i++) if (state.presence[friends[i].id] !== false) n++;
    $('qqOnline').textContent = state.status === 'hidden'
      ? '已隐身 · 暂停收新消息（在线 ' + n + ' 人）'
      : '在线 ' + n + ' 人';
  }

  /* ─────────── 七、会话渲染 ─────────── */
  function scrollLog() { var l = $('qqLog'); l.scrollTop = l.scrollHeight; }
  /* 真实 QQ2008 的消息格式：「昵称 2008-07-15 20:31:12」一行，内容另起一行 */
  function fmtFull(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function rowHtml(m) {
    var f = friendById(state.cur);
    var me = m.w === 'me';
    var who = me ? PRESETS.me.name : (m.who || (f && f.name) || '对方');
    return '<div class="qq-row' + (me ? ' me' : '') + '">' +
      '<div class="qq-bhead"><span class="qq-bwho">' + esc(who) + '</span>' +
      '<span class="qq-btime">' + esc(fmtFull(m.t)) + '</span></div>' +
      '<div class="qq-btxt">' + esc(m.text) + '</div></div>';
  }
  function appendRow(m) {
    var log = $('qqLog');
    var empty = log.querySelector('.qq-empty');
    if (empty) empty.parentNode.removeChild(empty);
    var k = dayKey(m.t);
    if (k !== lastDay) {
      lastDay = k;
      log.insertAdjacentHTML('beforeend', '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>');
    }
    if (m.w === 'sys') log.insertAdjacentHTML('beforeend', '<div class="qq-sys">' + esc(m.text) + '</div>');
    else log.insertAdjacentHTML('beforeend', rowHtml(m));
    scrollLog();
  }
  function renderLog() {
    var rec = chatRec(state.cur);
    var log = $('qqLog');
    if (!rec.msgs.length) {
      log.innerHTML = '<div class="qq-empty">还没有聊天记录。打开会话即会自动「演」出来，或自己说点什么。</div>';
      lastDay = '';
      return;
    }
    var html = '', last = '';
    for (var i = 0; i < rec.msgs.length; i++) {
      var m = rec.msgs[i];
      var k = dayKey(m.t);
      if (k !== last) { last = k; html += '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>'; }
      html += m.w === 'sys' ? '<div class="qq-sys">' + esc(m.text) + '</div>' : rowHtml(m);
    }
    log.innerHTML = html;
    lastDay = last;
    scrollLog();
  }
  function hint(text) {
    var log = $('qqLog');
    var empty = log.querySelector('.qq-empty');
    if (empty) empty.parentNode.removeChild(empty);
    log.insertAdjacentHTML('beforeend', '<div class="qq-sys">' + esc(text) + '</div>');
    scrollLog();
  }
  function hintIfOpen(text) {
    var w = $('qqChatWin');
    if (w && !w.hidden && state.cur) hint(text);
  }
  function showTyping(on) { $('qqTyping').hidden = !on; }

  /* ─────────── 八、消息流转 ─────────── */
  function pushMsg(id, msg) {
    var rec = chatRec(id);
    rec.msgs.push(msg);
    saveChat(id);
    if (state.cur === id) appendRow(msg);
  }
  function deliver(f, entry) {
    var msg = entry.g !== undefined
      ? { w: 'g', who: entry.g, text: entry.t, t: now() }
      : { w: 'you', text: entry.f, t: now() };
    pushMsg(f.id, msg);
    if (state.cur === f.id) {
      scrollLog();
    } else {
      state.unread[f.id] = (state.unread[f.id] || 0) + 1;
      saveUnread();
      renderPanel();
      renderTray();
      renderTaskFlash();
    }
  }
  /* 找到下一条对方台词（群/单人通用） */
  function nextFriendEntry(f) {
    var rec = chatRec(f.id);
    for (var i = rec.pos; i < f.script.length; i++) {
      if (f.script[i].f !== undefined || f.script[i].g !== undefined) return { entry: f.script[i], i: i };
    }
    return null;
  }

  /* ─────────── 九、自动播放宏（打开会话即真实逐字「演」出来，聊天窗里不放任何播放按钮） ─────────── */
  function macroOn() { return state.playing; }
  function play() {
    if (state.playing) return;
    if (!state.cur) return;
    var f = friendById(state.cur);
    if (chatRec(f.id).pos >= f.script.length) {
      hint('这部剧已经看完了。可在面板主菜单「重播对话」再看一遍，或自己接着说。');
      return;
    }
    state.playing = true;
    playNext();
  }
  function pause(byUser) {
    if (!state.playing) return;
    state.playing = false;
    clearMacroTimers();
    showTyping(false);
    if (byUser) hint('已接管输入，自动播放已暂停。');
  }
  function stopPlay() {
    pause(false);
    state.cur = null;
    showTyping(false);
  }
  function playNext() {
    if (!state.playing || !state.cur) return;
    var f = friendById(state.cur);
    var rec = chatRec(f.id);
    var entry = f.script[rec.pos];
    if (!entry) {
      state.playing = false;
      hint('剧本播放完毕。可在面板主菜单「重播对话」再看一遍，或自己接着说。');
      return;
    }
    if (entry.f !== undefined || entry.g !== undefined) {
      friendTurn(f, entry, function () { rec.pos++; saveChat(f.id); if (state.playing) after(rand(600, 1200), playNext); });
    } else {
      myTurn(f, entry, function (sent) {
        if (sent) { rec.pos++; saveChat(f.id); }
        if (state.playing) after(rand(600, 1200), playNext);
      });
    }
  }
  /* 对方发言：先「正在输入…」，再真的入流 + 消息音 */
  function friendTurn(f, entry, done) {
    if (state.cur === f.id) showTyping(true);
    after(rand(800, 1600), function () {
      showTyping(false);
      deliver(f, entry);
      sound('msg');
      if (done) done();
    });
  }
  /* 我方发言：逐字打进输入框（真实 value + 真实 input 事件），
     然后让发送按钮真的获得焦点并真的 click —— 与用户手动发送同一条路径 */
  function myTurn(f, entry, done) {
    var inp = $('qqIn');
    var text = entry.me;
    var i = state.partial && state.partial.text === text ? state.partial.i : 0;
    if (!i) inp.value = '';
    inp.focus();
    (function tick() {
      if (!macroOn()) { if (done) done(false); return; }
      if (i >= text.length) {
        state.partial = null;
        after(rand(120, 260), function () {
          if (!macroOn()) { if (done) done(false); return; }
          state.macroSend = true;
          $('qqSendBtn').focus();
          $('qqSendBtn').click();
          if (done) done(true);
        });
        return;
      }
      inp.value += text.charAt(i);
      i++;
      state.partial = { text: text, i: i };
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      after(rand(55, 130), tick);
    })();
  }
  /* 重播当前（或最近打开的）会话，从第一条台词重新「演」起。
     入口是面板主菜单的「重播对话」，不在聊天窗里放任何假按钮。 */
  function replayCurrent() {
    var id = state.cur || state.lastCur;
    if (!id || !friendById(id)) { hint('先打开一个会话，才能重播。'); return; }
    pause(false);
    var rec = chatRec(id);
    rec.pos = 0;
    rec.msgs = [];
    saveChat(id);
    state.partial = null;
    lastDay = '';
    if (state.cur !== id) openChat(id);   /* 没开着就先打开（openChat 末尾会自动 play） */
    else { renderLog(); play(); }
  }

  /* ─────────── 十、发送与回复引擎 ─────────── */
  function sendMsg() {
    var byMacro = state.macroSend;
    state.macroSend = false;
    var inp = $('qqIn');
    var text = inp.value.replace(/^\\s+|\\s+$/g, '');
    if (!text || !state.cur) return;
    /* 用户真的发了消息 → 接管；宏自己点的发送不算 */
    if (!byMacro && state.playing) pause(false);
    state.partial = null;
    inp.value = '';
    pushMsg(state.cur, { w: 'me', text: text, t: now() });
    sound('send');
    if (!byMacro) replyTo(state.cur, text);
  }
  /* 接得上剧本 → 按剧本回应；接不上 → 符合作语气场面的兜底回复，指针不动。
     不假装「AI 听懂了」，但对话体验始终连贯。 */
  function textMatch(text, trig, resp) {
    if (text === trig.me) return true;
    if (text.length >= 2 && (text.indexOf(trig.me) >= 0 || trig.me.indexOf(text) >= 0)) return true;
    var keys = (resp && resp.k) || trig.k;
    if (keys) for (var i = 0; i < keys.length; i++) if (text.indexOf(keys[i]) >= 0) return true;
    return false;
  }
  function replyTo(id, text) {
    var f = friendById(id);
    var rec = chatRec(id);
    var at = f.script[rec.pos];
    var respIdx = -1;
    if (at && at.me !== undefined) {
      /* 轮到我方发言：用户这句话顶替了剧本台词，往后找对方该回的那句 */
      for (var i = rec.pos + 1; i < f.script.length; i++) {
        if (f.script[i].f !== undefined || f.script[i].g !== undefined) { respIdx = i; break; }
      }
    } else if (at) {
      /* 正轮到对方说这句：用户插了句话，对得上就按剧本说 */
      respIdx = rec.pos;
    }
    var matched = false, trig = null;
    if (respIdx >= 0) {
      for (var j = respIdx - 1; j >= 0; j--) {
        if (f.script[j].me !== undefined) { trig = f.script[j]; break; }
      }
      if (trig) matched = textMatch(text, trig, f.script[respIdx]);
    }
    if (matched) {
      friendTurn(f, f.script[respIdx], function () { rec.pos = respIdx + 1; saveChat(id); });
    } else {
      var line = pick(f.fallback);
      var fb = f.isGroup
        ? { g: pick(f.members || [f.name]), t: line }
        : { f: line };
      friendTurn(f, fb, function () {});
    }
  }

  /* ─────────── 十一、托盘与任务栏闪动 ─────────── */
  function ensureTray() {
    if ($('qqTray')) return;
    var t = document.createElement('span');
    t.className = 'trayico';
    t.id = 'qqTray';
    t.title = 'QQ';
    t.innerHTML = '<span class="ico ico-qq ico-qq-s"></span>';
    t.addEventListener('click', function () { openPanel(); });
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); trayMenu(e.clientX, e.clientY); });
    $('trayIcons').appendChild(t);
  }
  function renderTray() {
    var t = $('qqTray');
    if (!t) return;
    var n = totalUnread();
    t.classList.toggle('unread', n > 0);
    t.title = n > 0 ? 'QQ · ' + n + ' 条未读' : 'QQ';
  }
  function renderTaskFlash() {
    var w = $('qqWin');
    var btn = w && w._taskBtn;
    if (btn) btn.classList.toggle('flash', totalUnread() > 0 && w.hidden);
  }
  function hideTrayMenu() {
    var m = $('qqTrayMenu');
    if (m) m.parentNode.removeChild(m);
  }
  function trayMenu(x, y) {
    hideTrayMenu();
    var m = document.createElement('div');
    m.className = 'ctxmenu';
    m.id = 'qqTrayMenu';
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - 150)) + 'px';
    m.style.top = Math.max(4, y - 108) + 'px';
    m.innerHTML = '<div class="ctxi" data-a="open">打开面板</div>' +
      '<div class="ctxi" data-a="sound">' + (state.sound ? '关闭音效' : '开启音效') + '</div>' +
      (state.era ? '<div class="ctxi" data-a="era">退出穿越 · 回真实日期</div>' : '') +
      '<div class="ctx-sep"></div>' +
      '<div class="ctxi" data-a="quit">退出 QQ</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var it = closestEl(e.target, '.ctxi');
      if (!it) return;
      var a = it.getAttribute('data-a');
      hideTrayMenu();
      if (a === 'open') openPanel();
      else if (a === 'sound') toggleSound();
      else if (a === 'era') { $('qqEra').value = ''; state.era = ''; store('era', ''); applyEra(); }
      else if (a === 'quit') quitQQ();
    });
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideTrayMenu();
        document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  /* ── 主菜单（底部企鹅按钮）与表情面板 ── */
  function hideMenu() { $('qqMenu').hidden = true; }
  function toggleMenu() {
    var m = $('qqMenu');
    m.hidden = !m.hidden;
    if (m.hidden) return;
    /* 菜单是窗口内的 absolute 定位：坐标必须相对窗口算。
       此前误用视口坐标，窗口不在原点时菜单会整体飞出屏幕——真 bug，已修。 */
    var b = $('qqMenuBtn').getBoundingClientRect();
    var w = $('qqWin').getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(b.left - w.left, w.width - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, b.top - w.top - m.offsetHeight - 4) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideMenu();
        document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function hideFace() { var b = $('qqFaceBox'); if (b) b.parentNode.removeChild(b); }
  function showFace(btn) {
    hideFace();
    var box = document.createElement('div');
    box.className = 'qq-face';
    box.id = 'qqFaceBox';
    var html = '';
    for (var i = 0; i < FACES.length; i++) html += '<span class="qq-face-i" data-f="' + esc(FACES[i]) + '">' + esc(FACES[i]) + '</span>';
    box.innerHTML = html;
    box.addEventListener('click', function (ev) {
      var it = closestEl(ev.target, '.qq-face-i');
      if (!it) return;
      var inp = $('qqIn');
      inp.value += '/' + it.getAttribute('data-f') + ' ';
      inp.focus();
      hideFace();
    });
    document.body.appendChild(box);
    var r = btn.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 184)) + 'px';
    box.style.top = Math.max(4, r.top - 150) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideFace();
        document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }

  function quitQQ() {
    stopPlay();
    clearMacroTimers();
    for (var i = 0; i < ambientTimers.length; i++) clearTimeout(ambientTimers[i]);
    ambientTimers = [];
    state.started = false;
    var t = $('qqTray');
    if (t) t.parentNode.removeChild(t);
    W98.closeWin($('qqWin'));
    W98.closeWin($('qqChatWin'));
    renderTaskFlash();
  }

  /* ─────────── 十二、来信派发（后台真实到达） ─────────── */
  function dispatchTick() {
    ambAfter(rand(16000, 38000), function () {
      /* 隐身不收信；页面隐藏时也不派发（与文件列表轮询同一省电原则） */
      if (state.status === 'online' && !document.hidden) {
        var cands = [];
        for (var i = 0; i < friends.length; i++) {
          var f = friends[i];
          if (state.presence[f.id] === false) continue;
          if (state.cur === f.id) continue;
          if (!nextFriendEntry(f)) continue;
          cands.push(f);
        }
        if (cands.length) {
          var fr = pick(cands);
          var ne = nextFriendEntry(fr);
          var rec = chatRec(fr.id);
          /* 磁带永远按顺序前进：跳过中间未播的「我方」台词，
             等价于「对方没等你回话就又发来一条」——这正是真实场景 */
          rec.pos = ne.i + 1;
          saveChat(fr.id);
          deliver(fr, ne.entry);
          sound('msg');
        }
      }
      dispatchTick();
    });
  }
  /* 好友在线状态会真的变：头像灰/亮、在线计数、上线敲门声都随之更新 */
  function presenceTick() {
    ambAfter(rand(45000, 90000), function () {
      var cands = friends.filter(function (f) { return !f.isGroup; });
      if (cands.length && Math.random() < 0.35) {
        var f = pick(cands);
        var on = state.presence[f.id] !== false;
        state.presence[f.id] = !on;
        renderPanel();
        renderOnline();
        if (!on && !$('qqWin').hidden) sound('knock');
      }
      presenceTick();
    });
  }

  /* ─────────── 十三、打开会话 / 面板 ─────────── */
  function renderChatTitle() {
    var f = friendById(state.cur);
    if (!f) return;
    $('qqChatTitle').textContent = '与 ' + f.name + (f.qq ? '（' + f.qq + '）' : '') + ' 对话' +
      (state.era ? ' · ' + state.era : '');
  }
  /* 聊天窗口顶部：对方头像 + 昵称（QQ号）+ 个性签名 */
  function renderChatHead() {
    var f = friendById(state.cur);
    if (!f) return;
    $('qqChatAv').innerHTML = avHtml(f);
    $('qqChatName').textContent = f.name + (f.qq ? '（' + f.qq + '）' : '');
    $('qqChatSign').textContent = f.sign;
  }
  /* 右侧资料栏：真实 QQ2008 聊天窗口右侧就是这么一栏 */
  function renderChatSide() {
    var f = friendById(state.cur);
    if (!f) { $('qqChatSide').innerHTML = ''; return; }
    $('qqChatSide').innerHTML =
      '<span class="qq-av">' + avHtml(f) + '</span>' +
      '<div class="qq-ch-sname">' + esc(f.name) + '</div>' +
      '<div class="qq-ch-srow"><b>' + (f.isGroup ? '群号' : 'QQ') + '</b> ' + esc(f.qq || '-') + '</div>' +
      '<div class="qq-ch-srow"><b>分组</b> ' + esc(f.group) + '</div>' +
      '<div class="qq-ch-srow"><b>年代</b> ' + f.era + '</div>' +
      '<div class="qq-ch-srow"><b>状态</b> ' + (state.presence[f.id] !== false ? '在线' : '离线') + '</div>' +
      '<div class="qq-ch-srow">' + esc(f.sign) + '</div>';
  }
  function openChat(id) {
    if (!friendById(id)) return;
    pause(false);          /* 切换到别的会话前，先停掉当前会话的播放 */
    state.cur = id;
    state.lastCur = id;    /* 记住最近打开的会话，关窗后也能从主菜单重播 */
    state.unread[id] = 0;
    saveUnread();
    state.partial = null;
    renderPanel();
    renderTray();
    renderTaskFlash();
    renderChatTitle();
    renderChatHead();
    renderChatSide();
    W98.openWin($('qqChatWin'));
    renderLog();
    /* 用户要求：打开好友消息之后自动输入 —— 打开即自动播放 */
    play();
  }
  function openPanel() {
    if (!state.started) {
      state.started = true;
      ensureTray();
      dispatchTick();
      hintIfOpen('QQ 已启动。好友会陆续发来消息，托盘图标有未读时会闪动。');
    }
    W98.openWin($('qqWin'));
    renderPanel();
    renderOnline();
    /* 打开面板时同步托盘与任务栏闪动：从托盘唤回时窗口已可见，
       任务栏按钮必须停止闪动，否则会出现「窗口开着、按钮狂闪」的假状态 */
    renderTray();
    renderTaskFlash();
  }

  /* ─────────── 十四、年代穿越 ─────────── */
  function applyEra() {
    W98.tickClock();
    if (state.cur) renderChatTitle();
    /* 系统属性窗口开着就同步刷新它的「系统日期」行 */
    if (!$('sysWin').hidden && W98.fillSys) W98.fillSys();
    hintIfOpen(state.era
      ? '已穿越到 ' + state.era + ' 年：任务栏时钟、系统属性、MS-DOS 的 date 同步显示当年的今天。'
      : '已回到真实日期。');
    if (state.era) sound('sys');
  }
  function buildEraOptions() {
    var sel = $('qqEra');
    for (var i = 0; i < ERAS.length; i++) {
      var o = document.createElement('option');
      o.value = ERAS[i];
      o.textContent = ERAS[i] + ' 年';
      sel.appendChild(o);
    }
    sel.value = state.era;
    sel.addEventListener('change', function () {
      state.era = sel.value;
      store('era', state.era);
      applyEra();
    });
  }

  /* ─────────── 十五、我的个性签名（真的可改、真的持久化） ─────────── */
  function initMySign() {
    var el = $('qqMySign');
    var saved = store('sign');
    el.textContent = saved || PRESETS.me.sign;
    el.title = '点击修改个性签名';
    el.addEventListener('click', function () {
      if (el._editing) return;
      el._editing = true;
      var old = el.textContent;
      var inp = document.createElement('input');
      inp.className = 'qq-era';
      inp.value = old;
      inp.setAttribute('aria-label', '修改个性签名');
      el.textContent = '';
      el.appendChild(inp);
      inp.focus();
      inp.select();
      function done(save) {
        if (!el._editing) return;
        el._editing = false;
        var v = inp.value.replace(/^\\s+|\\s+$/g, '');
        el.textContent = (save && v) ? v : old;
        if (save && v) store('sign', v);
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        else if (e.key === 'Escape') { done(false); }
      });
      inp.addEventListener('blur', function () { done(true); });
    });
  }

  /* ─────────── 十六、初始化 ─────────── */
  function init() {
    friends = PRESETS.friends.map(function (f, i) {
      f.id = 'f' + i;
      state.presence[f.id] = f.on !== false;
      return f;
    });
    state.era = store('era') || '';
    state.sound = store('sound') !== '0';
    state.status = store('status') || 'online';
    var u = store('unread');
    if (u) { try { state.unread = JSON.parse(u) || {}; } catch (e) { state.unread = {}; } }

    $('qqMyAv').innerHTML = avHtml(PRESETS.me);
    buildEraOptions();
    initMySign();
    syncSound();
    renderOnline();
    renderPanel();

    $('qqSound').addEventListener('click', toggleSound);
    $('qqState').addEventListener('change', function () {
      state.status = $('qqState').value;
      store('status', state.status);
      renderOnline();
      hintIfOpen(state.status === 'hidden'
        ? '已隐身：暂停接收新消息，切回在线后恢复。'
        : '已上线：恢复接收新消息。');
    });
    $('qqGroups').addEventListener('click', function (e) {
      var g = closestEl(e.target, '.qq-gname');
      if (g) {                                  /* 点分组标题 = 折叠/展开，与真实 QQ 一致 */
        var k = g.getAttribute('data-g');
        state.fold[k] = !state.fold[k];
        renderPanel();
        return;
      }
      var row = closestEl(e.target, '.qq-f');
      if (row) openChat(row.getAttribute('data-f'));
    });
    /* 三个 Tab：好友 / QQ群 / 最近联系人 */
    $('qqTabs').addEventListener('click', function (e) {
      var tab = closestEl(e.target, '.qq-tab');
      if (!tab) return;
      state.tab = tab.getAttribute('data-tab');
      var kids = $('qqTabs').children;
      for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('on', kids[i] === tab);
      renderPanel();
    });
    /* 查找联系人：真的按昵称/签名/号码过滤 */
    $('qqFind').addEventListener('input', function () {
      state.find = $('qqFind').value;
      renderPanel();
    });
    /* 主菜单 */
    $('qqMenuBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMenu();
    });
    $('qqMenu').addEventListener('click', function (e) { e.stopPropagation(); });
    $('qqQuitRow').addEventListener('click', function () { hideMenu(); quitQQ(); });
    /* 重播对话：从主菜单进入，不在聊天窗里放任何假按钮 */
    $('qqReplayRow').addEventListener('click', function () { hideMenu(); replayCurrent(); });
    /* 字体大小：真实切换（工具栏 A 按钮） */
    $('qqFontBtn').addEventListener('click', function () {
      var big = $('qqLog').classList.toggle('big');
      this.classList.toggle('on', big);
    });
    /* 表情：经典 QQ 默认表情，点一下真的把 /微笑 这样的文本代码插进输入框 */
    $('qqFaceBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      showFace(this);
    });
    $('qqCloseBtn').addEventListener('click', function () { W98.closeWin($('qqChatWin')); });
    /* Tab 图标：与真实 QQ 一样带小头像 */
    $('qqTabIcoF').innerHTML = avHtml({ av: 'A', pal: PRESETS.me.pal });
    $('qqTabIcoG').innerHTML = avHtml({ av: 'D', pal: { h: '#2a2a34', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#a03030' } });
    $('qqTabIcoR').innerHTML = avHtml({ av: 'E', pal: { k: '#2b6ea8', h: '#2b6ea8' } });
    $('qqSendBtn').addEventListener('click', sendMsg);
    $('qqIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMsg(); return; }
      /* 用户真的按下任意键 → 立即接管并明说。
         宏打字只改 value + 派发 input 事件，从不派发 keydown，
         所以这里收到的每一个按键都是真人发的，无需再分辨来源。 */
      if (state.playing) pause(true);
    });

    presenceTick();
  }
  init();

  /* 给 HOME_JS 的钩子用（openApp / closeWin / tickClock / fillSys / minWin / 任务栏按钮） */
  window.QQ = {
    openPanel: openPanel,
    stopPlay: stopPlay,
    syncFlash: renderTaskFlash,
    eraDate: eraDate,
    get era() { return state.era; }
  };
})();`;
const HOME_PAGE_404 = HOME_PAGE.replace('<body>', '<body class="nf">');

/* ── IE 彩蛋主页（独立端点 /ie-home 下发）──
   原实现用 iframe srcdoc 内嵌：srcdoc 文档继承父页严格 CSP
   （style-src 'self' / script-src 'self'），内联 <style> 与
   <a onclick> 全被拦，页面退化为浏览器默认样式（无灰按钮、
   无灰底、点链接无反应）。改为真实端点，仅此端点放宽为
   unsafe-inline，全站 CSP 不动。 */
const IE_HOME_HTML = '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><style>'
  + 'html{scrollbar-width:none}html::-webkit-scrollbar{width:0;height:0;display:none}'
  + 'body{margin:0;background:#c0c0c0;font:13px/1.6 "MS Sans Serif",Tahoma,"Microsoft YaHei",sans-serif;}'
  + '.wrap{max-width:520px;margin:8px auto;padding:0 12px;}'
  + '.page{background:#fff;border:2px solid;border-color:#dfdfdf #808080 #808080 #dfdfdf;box-shadow:2px 2px 0 #0a0a0a;padding:12px 16px 12px;}'
  + 'h1{font-size:18px;margin:0 0 2px;color:#000080;}'
  + '.sub{color:#404040;font-size:12px;margin:0 0 6px;}'
  + '.intro{font-size:12px;color:#404040;line-height:1.7;margin:0 0 10px;}'
  + 'hr{border:0;border-top:1px solid #808080;border-bottom:1px solid #fff;margin:6px 0 10px;}'
  + 'a.big{display:block;padding:6px 10px;background:#c0c0c0;color:#000080;font-weight:bold;'
  + 'text-decoration:underline;border:2px solid;border-color:#fff #0a0a0a #0a0a0a #fff;cursor:pointer;}'
  + 'a.big:active{border-color:#0a0a0a #fff #fff #0a0a0a;}'
  + 'a.big + a.big{margin-top:6px;}'
  + '.tip{font-size:11px;color:#404040;margin-top:8px;}'
  + '.foot{margin-top:8px;font-size:11px;color:#5a5a5a;text-align:center;}'
  + '</style></head><body><div class="wrap"><div class="page">'
  + '<h1>知行工作室</h1>'
  + '<p class="sub">Zhixing Studio · 知行合一 · <a href="https://w3b.pub/" target="_blank" rel="noopener noreferrer">https://w3b.pub/</a></p><hr>'
  + '<p class="intro">以知行合一的笨办法，做真正能用的小工具。'
  + '7喵快传 —— 单文件、零依赖的自托管文件中转服务 —— 就是其中之一。</p>'
  + '<a class="big" href="https://w3b.pub/" target="_blank" rel="noopener noreferrer">知行工作室 · 官网</a>'
  + '<a class="big" href="#" onclick="parent.window.__ieNav(null);return false">7喵快传 · 文件服务</a>'
  + '<p class="tip">官网在新标签页打开。也可以在地址栏输入文件口令（10 位）或 /s/口令/ 链接，回车即达。</p>'
  + '<div class="foot">(C) 1998-2026 知行工作室 · 本页为复古仿真彩蛋</div>'
  + '</div></div></body></html>';

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
  if (!m) {
    // 根路径：Win95 桌面（含扫雷/屏保/文件管理/开始菜单）。
    // 未知路径：HTTP 仍 404（语义正确），body 为同款桌面 + 404 对话框。
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') {
        return sendAsset(res, 'text/html; charset=utf-8', HOME_PAGE);
      }
      if (pathname === '/home.css') return sendAsset(res, 'text/css; charset=utf-8', HOME_CSS);
      /* /home.js = HOME_JS（桌面本体）+ QQ_JS（复古 QQ 模块），同一份 IIFE 纪律 */
      if (pathname === '/home.js') return sendAsset(res, 'application/javascript; charset=utf-8', HOME_JS + '\n' + QQ_JS);
      if (pathname === '/favicon.ico') return sendAsset(res, 'image/svg+xml', FAVICON);
      // IE 彩蛋主页：只在此端点放宽 CSP 允许内联样式/脚本（见 IE_HOME_HTML 注释）
      if (pathname === '/ie-home') {
        const buf = Buffer.from(IE_HOME_HTML, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          ...SEC_BASE,
        });
        return res.end(buf);
      }
      // ── 根桌面 PWA：manifest / Service Worker / 图标（作用域为 /）──
      if (pathname === '/manifest.webmanifest') {
        return sendAsset(res, 'application/manifest+json; charset=utf-8', rootManifestJson());
      }
      if (pathname === '/sw.js') {
        // VERSION 由服务端启动时间派生：每次重启都换缓存名，
        // 彻底治好「PWA 装完后永远命中旧外壳（CSS/JS 不更新）」这个顽疾。
        const buf = Buffer.from(ROOT_SW_JS.replace('__BUILD_ID__', SHELL_VERSION), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
          ...SEC_BASE,
        });
        return res.end(buf);
      }
      if (pathname === '/icons/icon-192.png') return sendBinary(res, 'image/png', ICON_192_PNG);
      if (pathname === '/icons/icon-512.png') return sendBinary(res, 'image/png', ICON_512_PNG);
      if (pathname === '/icons/icon-512-maskable.png') return sendBinary(res, 'image/png', ICON_512_MASKABLE_PNG);
      // 桌面自己用：拿到访客链接，好让"我的电脑"把文件服务嵌进窗口里
      if (pathname === '/api/boot') return sendJson(res, 200, bootPayload());
      return sendAsset(res, 'text/html; charset=utf-8', HOME_PAGE_404, 404);
    }
    if (req.method === 'POST') {
      // 登录发生在此之前还没有任何口令，所以挂在根段而非 /s/<口令>/ 下。
      if (pathname === '/api/admin-login') return handleAdminLogin(req, res);
    }
    return notFound(res);
  }
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
    // ── PWA：manifest / Service Worker / 图标 ──
    if (rest === '/manifest.webmanifest') {
      return sendAsset(res, 'application/manifest+json; charset=utf-8', manifestJson(m[1]));
    }
    if (rest === '/sw.js') {
      // SW 脚本：no-cache 让浏览器及时检测更新；不挂 CSP（SW 有独立上下文，
      // 挂了反而会限制其内部 fetch/cache 行为）。
      // VERSION 随服务启动时间变化，避免「PWA 装完永远旧外壳」。
      const buf = Buffer.from(SW_JS.replace('__BUILD_ID__', SHELL_VERSION), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        ...SEC_BASE,
      });
      return res.end(buf);
    }
    if (rest === '/icons/icon-192.png') return sendBinary(res, 'image/png', ICON_192_PNG);
    if (rest === '/icons/icon-512.png') return sendBinary(res, 'image/png', ICON_512_PNG);
    if (rest === '/icons/icon-512-maskable.png') return sendBinary(res, 'image/png', ICON_512_MASKABLE_PNG);
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
    if (rest === '/api/text') {
      // 文字分享同样写盘，之前漏了限流：脚本可以不受约束地刷满磁盘。
      if (rateLimited(clientIp(req))) {
        return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
      }
      return handleText(req, res, m[1]);
    }
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
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">',
  '<meta name="theme-color" content="#008080">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="robots" content="noindex,nofollow">',
  '<title>7喵快传 · 一个文件，一个桌面</title>',
  '<meta name="description" content="一个文件，一个桌面 —— 单文件、零依赖的自托管文件中转服务，带一套能装进手机的 Win98 桌面。">',
  '<link rel="icon" href="./favicon.ico">',
  '<link rel="apple-touch-icon" href="./icons/icon-192.png">',
  '<link rel="manifest" href="./manifest.webmanifest">',
  '<link rel="stylesheet" href="./app.css">',
  '</head>',
  '<body>',
  '<div class="desk">',
  '  <div class="window">',
  '',
  '    <div class="titlebar">',
  '      <span class="tb-title">7喵快传</span>',
  '      <span class="tb-actions">',
  '        <button class="tb-btn tb-install" id="tbInstall" type="button" hidden aria-label="安装到桌面" title="安装到桌面">⬇</button>',
  '        <button class="tb-mode" id="tbMode" type="button" title="查看当前链接的身份与权限">…</button>',
  '      </span>',
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
  '      <button id="viewerFs" class="tb-btn" type="button" aria-label="全屏" title="全屏 / 退出全屏">⛶</button>',
  '      <button id="viewerClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div id="viewerBody" class="viewer-body"></div>',
  '    <div class="viewer-foot">',
  '      <button id="viewerPrev" type="button">◀ 上一个</button>',
  '      <a id="viewerDl" class="btn-like" download>下载</a>',
  '      <button id="viewerNext" type="button">下一个 ▶</button>',
  '      <button id="viewerCloseFoot" type="button">关闭</button>',
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
html{-webkit-text-size-adjust:100%;overflow-x:hidden}
html,body{margin:0;padding:0}
/* ── 隐藏式滚动条：整页只保留一个滚动上下文，且不画滚动条轨道 ──
   滚轮 / 触屏滑动照常可用；视觉上由窗口边框与页面留白承担"可滚"暗示。 */
*{scrollbar-width:none;scrollbar-color:transparent transparent}
::-webkit-scrollbar{width:0;height:0;display:none}
::-webkit-scrollbar-button{display:none}
body{
  background:var(--desk);
  color:var(--text);
  min-height:100dvh;
  font:13px/1.45 "MS Sans Serif",Tahoma,"SimSun","宋体","Microsoft YaHei",sans-serif;
  -webkit-tap-highlight-color:transparent;
  /* 兜底：任何意外超宽元素都不产生横向滚动条 */
  overflow-x:hidden;
  max-width:100%;
  /* 触屏：阻止下拉刷新/滚动链穿透，页面本体不上下弹动 */
  overscroll-behavior-y:none;
}
/* 离线提示条：断网时如实告知当前展示的是缓存内容 */
body[data-net="off"]::before{
  content:'离线模式 · 正在显示已缓存内容';
  display:block;background:var(--face);color:var(--dis);
  box-shadow:var(--sink);font-size:11px;padding:4px 8px;text-align:center;
}
img,canvas,video{max-width:100%}
button,input,textarea,select{font-family:inherit}
[hidden]{display:none !important}

/* ── 触屏基础层 ──
   touch-action:manipulation 让浏览器放弃等待双击缩放，
   从而消除点击延迟（移动端最常见的"点了没反应"感）；
   按钮/图标同时禁止长按选中与系统菜单，避免打断操作。 */
button,.tb-btn,.tb-mode,.row-more,.ico,.sb-panel.clickable,.sheet-item,.btn-like,.drop,.row.tappable{
  touch-action:manipulation;
  -webkit-user-select:none;user-select:none;
  -webkit-touch-callout:none;
}
input,textarea{touch-action:auto}

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
/* 标题栏右侧动作区：安装按钮 + 模式按钮 */
.tb-actions{display:flex;align-items:center;gap:5px;flex:none}
.tb-install{font-size:12px;font-weight:700}
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
  /* fieldset 默认 min-inline-size:min-content 会阻止收缩并撑破窄屏，
     必须显式归零，否则移动端会出现横向溢出 */
  min-inline-size:0;min-width:0;
}
fieldset.panel legend{
  font-size:12px;font-weight:700;padding:0 6px;margin-left:2px;
  /* 长文字图例同样会撑破窄屏 */
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#filesCount{font-weight:400;color:#404040;margin-left:5px}
.panel-tools{position:absolute;top:-2px;right:8px;display:flex;gap:4px}
.panel-tools button{font-size:11.5px;padding:2px 9px;min-height:22px;position:relative}
.panel-tools button:active{padding:3px 8px 1px 10px}
/* 触屏：热区向下扩展补足高度（按钮本身不能被 top 偏移裁切） */
.panel-tools button::after{
  content:'';position:absolute;left:50%;top:50%;
  width:100%;min-width:48px;height:44px;transform:translate(-50%,-50%);
}

/* 文件列表不再自带内部滚动（旧版列表有高度上限 + overflow 会形成
   "页面滚动条 + 列表滚动条" 两级嵌套）：列表自然撑开，整页只滚一次。 */
.list{list-style:none;margin:8px 0 0;padding:2px;background:var(--win);box-shadow:var(--sink)}
.row{
  display:flex;align-items:center;gap:9px;
  padding:7px 6px;
  border-bottom:1px dotted #b0b0b0;
  min-width:0;
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
}.meta{min-width:0;flex:1}
.fname{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fsub{color:#505050;font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;
  min-width:0;overflow-wrap:anywhere}
.row-more{
  width:30px;height:30px;min-height:0;padding:0;flex:none;
  display:grid;place-items:center;font-size:15px;line-height:1;
  background:var(--face);color:var(--text);box-shadow:var(--raise);
  position:relative;
}
/* 触屏：视觉仍是 30px 小按钮，但热区向四周扩展到约 48px，
   兼顾复古观感与手指可点性（不改变布局，用 ::after 扩大命中区） */
.row-more::after{
  content:'';position:absolute;left:50%;top:50%;
  width:48px;height:48px;transform:translate(-50%,-50%);
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
  display:flex;align-items:center;min-height:19px;
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
.viewer .viewer-dlg{width:min(920px,100%);height:min(88dvh,100%);will-change:transform}
/* 全屏：真全屏 API 与 CSS 兜底都让对话框铺满视口，视频/图片随之填满；
   标题栏 ✕ 仍浮在最上层，保证任何设备都能随时退出 */
.viewer-dlg:fullscreen{width:100vw;height:100vh;max-width:none;max-height:none;border-width:0}
.viewer-dlg.is-full{position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;z-index:300;border-width:0}
.viewer-dlg:fullscreen .viewer-body,.viewer-dlg.is-full .viewer-body{margin:0}
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

/* ══ 触屏设备（手机/平板）：保证 44px 触控标准 ══
   Apple HIG 与 Material 均建议可点区域 ≥44×44。
   窄屏空间紧张，采用"视觉尺寸适度缩小、热区补足"的策略：
   按钮本体撑到 ≥44px 高，图标类用 ::after 扩热区，避免挤压排版。*/
@media (pointer:coarse), (max-width:560px){
  .desk{padding:calc(7px + var(--safe-t)) calc(7px + var(--safe-r)) calc(7px + var(--safe-b)) calc(7px + var(--safe-l))}
  .win-body{padding:8px 7px 7px}
  .sb-mid{display:none}
  .viewer .viewer-dlg{height:min(94dvh,100%)}
  .dialog{max-height:100%}

  /* 工具栏 / 按钮行：撑到 44px 高，字号保持可读 */
  .toolbar{gap:6px;margin-bottom:10px}
  .toolbar button{font-size:12px;padding:8px 6px;min-height:44px}
  .btnrow{gap:6px;margin-top:8px}
  .btnrow button{font-size:12px;padding:8px 6px;min-height:44px}

  /* 标题栏按钮：触屏撑到 44px 热区，标题栏相应加高 */
  .titlebar{min-height:44px;padding:5px 5px 5px 8px}
  .tb-mode{font-size:12px;padding:6px 12px;min-height:34px;position:relative}
  .tb-mode::after{content:'';position:absolute;left:0;top:50%;width:100%;height:44px;transform:translateY(-50%)}
  .tb-btn{width:38px;height:34px;font-size:13px;position:relative}
  .tb-btn::after{content:'';position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%)}

  /* 刷新按钮：热区补足（见 ::after 规则） */
  .panel-tools{top:-4px;right:6px}
  .panel-tools button{font-size:12px;padding:6px 12px;min-height:30px}

  /* 列表行：整体加高，让整行成为可点热区 */
  .row{gap:9px;padding:11px 7px;min-height:56px}
  .row-more{width:32px;height:32px;font-size:16px}
  .ico{width:32px;height:29px;font-size:9px}

  /* 状态栏：可点面板撑到 44px 高 */
  .statusbar{padding:4px}
  .sb-panel{min-height:44px;padding:4px 8px;font-size:11.5px}

  /* 页脚外链：扩大可点区域 */
  .footer{padding:10px 6px 8px}
  .footer a{display:inline-block;padding:8px 6px;min-height:32px}

  /* 图例让位给刷新按钮，避免重叠 */
  fieldset.panel legend{padding-right:76px}
  .fsub{gap:5px 10px}

  /* 操作面板（底部弹出）：条目撑到 48px，拇指友好 */
  .sheet-dlg{margin-bottom:calc(4px + var(--safe-b))}
  .sheet-item{min-height:48px;padding:12px 14px;font-size:14px}

  /* 预览页脚按钮 */
  .viewer-foot{gap:6px;padding:6px}
  .viewer-foot>*{min-height:44px}

  /* 输入框：字号 ≥16px 可避免 iOS 聚焦时自动放大页面 */
  textarea{font-size:16px;min-height:96px}
}

/* 极窄屏（≤400px）：只压字号与间距，不再缩小触控目标 */
@media (max-width:400px){
  .toolbar button,.btnrow button{font-size:11.5px;padding:8px 4px;min-height:44px}
  .row{gap:8px;padding:10px 6px;min-height:54px}
  .row-more{width:30px;height:30px}
  .ico{width:30px;height:27px;font-size:8.5px}
  fieldset.panel legend{padding-right:72px}
  .sb-panel{font-size:11px;padding:4px 6px}
}

/* 支持悬停的精确指针设备（桌面鼠标）才启用 hover 高亮 */
@media (hover:hover) and (pointer:fine){
  .row.tappable:hover{background:var(--sel);color:#fff}
}
@media (hover:none){
  .row:hover{background:transparent;color:var(--text)}
  .row:hover .fsub{color:#505050}
  .row:hover .ico{color:var(--title)}
  .row:hover .row-more{color:var(--text)}
  /* 触屏用按下态代替 hover，给出明确点击反馈 */
  .row.tappable:active{background:var(--sel);color:#fff}
  .row.tappable:active .fsub{color:#d0d0d0}
  .row.tappable:active .ico{color:#fff}
  .row.tappable:active .row-more{color:#fff}
  button:active,.btn-like:active{background:#b8b8b8}
}

/* ── 嵌入模式 (?embed=1) ──
   桌面把本页嵌进 iframe 当一个"窗口"用。此时外层已经提供了 95 的窗框、
   标题栏和背景，本页必须"脱壳"：让出内边距、去掉投影和宽度限制，
   否则会出现"窗中窗"两层边框叠在一起。背景改透明，桌面底色自然透进来。 */
body.embed{background:transparent;overflow:hidden;height:100vh;height:100dvh}
body.embed[data-net="off"]::before{display:none}
body.embed .desk{min-height:0;height:100%;padding:0;display:block}
body.embed .window{
  max-width:none;width:100%;height:100%;
  box-shadow:none;padding:0;
  display:flex;flex-direction:column;
}
body.embed .titlebar{display:none}
/* 预览浮层的标题栏不能跟着一起藏：右上角的 ✕ 是预览的出口之一，
   藏了它，视频/图片预览在内嵌窗口里就没有任何关闭入口（手机上尤其致命）。 */
body.embed .viewer .titlebar{display:flex}
body.embed .footer{display:none}
body.embed .win-body{
  flex:1;min-height:0;overflow-y:auto;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
`;

const APP_JS = `
(function () {
  'use strict';

  // ── 嵌入模式 (?embed=1) ──
  // 桌面把本页当"窗口内容"嵌进来。此时：
  //   1) 打上 body.embed，让 CSS 把窗框/内边距/投影全部让出去；
  //   2) **不注册 Service Worker** —— 外层根桌面已经有一个 SW，
  //      同源再注册一个会让两套 fetch 缓存策略互相打架；而且 embed 页面
  //      本来就不是一个独立的"应用"，离线能力由外层负责。
  //   3) 不触发安装提示（外层桌面才是可安装的那个应用）。
  var EMBED = /[?&]embed=1(&|$)/.test(location.search);
  if (EMBED) {
    document.body.classList.add('embed');
    try { document.documentElement.setAttribute('data-embed', '1'); } catch (e) {}
  }

  // 移动浏览器"桌面版网页"模式防御：触屏小屏设备 + 布局视口被拉到桌面宽(>=700)
  // 时，动态改写 viewport 强制回设备宽度。桌面/平板不受影响。
  try {
    var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (touch && window.screen.width <= 480 && document.documentElement.clientWidth >= 700) {
      var mv = document.querySelector('meta[name="viewport"]');
      if (mv) mv.setAttribute('content', 'width=device-width,initial-scale=1,viewport-fit=cover');
    }
  } catch (e) {}

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
  var currentVideo = null;   // 当前预览里的 <video>，全屏时优先用它
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

  /* ── PWA：缩略图生成 ──
     预览图片时顺手用 canvas 生成 ≤256px 的 JPEG 缩略图，交给 SW 写进
     Cache Storage（Cache API 只能在 SW 侧写，postMessage 是官方通道）。
     视频/大图/SVG 一律跳过：控制缓存体积，也避免无谓的解码开销。 */
  function makeThumb(it) {
    if (!it || !it.id) return;
    var t = String(it.type || '').toLowerCase();
    if (t.indexOf('image/') !== 0) return;
    if (t.indexOf('image/svg') === 0) return;
    if (it.size > 4 * 1024 * 1024) return;
    if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) return;

    var im = new Image();
    im.decoding = 'async';
    im.onload = function () {
      try {
        var MAX = 256;
        var w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) return;
        var s = Math.min(1, MAX / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * s));
        var ch = Math.max(1, Math.round(h * s));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(im, 0, 0, cw, ch);
        var done = function (blob) {
          if (blob) navigator.serviceWorker.controller.postMessage(
            { type: 'thumb', id: it.id, blob: blob });
        };
        if (cv.toBlob) cv.toBlob(done, 'image/jpeg', 0.72);
      } catch (e) { /* 忽略：缩略图是纯增量优化 */ }
    };
    im.onerror = function () { /* 忽略 */ };
    im.src = viewUrl(it);
  }
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
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    viewerDlg.classList.remove('is-full');
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
    currentVideo = null;
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
      makeThumb(it);
    } else if (kind === 'video') {
      var v = document.createElement('video');
      v.src = viewUrl(it); v.controls = true; v.autoplay = true;
      v.playsInline = true; v.setAttribute('playsinline', '');
      currentVideo = v;
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
  $('viewerCloseFoot').addEventListener('click', closeViewer);

  /* 全屏：视频预览要能沉浸式铺满，又不丢「随时关闭」的出口。
     三层兜底：① 标准 Fullscreen API（桌面，真·系统级全屏）；
     ② iOS Safari 用视频原生 webkitEnterFullscreen（标准 API 在 iOS 上对普通元素无效）；
     ③ 都不支持时退化为 CSS 兜底（对话框 fixed 铺满视口，标题栏 ✕ 仍在最上层）。 */
  var viewerDlg = viewer.querySelector('.viewer-dlg');
  function syncFsBtn() {
    var on = !!(document.fullscreenElement || viewerDlg.classList.contains('is-full'));
    $('viewerFs').textContent = on ? '⤡' : '⛶';
    $('viewerFs').setAttribute('aria-label', on ? '退出全屏' : '全屏');
  }
  function exitFull() {
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    if (viewerDlg.classList.contains('is-full')) { viewerDlg.classList.remove('is-full'); syncFsBtn(); return true; }
    return false;
  }
  function toggleFullscreen() {
    if (exitFull()) return;
    if (viewerDlg.requestFullscreen) {
      viewerDlg.requestFullscreen().catch(function () { viewerDlg.classList.add('is-full'); });
    } else if (currentVideo && currentVideo.webkitEnterFullscreen) {
      try { currentVideo.webkitEnterFullscreen(); } catch (e) { viewerDlg.classList.add('is-full'); }
    } else {
      viewerDlg.classList.add('is-full');
    }
    syncFsBtn();
  }
  $('viewerFs').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFsBtn);
  document.addEventListener('webkitfullscreenchange', syncFsBtn);
  /* 双击 / 双触关闭：视频、图片等内容可能占满整个预览区（内嵌窗口里更是如此），
     必须保证「双击内容本身」也能关掉预览，否则内容一撑满就找不到出口。
     自行计时判定（350ms 内同位置两次按下），不依赖 dblclick——
     iOS Safari 在部分缩放设置下根本不发 dblclick。 */
  (function doubleTapToClose() {
    var last = 0, lx = 0, ly = 0;
    viewerBody.addEventListener('pointerdown', function (e) {
      var now = Date.now();
      if (now - last < 350 && Math.abs(e.clientX - lx) < 48 && Math.abs(e.clientY - ly) < 48) {
        last = 0;
        closeViewer();
        return;
      }
      last = now; lx = e.clientX; ly = e.clientY;
    });
  })();
  viewer.addEventListener('click', function (e) {
    if (e.target === viewer) closeViewer();
  });
  /* 移动端：预览浮层下滑关闭（手机上最自然的手势）。
     只在内容未滚动到顶部、且纵向位移明显时触发，避免与内部滚动打架。 */
  (function swipeDownToClose() {
    var y0 = 0, x0 = 0, dragging = false, moved = false;
    var dlg = viewer.querySelector('.viewer-dlg');
    var body = $('viewerBody');
    viewer.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
      dragging = true; moved = false;
    }, { passive: true });
    viewer.addEventListener('touchmove', function (e) {
      if (!dragging || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - y0;
      var dx = e.touches[0].clientX - x0;
      if (Math.abs(dy) <= Math.abs(dx)) return;             // 横向滑动 = 切换上一个/下一个
      var atTop = !body || body.scrollTop <= 0;
      if (dy > 0 && atTop) {
        moved = true;
        if (dlg) dlg.style.transform = 'translateY(' + Math.min(dy, 140) + 'px)';
      }
    }, { passive: true });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      var dy = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY - y0 : 0;
      if (dlg) { dlg.style.transition = 'transform .18s ease'; dlg.style.transform = ''; }
      setTimeout(function () { if (dlg) dlg.style.transition = ''; }, 200);
      if (moved && dy > 90) closeViewer();
      moved = false;
    }
    viewer.addEventListener('touchend', end, { passive: true });
    viewer.addEventListener('touchcancel', end, { passive: true });
  })();

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

  /* ───────────── 触屏增强 ───────────── */
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  if (isTouch) {
    // 1) 滑动防误触：手指在滚动列表上滑动后抬起，不应触发该行的"点击进预览"。
    //    以 touchstart 起点为基准，位移超过阈值即判定为滚动，屏蔽随后的 click。
    var MOVE_TOL = 10; // px
    var tStart = null, tMoved = false;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tStart = null; return; }
      tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      tMoved = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!tStart || e.touches.length !== 1) return;
      var dx = Math.abs(e.touches[0].clientX - tStart.x);
      var dy = Math.abs(e.touches[0].clientY - tStart.y);
      if (dx > MOVE_TOL || dy > MOVE_TOL) tMoved = true;
    }, { passive: true });
    // 捕获阶段拦截：一旦判定为滑动，吃掉这次 click
    document.addEventListener('click', function (e) {
      if (!tMoved) return;
      tMoved = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    // 2) 遮罩层整片可点关闭：给弹层加一个更大的"点击背景关闭"区域，
    //    手机上没有 ESC 键，背景关闭是最自然的手势。
    [viewer, qrModal, $('infoModal'), sheet].forEach(function (layer) {
      if (!layer) return;
      layer.addEventListener('touchend', function (e) {
        // 仅当手指本身落在遮罩（不是对话框内部）时才关闭
        if (e.target !== layer) return;
        var t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        var el = document.elementFromPoint(t.clientX, t.clientY);
        if (el === layer) {
          if (layer === sheet) closeSheet();
          else if (layer === viewer) closeViewer();
          else layer.hidden = true;
        }
      }, { passive: true });
    });

    // 3) 双击缩放抑制：桌面版网页模式下，双击常被误判为缩放，
    //    对按钮/列表这类交互元素直接屏蔽后续双击。
    document.addEventListener('dblclick', function (e) {
      var t = e.target;
      if (t.closest && t.closest('button,.row-more,.ico,.tappable,.sheet-item')) e.preventDefault();
    }, { passive: false });

    // 4) 可视区域变化（手机键盘弹出/收起）时，让输入区滚动到可见位置，
    //    否则 iOS 聚焦输入框后会被键盘完全遮住。
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var ta = $('textInput');
        if (!document.activeElement || document.activeElement !== ta) return;
        var pane = $('textPane');
        if (pane && !pane.hidden) {
          setTimeout(function () { pane.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 120);
        }
      });
    }
  }

  /* ───────────── PWA：SW 注册 / 安装按钮 / 离线状态 ───────────── */
  // 注册 Service Worker（./sw.js 相对 <base> 解析为 /s/<口令>/sw.js，
  // 作用域天然落在本口令目录内，不影响其他口令与首页）。
  // embed 模式下跳过：外层桌面已有自己的 SW，同源双注册会互相打架。
  if (!EMBED && 'serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .catch(function () { /* SW 失败不影响页面正常使用 */ });
    });
  }

  // 安装按钮：Chromium 系捕获 beforeinstallprompt 后走原生安装流程；
  // iOS Safari 没有该事件，点击时如实给出「添加到主屏幕」的手动引导。
  var deferredPrompt = null;
  var installBtn = EMBED ? null : $('tbInstall');

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          deferredPrompt = null;
          installBtn.hidden = true;
        }).catch(function () {});
        return;
      }
      toast('iOS：点浏览器底部「分享」→「添加到主屏幕」');
    });
  }

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (installBtn) installBtn.hidden = true;
    toast('已安装到桌面');
  });

  // iOS：无 beforeinstallprompt 事件，但未以独立模式运行时也亮出按钮做引导
  var standalone = window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;
  if (installBtn && !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    installBtn.hidden = false;
  }

  // 离线状态条：断网时 body[data-net=off] 顶部如实提示当前是缓存内容
  function paintNet() {
    document.body.setAttribute('data-net', navigator.onLine ? 'on' : 'off');
  }
  window.addEventListener('online', function () { paintNet(); lastSig = ''; load(); });
  window.addEventListener('offline', paintNet);
  paintNet();

  // 嵌入模式下向桌面外层报到：外层据此收起"正在载入"遮罩。
  // 用 '*' 而不指定 origin：同源 iframe，且外层只需要知道"好了"。
  if (EMBED) {
    try { window.parent.postMessage({ type: 'drop-ready' }, '*'); } catch (e) {}
  }

  load();
  setInterval(function () {
    // 页面被切到后台时跳过本轮：省流量省电，也少一次无谓的列表渲染。
    // online 事件已负责恢复在线后的立即刷新，不会漏数据。
    if (document.hidden) return;
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


const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">' +
  '<rect width="32" height="32" fill="#008080"/>' +
  // Win95 四色旗：斜切平行四边形（顶边比底边右移 4 = 飘动感），黑描边硬像素
  '<path d="M6 5 L14 5 L10 14 L2 14 Z" fill="#d4000a" stroke="#0a0a0a" stroke-width="1"/>' +
  '<path d="M18 3 L26 3 L22 12 L14 12 Z" fill="#007c30" stroke="#0a0a0a" stroke-width="1"/>' +
  '<path d="M5 18 L13 18 L9 27 L1 27 Z" fill="#0050be" stroke="#0a0a0a" stroke-width="1"/>' +
  '<path d="M17 16 L25 16 L21 25 L13 25 Z" fill="#ffd500" stroke="#0a0a0a" stroke-width="1"/>' +
  '</svg>';

// ───────────────── PWA Service Worker ─────────────────
// 作用域 = SW 自身所在目录（/s/<口令>/），天然按口令隔离，首页不受影响。
// 策略：外壳 cache-first（离线可开）、导航 network-first（断网回退壳）、
// /api/* /v/* /d/* 一律 network-only（列表必须实时、私人文件不进缓存）。
// 注意：本模板串内禁止出现反引号与 ${（与 QR_JS 同一构建纪律）。
const SW_JS = `
'use strict';
var VERSION = '__BUILD_ID__';
var SHELL_CACHE = 'drop-shell-' + VERSION;
var THUMB_CACHE = 'drop-thumb-' + VERSION;
var SHELL = ['./', './app.css', './app.js', './qr.js', './favicon.ico', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  var keep = [SHELL_CACHE, THUMB_CACHE];
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (keep.indexOf(k) < 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 页面预览图片后会送来 canvas 生成的缩略图（≤256px JPEG），写进专用缓存。
// cache key 用 /thumb/<id>，与原图 /v/<id> 完全隔离，绝不污染原图预览。
// 缩略图缓存条数上限。只 put 不淘汰会让 THUMB_CACHE 随预览数量无限膨胀
// （每条 Cache-Control 一年、activate 又只按版本名清理旧缓存），
// 长期使用等于白占用户存储。这里做最简 LRU：每条 TTL 一年、
// 先 delete 再 put 保证刚写入的排在枚举尾部，超出上限就删头部最旧的几条。
// 误淘汰的后果仅仅是重新生成一张缩略图，无害。
var THUMB_MAX = 200;
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'thumb' || !d.id || !d.blob) return;
  e.waitUntil(
    caches.open(THUMB_CACHE).then(function (c) {
      var key = '/thumb/' + d.id;
      return c.delete(key).then(function () {
        return c.put(key, new Response(d.blob, {
          headers: { 'Content-Type': d.blob.type || 'image/jpeg', 'Cache-Control': 'max-age=31536000' }
        }));
      }).then(function () {
        return c.keys();
      }).then(function (keys) {
        if (keys.length <= THUMB_MAX) return;
        var stale = keys.slice(0, keys.length - THUMB_MAX);
        return Promise.all(stale.map(function (r) { return c.delete(r); }));
      });
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：network-first，断网时回退到缓存的应用外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('./').then(function (r) { return r || Response.error(); });
      })
    );
    return;
  }

  var path = url.pathname;

  // 缩略图：纯缓存读取（不会真的发起网络请求）
  if (path.indexOf('/thumb/') >= 0) {
    e.respondWith(
      caches.match(path).then(function (r) { return r || new Response('', { status: 404 }); })
    );
    return;
  }

  // 应用外壳：cache-first，未命中回源并回填。
  // 与根 SW 同一处坑：页面给静态资源加 ?v= 版本号时，按完整 request 匹配会落空，
  // 离线首启就拿不到 CSS/JS。统一按 pathname 存取，版本号只当缓存破坏器用。
  if (/\\.(css|js|webmanifest|ico|png|svg)$/.test(path) || path.charAt(path.length - 1) === '/') {
    var key = url.pathname;
    e.respondWith(
      caches.match(key).then(function (r) {
        if (r) return r;
        return fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(key, copy); });
          }
          return res;
        });
      }).catch(function () { return fetch(req); })
    );
  }
  // 其余（/api/*、/v/*、/d/* 等）：不拦截，直连网络
});
`;

// ───────────────────────── 启动 ─────────────────────────

// ───────────────── PWA 图标（纯 Node 手写 PNG）─────────────────
// 【落点说明】本段必须在「启动」标记**之后**。
// _build.js 用 src.slice(0, i) + ui + src.slice(j) 重写文件，其中
// [i, j) 是「前端」到「启动」之间的整个区间 —— 该区间内的一切都会被
// _newui.js 的内容替换掉。图标常量一度放在 SW_JS 之后（仍在该区间内），
// 首次构建即被静默抹除，表现为 /s/ 下三个图标 500 而根路径正常
// （根路径那几行路由在 [i,j) 之外，所以活着）。教训：边界外的真源只有
// 两处 —— 「前端」标记之前，和「启动」标记之后。
//
// 为什么不用 SVG：Android/Chromium 的安装器不消费 SVG 图标，manifest 里
// 必须给出真实的 192px 与 512px PNG，否则"添加到主屏幕"会退回一个默认方块。
// 为什么不用依赖库：本项目的卖点就是零 npm 依赖，一个 60 行的编码器足够。
// 构图复刻 FAVICON（青绿底 → 灰窗口 → 蓝标题栏 → 白内容区 → 三条蓝横线），
// 全部走 32×32 逻辑网格放大，边缘保持硬像素，符合 Windows 98 的观感。

const PNG_CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function pngCrc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = PNG_CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 32×32 的逻辑调色板图案放大成 size×size 的 PNG Buffer */
function makeIconPng(size, pad) {
  const PALETTE = {
    T: [0x00, 0x80, 0x80], // teal 桌面底
    F: [0xc0, 0xc0, 0xc0], // face 灰
    B: [0x00, 0x50, 0xbe], // 旗蓝
    W: [0xff, 0xff, 0xff], // 白内容区
    S: [0x80, 0x80, 0x80], // 阴影灰
    D: [0x0a, 0x0a, 0x0a], // 深色描边
    K: [0x0a, 0x0a, 0x0a], // 旗描边黑
    R: [0xd4, 0x00, 0x0a], // 旗红
    G: [0x00, 0x7c, 0x30], // 旗绿
    Y: [0xff, 0xd5, 0x00], // 旗黄
  };
  const ART = [
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    'TTTTTTTTTTTTTTTTTKKKKKKKKKKTTTTT',
    'TTTTTTTTTTTTTTTTTKGGGGGGGGGKTTTT',
    'TTTTTKKKKKKKKKKTKKGGGGGGGGGKTTTT',
    'TTTTTKRRRRRRRRRKKGGGGGGGGGKKTTTT',
    'TTTTKKRRRRRRRRRKKGGGGGGGGGKTTTTT',
    'TTTTKRRRRRRRRRKKGGGGGGGGGKKTTTTT',
    'TTTKKRRRRRRRRRKKGGGGGGGGGKTTTTTT',
    'TTTKRRRRRRRRRKKGGGGGGGGGKKTTTTTT',
    'TTKKRRRRRRRRRKKGGGGGGGGGKTTTTTTT',
    'TTKRRRRRRRRRKKGGGGGGGGGKKTTTTTTT',
    'TKKRRRRRRRRRKKGGGGGGGGGKTTTTTTTT',
    'TKRRRRRRRRRKKTKKKKKKKKKKTTTTTTTT',
    'TKRRRRRRRRRKTTTTTTTTTTTTTTTTTTTT',
    'TTKKKKKKKKKKTTTTKKKKKKKKKKTTTTTT',
    'TTTTTTTTTTTTTTTTKYYYYYYYYYKTTTTT',
    'TTTTKKKKKKKKKKTKKYYYYYYYYYKTTTTT',
    'TTTTKBBBBBBBBBKKYYYYYYYYYKKTTTTT',
    'TTTKKBBBBBBBBBKKYYYYYYYYYKTTTTTT',
    'TTTKBBBBBBBBBKKYYYYYYYYYKKTTTTTT',
    'TTKKBBBBBBBBBKKYYYYYYYYYKTTTTTTT',
    'TTKBBBBBBBBBKKYYYYYYYYYKKTTTTTTT',
    'TKKBBBBBBBBBKKYYYYYYYYYKTTTTTTTT',
    'TKBBBBBBBBBKKYYYYYYYYYKKTTTTTTTT',
    'KKBBBBBBBBBKKYYYYYYYYYKTTTTTTTTT',
    'KBBBBBBBBBKKTKKKKKKKKKKTTTTTTTTT',
    'KBBBBBBBBBKTTTTTTTTTTTTTTTTTTTTT',
    'TKKKKKKKKKKTTTTTTTTTTTTTTTTTTTTT',
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
  ];

  // pad=1（maskable）：把内容缩到中间 60%，四周补桌面底色，
  // 以适配 Android 的圆形/水滴形自适应裁剪。
  const scale = size / 32;
  const inset = pad ? Math.round(size * 0.2) : 0;
  const innerScale = (size - inset * 2) / 32;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowOff = y * (size * 4 + 1);
    raw[rowOff] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      let rgb;
      if (pad) {
        const lx = Math.floor((x - inset) / innerScale);
        const ly = Math.floor((y - inset) / innerScale);
        if (lx < 0 || ly < 0 || lx > 31 || ly > 31) rgb = PALETTE.T;
        else rgb = PALETTE[ART[ly][lx]] || PALETTE.T;
      } else {
        const lx = Math.min(31, Math.floor(x / scale));
        const ly = Math.min(31, Math.floor(y / scale));
        rgb = PALETTE[ART[ly][lx]] || PALETTE.T;
      }
      const o = rowOff + 1 + x * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const ICON_192_PNG = makeIconPng(192, 0);
const ICON_512_PNG = makeIconPng(512, 0);
const ICON_512_MASKABLE_PNG = makeIconPng(512, 1);

// ───────────────── 根桌面 PWA（manifest + Service Worker）─────────────────
// 与 /s/<口令>/ 那套完全平行，但作用域是 `/`。
// 关键差异：根 SW 的 fetch **必须显式跳过 /s/** —— 分享页有自己的 SW，
// 两个 SW 的 fetch 处理器都活着的话，缓存策略会互相打架。
// 这里不依赖"作用域不重叠"这个隐含假设，直接白名单化：只碰桌面自己的外壳。

function rootManifestJson() {
  return JSON.stringify({
    name: '7喵快传 · Win98 桌面',
    short_name: '7喵快传',
    description: '7喵快传 · 单文件自托管文件服务，跑在 Windows 98 仿真桌面上',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    id: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    theme_color: '#008080',
    background_color: '#008080',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/favicon.ico', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    /* Android 长按图标快捷方式：直接进文件服务 / 扫雷，省一层桌面点击 */
    shortcuts: [
      { name: '文件服务', short_name: '文件', url: '/', description: '进入文件管理' },
      { name: '扫雷', short_name: '扫雷', url: '/?app=mines', description: '来一局扫雷' },
    ],
  });
}

// 注意：本模板串内禁止出现反引号与 ${（与 QR_JS / SW_JS 同一构建纪律）。
const ROOT_SW_JS = `
'use strict';
var VERSION = '__BUILD_ID__';
var CACHE = 'win95-shell-' + VERSION;
var SHELL = ['/', '/home.css', '/home.js', '/favicon.ico',
             '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  var path = url.pathname;
  // 白名单化：除了桌面自己的外壳，一律不拦。
  // /s/ 前缀是硬红线 —— 那是分享页的地盘，它有自己的 SW。
  if (path.indexOf('/s/') === 0) return;
  var isShell = path === '/' || path === '/index.html' ||
    path === '/home.css' || path === '/home.js' || path === '/favicon.ico' ||
    path.indexOf('/icons/') === 0;
  if (!isShell) return;

  // 导航请求：network-first，断网时回退到缓存的桌面外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('/').then(function (r) { return r || Response.error(); });
      })
    );
    return;
  }

  // 外壳资源：cache-first。
  // 踩过的坑：页面里 home.css / home.js 带 ?v=6 版本号，而预缓存用的是裸路径，
  // 直接 caches.match(req) 会因查询串不匹配永远落空 —— 离线冷启动就没有 CSS/JS。
  // 这里统一按 pathname 存取，把版本号当作纯粹的缓存破坏器。
  var key = url.pathname;
  e.respondWith(
    caches.match(key).then(function (r) {
      if (r) return r;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(key, copy); });
        }
        return res;
      });
    }).catch(function () { return fetch(req); })
  );
});
`;

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
  if (ADMIN_PASS_IS_DEFAULT) {
    console.warn('⚠  未设置环境变量 ADMIN_PASS，使用内置默认口令。'
      + ' 任何拿到页面的人都能以管理员登录 —— 公网部署前请设置 ADMIN_PASS。');
  }
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await loadIndex();
  await sweep();
  setInterval(() => { sweep().catch(() => {}); }, SWEEP_INTERVAL_MS);

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

// 退出前收尾：abort 掉未完成的上传会话（tmp 不留到下次 sweep 才回收）、
// flush 防抖期间累积的下载计数。server.close 等长连接自然结束，但可能被
// 挂起的请求拖住，3 秒兜底强制退出，保证 Ctrl-C / kill 都能干脆退出。
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n正在退出…');
  server.close(async () => {
    try {
      await Promise.all(Array.from(uploads.keys()).map((id) => abortUpload(id)));
      await flushIndexNow();
    } catch { /* 退出路径不因清理失败而卡住 */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
