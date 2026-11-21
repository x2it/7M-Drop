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
 *   SHARE_TOKEN=guest node server.js        # 固定分享口令（访客权限隔离）
 *   SHARE_TOKEN=same node server.js         # 退回单口令模式
 *
 * 环境变量:
 *   PORT              监听端口              默认 8080
 *   HOST              监听地址              默认 ::（IPv4+IPv6 双栈，别改成 0.0.0.0）
 *   TOKEN             管理口令（全部管理权） 默认随机生成
 *   SHARE_TOKEN       分享口令（访客权限隔离） 默认随机生成；same = 与管理口令相同
 *   GUEST_UPLOAD      访客能否上传          默认 1；设 0 则只能下载
 *   GUEST_LIST        访客能否看列表/下载   默认 1；设 0 则只能上传（盲投）
 *   TTL_HOURS         文件保留小时数        默认 24（0 = 永久保留）
 *   MAX_MB            单文件大小上限（MB）    默认 2048
 *   MAX_TOTAL_MB      总容量上限（MB）        默认 5120；0 = 不限
 *   RATE_INIT_PER_MIN 每 IP 每分钟上传次数  默认 60；0 = 不限流
 *   OWNER_TTL_HOURS   设备凭证有效期(小时)   默认 8760（1 年）
 *   TRUSTED_IPS       可信 IP 自动提权       默认空=关闭；逗号分隔，支持 "192.168.1." 前缀
 *   TRUST_PROXY       信任 X-Forwarded-For   默认 0；仅当反代会覆写 XFF 时才开
 *   DATA_DIR          数据目录              默认 ./data
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
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
// 前端外壳版本号：由外壳内容（HOME_CSS + HOME_JS + QQ_JS）哈希得出。
// 内容变 → 版本变：SW 缓存名换代、页面 ?v= 缓存破坏同步失效，用户不会拿着旧 JS；
// 同一构建重启版本不变，不产生无谓的缓存重放。env SHELL_VERSION 可强制覆盖（调试用）。
// 惰性求值：HOME_CSS / HOME_JS / QQ_JS 定义在文件后部，请求期调用时已就绪。
let SHELL_VERSION = process.env.SHELL_VERSION || '';
let HOME_PAGE_CACHED = '';
function shellVersion() {
  if (!SHELL_VERSION) {
    SHELL_VERSION = crypto.createHash('sha1')
      .update(HOME_CSS).update(HOME_JS).update(QQ_JS).update(APP_JS)
      .digest('hex').slice(0, 10);
  }
  return SHELL_VERSION;
}
/* 根页下发前把 __SHELL_V__ 占位符换成真实版本号（模板串不能提前插值：引用后置常量） */
function homePageHtml(sc) {
  if (!HOME_PAGE_CACHED) HOME_PAGE_CACHED = HOME_PAGE.replace(/__SHELL_V__/g, shellVersion());
  return injectShareCode(HOME_PAGE_CACHED, sc);
}
/* CSS 同样要注入版本号：页面侧「版本自愈」靠 --shell-ver 判断
   实际生效的 CSS 是不是当前版本（旧 SW 缓存住旧 CSS 时会不一致）。 */
let HOME_CSS_CACHED = '';
function homeCssHtml() {
  if (!HOME_CSS_CACHED) HOME_CSS_CACHED = HOME_CSS.replace(/__SHELL_V__/g, shellVersion());
  return HOME_CSS_CACHED;
}
// 默认 '::' 双栈：同时接受 IPv4 与 IPv6。绑 0.0.0.0 会让 localhost(::1) 连接被拒，
// 这会让部分隧道客户端（如 Serveo over SSH）报 502。
const HOST = process.env.HOST || '::';
const MAX_BYTES = Math.max(1, Number(process.env.MAX_MB || 2048)) * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const TTL_HOURS = Math.max(0, Number(process.env.TTL_HOURS ?? 24));

/* ── 可选保留时长 / 访问密码 / 续期宽限期 ────────────────────────────
   默认行为完全不变：不传 h 时仍按 TTL_HOURS（默认 24h），不传 pw 时无密码。
   服务端对所有客户端传入值白名单校验，杜绝「设成永久 / 超大值撑爆磁盘」。 */
// 允许的有效期档位（小时）。0 = 永久保留。前端下拉与 Agent 都只能用这些值。
const EXP_CHOICES = [1, 6, 24, 72, 168, 720, 0];
const EXP_LABELS = { 0: '永久保留', 1: '1 小时', 6: '6 小时', 24: '1 天', 72: '3 天', 168: '7 天', 720: '30 天' };
// 允许「永久」与否：默认允许（项目 TTL_HOURS=0 本就是合法状态），可由 env 关掉。
const ALLOW_FOREVER = String(process.env.ALLOW_FOREVER ?? '1') !== '0';
// 「默认档位」与「可选档位」的关系以前只在代码里，API 只吐 ttlHours=24，
// 让人误以为只有 24 小时。这里统一生成一份自描述，meta / list / 前端文案
// 全部由它驱动 —— 能力改了文案必然跟着改，杜绝两边各说各话。
function expPayload() {
  const list = EXP_CHOICES.filter((h) => h !== 0 || ALLOW_FOREVER);
  const labels = {};
  for (const h of list) labels[h] = EXP_LABELS[h] || (h + ' 小时');
  return {
    ttlHours: TTL_HOURS,                 // 兼容旧客户端：数值仍是默认档位
    ttlHoursMeaning: 'default',         // 明确：这是「未指定 h 时的默认」，不是唯一值
    expChoices: list,                   // 全部合法档位（单位小时，0=永久）
    expChoicesLabel: labels,            // 人类可读标签，供 UI / Agent 直接展示
    expChoiceNote: 'h 取值必须是 expChoices 之一（0=永久）；未传、非法或超大值一律回落默认 ' +
      TTL_HOURS + 'h；ALLOW_FOREVER=0 时不提供永久档。上传用 X-7md-H 或 ?h=，' +
      'init/text 用 body.h，续期用 POST /api/renew 的 body.h。',
    graceHours: RENEW_GRACE_MS / 3600000,
  };
}
// 过期文件保留/清理窗口：到期后用户端已隐藏、不可续期，文件也不会立即消失，
// 而是留这段时间供管理端在控制台里手动删除（真正的删除）。窗口结束仍未删的，
// 由后台 sweep 兜底清理，避免磁盘被占满。默认 24h，env RENEW_GRACE_HOURS 可调
// （0 = 过期即清，退回到「不留窗口」的行为）。
const RENEW_GRACE_MS = Math.max(0, Number(process.env.RENEW_GRACE_HOURS ?? 24)) * 3600 * 1000;
// 解锁凭证有效期（签名 Cookie），默认 12h。
const UNLOCK_TTL_MS = Math.max(60000, Number(process.env.UNLOCK_TTL_HOURS ?? 12) * 3600 * 1000);
const UNLOCK_COOKIE = '7mdok';

/* 服务端密钥：用于把访问密码做成不可逆 HMAC 摘要、以及给解锁 Cookie 签名。
   必须持久化 —— 进程重启后既要能校验已存文件的密码，也要让已签发的
   解锁 Cookie 继续有效。首次启动随机生成，落在 data/ 下（已被 gitignore）。 */
const SECRET_FILE = path.join(DATA_DIR, '.secret');
let SECRET;
// 全新部署时 data/ 还不存在（main() 里的 mkdir 在后面才跑），此处若直接写
// .secret 会失败并退化成进程内随机密钥 —— 重启后已设密码、已签发的解锁
// Cookie、设备归属 HMAC 全部失效，且要等到第二次启动才落盘。先建目录。
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 只读数据目录时退化为进程内密钥 */ }
try {
  SECRET = fs.readFileSync(SECRET_FILE);
  if (SECRET.length < 32) throw new Error('too short');
} catch {
  SECRET = crypto.randomBytes(32);
  try { fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); } catch { /* 只读数据目录时退化为进程内密钥 */ }
}

const CHUNK_SIZE = 8 * 1024 * 1024; // 客户端分片大小，低于 Cloudflare 免费版 100MB 请求上限
// sweep 可调参数：默认值就是线上行为，测试可用更短的值实测
// 「活跃中的长上传不被误杀」与「孤儿文件被回收」。
//   idle    上传会话多久无活动视为死会话（期间每收到一个分片都会刷新）
//   interval sweep 运行周期
//   orphan  files/ 里不在索引的文件的 mtime 保护期，超过才回收
const SWEEP_IDLE_MS = Math.max(1000, Number(process.env.SWEEP_IDLE_MS ?? 2 * 3600 * 1000));
const SWEEP_INTERVAL_MS = Math.max(1000, Number(process.env.SWEEP_INTERVAL_MS ?? 60 * 1000));
const SWEEP_ORPHAN_MS = Math.max(1000, Number(process.env.SWEEP_ORPHAN_MS ?? 6 * 3600 * 1000));

// ── 权限：两级角色 + 设备归属 ────────────────────────────────
// 管理口令：全部管理权（改时长/续期/删除任意文件）。
// 分享口令：可看列表、下载、上传；改时长/续期/删除「仅限自己上传的」。
//   归属由服务端签名的设备凭证（7mdid Cookie，不可伪造）自动识别，无需登录；
//   管理链接一律放行。历史无归属文件仅管理员可管。全部由服务端强制，不是前端藏按钮。
//   可选：TRUSTED_IPS 命中的来源 IP 自动提权为管理员（默认关，见 clientIp 的 XFF 说明）；
//   OWNER_TTL_HOURS 调设备凭证有效期，默认 8760h（1 年）。
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

// 平台网关的分享凭据（如 WorkBuddy「发布为应用」的 ?sharecode=...）。
// 网关凭据与站内分享口令是两回事：缺网关凭据时网关直接拦截，
// 返回 403「链接不完整」页，请求根本到不了本服务。
const GATEWAY_SHARECODE = String(process.env.GATEWAY_SHARECODE || '').trim();

// 桌面「登录 Windows 98」的 Administrator 通行口令。
// 与 TOKEN 是两个独立的东西：TOKEN 是 /s/<口令>/ 的路径凭据，
// ADMIN_PASS 只是仿真桌面登录框的口令。校验一律走服务端，前端源码里不出现明文。
// 生产环境务必通过环境变量 ADMIN_PASS 覆盖默认值；未设置时沿用内置默认，
// 并在启动时打印告警，避免"裸口令裸奔"。
const ADMIN_PASS = String(process.env.ADMIN_PASS || '@8688991230');
const ADMIN_PASS_IS_DEFAULT = !process.env.ADMIN_PASS;

const mbText = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

// ───────────────────────────── 状态 ─────────────────────────────

/** @type {Array<{id:string,name:string,size:number,type:string,time:number,expires:number,expH:number,lock:string,renewals:number,downloads:number,kind:'file'|'text'}>} */
let index = [];
/** @type {Map<string,{name:string,size:number,type:string,tmp:string,received:number,nextIndex:number,createdAt:number,lastAt:number,expH:number,lock:string}>} */
const uploads = new Map();
/* 已完成、但 finish 的响应可能在回程丢失的会话。/api/status 靠它回答"已经传完了，
   别重开"，避免客户端重试时把整个文件重传一遍、生成重复记录。sweep 定时清理。 */
const recentDone = new Map(); // id -> { item, at }
const RECENT_DONE_MS = 10 * 60 * 1000;

const now = () => Math.floor(Date.now() / 1000);
const newId = () => crypto.randomBytes(9).toString('base64url');
const blobPath = (id) => path.join(FILES_DIR, id);

function expiryFor(hours) {
  // 不传 → 旧行为（全局 TTL_HOURS）；传了 → 用已白名单归一化的档位。
  const h = hours === undefined ? TTL_HOURS : normExpHours(hours);
  return h > 0 ? now() + Math.round(h * 3600) : 0;
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

/* ───────────── 可选有效期 / 访问密码 / 解锁凭证 ─────────────
   密码只做「不可逆摘要」：明文既不落盘、也不进索引和任何响应。
   整批共享：一次上传的所有文件写入同一个 lock 摘要；解锁一次，
   签名 Cookie 里带上这个摘要，同批文件全部放行。 */

function normExpHours(v) {
  // 客户端只能选预设档位（含 0=永久）；未传/非法一律回落到全局默认，
  // 防止「随手一个超大值 / 悄悄设永久」绕过 TTL 把磁盘占满。
  if (v === undefined || v === null || v === '') return TTL_HOURS;
  const h = Number(v);
  if (!EXP_CHOICES.includes(h)) return TTL_HOURS;
  if (h === 0 && !ALLOW_FOREVER) return TTL_HOURS;
  return h;
}

function pwHash(pw) {
  const s = typeof pw === 'string' ? pw : '';
  if (!s) return '';
  // 加盐 HMAC 摘要，取前 32 hex。不可逆，且不同站点 SECRET 不同。
  return crypto.createHmac('sha256', SECRET).update('pw:' + s).digest('hex').slice(0, 32);
}

// 从请求里取「时长 / 密码」。JSON 接口走 body；raw 上传(/api/put)走 header + query。
// 密码刻意不接受 query：URL 会进浏览器历史、代理日志与 Referer，等于把提取码写出去。
function optFromReq(req, url, body) {
  const b = body || {};
  const hRaw = b.h !== undefined ? b.h
    : (req.headers['x-7md-h'] !== undefined ? req.headers['x-7md-h']
      : (url ? url.searchParams.get('h') : null));
  const pw = b.pw !== undefined ? b.pw : (req.headers['x-7md-pw'] || '');
  return { expH: normExpHours(hRaw), lock: pwHash(pw) };
}

// 索引记录的扩展字段：一次算好，三处构造保持一致。
function recOpts(opt, expHOverride) {
  const expH = expHOverride === undefined ? opt.expH : normExpHours(expHOverride);
  return {
    expH: expH,
    lock: opt.lock || '',
    renewals: 0,
    expires: expiryFor(expH),
  };
}

function b64u(s) { return Buffer.from(s, 'utf8').toString('base64url'); }

// 解锁凭证 = base64url(payload) + '.' + HMAC 签名。payload 含已解锁的 lock
// 摘要列表与到期时间；签名防伪造/篡改，浏览器只当它是张门票。
function signUnlock(locks) {
  const payload = b64u(JSON.stringify({ l: locks, e: Date.now() + UNLOCK_TTL_MS }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function readUnlock(req) {
  const m = /(?:^|;\s*)7mdok=([^;]+)/.exec(String(req.headers.cookie || ''));
  if (!m) return [];
  const parts = m[1].split('.');
  if (parts.length !== 2) return [];
  const expect = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expect)) return [];
  try {
    const o = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!o || !Array.isArray(o.l) || !(o.e > Date.now())) return [];
    return o.l.filter((x) => typeof x === 'string');
  } catch { return []; }
}
// 每请求缓存解析结果；一张请求里可能校验多个文件（如整批预览）。
function unlockedSet(req) {
  if (!req.__unlockSet) req.__unlockSet = new Set(readUnlock(req));
  return req.__unlockSet;
}
function isUnlocked(req, rec) {
  if (!rec.lock) return true;                 // 无密码文件永远放行
  if (req.__isAdmin) return true;             // 管理链接是主人自己，免提取码
  return unlockedSet(req).has(rec.lock);
}

// ── 设备归属：服务端签发的「稳定机器码」 ───────────────────────
// 浏览器拿不到真机器码；IP 又会因 NAT 共享、宽带重拨、移动网络切换、XFF
// 伪造而串号或漂移（clientIp 的注释里记着一次伪造绕过限流的事故）。
// 所以改用 HMAC 签名 Cookie：首次访问自动下发，之后每个请求自动携带，
// 客户端伪造不了（签名密钥只在服务端），换 WiFi/换网络也不丢身份。
// 这等价于「自动识别安全环境 → 自动获得对应权限」，无需登录、无需输入。
const OWNER_COOKIE = '7mdid';
const OWNER_HEADER = 'x-7md-owner';   // 显式通道：curl / Agent 可带上传返回的 ownerToken
const OWNER_TTL_MS = Math.max(3600000, Number(process.env.OWNER_TTL_HOURS ?? 8760) * 3600000);
// 可选「可信环境自动提权」：命中的来源 IP 视为管理员，默认关闭。
// 判断走 clientIp()（已含 XFF 防伪造），代理后需 TRUST_PROXY=1 且确认反代覆写 XFF。
const TRUSTED_IPS = String(process.env.TRUSTED_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function signOwner(id) {
  const payload = b64u(JSON.stringify({ d: id, e: Date.now() + OWNER_TTL_MS }));
  const sig = crypto.createHmac('sha256', SECRET).update('owner:' + payload).digest('base64url');
  return payload + '.' + sig;
}
function ownerFromToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 2) return '';
  const expect = crypto.createHmac('sha256', SECRET).update('owner:' + parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expect)) return '';
  try {
    const o = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!o || typeof o.d !== 'string' || !/^[0-9a-f]{32}$/.test(o.d) || !(o.e > Date.now())) return '';
    return o.d;
  } catch { return ''; }
}
function readOwner(req) {
  if (req.__ownerId !== undefined) return req.__ownerId;
  const m = /(?:^|;\s*)7mdid=([^;]+)/.exec(String(req.headers.cookie || ''));
  const tok = m ? m[1] : String(req.headers[OWNER_HEADER] || '');
  req.__ownerId = ownerFromToken(tok);
  return req.__ownerId;
}
// 索引里只存摘要：即便 index.json 泄漏也推不回凭证，更伪造不了 Cookie。
function ownerTag(req) {
  const id = readOwner(req);
  return id ? crypto.createHmac('sha256', SECRET).update('tag:' + id).digest('hex').slice(0, 32) : '';
}
function isMine(req, rec) {
  const t = ownerTag(req);
  return !!t && !!rec.owner && safeEqual(t, rec.owner);
}
// 能不能管理这条记录：管理链接（或可信环境）一律放行；否则必须本人。
// 历史文件没有 owner 字段 → 只归管理员，绝不误放开给陌生人。
function canManage(req, rec) {
  return !!req.__isAdmin || isMine(req, rec);
}
function trustedEnv(req) {
  if (!TRUSTED_IPS.length) return false;
  // 默认只认真实 socket 地址：本机 loopback 下 clientIp 会信任 XFF，
  // 若用它判可信 IP，伪造一个 X-Forwarded-For 就能给自己提权。
  // 只有显式 TRUST_PROXY=1（确认反代会覆写 XFF）时才改用 clientIp。
  const sock = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').trim();
  const ip = TRUST_PROXY ? String(clientIp(req)).replace(/^::ffff:/, '').trim() : sock;
  return TRUSTED_IPS.some((r) => r === ip || (r.endsWith('.') && ip.startsWith(r)));
}

/* 把设备凭证挂到本次响应的所有出口：sendJson / sendAsset / sendBinary /
   serveBlob(206) / notFound / 500 都会经过 writeHead，包一层即可全覆盖，
   且能与 handleUnlock 自己下发的 7mdok 合并成数组，互不覆盖。 */
function wrapOwnerCookie(res, header) {
  const orig = res.writeHead;
  res.writeHead = function () {
    const args = Array.prototype.slice.call(arguments);
    const hi = args.length - 1;
    if (hi >= 1 && args[hi] && typeof args[hi] === 'object' && !Array.isArray(args[hi])) {
      const h = Object.assign({}, args[hi]);
      const prev = h['Set-Cookie'];
      h['Set-Cookie'] = prev ? (Array.isArray(prev) ? prev.concat(header) : [prev, header]) : header;
      args[hi] = h;
    } else {
      args.push({ 'Set-Cookie': header });
    }
    return orig.apply(this, args);
  };
}
function ensureOwner(req, res, issue) {
  let id = readOwner(req);
  const fresh = !id;        // 只有「首次 / 凭证失效」才需要把明文凭证交给调用方
  if (fresh) { id = crypto.randomBytes(16).toString('hex'); req.__ownerId = id; }
  const tok = signOwner(id);
  req.__ownerFresh = fresh;
  // 仅无状态客户端（本次才拿到凭证、没法靠 Cookie 自动回传）才回传明文凭证；
  // 浏览器已有 HttpOnly Cookie，JSON 里不给，避免凭证进入 JS 可读空间。
  req.__ownerToken = fresh ? tok : '';
  // 静态资源不新签发：页面导航请求一定先于子资源到达，cookie 那时已写入。
  // 这样首屏并发请求不会各自生成不同设备 ID，归属从第一刻起就稳定。
  if (issue !== false) {
    wrapOwnerCookie(res, OWNER_COOKIE + '=' + tok +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(OWNER_TTL_MS / 1000));
  }
  return id;
}
function isExpired(rec) {
  return rec.expires > 0 && rec.expires <= now();
}
const EXPIRE_SOON_SEC = 2 * 3600;            // 列表「即将过期」高亮阈值（续期入口只在这个窗口内出现）
function isExpiringSoon(rec) {
  return rec.expires > 0 && !isExpired(rec) && (rec.expires - now()) <= EXPIRE_SOON_SEC;
}

// 提取码校验单独限流：这是唯一一处「靠猜的口令」，必须防暴力。
const UNLOCK_PER_MIN = 8;
const unlockHits = new Map();
function unlockRateLimited(ip) {
  const t = Date.now();
  const arr = (unlockHits.get(ip) || []).filter((x) => t - x < 60000);
  arr.push(t);
  unlockHits.set(ip, arr);
  if (unlockHits.size > 5000) unlockHits.clear();
  return arr.length > UNLOCK_PER_MIN;
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
    canDelete: admin,             // 能删「任意」文件（管理员）；自己上传的另按归属判定
    canManageOwn: true,           // 任何持有设备凭证者都能管理自己上传的文件
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

// 通用滑动窗口限流：上传与聊天共用同一份实现，只换计数器与阈值。
// 任何新的写接口都该调它，而不是再抄一遍 filter/push/set。
function slidingHit(map, ip, limit) {
  if (!limit) return false;
  const t = Date.now();
  const arr = (map.get(ip) || []).filter((x) => t - x < 60000);
  arr.push(t);
  map.set(ip, arr);
  return arr.length > limit;
}
const initHits = new Map();          // /api/init：防止脚本刷爆磁盘
const chatHits = new Map();          // /api/qq/*：防止刷屏
function rateLimited(ip) { return slidingHit(initHits, ip, RATE_INIT_PER_MIN); }
function chatRateLimited(ip) { return slidingHit(chatHits, ip, RATE_CHAT_PER_MIN); }

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
  // U+FFFD（替换字符）：上游把文件名按错误编码传过来时产生，是信息已丢失的
  // 占位符。原样入库会在列表里显示成一串菱形问号；折叠成 '_'，并把
  // nameRepaired 标记随上传响应回传，让调用方知道文件名被修过。
  let s = String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\uFFFD+/g, '_');
  s = s.replace(/[\\/]+/g, '_').replace(/^[.\s]+/, '').trim();
  if (!s) s = 'unnamed';
  if (s.length > 160) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, Math.max(1, 160 - ext.length)) + ext;
  }
  return s;
}

// 客户端（curl -T、多数 SDK 流式上传）不送 Content-Type 时按扩展名兜底。
// /v/ 端点带 nosniff，浏览器不会自行嗅探；type 落成 application/octet-stream
// 会导致「UI 认为是视频、浏览器认为是二进制」，内联播放直接失败。
// 兜底只在 type 缺省或恰好是 octet-stream 时生效，显式 Content-Type 永远优先。
const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  zip: 'application/zip', gz: 'application/gzip',
};
function guessMime(name, fallback) {
  const t = String(fallback || '').slice(0, 120);
  if (t && t !== 'application/octet-stream') return t;
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || t || 'application/octet-stream';
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

// ── 平台分享凭证透传 ────────────────────────────────────────
// 托管平台用 ?sharecode= 给入口链接授权，再种一个 SameSite=None 的 Cookie
// 让后续请求放行。但 App 预览面板 / webview / 隐私模式常把这个第三方 Cookie
// 拦掉：入口 HTML 能开，页面里的 CSS、JS、API 全部 403 —— 看起来就像
// 「能打开但不能正常访问」。所以把凭证显式透传到每一个请求，不依赖 Cookie。
function shareCode(req) {
  try {
    const v = new URL(req.url, 'http://localhost').searchParams.get('sharecode') || '';
    if (/^[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
    // 平台网关会把入口 URL 的 ?sharecode= 剥掉再转发，但用 x-wb-share-code 头透传凭证
    // （实测：转发请求头带 x-wb-share-code，而 req.url 里已无该参数）。
    // 不读这个头，服务端就永远注入不了凭证，页面里的 CSS/JS 只能靠网关 Cookie 放行。
    const h = String((req.headers && (req.headers['x-wb-share-code'] ||
      req.headers['x-forwarded-share-code'])) || '');
    return /^[A-Za-z0-9_-]{1,64}$/.test(h) ? h : '';
  } catch (e) { return ''; }
}
function withShareCode(u, sc) {
  if (!sc) return u;
  if (/[?&]sharecode=/.test(u)) return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + sc;
}
// 把 HTML 里的相对/根相对资源引用统一挂上凭证（只改 href/src，不动其它属性）
function tagShareCode(html, sc) {
  if (!sc) return html;
  return html.replace(/<[^>]+>/g, function (tag) {
    // <base> 决定相对路径的解析基准，带 query 会把它带偏，绝不能改
    if (/^<base\b/i.test(tag)) return tag;
    return tag.replace(/\b(href|src)="([^"]+)"/g, function (all, attr, u) {
      if (/^(https?:|data:|blob:|#|mailto:|javascript:)/i.test(u)) return all;
      return attr + '="' + withShareCode(u, sc) + '"';
    });
  });
}
// 在 <head> 注入凭证 meta：前端 JS 从这里读取，比 location.search 稳
// （页面内跳转、replaceState、iframe 导航都可能把 query 弄丢）。
function injectShareCode(html, sc) {
  if (!sc) return html;
  return tagShareCode(
    html.replace('<head>', '<head>\n<meta name="7md-sc" content="' + sc + '">'), sc
  );
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_BASE });
  res.end('404 Not Found');
}

function sendJson(res, code, obj, extra) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...SEC_BASE,
    ...(extra || {}),
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

  const nameRepaired = /[\uFFFD]/.test(String(body.name || ''));   // 上游编码损坏：文件名已被清洗
  const name = sanitizeName(body.name);
  const size = Number(body.size);
  const type = guessMime(body.name, body.type);

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

  // 上传选项随会话存下，finish 生成索引记录时沿用：整批文件共享同一时长/密码。
  // 密码明文只在内存里走一趟，立即变成不可逆摘要，绝不落盘。
  const opt = optFromReq(req, null, body);
  uploads.set(id, {
    name, size, type, tmp,
    received: 0, nextIndex: 0, createdAt: Date.now(), lastAt: Date.now(),
    expH: opt.expH, lock: opt.lock,
    // 归属锁定在发起上传那一刻：谁 init 谁拥有。finish 沿用，并把 init
    // 发给脚本的凭证原样回传，保证「文件 owner」与「手里凭证」严格一致。
    // 浏览器走 Cookie（ownerTok 为空也无所谓），脚本走 X-7md-Owner。
    owner: ownerTag(req), ownerTok: req.__ownerToken,
    nameRepaired,                  // init 时原文件名已损坏 → finish 时回传
  });
  // 会话一建立就占账本：从此刻起它写的每个字节都不会被别的请求重复分配，
  // 直到 finish 入索引（那时 totalBytes 自然接管）或 abort 释放。
  inflightBytes.set('chunk:' + id, 0);

  sendJson(res, 200, {
    uploadId: id, chunkSize: CHUNK_SIZE, maxBytes: MAX_BYTES,
    nameRepaired,                   // true = 原文件名含无法解码的字符，已替换
    ownerToken: req.__ownerToken,   // 分片脚本首次请求即可拿到凭证
  });
}

// ───────────────────────── Agent 接口 ─────────────────────────

/** 依据请求头推断本站对外基址（兼容隧道/反向代理） */
function baseUrlFor(req, token) {
  // 部署者显式声明的对外域名（PUBLIC_ORIGIN=https://example.host），永远优先。
  // 网关/反代改写 Host 时（如平台沙箱），请求头推断必然拿到内部域名，
  // 外部脚本按 meta.baseUrl 拼链接就会得到不可达地址——这正是 A2 缺陷的根因。
  const pub = String(process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (pub) return pub + '/s/' + token + '/';
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
  // 网关凭据：若部署环境经平台网关对外发布，所有对外 URL 都要追加 ?sharecode=...
  // （quickstart 命令在这里直接拼好，调用方复制即可用；页面链接同理。）
  const gq = GATEWAY_SHARECODE
    ? 'sharecode=' + encodeURIComponent(GATEWAY_SHARECODE) : '';
  const joinQ = (url) => (gq
    ? url + (url.indexOf('?') >= 0 ? '&' : '?') + gq : url);
  return {
    service: '7喵快传',
    apiVersion: 1,
    role: P.role,
    baseUrl: base,
    shareUrl: (P.role === 'admin' && splitTokens)
      ? base.replace(/\/s\/[^/]+\/$/, '/s/' + SHARE_TOKEN + '/')
      : null,
    access: GATEWAY_SHARECODE ? {
      gatewaySharecode: GATEWAY_SHARECODE,
      querySuffix: '?' + gq,
      rule: '本站经平台网关对外发布。网关有独立于站内口令的分享凭据：经对外域名访问任何页面或 API（含本 meta 给出的全部 URL）都必须在末尾追加 querySuffix，缺失时网关直接返回 403「链接不完整」页，请求不会到达本服务。',
      entryUrl: base + '?' + gq,
      note: 'baseUrl 与各接口路径不含该参数，请在每条 URL 末尾自行追加（已带 ? 的用 & 连接）。沙箱内部直连域名（如 *.e2b.*.club）是绕过网关的临时通道，随实例回收即失效，脚本不要使用或缓存。',
    } : null,
    permissions: {
      canList: P.canList, canUpload: P.canUpload,
      canDelete: P.canDelete,          // 能删「任意」文件（仅管理员）
      canManageOwn: true,              // 能改时长/续期/删除自己上传的
    },
    // 归属模型：服务端签名的设备凭证自动识别，不需要注册/登录。
    ownership: {
      mode: 'signed-device-cookie',
      cookie: OWNER_COOKIE,
      header: OWNER_HEADER.toUpperCase(),
      ttlHours: Math.round(OWNER_TTL_MS / 3600000),
      trustedIpElevates: TRUSTED_IPS.length > 0,
      rule: '改时长/续期/删除仅限上传者本人或管理员；历史无归属文件仅管理员可管',
      note: '浏览器自动携带 Cookie；无状态脚本可用上传响应里的 ownerToken 经 X-7md-Owner 显式携带',
    },
    limits: {
      maxMb: Math.round(MAX_BYTES / 1048576),
      maxTotalMb: MAX_TOTAL_BYTES ? Math.round(MAX_TOTAL_BYTES / 1048576) : 0,
      usedBytes: totalBytes(),
      ...expPayload(),                 // ttlHours(默认) / expChoices(可选) / 标签 / 说明
      chunkSize: CHUNK_SIZE,
      rateInitPerMin: RATE_INIT_PER_MIN,
    },
    // Agent 最需要的两件事：一条命令传完，和拿到手就能用的链接
    // 注意：joinQ 只对 URL 生效，且必须在引号内拼接，否则凭据会落到命令引号外
    quickstart: {
      uploadOneShot: 'curl -c jar -T <file> "' + joinQ(base + 'api/put?name=<urlencoded-name>') + '"',
      uploadStdin: 'curl -c jar --data-binary @- -H "X-File-Name: <base64url(name)>" "' + joinQ(base + 'api/put') + '"',
      uploadWithOptions: 'curl -c jar -T <file> -H "X-7md-H: 168" -H "X-7md-Pw: <提取码>" "' + joinQ(base + 'api/put?name=<name>') + '"',
      unlock: 'curl -b jar -c jar -X POST -d \'{"pw":"<提取码>"}\' "' + joinQ(base + 'api/unlock') + '"',
      renew: 'curl -b jar -X POST -d \'{"id":"<id>","h":168}\' "' + joinQ(base + 'api/renew') + '"',
      deleteOwn: 'curl -b jar -X POST -d \'{"id":"<id>"}\' "' + joinQ(base + 'api/delete') + '"',
      cancelUpload: 'curl -b jar -X POST -d \'{"uploadId":"<uploadId>"}\' "' + joinQ(base + 'api/cancel') + '"',
      listFiles: 'curl -b jar "' + joinQ(base + 'api/list') + '"',
      // 无状态脚本（不保存 Cookie）：上传响应带 ownerToken，后续请求显式携带即可
      ownWithHeader: 'curl -H "X-7md-Owner: <ownerToken>" -X POST -d \'{"id":"<id>","h":168}\' "' + joinQ(base + 'api/renew') + '"',
    },
    endpoints: {
      meta: { method: 'GET', path: 'api/meta' },
      list: { method: 'GET', path: 'api/list' },
      put: { method: 'POST', path: 'api/put?name=<urlencoded>', body: 'raw bytes', note: '单请求上传；可选 header X-7md-H 或 ?h= 指定保留小时数（合法值见 limits.expChoices：1/6/24/72/168/720，0=永久；未传=默认 24h，非法值回落默认）/ X-7md-Pw 访问密码' },
      init: { method: 'POST', path: 'api/init', body: '{name,size,type,h?,pw?}', note: 'h 同上，取值见 limits.expChoices' },
      status: { method: 'GET', path: 'api/status?u=<uploadId>', note: '查询分片进度，网络中断后据此续传' },
      chunk: { method: 'POST', path: 'api/chunk?u=<uploadId>&i=<n>', body: 'raw bytes' },
      cancel: { method: 'POST', path: 'api/cancel', body: '{uploadId}', note: '取消未完成的分片会话，立即释放临时文件与配额占用' },
      finish: { method: 'POST', path: 'api/finish', body: '{uploadId}' },
      text: { method: 'POST', path: 'api/text', body: '{text,h?,pw?}', note: 'h 同上，取值见 limits.expChoices' },
      unlock: { method: 'POST', path: 'api/unlock', body: '{pw}', note: '校验提取码，成功后签发签名 Cookie，整批共用' },
      renew: { method: 'POST', path: 'api/renew', body: '{id,h?}', note: '续期/改时长；h 取值见 limits.expChoices（0=永久），缺 h 沿用原档位；仅限上传者本人或管理员' },
      delete: { method: 'POST', path: 'api/delete', body: '{id}', note: '仅限上传者本人或管理员；不再是 adminOnly' },
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
  const nameRepaired = /[\uFFFD]/.test(name);   // 上游编码损坏：文件名已被清洗
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
    type: guessMime(name, req.headers['content-type']),
    time: now(),
    downloads: 0,
    kind: 'file',
    owner: ownerTag(req),          // 归属：谁传的，谁才能改时长/续期/删除
    ...recOpts(optFromReq(req, url, null)),
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
    nameRepaired,                   // true = 原文件名含无法解码的字符，已替换
    ownerToken: req.__ownerToken,   // 无 Cookie 的脚本可显式携带，管理自己上传的文件
    urls: {
      page: base + 'f/' + id,      // 分享给别人
      direct: base + 'd/' + id,    // 直接下载
      inline: base + 'v/' + id,    // 内联预览
    },
  });
}

// ───────────────────────── 上传：进度查询（断点续传） ─────────────────────────

/**
 * 网络中断后，客户端先问"你到底收到第几片了"，再决定从哪片接着传。
 * 之所以必须查：XHR 失败时无法区分「请求没到服务端」和「服务端写完了、
 * 响应在回来路上丢了」——后者若盲目重发同一片会被 409 拒绝。
 * 三种结果：
 *   uploading → 返回 received / next，客户端从 next 续传
 *   done      → finish 曾成功但响应丢了，直接告诉客户端别重传
 *   404       → 会话已过期/进程重启过，客户端重新 init 从头传
 */
function handleStatus(req, res, url) {
  const id = url.searchParams.get('u') || '';
  const up = uploads.get(id);
  if (up) {
    return sendJson(res, 200, {
      state: 'uploading', uploadId: id,
      name: up.name, size: up.size, type: up.type,
      chunkSize: CHUNK_SIZE, received: up.received, next: up.nextIndex,
    });
  }
  const done = recentDone.get(id);
  if (done) {
    return sendJson(res, 200, { state: 'done', uploadId: id, item: done.item });
  }
  return sendJson(res, 404, { error: '上传会话不存在或已过期' });
}

/**
 * 主动取消上传：丢弃尚未完成的分片会话，立刻释放 .part 临时文件与配额账本。
 * 只作用于「未完成」的会话；已经 finish 入索引的文件不受影响（在列表里删除）。
 * 没有这一步，被放弃的会话会一直虚占配额、留着半成品，直到 2 小时后的 sweep。
 */
async function handleCancel(req, res) {
  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const id = String(body.uploadId || '');
  if (!id) return sendJson(res, 400, { error: '缺少 uploadId' });
  await abortUpload(id);
  return sendJson(res, 200, { ok: true, cancelled: id });
}

// ───────────────────────── 上传：分片 ─────────────────────────

async function handleChunk(req, res, url) {
  const id = url.searchParams.get('u') || '';
  const idx = Number(url.searchParams.get('i'));
  const up = uploads.get(id);

  /* 提前拒绝时要「等请求体读完」再回 4xx。断线重传时客户端很可能正推着
     一整个 8MB 分片，服务端若在 body 收完前 res.end()，Node 会关闭 socket，
     客户端侧只看到 BrokenPipe（拿不到明确错误码），白白多一轮重试。
     仅 req.resume() 不够——那只是开始丢弃，不能阻止 res.end() 时的关连接。 */
  async function early(status, obj) {
    if (!req.complete) {
      await new Promise(function (resolve) {
        var done = false, timer = null;
        function fin() { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(); }
        req.on('end', fin); req.on('error', fin); req.on('aborted', fin);
        req.resume();
        timer = setTimeout(fin, 3000);   // 客户端不发完也不能把请求挂死
      });
    }
    return sendJson(res, status, obj);
  }

  if (!up) return early(404, { error: '上传会话不存在或已过期' });
  if (!Number.isInteger(idx) || idx !== up.nextIndex) {
    return early(409, { error: '分片顺序错误', expect: up.nextIndex });
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared && up.received + declared > MAX_BYTES) {
    await abortUpload(id);
    return early(413, { error: '文件超过上限' });
  }

  const ckey = 'chunk:' + id;
  inflightBytes.set(ckey, up.received);
  // 总配额在 init 时只按「客户端声明的大小」检查，可以少报绕过：
  // 声明 1 字节再实灌几 MB，数据会落进 tmp 却不算配额。
  // 这里用共享在途账本（含并发 put 字节）再兜一道，把 tmp 占用压在配额内。
  if (MAX_TOTAL_BYTES && up.received + declared > quotaRoomFor(ckey)) {
    await abortUpload(id);
    return early(507, { error: '服务器存储已满' });
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
    downloads: 0,
    kind: 'file',
    owner: up.owner || ownerTag(req),  // 沿用 init 锁定的归属；旧会话兜底
    ...recOpts({ expH: up.expH, lock: up.lock }),
  };
  // 若 init 是无 Cookie 脚本发起的，把它的凭证在 finish 再回一次，保证脚本
  // 最终手里拿到的 token 与文件 owner 是同一个身份。
  if (up.ownerTok) req.__ownerToken = up.ownerTok;
  index.unshift(rec);
  uploads.delete(id);
  recentDone.set(id, { item: rec, at: Date.now() });
  await saveIndex();
  // 到这里字节才真正被 totalBytes 看见，此刻释放账本才算安全
  inflightBytes.delete(fkey);

  // 与 /api/put 保持一致的返回形状 —— 客户端不该因为走了分片就拿不到链接
  const base = baseUrlFor(req, token);
  sendJson(res, 200, {
    ok: true,
    item: rec,
    nameRepaired: up.nameRepaired === true,   // init 时检测的原文件名损坏标记
    ownerToken: req.__ownerToken,
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
    downloads: 0,
    kind: 'text',
    owner: ownerTag(req),
    ...recOpts(optFromReq(req, null, body)),
  };
  index.unshift(rec);
  await saveIndex();
  const base = baseUrlFor(req, token);
  sendJson(res, 200, {
    ok: true,
    item: rec,
    ownerToken: req.__ownerToken,
    urls: {
      page: base + 'f/' + id,
      direct: base + 'd/' + id,
      inline: base + 'v/' + id,
    },
  });
}

// ───────────────────────── 列表 / 删除 ─────────────────────────

function listPayload(P, req) {
  const p = P || perms('admin');
  const request = req || { __isAdmin: true };
  const out = {
    role: p.role,
    canUpload: p.canUpload,
    canList: p.canList,
    canDelete: p.canDelete,
    canManageOwn: true,
    ownership: {
      mode: 'device',                 // 签名设备凭证自动识别，无需登录
      cookie: OWNER_COOKIE,
      header: OWNER_HEADER.toUpperCase(),
      ttlHours: Math.round(OWNER_TTL_MS / 3600000),
      trustedIpElevates: TRUSTED_IPS.length > 0,
    },
    // 前端渲染「上传设置」面板与续期弹窗所需的服务端约束，全部由 expPayload()
    // 单一数据源生成，避免客户端各自硬编码、出现「文案说 24h 但能选 7 档」的错位。
    ...expPayload(),
    maxMb: Math.round(MAX_BYTES / 1048576),
    maxTotalMb: MAX_TOTAL_BYTES ? Math.round(MAX_TOTAL_BYTES / 1048576) : 0,
    usedBytes: totalBytes(),
    // 用户端：已过期的文件直接消失，不存在「续期」一说；只有管理端才看得到、
    // 并负责真正的删除。所以非管理员一律过滤掉 isExpired 的记录。
    items: index
      .filter((r) => request.__isAdmin || !isExpired(r))
      .map((r) => {
      const unlocked = isUnlocked(request, r);
      const expired = isExpired(r);
      const item = {
        id: r.id, size: r.size, time: r.time, expires: r.expires,
        downloads: r.downloads, kind: r.kind,
        expH: r.expH === undefined ? TTL_HOURS : r.expH,
        renewals: r.renewals || 0,
        locked: !!r.lock,
        unlocked: unlocked,
        expired: expired,
        expiringSoon: isExpiringSoon(r),
        mine: isMine(request, r),                // 是不是我传的（用于「我的」标）
        canManage: canManage(request, r),        // 我能不能改时长/续期/删除
        // 续期只面向「尚未过期、且临近到期」的文件；已过期的一律不可续，
        // 由管理端做真正的删除，用户端则直接隐藏（见上方 filter）。
        canRenew: !expired && isExpiringSoon(r) && canManage(request, r),
      };
      if (unlocked) {
        item.name = r.name;
        item.type = r.type;
      } else {
        // 脱敏：未解锁的加密文件只保留「这里有个文件、需要提取码」的事实，
        // 不泄露文件名与类型。id 仍给前端用于触发解锁。
        item.name = '需要访问密码';
        item.type = 'application/octet-stream';
        item.masked = true;
      }
      return item;
    }),
  };
  // 分享口令只回传给管理员，方便他一键把分享链接/二维码给出去
  if (p.role === 'admin' && splitTokens) out.shareToken = SHARE_TOKEN;
  return out;
}

// ── 访问密码：解锁（提取码） ─────────────────────────────────
// 提交提取码 → 服务端算摘要 → 只要站上确有文件用了它，就把该摘要并入
// 签名 Cookie。同批文件 lock 相同，一次解锁整批放行；多次解锁的摘要累加。
async function handleUnlock(req, res) {
  if (unlockRateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
  }
  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const lock = pwHash(body.pw);
  if (!lock || !index.some((r) => r.lock === lock)) {
    return sendJson(res, 403, { error: '访问密码不正确' });
  }
  const locks = readUnlock(req);
  if (!locks.includes(lock)) locks.push(lock);
  const cookie = UNLOCK_COOKIE + '=' + signUnlock(locks) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(UNLOCK_TTL_MS / 1000);
  return sendJson(res, 200, { ok: true, unlocked: locks.length }, { 'Set-Cookie': cookie });
}

// ── 续期：把到期时间重新推后（不改文件、不动下载计数） ────────
// 缺 h 时沿用该文件上传时的档位，做到「一键按原设置续期」。
// 加锁文件须已解锁才能续，避免陌生人给一个看不见的文件乱续。
async function handleRenew(req, res) {
  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const rec = lookup(String(body.id || ''));
  if (!rec) return sendJson(res, 404, { error: '文件不存在' });
  // 归属：改时长 / 续期只能作用于自己上传的文件，管理员例外（服务端强制）。
  if (!canManage(req, rec)) return sendJson(res, 403, { error: '只能管理自己上传的文件' });
  if (!isUnlocked(req, rec)) return sendJson(res, 403, { error: '请先输入访问密码' });
  // 已过期一律不可续：续期只服务于「尚未过期、临近到期」的文件；
  // 过期的交由管理端真正删除，避免「过期还能复活」的歧义。
  if (isExpired(rec)) {
    return sendJson(res, 410, { error: '文件已过期，无法续期；仅可续期临近过期的文件' });
  }
  let expH = rec.expH === undefined ? TTL_HOURS : rec.expH;
  if (body.h !== undefined) {
    const h = Number(body.h);
    if (EXP_CHOICES.includes(h) && (h !== 0 || ALLOW_FOREVER)) expH = h;
  }
  rec.expH = expH;
  rec.expires = expiryFor(expH);
  rec.renewals = (rec.renewals || 0) + 1;
  await saveIndex();
  return sendJson(res, 200, {
    ok: true, id: rec.id, expires: rec.expires, expH: rec.expH, renewals: rec.renewals,
  });
}

async function handleDelete(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: '请求格式错误' });
  }
  // 兼容单删（{id}）与批量删（{ids:[...]}）：逐条归属校验后删除，
  // 无权限或已不存在的条目静默跳过，不中断其余，最后统一返回删除清单。
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id || '')];
  const deleted = [];
  for (const id of ids) {
    if (!id) continue;
    const rec = lookup(id);
    if (!rec) continue;
    // 归属：只能删自己上传的文件，管理员例外。前端藏按钮只是体验，这里是硬拦截。
    if (!canManage(req, rec)) continue;
    index = index.filter((r) => r.id !== id);
    await fsp.rm(blobPath(id), { force: true }).catch(() => {});
    deleted.push(id);
  }
  if (deleted.length) await saveIndex();
  return sendJson(res, 200, { ok: true, deleted });
}

// ───────────────────────── 下载 / 预览 ─────────────────────────

const DANGEROUS_TYPE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml)$/i;

async function serveBlob(req, res, rec, inline) {
  if (!rec) return notFound(res);
  // 访问密码：直链 /d/ /v/ 是分享出去的硬入口，服务端必须强制校验，
  // 不能只靠前端藏按钮。Cookie 里有对应摘要（或管理链接）才放行。
  if (!isUnlocked(req, rec)) {
    return sendJson(res, 401, { error: '需要访问密码', needUnlock: true, id: rec.id });
  }
  // 已过期：用户端已隐藏、不可续期，也不再提供内容，避免「过期还能下」。
  // 管理端在列表里可见并做真正的删除。
  if (isExpired(rec)) {
    return sendJson(res, 410, { error: '文件已过期', expired: true, id: rec.id, canRenew: false });
  }

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

/* ═══════════════ 在线聊天：真实用户 / 单聊 / 群聊 / 时效性 ═══════════════
   与网盘共用同一套底座，不另起炉灶：
     · 身份  ensureOwner + 7mdid HMAC Cookie → ownerTag(req)（每浏览器唯一、不可伪造）
     · 权限  canManage(req, rec)：本人或管理员；管理员含管理链接 / trustedEnv / 登录 Cookie
     · 时效  秒级 expires + isExpired(rec) + sweep() 同一个定时器清理
     · 限流  slidingHit(chatHits, ip, RATE_CHAT_PER_MIN)（与上传限流同一实现）
     · 出口  sendJson / readJson / SEC_BASE
   数据落 DATA_DIR/qq.json（在线存储，重启不丢），但每条都带 expires，过期即清。
   房间：dm:<a>:<b>（按 tag 排序，仅双方可见）/ group:<gid>（仅成员可见）。
   管理员可见并删除全部消息、解散任意群、让用户下线 —— 即「全局管理」。
*/
const ADMIN_COOKIE = '7mdadmin';
const ADMIN_COOKIE_MS = 2 * 3600 * 1000;
const QQ_FILE = path.join(DATA_DIR, 'qq.json');
const QQ_MSG_TTL = Math.max(60, Number(process.env.QQ_MSG_TTL_HOURS ?? 24) * 3600);
const QQ_ROOM_TTL = Math.max(600, Number(process.env.QQ_ROOM_TTL_HOURS ?? 24) * 3600);
const QQ_PRESENCE = Math.max(10, Number(process.env.QQ_PRESENCE_SEC ?? 45));
const QQ_MAX_TEXT = 500;
const QQ_MAX_MSGS = 3000;
const QQ_MAX_USERS = 300;
const QQ_MAX_GROUPS = 80;
const QQ_MAX_MEMBERS = 50;
const RATE_CHAT_PER_MIN = Math.max(0, Number(process.env.RATE_CHAT_PER_MIN ?? 90));

let qqUsers = new Map();    // tag -> { id, name, sign, av, status, lastAt, expires }
let qqGroups = new Map();   // gid -> { id, name, owner, members:[tag], at, expires }
let qqMsgs = [];            // { seq, room, from, fromName, text, at, expires, owner }
let qqSeq = 0;
let qqSaveChain = Promise.resolve();

// 管理员登录凭证：与 7mdid / 7mdok 同一套 HMAC 机制，浏览器伪造不了。
function signAdmin() {
  const payload = b64u(JSON.stringify({ a: 1, e: Date.now() + ADMIN_COOKIE_MS }));
  const sig = crypto.createHmac('sha256', SECRET).update('admin:' + payload).digest('base64url');
  return payload + '.' + sig;
}
function readAdmin(req) {
  const m = /(?:^|;\s*)7mdadmin=([^;]+)/.exec(String(req.headers.cookie || ''));
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 2) return false;
  const expect = crypto.createHmac('sha256', SECRET).update('admin:' + parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expect)) return false;
  try {
    const o = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return !!(o && o.a === 1 && o.e > Date.now());
  } catch { return false; }
}
function qqIsAdmin(req) { return !!(req.__isAdmin || trustedEnv(req) || readAdmin(req)); }

function qqText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
    .trim().slice(0, max || QQ_MAX_TEXT);
}
function qqOnline(u) { return !!u && u.expires > now(); }
function qqMe(req) {
  const tag = ownerTag(req);
  if (!tag) return null;
  let u = qqUsers.get(tag);
  if (!u) {
    if (qqUsers.size >= QQ_MAX_USERS) return null;
    u = { id: tag, name: '访客' + tag.slice(0, 4).toUpperCase(), sign: '', av: 'A',
          status: 'online', lastAt: now(), expires: 0 };
    qqUsers.set(tag, u);
  }
  u.lastAt = now();
  u.expires = now() + QQ_PRESENCE;   // 心跳续期；停跳即过期掉线
  return u;
}
function dmRoom(a, b) { return 'dm:' + [a, b].sort().join(':'); }
function qqCanSpeak(req, room) {
  if (qqIsAdmin(req)) return true;
  const tag = ownerTag(req);
  let m = /^dm:([0-9a-f]{32}):([0-9a-f]{32})$/.exec(room);
  if (m) return m[1] === tag || m[2] === tag;
  m = /^group:([A-Za-z0-9_-]+)$/.exec(room);
  if (m) {
    const g = qqGroups.get(m[1]);
    return !!g && !isExpired(g) && g.members.indexOf(tag) >= 0;
  }
  return false;
}
function qqCanSee(req, msg) {
  if (qqIsAdmin(req) || msg.owner === ownerTag(req)) return true;
  const tag = ownerTag(req);
  const m = /^dm:([0-9a-f]{32}):([0-9a-f]{32})$/.exec(msg.room);
  if (m) return m[1] === tag || m[2] === tag;
  const g = /^group:([A-Za-z0-9_-]+)$/.exec(msg.room);
  if (g) {
    const grp = qqGroups.get(g[1]);
    return !!grp && !isExpired(grp) && grp.members.indexOf(tag) >= 0;
  }
  return false;
}
// 时效性：直接复用网盘的 isExpired（秒级 expires）与 sweep 定时器
function qqPurge() {
  const n0 = qqMsgs.length + qqUsers.size + qqGroups.size;
  qqMsgs = qqMsgs.filter((m) => !isExpired(m));
  for (const [k, u] of qqUsers) if (isExpired(u)) qqUsers.delete(k);
  for (const [k, g] of qqGroups) if (isExpired(g)) qqGroups.delete(k);
  if (qqMsgs.length > QQ_MAX_MSGS) qqMsgs = qqMsgs.slice(-QQ_MAX_MSGS);
  return n0 !== qqMsgs.length + qqUsers.size + qqGroups.size;
}
async function saveQQ() {
  const data = { seq: qqSeq, users: Array.from(qqUsers.values()),
                 groups: Array.from(qqGroups.values()), msgs: qqMsgs };
  qqSaveChain = qqSaveChain.then(async () => {
    const tmp = QQ_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, QQ_FILE);
  }).catch((e) => console.error('[qq] 写入失败:', e.message));
  return qqSaveChain;
}
async function loadQQ() {
  try {
    const o = JSON.parse(await fsp.readFile(QQ_FILE, 'utf8'));
    qqSeq = Number(o.seq) || 0;
    qqUsers = new Map((Array.isArray(o.users) ? o.users : []).map((u) => [u.id, u]));
    qqGroups = new Map((Array.isArray(o.groups) ? o.groups : []).map((g) => [g.id, g]));
    qqMsgs = Array.isArray(o.msgs) ? o.msgs : [];
  } catch { /* 首次启动或存档损坏：按空库处理，不假装有数据 */ }
  qqPurge();
}
function qqUserView(u, meTag, admin) {
  return { id: u.id, name: u.name, sign: u.sign, av: u.av, status: u.status,
           me: u.id === meTag, admin: !!admin };
}

async function handleQQ(req, res, url) {
  const act = url.pathname.slice('/api/qq/'.length);
  ensureOwner(req, res, true);           // 复用身份签发（7mdid）
  req.__isAdmin = qqIsAdmin(req);        // 让 canManage 直接生效
  const tag = ownerTag(req);
  const me = qqMe(req);
  if (!me) return sendJson(res, 503, { error: '在线人数已满，请稍后再试' });
  const admin = qqIsAdmin(req);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (act === 'hello') {
      qqPurge();
      // 隐身是真状态：别人（非管理员）的在线列表里看不到隐身者，本人与管理员可见
      const users = Array.from(qqUsers.values()).filter(qqOnline)
        .filter((u) => u.id === tag || admin || u.status !== 'hidden')
        .map((u) => qqUserView(u, tag, admin));
      const groups = Array.from(qqGroups.values())
        .filter((g) => !isExpired(g) && (admin || g.members.indexOf(tag) >= 0))
        .map((g) => ({ id: g.id, name: g.name, owner: g.owner,
                       members: g.members.length, mine: g.owner === tag,
                       expires: g.expires }));
      return sendJson(res, 200, {
        ok: true, me: qqUserView(me, tag, admin), users, groups, admin,
        seq: qqSeq, ttlHours: Math.round(QQ_MSG_TTL / 3600),
        presenceSec: QQ_PRESENCE, maxText: QQ_MAX_TEXT,
      });
    }
    if (act === 'poll') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const room = String(url.searchParams.get('room') || '');
      qqPurge();
      const list = qqMsgs.filter((m) => m.seq > since && qqCanSee(req, m) &&
        (!room || m.room === room)).slice(-200);
      return sendJson(res, 200, { ok: true, seq: qqSeq, msgs: list, admin });
    }
    return sendJson(res, 404, { error: '未知接口' });
  }

  if (req.method === 'POST') {
    if (chatRateLimited(clientIp(req))) return sendJson(res, 429, { error: '操作太频繁，稍后再试' });
    let body;
    try { body = await readJson(req, 16 * 1024); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }

    if (act === 'profile') {
      // 只能改自己：me 由本人凭证推出，没有任何「替别人改」的入口。
      // patch 语义：只更新本次传入的字段，避免只改昵称却把签名/状态清掉。
      if (body.name !== undefined) {
        const n = qqText(body.name, 20);
        if (n) me.name = n;
      }
      if (body.sign !== undefined) me.sign = qqText(body.sign, 60);
      if (body.status !== undefined) me.status = body.status === 'hidden' ? 'hidden' : 'online';
      await saveQQ();
      return sendJson(res, 200, { ok: true, me: qqUserView(me, tag, admin) });
    }

    if (act === 'say') {
      const room = String(body.room || '');
      const text = qqText(body.text, QQ_MAX_TEXT);
      if (!text) return sendJson(res, 400, { error: '消息不能为空' });
      if (!qqCanSpeak(req, room)) return sendJson(res, 403, { error: '不在这个会话里，无法发言' });
      const gm = /^group:([A-Za-z0-9_-]+)$/.exec(room);
      if (gm) {
        const g = qqGroups.get(gm[1]);
        if (!g || isExpired(g)) return sendJson(res, 410, { error: '群已过期' });
        g.expires = now() + QQ_ROOM_TTL;   // 有活动就续期，无人说话才到期解散
      }
      const msg = { seq: ++qqSeq, room, from: tag, fromName: me.name,
                    text, at: now(), expires: now() + QQ_MSG_TTL, owner: tag };
      qqMsgs.push(msg);
      if (qqMsgs.length > QQ_MAX_MSGS) qqMsgs = qqMsgs.slice(-QQ_MAX_MSGS);
      await saveQQ();
      return sendJson(res, 200, { ok: true, seq: msg.seq, msg });
    }

    if (act === 'group') {
      const a = String(body.action || '');
      const gid = String(body.gid || '');
      if (a === 'create') {
        if (qqGroups.size >= QQ_MAX_GROUPS) return sendJson(res, 503, { error: '群数量已达上限' });
        const g = { id: newId(), name: qqText(body.name, 24) || '新群', owner: tag,
                    members: [tag], at: now(), expires: now() + QQ_ROOM_TTL };
        qqGroups.set(g.id, g);
        await saveQQ();
        return sendJson(res, 200, { ok: true, group: g });
      }
      const g = qqGroups.get(gid);
      if (!g || isExpired(g)) return sendJson(res, 404, { error: '群不存在或已过期' });
      if (!canManage(req, g) && g.members.indexOf(tag) < 0)
        return sendJson(res, 403, { error: '你不在该群' });
      if (a === 'rename' || a === 'dismiss' || a === 'invite') {
        if (!canManage(req, g)) return sendJson(res, 403, { error: '只有群主或管理员能做这个操作' });
      }
      if (a === 'rename') {
        const n = qqText(body.name, 24);
        if (n) g.name = n;
      } else if (a === 'dismiss') {
        qqGroups.delete(gid);
      } else if (a === 'invite') {
        const add = Array.isArray(body.members) ? body.members.map(String) : [];
        let n = 0;
        for (const id of add) {
          if (g.members.length >= QQ_MAX_MEMBERS) break;
          if (g.members.indexOf(id) >= 0) continue;
          const u = qqUsers.get(id);
          if (u && qqOnline(u)) { g.members.push(id); n++; }
        }
        if (!n) return sendJson(res, 400, { error: '没有可邀请的在线用户' });
      } else if (a === 'leave') {
        if (g.owner === tag) qqGroups.delete(gid);   // 群主退出 = 解散，不留无主群
        else g.members = g.members.filter((x) => x !== tag);
      } else {
        return sendJson(res, 400, { error: '未知群操作' });
      }
      if (qqGroups.has(gid)) g.expires = now() + QQ_ROOM_TTL;
      await saveQQ();
      return sendJson(res, 200, { ok: true, group: qqGroups.get(gid) || null });
    }

    if (act === 'delete') {
      // 复用 canManage：本人删自己的消息，管理员删任意消息（全局管理）
      const seqs = Array.isArray(body.seqs) ? body.seqs.map(Number)
        : (body.seq !== undefined ? [Number(body.seq)] : []);
      const set = new Set(seqs);
      const before = qqMsgs.length;
      qqMsgs = qqMsgs.filter((m) => !(set.has(m.seq) && canManage(req, m)));
      const deleted = before - qqMsgs.length;
      if (deleted) await saveQQ();
      return sendJson(res, 200, { ok: true, deleted });
    }

    if (act === 'admin') {
      if (!admin) return sendJson(res, 403, { error: '需要管理员' });
      const a = String(body.action || '');
      if (a === 'purge') {
        const n = qqMsgs.length;
        qqMsgs = [];
        await saveQQ();
        return sendJson(res, 200, { ok: true, deleted: n });
      }
      if (a === 'kick') {
        const had = qqUsers.delete(String(body.id || ''));
        await saveQQ();
        return sendJson(res, 200, { ok: true, kicked: had });
      }
      if (a === 'dismiss') {
        const had = qqGroups.delete(String(body.gid || ''));
        await saveQQ();
        return sendJson(res, 200, { ok: true, dismissed: had });
      }
      return sendJson(res, 400, { error: '未知管理操作' });
    }
    return sendJson(res, 404, { error: '未知接口' });
  }
  return sendJson(res, 405, { error: '方法不允许' });
}

async function sweep() {
  if (initHits.size > 5000) initHits.clear();
  if (chatHits.size > 5000) chatHits.clear();
  if (qqPurge()) await saveQQ();
  const t = now();
  // 过期文件清理：用户端已隐藏、不可续期，文件由管理端在控制台里做真正的删除。
  // 这里只是兜底——过期时间 + 保留窗口都过了、管理端还没删的，才自动清掉，
  // 防止磁盘被一直占着。RENEW_GRACE_MS=0 即过期立即清理（不保留删除窗口）。
  const dead = index.filter((r) => r.expires > 0 &&
    (r.expires * 1000 + RENEW_GRACE_MS) <= Date.now());
  if (dead.length) {
    const deadIds = new Set(dead.map((r) => r.id));
    index = index.filter((r) => !deadIds.has(r.id));
    for (const r of dead) await fsp.rm(blobPath(r.id), { force: true }).catch(() => {});
    await saveIndex();
    console.log('[sweep] 清理过期文件 ' + dead.length + ' 个（宽限期结束）');
  }

  const cutoff = Date.now() - SWEEP_IDLE_MS;
  for (const [id, up] of uploads) {
    if (up.lastAt < cutoff) await abortUpload(id);
  }
  for (const [id, d] of recentDone) {
    if (d.at < Date.now() - RECENT_DONE_MS) recentDone.delete(id);
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
function pageHtml(token, sc) {
  const safe = String(token).replace(/[^A-Za-z0-9._-]/g, '');
  return injectShareCode(
    PAGE.replace('<head>', '<head>\n<base href="/s/' + safe + '/">'), sc
  );
}

/**
 * 桌面启动配置。前端不内嵌任何口令，靠这个接口拿"该往哪儿开文件服务"。
 * 用接口而不是模板串替换：模板串替换要让 HOME_PAGE 变成函数，
 * 每次请求重新拼 4KB 字符串，且容易在手改文本时静默写坏。
 */
function bootPayload() {
  return {
    // 保持干净的相对路径：桌面 JS 会在拼接完 ?embed=1 之后统一挂凭证，
    // 若这里先加就会撞成 "/s/x/?sharecode=SC?embed=1" 把凭证吃掉。
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
    // 追加管理员凭证：让根桌面的 QQ 聊天也能识别管理员（全局管理）。
    // 与文件侧「管理链接 = 主人」语义一致，同样是 HMAC 签名、浏览器伪造不了。
    return sendJson(res, 200, { ok: true, user: 'Administrator', url: '/s/' + TOKEN + '/' }, {
      'Set-Cookie': ADMIN_COOKIE + '=' + signAdmin() +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(ADMIN_COOKIE_MS / 1000),
    });
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
function manifestJson(token, sc) {
  const safe = String(token).replace(/[^A-Za-z0-9._-]/g, '');
  const root = '/s/' + safe + '/';
  const u = (x) => withShareCode(x, sc);
  return JSON.stringify({
    name: '7喵快传',
    short_name: '7喵快传',
    description: '一个文件，一个桌面 —— 单文件、零依赖的自托管文件中转服务',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: u(root),      // 桌面图标启动也必须带凭证，否则 PWA 打开即 403
    scope: root,             // scope 是路径前缀，带 query 反而会让浏览器判定失效
    id: root,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    theme_color: '#008080',
    background_color: '#008080',
    icons: [
      { src: u('./icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: u('./icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: u('./icons/icon-512-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: u('./favicon.ico'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    /* 长按图标 → 直达文件列表或上传（Android；iOS 忽略此字段） */
    shortcuts: [
      { name: '看文件列表', short_name: '列表', url: u(root), description: '打开文件列表' },
      { name: '上传到桌面', short_name: '桌面', url: u('/'), description: '打开 Win98 桌面' },
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
<link rel="stylesheet" href="/home.css?v=__SHELL_V__">
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
        <span class="ico ico-qq"></span><span class="dlabel">IM 即时通讯</span>
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
        <span class="tb-icon tb-snake-ico ico-snake"></span>
        <span class="tb-text">Snake.exe</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="menubar">
        <span class="mu" data-mu="file">文件(F)</span>
        <span class="mu" data-mu="help">帮助(H)</span>
      </div>
      <div class="notepad">
        <pre>7喵快传
═══════════════════════════

一个自托管的文件中转站，
跑在 1998 年的一台 Windows 98「电脑」上。

  · 双击「我的电脑」打开文件服务
  · 双击「扫雷」玩一局（游戏菜单可调难度）
  · 双击「IM 即时通讯」和在线的人聊天（可单聊、可建群）
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
        <button class="wclose" data-close aria-label="关闭"></button>
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
      <div class="fs-exit" title="退出全屏" aria-label="退出全屏">✕</div>
      <div class="statusbar">
        <span class="grow" id="fmStatus">就绪</span>
        <span class="grow" id="fmInfo"></span>
        <span class="grow2" id="fmWho">访客</span>
      </div>
    </div>

    <!-- ── IE 浏览器 ── -->
    <div class="win95 appwin" id="ieWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-ie-ico"></span>
        <span class="tb-text ie-title-el" id="ieTitle">Internet Explorer - 知行工作室</span>
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="menubar">
        <span class="mu" data-mu="file">文件(F)</span>
        <span class="mu" data-mu="edit">编辑(E)</span>
        <span class="mu" data-mu="view">查看(V)</span>
        <span class="mu" data-mu="fav">收藏(A)</span>
        <span class="mu" data-mu="help">帮助(H)</span>
      </div>
      <div class="ie-toolbar">
        <button class="ie-btn ie-back-el" id="ieBack">后退</button>
        <button class="ie-btn ie-fwd-el" id="ieFwd">前进</button>
        <button class="ie-btn ie-refresh-el" id="ieRefresh">刷新</button>
        <button class="ie-btn ie-home-el" id="ieHome">主页</button>
      </div>
      <div class="ie-addrbar">
        <span class="ie-addr-label">地址(D)</span>
        <input id="ieAddr" class="ie-addr ie-addr-el" autocomplete="off" spellcheck="false" aria-label="地址">
      </div>
      <!-- 收藏夹栏（真 IE 就在地址栏下方）：点开在本浏览器内打开 -->
      <div class="ie-favbar" id="ieFavBar"></div>
      <div class="fm-frame">
        <div class="fm-loading ie-loading-el" id="ieLoading">正在连接 Internet…</div>
        <!-- sandbox 不给 allow-same-origin：被代理的页面处于不透明源，
             读不到本项目的 DOM 与本地存储。
             也不给 allow-popups：否则外站页面里的 target=_blank 链接
             会真的弹出系统浏览器窗口 —— 那就前功尽弃了。
             页面里的跳转一律由桥接脚本 postMessage 交回桌面壳，
             在本项目内完成。 -->
        <iframe id="ieFrame" class="ie-frame-el" title="Internet Explorer" referrerpolicy="no-referrer"
                sandbox="allow-scripts allow-forms"></iframe>
      </div>
      <div class="statusbar">
        <span class="grow ie-status-el" id="ieStatus">就绪</span>
      </div>
    </div>

    <!-- ── IE「查看源代码」：在项目内看源码，不跳外部浏览器 ── -->
    <div class="win95 appwin" id="ieSrcWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-note-ico"></span>
        <span class="tb-text" id="ieSrcTitle">源代码 - Internet Explorer</span>
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="notepad">
        <pre id="ieSrcBody"></pre>
      </div>
    </div>

    <!-- ── 扫雷 ── -->
    <div class="win95 narrowwin" id="mineWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tb-mine-ico"></span>
        <span class="tb-text">扫雷</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="dos-body" id="dosBody">
        <div class="dos-out" id="dosOut">7M-Drop(R) Windows 98 Shell
   (C)Copyright 知行工作室 2026.

7喵快传 · 知行工作室
输入 help 查看可用命令。</div>
        <div class="dos-line"><span class="dos-prompt">C:\\&gt;</span><input id="dosIn" class="dos-in" type="text" name="dos-cmd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" aria-label="DOS 命令"></div>
      </div>
    </div>

    <div class="win95 msgwin" id="msgWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text" id="msgTitle">提示</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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
        <button class="wclose" data-close aria-label="关闭"></button>
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
              <option value="Guest">访客</option>
              <option value="Administrator">管理员</option>
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
        <div class="smi" data-app="qq"><span class="smi-ico ico-qq"></span>IM 即时通讯</div>
      </div>
      <div class="smsub" id="smsub-docs" hidden>
        <div class="smi" data-app="readme"><span class="smi-ico ico-note"></span>readme.txt</div>
        <div class="smi" data-app="net"><span class="smi-ico ico-net"></span>网上邻居</div>
      </div>
      <div class="smsub" id="smsub-fav" hidden>
        <div class="smi" data-app="fav-w3b"><span class="smi-ico ico-fav"></span>知行工作室</div>
        <div class="smi" data-app="fav-github"><span class="smi-ico ico-fav"></span>开源仓库</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="ie"><span class="smi-ico ico-ie"></span>7喵快传</div>
      </div>
      <div class="smsub" id="smsub-set" hidden>
        <div class="smi" data-app="props"><span class="smi-ico ico-set"></span>显示属性</div>
        <div class="smi" data-app="saver"><span class="smi-ico ico-saver"></span>屏幕保护</div>
        <div class="smi" data-app="sysinfo"><span class="smi-ico ico-sys"></span>系统属性</div>
        <div class="sm-sep"></div>
        <div class="smi" data-app="install"><span class="smi-ico ico-install"></span>安装到桌面</div>
      </div>
      <div class="smsub" id="smsub-find" hidden>
        <div class="smi" data-app="run"><span class="smi-ico ico-run"></span>按口令查找文件服务…</div>
      </div>
    </div>

    <div class="win95 smalldlg" id="runWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">运行</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="dlg-pad">
        <div class="sys-grid" id="sysGrid"></div>
        <div class="msgbtn"><button class="btn95" id="sysOk">确定</button></div>
      </div>
    </div>

    <div class="win95 smalldlg" id="netWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">网上邻居</span>
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="dlg-pad">
        <div class="sys-grid" id="netGrid"></div>
        <div class="msgbtn"><button class="btn95" id="netOk">确定</button></div>
      </div>
    </div>

    <div class="win95 smalldlg" id="propWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">显示 属性</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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

    <!-- 图标右键菜单：按图标类型动态渲染（系统根/IE/普通应用各有不同菜单，杜绝假功能与错误关联） -->
    <div class="ctxmenu" id="iconCtx" hidden></div>

    <!-- ═══════════ 回收站窗口：被删除的桌面图标可还原 / 可彻底删除 ═══════════ -->
    <div class="win95 appwin rbwin" id="rbWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-text">回收站</span>
        <button class="wclose" data-close aria-label="关闭"></button>
      </div>
      <div class="rb-bar">
        <label class="rb-all"><input type="checkbox" id="rbAll">全选</label>
        <span class="rb-count" id="rbCount"></span>
        <button class="btn95 rb-btn" id="rbRestore" type="button" disabled>还原选中</button>
        <button class="btn95 rb-btn" id="rbPurge" type="button" disabled>彻底删除</button>
        <button class="btn95 rb-btn" id="rbEmpty" type="button" disabled>清空回收站</button>
      </div>
      <div class="rb-head"><span class="rb-h-chk"></span><span>名称</span><span>原位置</span><span>删除时间</span></div>
      <div class="rb-list" id="rbList"></div>
      <div class="rb-empty" id="rbEmptyTip" hidden>回收站是空的。</div>
      <div class="statusbar"><span class="grow" id="rbStatus">0 个对象</span></div>
    </div>

    <!-- ═══════════ IM 面板（在线聊天：真实用户 / 单聊 / 群聊）═══════════ -->
    <div class="win95 appwin qqwin" id="qqWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tbqq"><span class="ico ico-qq ico-qq-s"></span></span>
        <span class="tb-text">IM 即时通讯</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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
        <!-- 三个 Tab：好友 / 群聊 / 最近联系人（真实切换） -->
        <div class="qq-tabs" id="qqTabs">
          <div class="qq-tab on" data-tab="friend"><span class="qq-tab-ico" id="qqTabIcoF"></span>好友</div>
          <div class="qq-tab" data-tab="group"><span class="qq-tab-ico" id="qqTabIcoG"></span>群聊</div>
          <div class="qq-tab" data-tab="recent"><span class="qq-tab-ico" id="qqTabIcoR"></span>最近联系人</div>
        </div>
        <div class="qq-list" id="qqGroups"></div>
        <!-- 底部工具栏：主菜单 + 在线统计 -->
        <div class="qq-bar">
          <button class="qq-bar-btn" id="qqMenuBtn" title="主菜单" aria-label="主菜单">
            <span class="ico ico-qq ico-qq-s"></span>
          </button>
          <span class="qq-online" id="qqOnline">在线 0 人</span>
        </div>
        <!-- 主菜单弹出层：每一项都真实生效，不摆装饰性入口 -->
        <div class="qq-menu" id="qqMenu" hidden>
          <div class="qq-menu-lab">音效</div>
          <div class="qq-menu-row"><button class="btn95 qq-mini" id="qqSound">音效:开</button></div>
          <div class="qq-menu-sep"></div>
          <div class="qq-menu-row" id="qqNewGroupRow" data-a="newgroup">新建群聊</div>
          <div class="qq-menu-row" id="qqProfileRow" data-a="profile">修改我的昵称</div>
          <div class="qq-menu-row" id="qqRefreshRow" data-a="refresh">刷新在线列表</div>
          <div class="qq-menu-row" id="qqAdminRow" data-a="admin" hidden>管理员：清空全部消息</div>
          <div class="qq-menu-sep"></div>
          <div class="qq-menu-row" id="qqQuitRow" data-a="quit">退出 IM</div>
        </div>
      </div>
    </div>

    <!-- ═══════════ IM 聊天窗口 ═══════════ -->
    <div class="win95 appwin qqchatwin" id="qqChatWin" hidden>
      <div class="titlebar" data-drag>
        <span class="tb-icon tbqq"><span class="ico ico-qq ico-qq-s"></span></span>
        <span class="tb-text" id="qqChatTitle">与好友对话</span>
        <button class="wclose" data-close aria-label="关闭"></button>
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
        <!-- 消息区（左）+ 对方资料栏（右） -->
        <div class="qq-ch-main">
          <div class="qq-ch-log" id="qqLog"></div>
          <div class="qq-ch-side" id="qqChatSide"></div>
        </div>
        <!-- 连接状态：只在与服务端断连/重连时如实出现，不摆假的「正在输入」 -->
        <div class="qq-typing" id="qqTyping" hidden><span id="qqTypingText"></span></div>
        <!-- 工具栏：字体 / 表情（不放任何播放控制） -->
        <div class="qq-ch-tools">
          <button class="qq-tool" id="qqFontBtn" title="切换字体大小" aria-label="切换字体大小">A</button>
          <button class="qq-tool qq-facebtn" id="qqFaceBtn" title="表情" aria-label="插入表情"></button>
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
    <div class="tray">
      <button class="volbtn" id="volBtn" type="button" aria-label="音量" title="音量调节"><span id="volGlyph"></span></button>
      <div class="vol-pop" id="volPop" hidden>
        <div class="vol-pop-t">主音量</div>
        <input id="volRange" class="vol-range" type="range" min="0" max="100" value="70" aria-label="主音量">
        <div class="vol-pct" id="volPct">70%</div>
        <label class="vol-mute"><input type="checkbox" id="volMute"> 静音</label>
      </div>
      <span id="trayIcons"></span><span id="clock">--:--</span>
    </div>
  </div>

  <canvas id="ssaver" hidden></canvas>
  <div id="shutdown" hidden>
    <div class="shut-stage">
      <div class="shut-logo">
        <div class="winflag big"></div>
        <div class="shut-wordmark">7喵快传 <b>Windows</b><i>98</i></div>
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
  <script src="/home.js?v=__SHELL_V__"></script>
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
  /* 构建版本标记：页面侧「版本自愈」用它核对实际生效的 CSS 是不是当前版本。
     旧 SW 缓存住旧 CSS 时，页面声明的 ?v= 与这里的值对不上，
     页面就会清缓存重载，避免「新版 JS + 旧版 CSS」混搭导致布局错乱。
     占位符由 homePageHtml() 之外的 cssWithVersion() 在下发前替换。 */
  --shell-ver: __SHELL_V__;
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
  /* ───── 统一控制按钮图标（同一功能=同一图标，全站复用，杜绝 ×/✕/□ 混用）─────
     像素风 SVG，黑描边透明底；win95 标题栏(16px)与查看器/弹窗(19~38px)各自缩放。 */
  --ico-x:       url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5' stroke='%23000' stroke-width='2' stroke-linecap='square'/%3E%3C/svg%3E");
  --ico-min:     url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='3' y='9.5' width='8' height='2' fill='%23000'/%3E%3C/svg%3E");
  /* --ico-max（方框）保留备用：当前「放大到极限」统一用 --ico-expand（四角箭头），
     窗口最大化与视频全屏同形。若日后要区分二者，这里就是方框版素材 */
  --ico-max:     url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='3' y='3' width='8' height='8' fill='none' stroke='%23000' stroke-width='1.4'/%3E%3Crect x='3' y='3' width='8' height='1.6' fill='%23000'/%3E%3C/svg%3E");
  --ico-restore: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='5' y='4' width='6' height='6' fill='none' stroke='%23000' stroke-width='1.3'/%3E%3Crect x='3' y='2' width='6' height='6' fill='none' stroke='%23000' stroke-width='1.3'/%3E%3C/svg%3E");
  --ico-expand:  url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M2 5V2H5 M9 2H12V5 M12 9V12H9 M5 12H2V9' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square'/%3E%3C/svg%3E");
  /* 桌面：底色 + 4px 棋盘格抖动（还原 CRT 低色深观感） */
  --desk1: #008080;
  --desk2: #007d7d;
  /* 几何（Win98 标准度量） */
  --tb-h: 28px;      /* 任务栏基础高度 */
  --taskbar-h: calc(var(--tb-h) + env(safe-area-inset-bottom, 0px)); /* 含底部安全区，最大化窗口用它让位 */
  --ui-fs: 11px;     /* MS Sans Serif 8pt ≈ 11px */
  --scroll-w: 16px;  /* 滚动条宽度 */
  /* 语义色：信息蓝 / 错误红（重复出现的语义色集中成 token，新增代码禁止再硬编码） */
  --info: #1971c2;   /* 信息 / 链接蓝：系统图标、提示、运行图标等 */
  --err:  #e8394a;   /* 错误红：消息框叉、关闭图标、收藏红等 */
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
  /* 触屏：声明 manipulation 消除 300ms 点击延迟，并禁掉长按选中/系统菜单，
     不然手机上点图标要么慢半拍，要么被弹出「复制/粘贴」系统菜单打断。 */
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
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
/* hover / 按下反馈：Win98 真机 hover 无效果，但 Web 上触屏/鼠标用户
   需要"这个可以点"的暗示——hover 给标签一层半透明选中底色、
   图标提亮；按下时图标轻微收缩，与按钮"按下去"的语言呼应 */
.dicon:hover .dlabel { background: rgba(0,0,128,.30); }
.dicon:hover .ico { filter: brightness(1.12); }
.dicon:active .ico { transform: scale(.92); }
.ico { transition: transform .06s ease-out; }

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

/* 标题栏图标的底板（黑底 + 内高光）。
   必须排在各 .tb-*-ico 专属规则之前：同特异度下后写的赢，
   放后面会把专属图标的底色/阴影全盖掉（踩过一次：所有窗口标题栏都成了同一个黑块）。 */
.tb-icon {
  flex: none;
  width: 16px;
  height: 16px;
  background: #000;
  box-shadow: inset 1px 1px 0 #6a6a6a;
  position: relative;
}
/* 这里原本还有一条"通用绿点"占位图标（.tb-icon::after）。它与各专属图标
   （.tb-pc-ico::after / .tb-mine-ico::after / .tb-note-ico::after …）特异度相同、
   位置更靠后，反过来把专属图标全盖住 —— 结果每个窗口标题栏都长成同一个绿点，
   「我的电脑」显示的不是电脑。现在每个窗口都有专属图标，占位绿点已移除。 */
.tb-note-ico { background: #fff; box-shadow: inset 0 0 0 2px #808080; }
.tb-note-ico::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 4px;
  width: 6px;
  height: 1.5px;
  background: var(--info);
  box-shadow: 0 3px var(--info), 0 6px var(--info);
}
/* 这三个窗口的标题栏图标之前没有专属 ::after，于是统统退化成 .tb-icon 的绿色 LED 点，
   看着像「同一个图标」。补上各自的简易字形（风格从简，重在可辨识）。 */
.tb-pc-ico { background: #fff; box-shadow: inset 0 0 0 2px #808080; }
/* 迷你显示器：蓝屏 + 灰色底座（与桌面像素图标同套 2px 网格）。
   原画的底座像素落在 y=16，超出 16px 图标框，会糊到标题文字上。 */
.tb-pc-ico::after {
  content: ""; position: absolute; left: 0; top: 0; width: 2px; height: 2px;
  box-shadow:
    4px 3px 0 var(--info), 6px 3px 0 var(--info), 8px 3px 0 var(--info), 10px 3px 0 var(--info),
    4px 5px 0 var(--info), 6px 5px 0 var(--info), 8px 5px 0 var(--info), 10px 5px 0 var(--info),
    4px 7px 0 var(--info), 6px 7px 0 var(--info), 8px 7px 0 var(--info), 10px 7px 0 var(--info),
    6px 9px 0 #808080, 8px 9px 0 #808080,
    4px 11px 0 #808080, 6px 11px 0 #808080, 8px 11px 0 #808080, 10px 11px 0 #808080;
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

/* ═══════════════ 开始菜单图标系统（此前 5 个类无 CSS 定义 = 空白图标）═══════════════
   与桌面同套 2px 网格 + 配色语言。复用桌面的像素图标时，32px 原画缩到 16px，
   否则会被 16px 的 .smi-ico 容器裁成左上角一格。 */
.smi-ico.ico-pc::before, .smi-ico.ico-net::before, .smi-ico.ico-note::before,
.smi-ico.ico-saver::before, .smi-ico.ico-install::before, .smi-ico.ico-dos::before,
.smi-ico.ico-qq::before, .smi-ico.ico-snake::before {
  transform: scale(.5); transform-origin: 0 0;
}
/* 5 个此前缺失的图标（程序/文档/设置/查找/系统属性）：直接以 16px 绘制 */
.smi-ico.ico-prog::before, .smi-ico.ico-docs::before, .smi-ico.ico-set::before,
.smi-ico.ico-find::before, .smi-ico.ico-sys::before {
  content: ""; position: absolute; left: 0; top: 0; width: 2px; height: 2px;
}
/* 程序：文件夹（金黄） */
.smi-ico.ico-prog::before { box-shadow:
  2px 2px 0 #caa000, 4px 2px 0 #caa000, 6px 2px 0 #caa000, 8px 2px 0 #caa000, 10px 2px 0 #caa000,
  0px 4px 0 #caa000, 2px 4px 0 #ffe066, 4px 4px 0 #ffe066, 6px 4px 0 #ffe066, 8px 4px 0 #ffe066, 10px 4px 0 #ffe066, 12px 4px 0 #ffe066, 14px 4px 0 #caa000,
  0px 6px 0 #caa000, 2px 6px 0 #ffe066, 4px 6px 0 #ffe066, 6px 6px 0 #ffe066, 8px 6px 0 #ffe066, 10px 6px 0 #ffe066, 12px 6px 0 #ffe066, 14px 6px 0 #caa000,
  0px 8px 0 #caa000, 2px 8px 0 #ffe066, 4px 8px 0 #ffe066, 6px 8px 0 #ffe066, 8px 8px 0 #ffe066, 10px 8px 0 #ffe066, 12px 8px 0 #ffe066, 14px 8px 0 #caa000,
  0px 10px 0 #caa000, 2px 10px 0 #ffe066, 4px 10px 0 #ffe066, 6px 10px 0 #ffe066, 8px 10px 0 #ffe066, 10px 10px 0 #ffe066, 12px 10px 0 #ffe066, 14px 10px 0 #caa000,
  0px 12px 0 #caa000, 2px 12px 0 #ffe066, 4px 12px 0 #ffe066, 6px 12px 0 #ffe066, 8px 12px 0 #ffe066, 10px 12px 0 #ffe066, 12px 12px 0 #ffe066, 14px 12px 0 #caa000,
  0px 14px 0 #caa000, 2px 14px 0 #caa000, 4px 14px 0 #caa000, 6px 14px 0 #caa000, 8px 14px 0 #caa000, 10px 14px 0 #caa000, 12px 14px 0 #caa000, 14px 14px 0 #caa000; }
/* 文档：白页 + 右上蓝色折角 + 文字行 */
.smi-ico.ico-docs::before { box-shadow:
  2px 2px 0 #fff, 4px 2px 0 #fff, 6px 2px 0 #fff, 8px 2px 0 #fff, 10px 2px 0 #1084d0, 12px 2px 0 #1084d0,
  2px 4px 0 #fff, 4px 4px 0 #fff, 6px 4px 0 #fff, 8px 4px 0 #fff, 10px 4px 0 #fff, 12px 4px 0 #1084d0,
  2px 6px 0 #fff, 4px 6px 0 #808080, 6px 6px 0 #808080, 8px 6px 0 #fff, 10px 6px 0 #fff, 12px 6px 0 #fff,
  2px 8px 0 #fff, 4px 8px 0 #fff, 6px 8px 0 #fff, 8px 8px 0 #fff, 10px 8px 0 #fff, 12px 8px 0 #fff,
  2px 10px 0 #fff, 4px 10px 0 #808080, 6px 10px 0 #808080, 8px 10px 0 #808080, 10px 10px 0 #fff, 12px 10px 0 #fff,
  2px 12px 0 #fff, 4px 12px 0 #fff, 6px 12px 0 #fff, 8px 12px 0 #fff, 10px 12px 0 #fff, 12px 12px 0 #fff,
  2px 14px 0 #c0c0c0, 4px 14px 0 #c0c0c0, 6px 14px 0 #c0c0c0, 8px 14px 0 #c0c0c0, 10px 14px 0 #c0c0c0, 12px 14px 0 #c0c0c0; }
/* 设置：齿轮（灰） */
.smi-ico.ico-set::before { box-shadow:
  4px 2px 0 #808080, 6px 2px 0 #808080, 8px 2px 0 #808080, 10px 2px 0 #808080,
  2px 4px 0 #808080, 4px 4px 0 #c0c0c0, 6px 4px 0 #c0c0c0, 8px 4px 0 #c0c0c0, 10px 4px 0 #c0c0c0, 12px 4px 0 #808080,
  2px 6px 0 #808080, 4px 6px 0 #c0c0c0, 6px 6px 0 #fff, 8px 6px 0 #fff, 10px 6px 0 #c0c0c0, 12px 6px 0 #808080,
  2px 8px 0 #808080, 4px 8px 0 #c0c0c0, 6px 8px 0 #fff, 8px 8px 0 #fff, 10px 8px 0 #c0c0c0, 12px 8px 0 #808080,
  2px 10px 0 #808080, 4px 10px 0 #c0c0c0, 6px 10px 0 #c0c0c0, 8px 10px 0 #c0c0c0, 10px 10px 0 #c0c0c0, 12px 10px 0 #808080,
  2px 12px 0 #808080, 4px 12px 0 #c0c0c0, 6px 12px 0 #c0c0c0, 8px 12px 0 #c0c0c0, 10px 12px 0 #c0c0c0, 12px 12px 0 #808080,
  4px 14px 0 #808080, 6px 14px 0 #808080, 8px 14px 0 #808080, 10px 14px 0 #808080; }
/* 查找：放大镜 */
.smi-ico.ico-find::before { box-shadow:
  2px 2px 0 #808080, 4px 2px 0 #dfdfdf, 6px 2px 0 #dfdfdf, 8px 2px 0 #808080,
  0px 4px 0 #808080, 2px 4px 0 #dfdfdf, 4px 4px 0 #fff, 6px 4px 0 #fff, 8px 4px 0 #dfdfdf, 10px 4px 0 #808080,
  0px 6px 0 #808080, 2px 6px 0 #dfdfdf, 4px 6px 0 #fff, 6px 6px 0 #fff, 8px 6px 0 #dfdfdf, 10px 6px 0 #808080,
  2px 8px 0 #808080, 4px 8px 0 #dfdfdf, 6px 8px 0 #dfdfdf, 8px 8px 0 #808080,
  10px 10px 0 #808080,
  12px 12px 0 #808080,
  14px 14px 0 #808080; }
/* 系统属性：显示器 */
.smi-ico.ico-sys::before { box-shadow:
  2px 2px 0 #0a0a0a, 4px 2px 0 #1084d0, 6px 2px 0 #1084d0, 8px 2px 0 #1084d0, 10px 2px 0 #1084d0, 12px 2px 0 #0a0a0a,
  2px 4px 0 #0a0a0a, 4px 4px 0 #1084d0, 6px 4px 0 #1084d0, 8px 4px 0 #1084d0, 10px 4px 0 #1084d0, 12px 4px 0 #0a0a0a,
  2px 6px 0 #0a0a0a, 4px 6px 0 #1084d0, 6px 6px 0 #1084d0, 8px 6px 0 #1084d0, 10px 6px 0 #1084d0, 12px 6px 0 #0a0a0a,
  2px 8px 0 #0a0a0a, 4px 8px 0 #1084d0, 6px 8px 0 #1084d0, 8px 8px 0 #1084d0, 10px 8px 0 #1084d0, 12px 8px 0 #0a0a0a,
  6px 10px 0 #808080, 8px 10px 0 #808080, 10px 10px 0 #808080,
  4px 12px 0 #c0c0c0, 6px 12px 0 #c0c0c0, 8px 12px 0 #c0c0c0, 10px 12px 0 #c0c0c0, 12px 12px 0 #c0c0c0,
  4px 14px 0 #808080, 6px 14px 0 #808080, 8px 14px 0 #808080, 10px 14px 0 #808080, 12px 14px 0 #808080; }

/* 贪吃蛇窗口标题栏：复用桌面同套画法的贪吃蛇像素图标，替代通用绿点占位 */
.tb-snake-ico { background: none; box-shadow: none; }
.tb-snake-ico::after { content: none; }
.tb-snake-ico.ico-snake::before { transform: scale(.5); transform-origin: 0 0; }

/* ───── Win95 窗口公共 ───── */
.win95 {
  position: absolute;
  background: #c0c0c0;
  padding: 3px;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff,
              /* 硬边外投影：与像素语言一致（无模糊），给窗口在桌面上
                 一层"浮起"的层次；最大化铺满时撤掉（见 .maxed） */
              3px 3px 0 rgba(0,0,0,.30);
  /* 打开瞬间 90ms 淡入：消灭"硬弹"感（display:none→可见会自动重放） */
  animation: winIn .09s ease-out;
}
@keyframes winIn { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .win95 { animation: none; }
}
.win95.maxed {
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff;
}
/* 窗口层级：非活动窗口投影更浅、偏移更小 —— 真 Win98 也是"当前窗最靠前、
   背景窗后退一层"，一层浅硬投影就够，多窗口叠放时层次立刻读得出来。 */
.win95.inactive:not(.maxed) {
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf,
              inset -2px -2px #808080, inset 2px 2px #fff,
              2px 2px 0 rgba(0,0,0,.16);
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
/* 源码窗：必须有硬性尺寸上限。之前无约束，抓到 700KB 级源码时
   flex 子项默认 min-height:auto 不许收缩，整个窗口被撑出视口铺满屏幕 */
#ieSrcWin { width: min(94vw, 640px); max-height: min(82vh, 560px); }
#ieSrcWin > .notepad { flex: 1 1 auto; min-height: 0; overflow: auto; }
#dosWin  { width: min(94vw, 560px); }
#dosWin > .dos-body { min-height: 320px; }
#gameWin > .client { min-height: 300px; }
/* ── 内嵌页请求「铺满全屏」时的宿主窗口状态 ──
   内层（文件服务页）的预览全屏只能铺满 iframe 自己；在手机上 iframe 只有半屏宽，
   于是内容挤在一侧。此类让宿主窗口铺满视口，并把菜单栏/标题栏收起来，
   让出全部空间给预览内容。
   注意：.win95.maxed 用的是 !important（left/width/height 全带），
   两者叠加时 maxed 会赢 —— 所以这里同样必须 !important，
   且选择器要更具体（.win95.appwin.embed-fs 比 .win95.maxed 特异性高）。 */
.win95.appwin.embed-fs {
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  top: 0 !important;
  bottom: 0 !important;
  width: auto !important;
  height: auto !important;
  max-width: none !important;
  max-height: none !important;
  z-index: 200;
}
.win95.appwin.embed-fs > .menubar,
.win95.appwin.embed-fs > .statusbar,
.win95.appwin.embed-fs > .titlebar { display: none; }
.win95.appwin.embed-fs > .fm-frame { min-height: 0; }
/* 全屏(embed-fs)浮动退出把手：标题栏被隐藏后唯一的退出入口。
   平时隐藏、不破坏沉浸感；全屏时浮在右上角、z-index 盖在 iframe 之上，
   点击驱动预览真正退出全屏（与 ⛶ 同一闭环），消除「困在全屏里没把手」的焦虑 */
.fs-exit {
  display: none;
  position: absolute;
  top: 6px; right: 6px;
  z-index: 60;
  width: 24px; height: 24px;
  padding: 0;
  border: 2px outset #c0c0c0;
  background: #c0c0c0;
  color: #000;
  font: 700 14px/20px Tahoma, "MS Sans Serif", sans-serif;
  text-align: center;
  cursor: pointer;
}
.fs-exit:active { border-style: inset; }
.win95.appwin.embed-fs > .fs-exit { display: block; }
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
/* 触屏：所有可点的窗口控件都要消除 300ms 点击延迟，
   否则手机上点最小化/关闭会「按了没反应」半天。 */
.wbtn, .wclose, .startbtn {
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
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
/* 三个控制按钮统一引用 --ico-* 图标，同一功能全站同形 */
.wbtn::after {
  content: '';
  display: block;
  width: 9px; height: 9px;
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
}
.wbtn.min::after  { background-image: var(--ico-min); }
/* 「放大到极限」全站永远同一个图标：无论窗口是普通还是已最大化、
   视频是窗口内还是已全屏，按钮一律显示 --ico-expand（四角箭头）。
   不再切 --ico-restore 双框：移动端窗口打开即自动最大化，若切换图标，
   同屏的外壳与内嵌预览按钮一双框一四角箭头，观感即「两种设计」；
   且 14px 的双框在触屏上难以辨认。放大/还原语义由 aria-label/title
   与点击行为保留，仅图形恒定。 */
.wbtn.max::after  { background-image: var(--ico-expand); }
.wbtn.rest::after { background-image: var(--ico-expand); }
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
/* .tb-icon 底板已上移到各 .tb-*-ico 专属规则之前（见图标区开头），
   专属图标必须能覆盖底色，底板就不能写在后面。 */
.wclose {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 14px;
  background: #c0c0c0;
  border: none;
  color: transparent;   /* 隐藏 × 文本，改用统一像素 X 图标 */
  font-size: 0;
  box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff,
              inset -2px -2px #808080, inset 2px 2px #dfdfdf;
}
.wclose::after {
  content: "";
  display: block;
  /* 与 .wbtn::after 同为 9px：同一标题栏里所有图标一种规格 */
  width: 9px; height: 9px;
  background: var(--ico-x) center / contain no-repeat;
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
/* 「我的电脑」窗口状态栏三格：权限短句固定宽、容量信息弹性伸缩、
   身份标签固定宽。窄屏（392px）下三格也不会互相挤没。 */
#fmStatus { flex: 0 0 auto; cursor: pointer; }
#fmStatus:hover { background: #d4d4d4; }
#fmInfo { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
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
.micon.err { background: var(--err); }
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
.micon.info { background: var(--info); }
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
  display: flex;
  align-items: center;
  gap: 4px;
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
/* 任务栏按钮 = 窗口小图标 + 短标题（Win98 原版行为）。
   图标直接克隆窗口标题栏那一枚，同一个应用在标题栏与任务栏是同一个图形，
   不另造一套 —— 也就不会出现「任务栏是纸飞机、标题栏是显示器」这类割裂。 */
.taskbtn .tbi { flex: none; overflow: hidden; }
.taskbtn .tb-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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
.smi-ico.ico-shut { background: var(--err); box-shadow: inset 0 0 0 2px #9c2029; }
.sm-sep { height: 1px; margin: 3px 6px; background: #808080; box-shadow: 0 1px 0 #fff; }
/* 运行：白窗口 + 蓝色标题条 + 橙色右向箭头（三者合成一个完整图标。
   原先只有白底 + 一条细小 ::after，缩到 16px 后几乎不可见，看着像空白占位） */
.smi-ico.ico-run {
  background: #fff;
  box-shadow: inset 0 0 0 1px var(--info);
}
.smi-ico.ico-run::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 2px;
  width: 12px;
  height: 3px;
  background: var(--info);
}
.smi-ico.ico-run::after {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  width: 2px;
  height: 2px;
  box-shadow:
    2px 8px 0 #f59f00, 4px 8px 0 #f59f00, 6px 8px 0 #f59f00, 8px 8px 0 #f59f00,
    4px 10px 0 #f59f00, 6px 10px 0 #f59f00, 8px 10px 0 #f59f00, 10px 10px 0 #f59f00,
    2px 12px 0 #f59f00, 4px 12px 0 #f59f00, 6px 12px 0 #f59f00, 8px 12px 0 #f59f00;
}
.smi-ico.ico-help {
  background: var(--info);
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

/* ───── 网上邻居：可点的站点列表 ───── */
.net-label {
  font-size: 11px; color: #404040; margin: 12px 0 6px;
  padding-top: 8px; border-top: 1px solid #808080; box-shadow: 0 -1px 0 #fff inset;
}
.net-list { display: flex; flex-direction: column; gap: 3px; }
.net-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px; cursor: default; user-select: none;
}
.net-item:hover { background: #d8ebfb; }
.net-item:active { background: #cfe6fa; }
.net-item:focus-visible { outline: 1px dotted #000080; outline-offset: -2px; }
/* 站点图标：Win98 的网上邻居就是一堆小图标 */
.net-ico {
  flex: none; width: 16px; height: 16px; background: #fff;
  box-shadow: inset 0 0 0 1px #808080;
  background-image:
    linear-gradient(#1084d0, #1084d0);
  background-size: 8px 8px;
  background-repeat: no-repeat;
  background-position: 3px 3px;
}
.net-txt { display: flex; flex-direction: column; line-height: 1.35; min-width: 0; }
.net-txt b { font-size: 12px; font-weight: normal; color: #000080; }
.net-txt i { font-size: 10px; font-style: normal; color: #7b8fa3; }

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
  /* 触屏：消除 300ms 点击延迟 + 禁长按系统菜单 */
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.ctxi:hover { background: #000080; color: #fff; }
.ctx-sep { height: 1px; margin: 3px 4px; background: #808080; box-shadow: 0 1px 0 #fff; }

/* ───── 记事本下拉菜单 ───── */
.menubar { position: relative; }
.mu {
  padding: 2px 7px;
  cursor: default;
  /* 触屏：消除 300ms 点击延迟（否则点菜单半天没反应） */
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
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
/* ── 收藏夹栏（真 IE 的 Favorites Bar 就在地址栏下方）──
   点站点在本浏览器内打开；绝不跳系统浏览器。 */
.ie-favbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 3px;
  background: var(--face);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ie-favbar::-webkit-scrollbar { display: none; height: 0; }
.ie-fav {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 3px;
  font: inherit;
  font-size: 11px;
  color: #000080;
  background: transparent;
  border: 1px solid transparent;
  cursor: default;
  white-space: nowrap;
}
.ie-fav:hover { border-color: var(--hi) var(--sh) var(--sh) var(--hi); }
.ie-fav:active { border-color: var(--sh) var(--hi) var(--hi) var(--sh); }
.ie-fav:focus-visible { outline: 1px dotted #000080; outline-offset: -2px; }
/* 收藏项的小图标：Win98 收藏栏就是一堆小图标+文字 */
.ie-fav-ico {
  flex: none;
  width: 14px;
  height: 14px;
  background: #fff;
  box-shadow: inset 0 0 0 1px #808080;
  background-image: linear-gradient(#1084d0, #1084d0);
  background-size: 7px 7px;
  background-repeat: no-repeat;
  background-position: 3px 3px;
}
.ie-fav-add {
  flex: none;
  width: 16px;
  height: 16px;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: #000;
  background: var(--face);
  border: 0;
  cursor: default;
  box-shadow: inset -1px -1px var(--dk), inset 1px 1px var(--hi),
              inset -2px -2px var(--sh), inset 2px 2px var(--lt);
}
.ie-fav-add:active { box-shadow: inset 1px 1px var(--sh), inset -1px -1px var(--hi); }
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

/* ═══════════════ IM 界面样式 ═══════════════
   企鹅图标与其它桌面图标同一套画法：16×16 像素 → box-shadow，2px 网格。
   面板/会话窗口一律用 Win98 的凸凹边框语言，点缀色取 QQ 经典蓝。
   好友头像不写死：由 JS 按 10×10 像素谱生成 box-shadow（见 QQ_JS）。 */
.ico-qq { background: none; }
.ico-qq::before { box-shadow: 14px 2px 0 #0a0a0a,16px 2px 0 #0a0a0a,18px 2px 0 #0a0a0a,20px 2px 0 #0a0a0a,10px 4px 0 #0a0a0a,12px 4px 0 #0a0a0a,14px 4px 0 #22262e,16px 4px 0 #22262e,18px 4px 0 #22262e,20px 4px 0 #22262e,22px 4px 0 #0a0a0a,24px 4px 0 #0a0a0a,8px 6px 0 #0a0a0a,10px 6px 0 #22262e,12px 6px 0 #22262e,14px 6px 0 #ffffff,16px 6px 0 #ffffff,18px 6px 0 #ffffff,20px 6px 0 #ffffff,22px 6px 0 #22262e,24px 6px 0 #22262e,26px 6px 0 #0a0a0a,6px 8px 0 #0a0a0a,8px 8px 0 #22262e,10px 8px 0 #22262e,12px 8px 0 #ffffff,14px 8px 0 #0a0a0a,16px 8px 0 #22262e,18px 8px 0 #22262e,20px 8px 0 #0a0a0a,22px 8px 0 #ffffff,24px 8px 0 #ffffff,26px 8px 0 #22262e,28px 8px 0 #22262e,30px 8px 0 #0a0a0a,6px 10px 0 #0a0a0a,8px 10px 0 #22262e,10px 10px 0 #22262e,12px 10px 0 #ffffff,14px 10px 0 #ffffff,16px 10px 0 #f8b800,18px 10px 0 #f8b800,20px 10px 0 #ffffff,22px 10px 0 #ffffff,24px 10px 0 #22262e,26px 10px 0 #22262e,28px 10px 0 #0a0a0a,6px 12px 0 #0a0a0a,8px 12px 0 #22262e,10px 12px 0 #22262e,12px 12px 0 #ffffff,14px 12px 0 #ffffff,16px 12px 0 #f8b800,18px 12px 0 #f8b800,20px 12px 0 #ffffff,22px 12px 0 #ffffff,24px 12px 0 #22262e,26px 12px 0 #22262e,28px 12px 0 #0a0a0a,8px 14px 0 #0a0a0a,10px 14px 0 #22262e,12px 14px 0 #22262e,14px 14px 0 #ffffff,16px 14px 0 #ffffff,18px 14px 0 #ffffff,20px 14px 0 #ffffff,22px 14px 0 #22262e,24px 14px 0 #22262e,26px 14px 0 #0a0a0a,10px 16px 0 #0a0a0a,12px 16px 0 #22262e,14px 16px 0 #22262e,16px 16px 0 #ffffff,18px 16px 0 #ffffff,20px 16px 0 #22262e,22px 16px 0 #22262e,24px 16px 0 #0a0a0a,8px 18px 0 #0a0a0a,10px 18px 0 #0a0a0a,12px 18px 0 #d82828,14px 18px 0 #d82828,16px 18px 0 #d82828,18px 18px 0 #d82828,20px 18px 0 #d82828,22px 18px 0 #d82828,24px 18px 0 #0a0a0a,26px 18px 0 #0a0a0a,10px 20px 0 #0a0a0a,12px 20px 0 #22262e,14px 20px 0 #22262e,16px 20px 0 #22262e,18px 20px 0 #22262e,20px 20px 0 #22262e,22px 20px 0 #22262e,24px 20px 0 #0a0a0a,6px 22px 0 #0a0a0a,8px 22px 0 #0a0a0a,10px 22px 0 #22262e,12px 22px 0 #22262e,14px 22px 0 #ffffff,16px 22px 0 #ffffff,18px 22px 0 #ffffff,20px 22px 0 #ffffff,22px 22px 0 #22262e,24px 22px 0 #22262e,26px 22px 0 #0a0a0a,28px 22px 0 #0a0a0a,6px 24px 0 #0a0a0a,8px 24px 0 #0a0a0a,10px 24px 0 #22262e,12px 24px 0 #ffffff,14px 24px 0 #ffffff,16px 24px 0 #ffffff,18px 24px 0 #ffffff,20px 24px 0 #ffffff,22px 24px 0 #ffffff,24px 24px 0 #22262e,26px 24px 0 #0a0a0a,28px 24px 0 #0a0a0a,6px 26px 0 #0a0a0a,8px 26px 0 #0a0a0a,10px 26px 0 #22262e,12px 26px 0 #22262e,14px 26px 0 #ffffff,16px 26px 0 #ffffff,18px 26px 0 #ffffff,20px 26px 0 #ffffff,22px 26px 0 #22262e,24px 26px 0 #22262e,26px 26px 0 #0a0a0a,28px 26px 0 #0a0a0a,10px 28px 0 #0a0a0a,12px 28px 0 #22262e,14px 28px 0 #22262e,16px 28px 0 #ffffff,18px 28px 0 #ffffff,20px 28px 0 #22262e,22px 28px 0 #22262e,24px 28px 0 #0a0a0a,8px 30px 0 #f8b800,10px 30px 0 #f8b800,12px 30px 0 #f8b800,14px 30px 0 #f8b800,18px 30px 0 #f8b800,20px 30px 0 #f8b800,22px 30px 0 #f8b800,24px 30px 0 #f8b800,10px 32px 0 #0a0a0a,12px 32px 0 #0a0a0a,14px 32px 0 #0a0a0a,18px 32px 0 #0a0a0a,20px 32px 0 #0a0a0a,22px 32px 0 #0a0a0a; }
/* 16px 场景（标题栏/托盘）：整幅缩半，省得再抄一遍几千字符 */
.ico-qq-s::before { transform: scale(.5); transform-origin: 0 0; }
.tbqq { background: none; box-shadow: none; }

/* ── IM 面板：蓝色经典皮肤 + 白色列表（沿用 Win98 立体控件语言）──
   取经典「蓝色经典」皮肤：窗口标题栏蓝渐变、好友列表纯白、
   分组栏浅蓝渐变、底部工具栏浅蓝；字体 Tahoma/宋体 12px。
   结构与真实一致：个人区 → 搜索框 → 分组 Tab → 好友列表（分组可折叠）
   → 底部工具栏。群聊在独立的 Tab 里。 */
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
/* 分组 Tab：好友 / 群聊 / 最近联系人 */
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
/* 菜单弹出层（主菜单：音效 / 建群 / 资料 / 刷新 / 退出） */
.qq-menu {
  position: absolute; z-index: 60; min-width: 150px; padding: 2px;
  background: #fff; border: 1px solid #8fa8bd; box-shadow: 2px 2px 0 rgba(0, 0, 0, .18);
  font: 12px/1.7 Tahoma, "宋体", sans-serif; color: #10314c;
}
.qq-menu-row { display: flex; align-items: center; gap: 6px; padding: 1px 8px; white-space: nowrap; }
.qq-menu-row:hover { background: #d8ebfb; }
.qq-menu-sep { height: 1px; margin: 3px 2px; background: #dde6ee; }
.qq-menu-lab { font-size: 10px; color: #7b8fa3; padding: 1px 8px; }

/* ── 聊天窗口：左消息区 + 右资料栏 ──
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
/* 号段说明：这些号码一律是 0100000X 保留段（真实 QQ 号首位永不为 0），
   不会与任何真人号码冲突；这里明说，免得被误当成真实 QQ 号 */
.qq-ch-snote { color: #a9b6c2; font-size: 9px; }
/* 消息行：真实 QQ 格式 —— 「昵称 时间」一行，消息内容另起一行 */
.qq-row { margin: 0 0 8px; }
.qq-bhead { font-size: 11px; line-height: 1.5; }
.qq-bwho { font-weight: bold; color: #12518a; }
.qq-btime { margin-left: 6px; font-size: 10px; color: #9aa7b3; }
/* 删除自己消息的小按钮：沿用 Win95 按钮，只在有权限时出现 */
.qq-del { float: right; margin-left: 4px; font-size: 10px; padding: 0 4px; min-height: 16px; line-height: 14px; }
/* 新建群的内联输入框：复用查找栏的 flex 行 */
.qq-search .qq-inp { flex: 1; min-width: 0; }
.qq-search .btn95 { flex: none; margin-left: 4px; }
/* 群资料栏里的可邀请在线用户 */
.qq-ch-side .qq-f { padding: 2px 4px; cursor: pointer; }
.qq-ch-side .qq-f:hover { background: #e8f0ff; }
.qq-btxt { font-size: 12px; line-height: 1.65; color: #000; word-break: break-word; white-space: pre-wrap; }
.qq-sep { text-align: center; font-size: 10px; color: #93a3b2; margin: 4px 0 8px; }
.qq-sys { text-align: center; font-size: 11px; color: #8a6d1f; margin: 2px 0 6px; }
.qq-typing { display: flex; align-items: center; gap: 4px; padding: 2px 12px 4px; font-size: 11px; color: #7b8fa3; }
.qq-tdot { width: 4px; height: 4px; background: #7b8fa3; border-radius: 50%; animation: qqdot 1.1s ease-in-out infinite; }
.qq-tdot:nth-child(2) { animation-delay: .18s; }
.qq-tdot:nth-child(3) { animation-delay: .36s; }
@keyframes qqdot { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
/* 工具栏：字体 / 表情（不放任何播放控制） */
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
/* 表情按钮：黄色像素笑脸（与扫雷笑脸同一套画法）。
   原先直接用 Unicode「☺」—— 各系统字形不同（Windows 用 Segoe UI Symbol、
   Linux 用别的），缩到 16px 又糊成一团，与全站像素图标体系对不上。 */
.qq-facebtn { position: relative; }
.qq-facebtn::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 4px;
  width: 2px;
  height: 2px;
  box-shadow:
    2px 0px 0 #d89400, 4px 0px 0 #d89400, 6px 0px 0 #d89400, 8px 0px 0 #d89400,
    0px 2px 0 #d89400, 2px 2px 0 #ffe066, 4px 2px 0 #ffe066, 6px 2px 0 #ffe066, 8px 2px 0 #ffe066, 10px 2px 0 #d89400,
    0px 4px 0 #d89400, 2px 4px 0 #ffe066, 4px 4px 0 #000, 6px 4px 0 #ffe066, 8px 4px 0 #000, 10px 4px 0 #d89400,
    0px 6px 0 #d89400, 2px 6px 0 #ffe066, 4px 6px 0 #ffe066, 6px 6px 0 #ffe066, 8px 6px 0 #ffe066, 10px 6px 0 #d89400,
    0px 8px 0 #d89400, 2px 8px 0 #ffe066, 4px 8px 0 #000, 6px 8px 0 #000, 8px 8px 0 #ffe066, 10px 8px 0 #d89400,
    2px 10px 0 #d89400, 4px 10px 0 #d89400, 6px 10px 0 #d89400, 8px 10px 0 #d89400;
}
.qq-tool-sep { width: 1px; height: 14px; margin: 0 3px; background: #cfdde9; }
.qq-ch-tools .spacer { flex: 1; }
/* 输入区：多行文本框 */
.qq-ch-input { padding: 3px 6px 4px; background: #fff; }
.qq-in {
  display: block; width: 100%; height: 54px; resize: none;
  font: 12px/1.6 Tahoma, "宋体", SimSun, sans-serif; color: #000;
  padding: 3px 5px; background: #fff; border: 1px solid #a8c4dc; box-shadow: none;
}
.qq-in:focus { outline: none; border-color: #2b81c2; }
/* 底部：发送(S) / 关闭(C) */
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

/* 菜单里的内联输入框（改昵称 / 建群名） */
.qq-inp {
  flex: 1; min-width: 0; font: 11px Tahoma, "宋体", sans-serif; color: #10314c;
  padding: 1px 3px; background: #fff; border: 1px solid #86aecd; min-height: 20px;
}
.qq-inp:focus { outline: none; }
.qq-mini { font: 11px Tahoma, "宋体", sans-serif; padding: 1px 8px; min-height: 20px; }

/* 视觉降噪：滚动条一律不显示（滚轮 / 触屏照常可滚），
   聊天窗不放开下角缩放手柄 —— 它本就不可拖拽缩放，
   那块斜纹把手看着就像装饰假功能。主面板与其他窗口的手柄不受影响。 */
.qq-list, .qq-ch-log, .qq-ch-side { scrollbar-width: none; }
.qq-list::-webkit-scrollbar, .qq-list::-webkit-scrollbar-button,
.qq-ch-log::-webkit-scrollbar, .qq-ch-log::-webkit-scrollbar-button,
.qq-ch-side::-webkit-scrollbar, .qq-ch-side::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
.qqchatwin .reshandle { display: none; }

/* 头像像素画：JS 现场生成 SVG data URI（img-src data: 在 CSP 白名单内），
   <img> 撑满容器，pixelated 保证像素感；容器多大画就多大 */
.qq-avimg {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  display: block; image-rendering: pixelated;
}

/* ── 托盘：QQ 启动后驻留，有未读时闪动 ── */
#trayIcons { display: flex; align-items: center; gap: 4px; }
.trayico { position: relative; width: 16px; height: 16px; cursor: default; }
/* 音量控件：右下角托盘区，仿 Win98 系统音量小喇叭 */
.volbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; margin: 0 1px;
  background: var(--face); box-shadow: var(--btn-face);
  border: 1px solid; border-color: var(--hi) var(--sh) var(--sh) var(--hi);
  cursor: default; color: #222;
}
.volbtn:active { box-shadow: var(--btn-face-a); border-color: var(--sh) var(--hi) var(--hi) var(--sh); }
.volbtn svg { display: block; width: 14px; height: 14px; }
.vol-pop {
  position: fixed; right: 4px; bottom: var(--tb-h); z-index: 900;
  width: 78px; padding: 9px 8px 8px; text-align: center;
  background: var(--face); box-shadow: var(--raise); border: 1px solid;
  border-color: var(--hi) var(--sh) var(--sh) var(--hi);
}
.vol-pop[hidden] { display: none; }
.vol-pop-t { font: 11px Tahoma, "宋体", sans-serif; color: #222; margin-bottom: 6px; }
/* 竖向滑块（Win98 音量推子）：用 appearance 重绘成细推子 */
.vol-range {
  -webkit-appearance: none; appearance: none;
  writing-mode: vertical-lr; direction: rtl;
  width: 6px; height: 96px; margin: 0 auto; background: transparent; cursor: pointer;
}
.vol-range::-webkit-slider-runnable-track { width: 4px; background: var(--win); box-shadow: var(--sink); }
.vol-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 18px; height: 9px; margin-left: -7px;
  background: linear-gradient(#fdfdfd, #c3c3c3);
  border: 1px solid; border-color: var(--hi) var(--sh) var(--sh) var(--hi);
  box-shadow: 1px 1px 0 #808080;
}
.vol-range::-moz-range-track { width: 4px; background: var(--win); box-shadow: var(--sink); }
.vol-range::-moz-range-thumb {
  width: 18px; height: 9px; border-radius: 0;
  background: linear-gradient(#fdfdfd, #c3c3c3);
  border: 1px solid; border-color: var(--hi) var(--sh) var(--sh) var(--hi);
}
.vol-pct { font: 11px Tahoma, "宋体", sans-serif; color: #222; margin-top: 6px; }
.vol-mute { display: flex; align-items: center; justify-content: center; gap: 4px; font: 11px Tahoma, "宋体", sans-serif; color: #222; margin-top: 7px; cursor: default; }
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
  :root { --cell: 32px; --tb-h: 40px; }
  .mine-smiley { width: 34px; height: 34px; }
  .mine-foot .btn95 { min-height: 34px; padding: 5px 14px; font-size: 12px; }
  /* 任务栏按钮与托盘音量钮：手机上 22px 高点不准，统一撑到 34px
     （与窗口控制钮同一套规格）；任务栏随之由 28px 提到 40px 容纳 */
  .taskbtn { min-height: 34px; padding: 0 10px; }
  .volbtn { width: 34px; height: 34px; }
  .volbtn svg { width: 18px; height: 18px; }
  /* 开始按钮同规格：任务栏里所有可点元素一样高，视觉与手感才统一 */
  .startbtn { height: 34px; }
  /* 触屏下窗口控制钮要够大：与内层文件服务页的 .tb-btn 同一套尺寸（38×34），
     否则外壳 16×14 的小钮在手机上难点中 —— 两处按钮视觉规格必须一致。
     图标要跟着一起放大：按钮放大而图标不变，就成了「大灰方块里一个几乎看不见的墨点」。 */
  .wbtn, .wclose { width: 38px; height: 34px; }
  .wbtn::after { width: 18px; height: 18px; }
  /* 关闭钮图标与最小化/最大化同为 18px：一个标题栏不允许两种图标规格 */
  .wclose::after { width: 18px; height: 18px; }
  /* 标题栏高度与内层文件页的 .titlebar（min-height:44px）对齐：
     同一个系统里两代窗口的标题栏必须一样高 */
  .titlebar { min-height: 44px; }
  /* 菜单项：手机上 21px 高的文字条很难点，撑到 40px */
  .menubar { gap: 4px; padding: 4px 6px; }
  .menubar .mu { padding: 8px 12px; min-height: 40px; display: flex; align-items: center; }
  /* 开始按钮：视觉保持 98 的 24px 高，用 ::after 把触摸热区扩到 44px */
  .startbtn { position: relative; }
  .startbtn::after {
    content: ''; position: absolute; left: 0; right: 0; top: 50%;
    width: 100%; height: 44px; transform: translateY(-50%);
  }
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
  /* 桌面端窗口靠 transform:translate(-50%,-50%) 做居中。
     移动端改成 left:0;right:0 铺满宽后，这个 translate 会把整窗往左上各挪一半 ——
     表现是标题栏左边被切掉、窗口位置偏上。必须清掉。
     注意：拖拽 JS 也会写 inline transform，所以这里要用 !important 压住它，
     否则拖动过的窗口在手机上会被「拽回去」。 */
  .appwin, #pcWin, #ieWin, #dosWin, #readmeWin, #mineWin, #gameWin, #qqWin, #qqChatWin {
    transform: none !important;
  }
  /* 移动端窗口初始位置：贴顶部而不是 42% 居中。
     居中意味着窗口一开始就在屏幕中下部，往上拖的空间被压缩 ——
     拖拽手感是「怎么拖都上不去」。贴顶则能自由拖到任何位置。
     这里不用 !important：拖拽 JS 写的 inline top 必须能覆盖它，
     否则窗口拖不动了。 */
  .appwin, #pcWin, #ieWin, #dosWin, #readmeWin, #mineWin, #gameWin, #qqWin, #qqChatWin {
    top: 8px;
  }
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

/* ═════════════ 回收站窗口（列表 / 全选 / 还原 / 彻底删除）═════════════ */
.rbwin { width: min(94vw, 600px); }
.rb-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; }
.rb-all { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; white-space: nowrap; }
.rb-count { font-size: 11px; color: #404040; margin-right: auto; white-space: nowrap; }
.rb-btn { min-width: 0; padding: 4px 9px; font-size: 11.5px; }
.rb-btn:disabled { color: #808080; text-shadow: 1px 1px 0 #fff; }
.rb-all input[type=checkbox], .rb-ck {
  -webkit-appearance: none; appearance: none;
  width: 18px; height: 18px; flex: none; margin: 0; padding: 0;
  background: #fff; border: 0; border-radius: 0; cursor: pointer; position: relative;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #808080,
              inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a;
}
.rb-all input:checked::after, .rb-ck:checked::after {
  content: ''; position: absolute; left: 5px; top: 1px; width: 5px; height: 10px;
  border: solid #000; border-width: 0 2px 2px 0; transform: rotate(42deg);
}
.rb-all input:indeterminate::after {
  content: ''; position: absolute; left: 3px; top: 7px; width: 12px; height: 3px; background: #000;
}
.rb-head, .rb-row {
  display: grid; grid-template-columns: 26px minmax(0,1fr) 84px 128px;
  gap: 6px; align-items: center;
}
.rb-head { padding: 3px 8px; font-size: 11px; }
.rb-head > span {
  padding: 2px 5px; background: #c0c0c0; white-space: nowrap;
  box-shadow: inset -1px -1px #808080, inset 1px 1px #fff;
  overflow: hidden; text-overflow: ellipsis;
}
/* 复选框列的表头留空，不画一个没有意义的按钮条 */
.rb-head > .rb-h-chk { background: transparent; box-shadow: none; }
.rb-list {
  margin: 0 8px; background: #fff; overflow: auto;
  min-height: 120px; max-height: min(46vh, 340px);
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
}
.rb-row { padding: 3px 8px; font-size: 11.5px; min-height: 28px; }
.rb-row:hover { background: #e8eefb; }
.rb-c { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 像素图标原本是 32×32 的 box-shadow 字符画：transform 只缩放视觉、不改布局占位，
   所以必须用一个固定 18×18 的容器裁切，否则文字会挤到图标上。 */
.rb-icow { width: 18px; height: 18px; flex: none; overflow: hidden; position: relative; }
.rb-icow .ico { transform: scale(.56); transform-origin: 0 0; margin: 0; }
.rb-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-empty {
  margin: 0 8px; padding: 18px; background: #fff; text-align: center;
  font-size: 12px; color: #606060;
  box-shadow: inset -1px -1px #fff, inset 1px 1px #0a0a0a,
              inset -2px -2px #dfdfdf, inset 2px 2px #808080;
}
@media (max-width: 480px) {
  .rb-head, .rb-row { grid-template-columns: 22px minmax(0,1fr) 58px 98px; gap: 4px; }
  .rb-bar { gap: 5px; }
  .rb-btn { padding: 4px 7px; font-size: 11px; }
}
`;

const HOME_JS = `(function () {
'use strict';

/* ── 平台分享凭证透传（与分享页同一套）─────────────────────────
   App 预览面板 / webview 会拦掉网关的第三方 Cookie，首页 HTML 能开但
   /home.js、/api/boot、窗口里的 iframe 全部 403。从 <meta> 读凭证，
   在 URL 拼接完成后统一挂上去（注意别在 guestUrl 上先加，否则 ?embed=1
   会撞成双问号）。无凭证时 withSC 原样返回，桌面本地运行完全不受影响。 */
var SC = (function () {
  var m = document.querySelector('meta[name="7md-sc"]');
  if (m) return (m.getAttribute('content') || '').replace(/[^A-Za-z0-9_-]/g, '');
  var q = /[?&]sharecode=([A-Za-z0-9_-]+)/.exec(location.search);
  return q ? q[1] : '';
})();
function withSC(u) {
  if (!SC || typeof u !== 'string') return u;
  if (/[?&]sharecode=/.test(u)) return u;
  if (/^(data|blob|javascript|about|mailto|https?:)/i.test(u) || u.charAt(0) === '#') return u;
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + SC;
}
if (SC) {
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') input = withSC(input);
    return _fetch.call(window, input, init);
  };
}
/* iframe 的 src 不走 fetch，必须单独包一层；统一劫持 setAttribute 的 src，
   覆盖 fmFrame / ieFrame / 克隆窗口 / 刷新重设等所有赋值点，避免逐个漏改。 */
var _setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (name === 'src' && typeof value === 'string') value = withSC(value);
  return _setAttr.call(this, name, value);
};

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
  /* 任务栏时钟恒为真实时间 */
  var d = new Date();
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
  var shortName = (t ? t.textContent : '窗口').split(' - ')[0];
  /* Win98 任务栏按钮 = 窗口小图标 + 短标题；图标克隆自标题栏，保证两处同形 */
  var icon = win.querySelector('.titlebar .tb-icon');
  if (icon) {
    var ic = icon.cloneNode(true);
    ic.classList.add('tbi');
    btn.appendChild(ic);
    var lb = document.createElement('span');
    lb.className = 'tb-label';
    lb.textContent = shortName;
    btn.appendChild(lb);
  } else {
    btn.textContent = shortName;
  }
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
  /* IE 窗口一打开就该有收藏夹栏（真 IE 的 Favorites Bar 常驻），
     挂在这里而不是只挂在 ieOpen 里：任何路径打开 IE 都一样 */
  if (win.querySelector && win.querySelector('.ie-favbar')) {
    if (!win._favDone) { win._favDone = true; ieRenderFavBar(win); }
  }
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
  /* .appwin 的 top 是 translate(-50%,-50%) 的锚点而非窗口顶边：
     直接设 top=4px 会让窗口半边悬到视口上方，标题栏反而被裁掉。
     要让顶边落在 4px，锚点必须下移半个窗高。 */
  if (r.top < 0) win.style.top = (win.offsetHeight / 2 + 4) + 'px';
}
function closeWin(win) {
  if (!win) return;
  win.hidden = true;
  if (win._taskBtn) { win._taskBtn.remove(); win._taskBtn = null; }
  if (win.id === 'gameWin' && game.state === 'run') game.pause();
  /* 扫雷同理：窗口藏起来但计时器还在跑，回来发现时间凭空多出几分钟 */
  if (win.id === 'mineWin' && typeof mines !== 'undefined' && mines) mines.stop();
  /* IM 会话关窗钩子：真实聊天持续收消息，此接口为空操作 */
  if (win.id === 'qqChatWin' && window.QQ) window.QQ.stopPlay();
  setActiveTop();
}

/* 标题栏拖动（鼠标 + 触屏 pointer events） */
/* 标题栏拖动（鼠标 + 触屏 pointer events）
   用事件委托而非逐个 addEventListener：克隆出来的窗口（如新建的 IE 窗口）
   会自动获得同样的拖拽能力，不用再补一遍绑定。 */
document.addEventListener('pointerdown', function (e) {
  var bar = near(e.target, '[data-drag]');
  if (!bar || near(e.target, 'button')) return;
  var win = bar.closest('.win95');
  if (!win) return;
  bringTop(win);
  var rect = win.getBoundingClientRect();
  var ox = e.clientX - rect.left;
  var oy = e.clientY - rect.top;
  win.style.transform = 'none';
  /* 手机上页面本身可滚动：clientX/Y 是视口坐标，而窗口的 left/top 相对文档，
     必须把抓取时的滚动量补回去，否则滚动后拖拽会错位（桌面端滚动量为 0，不受影响） */
  var sx0 = window.scrollX, sy0 = window.scrollY;
  function mv(ev) {
    /* 桌面端允许窗口拖出屏幕（真 98 就是这样，只留 40px 在屏内方便拖回）；
       手机上窗口本身占 96vw，拖出去的右半截(状态栏/关闭钮)就永远够不着 ——
       窄屏下两端都锁在屏内，窗口任何时刻都完整可见。 */
    var minX = 40 - rect.width, maxX = sx0 + document.documentElement.clientWidth - 40;
    if (document.documentElement.clientWidth <= 640) {
      minX = sx0;
      maxX = sx0 + document.documentElement.clientWidth - rect.width;
    }
    var x = Math.min(Math.max(ev.clientX - ox + sx0, minX), maxX);
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

/* 关闭按钮（同样用委托，克隆窗口的 × 也能关） */
document.addEventListener('click', function (e) {
  var b = near(e.target, '[data-close]');
  if (!b) return;
  closeWin(b.closest('.win95'));
});

/* 全屏(embed-fs)浮动退出按钮：标题栏已隐藏，给一个始终可见的退出入口。
   点击时驱动 iframe 内的预览真正退出全屏（闭环一致、避免状态分裂），
   外壳同时移除 embed-fs（幂等，iframe 退出后会再回传 off）。 */
document.addEventListener('click', function (e) {
  var b = near(e.target, '.fs-exit');
  if (!b) return;
  var host = b.closest('.win95');
  var fw = host && host.querySelector('iframe');
  if (fw && fw.contentWindow) {
    try { fw.contentWindow.postMessage({ type: '7md:request-exit-fs' }, '*'); } catch (e2) {}
  }
  if (host) host.classList.remove('embed-fs');
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
  /* 按钮的 aria-label/title 必须跟着状态走，否则读屏永远念「最大化」；
     图标同理：最大化后切到还原图标（.wbtn.rest 覆盖 .wbtn.max 的图形） */
  var mb = win.querySelector('.wbtn.max');
  if (mb) {
    var maxed = win.classList.contains('maxed');
    mb.classList.toggle('rest', maxed);
    mb.setAttribute('aria-label', maxed ? '还原' : '最大化');
    mb.title = maxed ? '还原' : '最大化';
  }
  /* 扫雷最大化时格子同步放大（铺满大屏而不是原尺寸缩在角落） */
  if (win.id === 'mineWin') mines.fitCell(win.classList.contains('maxed'));
}
/* 窗口装饰（最小化/最大化/缩放手柄/双击标题栏）：
   抽成函数是为了让「新建 IE 窗口」克隆出的窗口也能拿到同一套装饰，
   否则克隆体只有个空壳标题栏 —— 假窗口。 */
function decorateWin(win) {
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
}
document.querySelectorAll('.win95.appwin, .win95.narrowwin').forEach(function (win) {
  decorateWin(win);
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
  $('fmWho').textContent = admin && adminBase ? '管理员' : '访客';
  /* 措辞与内页文件服务页的状态栏一致（分享模式 / 管理模式），
     同一屏出现两套叫法会让人以为是两种权限。
     状态栏只有一格给权限，完整说明放 title 与「链接与权限」弹窗里。 */
  var fmSt = $('fmStatus');
  fmSt.textContent = admin && adminBase ? '管理模式 · 全部可管' : '分享模式 · 仅管理本人文件';
  fmSt.title = admin && adminBase ? '管理权限：可管理所有人的文件（改时长 / 续期 / 删除）· 点此查看链接与权限' : '访客权限：可查看、上传；只有你和管理员能改 / 续 / 删你传的文件 · 点此查看链接与权限';
  /* 底部分享模式标签可点击：内页在嵌入模式下标题栏与状态栏都被隐藏，
     「链接与权限」(Agent 入口) 的两个入口随之消失。这里把外壳状态栏的
     权限格做成入口，点击转发给内页打开对话框，恢复「点底部分享进 Agent」体验。 */
  if (!fmSt.dataset.bound) {
    fmSt.dataset.bound = '1';
    fmSt.classList.add('clickable');
    fmSt.addEventListener('click', function () {
      var f = $('fmFrame');
      if (f && f.contentWindow) {
        try { f.contentWindow.postMessage({ type: '7md:open-info' }, '*'); } catch (e) {}
      }
    });
  }
  openWin(w);
  /* 兜底：iframe 的 load 事件在某些浏览器上对同源 embed 页不触发，
     3 秒后无论如何都收起遮罩，避免用户看到永恒的"正在打开"。 */
  setTimeout(function () { $('fmLoading').classList.add('done'); }, 3000);
}
$('fmFrame').addEventListener('load', function () {
  fmLoaded = true;
  $('fmLoading').classList.add('done');
});

/* ═════════════ IE 浏览器（项目内置的沉浸式浏览器）═════════════
   与「我的电脑」刻意分工：我的电脑 = 文件管理器（直达文件页）；
   IE = 浏览器（先到 98 风格 Internet 主页，地址栏可输入）。

   核心约束（用户明确要求）：帮助、网址链接一律不许跳出到外部浏览器，
   全部在项目内沉浸式完成。做法：
     · 外站一律经服务端 /ie-proxy 抓回来渲染（外站普遍带
       X-Frame-Options: DENY，直接 iframe 必然白屏）；
     · iframe 加 sandbox，被代理页面处于不透明源，读不到本项目数据；
     · 页面里的链接由注入的桥接脚本 postMessage 交回这里统一导航，
       于是「点链接」也永远在本项目内，不会开出系统浏览器。 */
var IE_HOME_URL = 'https://w3b.pub/';
var ieStarted = false;
/* 主页 HTML 由服务端 /ie-home 端点下发（IE_HOME_HTML 常量在服务端区）。
   不能用 srcdoc：srcdoc 文档继承父页严格 CSP（style-src 'self'），
   内联 <style> 与 <a onclick> 会被整个拦掉，页面退化成浏览器默认样式。 */

function ieShowLoading(win) {
  var ld = win ? win.querySelector('.ie-loading-el') : $('ieLoading');
  if (!ld) return;
  ld.classList.remove('done');
  setTimeout(function () { ld.classList.add('done'); }, 2500);
}
/* 把地址栏显示的「人话网址」与 iframe 实际要加载的 src 分开：
   外站显示原网址、实际加载本地代理地址，这样用户看到的仍是真实 URL。 */
function ieProxySrc(url) { return '/ie-proxy?u=' + encodeURIComponent(url); }
function ieDisplayUrl(url) {
  if (url.charAt(0) === '/') return location.protocol + '//' + location.host + url;
  return url;
}
/* 主页链接回调：path 为空 = 去文件服务 */
window.__ieNav = function (path) {
  var url;
  if (!path) url = BOOT.guestUrl + '?embed=1';
  else if (path.indexOf('/s/') === 0 && path.indexOf('embed') < 0) url = path + '?embed=1';
  else url = path;
  ieNavTo($('ieWin'), url);
};
function ieOpen() {
  var f = $('ieFrame');
  if (!ieStarted) {
    ieStarted = true;
    f.setAttribute('src', '/ie-home');
    $('ieAddr').value = IE_HOME_URL;
  }
  /* 收藏夹栏由 openWin 统一渲染（任何路径打开都有） */
  openWin($('ieWin'));
}
/* IE 的交互一律用事件委托：克隆出的窗口（新建 IE 窗口）自动继承行为，
   不必再逐个补绑定 —— 否则第二个窗口会是个点不动的空壳。 */
document.addEventListener('click', function (e) {
  var win = near(e.target, '#ieWin, .ie-clone');
  if (!win) return;
  if (near(e.target, '.ie-back-el')) {
    try { win.querySelector('.ie-frame-el').contentWindow.history.back(); } catch (err) { /* 跨域忽略 */ }
  } else if (near(e.target, '.ie-fwd-el')) {
    try { win.querySelector('.ie-frame-el').contentWindow.history.forward(); } catch (err) { /* 跨域忽略 */ }
  } else if (near(e.target, '.ie-refresh-el')) {
    var f = win.querySelector('.ie-frame-el');
    if (!f) return;
    if (!f.getAttribute('src')) { ieNavTo(win, ''); return; }
    try { f.contentWindow.location.reload(); } catch (err) { /* 跨域忽略 */ }
  } else if (near(e.target, '.ie-home-el')) {
    ieNavTo(win, '');
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var addr = near(e.target, '.ie-addr-el');
  if (!addr) return;
  var win = near(e.target, '#ieWin, .ie-clone');
  if (!win) return;
  var v = (addr.value || '').trim();
  if (!v || v === IE_HOME_URL) { ieNavTo(win, ''); return; }
  /* 地址解析与「运行」框共用一套（域名简写自动补 https://） */
  var a = parseAddr(v);
  if (!a) {
    msgbox('Internet Explorer', '无法识别的地址。\\n\\n支持：\\n· 完整网址 https://example.com\\n· 域名简写 example.com（自动补 https://）\\n· 10 位文件口令\\n· /s/口令/ 链接', 'err');
    return;
  }
  ieNavTo(win, a.url);
});
/* 桥接脚本的回报：被代理页面要跳转时把目标交回来，统一在本项目内导航 */
window.addEventListener('message', function (e) {
  var d = e.data;
  if (!d) return;
  /* 分享页（嵌在「我的电脑」窗口里的文件服务）请求打开外链：
     交由项目内置的 IE 处理，不跳出到系统浏览器 */
  if (d.type === '7md:open-ie') {
    ieOpen();
    ieNavTo($('ieWin'), d.url || 'https://w3b.pub/');
    return;
  }
  /* 内嵌文件服务页请求「铺满全屏」：
     iframe 内的全屏只能铺满 iframe 自己（手机上只有半屏宽），
     必须由外层把「我的电脑」窗口也一起铺开，内外同步才是真全屏。 */
  if (d.type === '7md:embed-fullscreen') {
    var fw = $('fmFrame');
    var host = fw ? fw.closest('.win95') : null;
    if (!host) return;
    if (d.on) {
      host.classList.add('embed-fs');
      /* 桌面端窗口不够大时铺满；移动端窗口本就铺满宽，再调 maxWin 反而
         会套上 .maxed 的 height:calc(100dvh - 任务栏)，把高度压回去。 */
      if (window.innerWidth > 640 && !host.classList.contains('maxed')) maxWin(host);
    } else {
      host.classList.remove('embed-fs');
      if (host.classList.contains('maxed')) maxWin(host);   /* 还原 */
    }
    return;
  }
  /* 内嵌文件服务页把它的状态栏内容交上来（内页那条已隐藏）：
     一个窗口只留一条状态栏，权限 / 限制 / 容量挤在同一行里。 */
  if (d.type === '7md:status') {
    var fi = $('fmInfo');
    if (fi) {
      var parts = [d.limit, d.quota].filter(Boolean);
      fi.textContent = parts.join(' · ');
      fi.title = parts.join(' · ');   /* 窄屏放不下时，悬停/长按可看全量 */
    }
    return;
  }
  /* 内嵌文件服务页（embed）内容真正就绪后，请外层收起"正在打开"遮罩。
     比 iframe 的 load 事件可靠：load 在 app.js 下载完就触发，内容还靠 fetch 异步
     渲染；且动态设 iframe.src 时 load 偶发漏触发，会让遮罩卡 3 秒兜底。
     这里用 drop-ready 让遮罩与内容对齐，消除开窗口时的卡顿/白屏闪。 */
  if (d.type === '7md:drop-ready') {
    var fl = $('fmLoading');
    if (fl) fl.classList.add('done');
    return;
  }
  if (d.__7md !== 1) return;
  /* 只认本项目自己开的 IE 窗口（按 source 判定，不看 origin：
     被代理页面处于不透明源，origin 恒为 null，无法据此区分来源） */
  var win = null;
  document.querySelectorAll('#ieWin, .ie-clone').forEach(function (w) {
    var f = w.querySelector('.ie-frame-el');
    if (f && f.contentWindow === e.source) win = w;
  });
  if (!win) return;
  if (d.type === 'nav') {
    if (!d.url) { ieNavTo(win, ''); return; }
    /* 外站页面里的 target=_blank / window.open：
       不开系统浏览器，而是在项目内开一个新的 IE 窗口 */
    if (d.blank) { ieNewWindow(d.url); return; }
    ieNavTo(win, d.url);
  } else if (d.type === 'info') {
    var ad = win.querySelector('.ie-addr-el');
    if (ad && d.url) ad.value = d.url;
    var ti = win.querySelector('.ie-title-el');
    var st = win.querySelector('.ie-status-el');
    if (d.title) {
      if (ti) ti.textContent = d.title + ' - Internet Explorer';
      if (st) st.textContent = d.title;
    }
  } else if (d.type === 'note') {
    msgbox('Internet Explorer', d.msg || '该操作无法在应用内完成。', 'info');
  }
});
/* 「查看源代码」：在项目内的源码窗里看，不跳外部浏览器 */
function ieShowSource(url) {
  var target = url && url.charAt(0) === '/' ? url : ieProxySrc(url) + '&raw=1';
  $('ieSrcTitle').textContent = '源代码 - Internet Explorer';
  /* 代理抓取要几秒，这段时间必须有明确状态，不能干晾着 */
  $('ieSrcBody').textContent = '正在读取 ' + (url || '') + ' 的源代码…\\n\\n（外站内容由本站服务端代取，可能需要几秒）';
  openWin($('ieSrcWin'));
  fetch(target, { cache: 'no-store' })
    .then(function (r) { return r.text(); })
    .then(function (t) {
      if (!t) { $('ieSrcBody').textContent = '(空文档)'; return; }
      $('ieSrcBody').textContent = t;
    })
    .catch(function () {
      $('ieSrcBody').textContent = '无法读取该地址的源代码。\\n\\n可能是网络超时，或该地址不允许被代理。';
    });
}

/* ── 收藏夹栏（真 IE 的 Favorites Bar）──
   默认收录几个常用站点；「+」按钮把当前网址加入收藏（真·持久化）。
   点任何一项都在本浏览器内打开 —— 不跳系统浏览器。
   命名与「开始菜单 → 收藏夹」完全一致：同一份收藏，两个入口同名，
   否则用户在两处看到「知行工作室」和「知行工作室 · 主页」会以为是两个站点。 */
var IE_FAV_DEFAULT = [
  { name: '知行工作室', url: 'https://w3b.pub/' },
  { name: '开源仓库', url: 'https://github.com/x2it/7M-Drop' },
  { name: '7喵快传', url: '' }
];
function ieFavKey() { return 'ieFavBar'; }
function ieFavList() {
  var raw = null;
  try { raw = localStorage.getItem(ieFavKey()); } catch (e) { raw = null; }
  var list = [];
  if (raw) {
    try {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          if (it && typeof it.url === 'string' && it.url) list.push({ name: String(it.name || it.url), url: it.url });
        }
      }
    } catch (e) { /* 存档坏了就当没有，不装作成功 */ }
  }
  if (!list.length) {
    for (var j = 0; j < IE_FAV_DEFAULT.length; j++) list.push({ name: IE_FAV_DEFAULT[j].name, url: IE_FAV_DEFAULT[j].url });
  }
  return list;
}
function ieFavSave(list) {
  try { localStorage.setItem(ieFavKey(), JSON.stringify(list)); } catch (e) { /* 无存储权限则不持久化 */ }
}
/* 渲染某个 IE 窗口的收藏栏 */
function ieRenderFavBar(win) {
  var bar = win.querySelector('.ie-favbar');
  if (!bar) return;
  var list = ieFavList();
  bar.innerHTML = '';
  list.forEach(function (it, idx) {
    var b = document.createElement('button');
    b.className = 'ie-fav';
    b.type = 'button';
    b.title = it.url || 'IE 起始页';
    var ico = document.createElement('span');
    ico.className = 'ie-fav-ico';
    b.appendChild(ico);
    var t = document.createElement('span');
    t.textContent = it.name;
    b.appendChild(t);
    b.addEventListener('click', function () {
      /* 空 url = 起始页；其余在本浏览器内打开 */
      ieNavTo(win, it.url || '');
    });
    b.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      /* 右键：移除该收藏（真 IE 也是这样） */
      var cur = ieFavList();
      cur.splice(idx, 1);
      ieFavSave(cur);
      ieRenderFavBar(win);
    });
    bar.appendChild(b);
  });
  var add = document.createElement('button');
  add.className = 'ie-fav-add';
  add.type = 'button';
  add.title = '将当前网址加入收藏';
  add.setAttribute('aria-label', '将当前网址加入收藏');
  add.textContent = '+';
  add.addEventListener('click', function () {
    var addr = win.querySelector('.ie-addr-el');
    var url = addr ? (addr.value || '').trim() : '';
    if (!url || url === IE_HOME_URL) {
      msgbox('Internet Explorer', '请先在地址栏输入要收藏的网址。', 'info');
      return;
    }
    if (url.charAt(0) === '/') {
      msgbox('Internet Explorer', '本站地址无需收藏。', 'info');
      return;
    }
    var cur = ieFavList();
    var exists = false;
    for (var i = 0; i < cur.length; i++) if (cur[i].url === url) { exists = true; break; }
    if (exists) { msgbox('Internet Explorer', '该网址已在收藏夹中。', 'info'); return; }
    /* 名称取域名（真实浏览器也这么干） */
    var nm = url.replace(/^https?:\\/\\//i, '').split('/')[0] || url;
    cur.push({ name: nm, url: url });
    ieFavSave(cur);
    ieRenderFavBar(win);
  });
  bar.appendChild(add);
}

/* ── 多窗口 IE：Win98 的 IE 本就支持多窗口，「新窗口打开」在项目内实现 ──
   做法：克隆 ieWin 模板 → 换成独立 id → 事件全部走委托，克隆即自动继承行为。
   这样第二个浏览器窗口依然完全在本项目内，绝不开系统浏览器。 */
var ieWinSeq = 0;
function ieNewWindow(url) {
  var tpl = $('ieWin');
  if (!tpl) return;
  var n = ++ieWinSeq;
  var w = tpl.cloneNode(true);
  var suffix = n === 1 ? '' : String(n);
  /* id 重排：克隆体里的 id 必须唯一，否则 getElementById 会拿到旧窗口的元素 */
  var map = {
    ieWin: 'ieWin' + suffix, ieTitle: 'ieTitle' + suffix, ieBack: 'ieBack' + suffix,
    ieFwd: 'ieFwd' + suffix, ieRefresh: 'ieRefresh' + suffix, ieHome: 'ieHome' + suffix,
    ieAddr: 'ieAddr' + suffix, ieLoading: 'ieLoading' + suffix, ieFrame: 'ieFrame' + suffix,
    ieStatus: 'ieStatus' + suffix
  };
  Object.keys(map).forEach(function (old) {
    var el = w.querySelector('#' + old);
    if (el) el.id = map[old];
  });
  w.hidden = false;
  w.removeAttribute('id');
  w.classList.add('ie-clone');
  /* 让新窗口错开一点，两个窗口不叠在一起（真 IE 也不完全重合） */
  w.style.left = (50 + n * 4) + '%';
  w.style.top = (42 + n * 3) + '%';
  $('desk').appendChild(w);
  /* 补上窗口装饰（最小化/最大化/缩放手柄）——原逻辑只对启动时已存在的窗口生效 */
  decorateWin(w);
  var f = w.querySelector('#' + map.ieFrame);
  var addr = w.querySelector('#' + map.ieAddr);
  if (f) f.setAttribute('src', '/ie-home');
  if (addr) addr.value = IE_HOME_URL;
  /* 克隆窗口的收藏夹栏：openWin 会负责渲染（_favDone 需清掉，
     否则克隆体从模板继承来的标记会让它跳过渲染） */
  w._favDone = false;
  openWin(w);
  if (url && url !== '/') ieNavTo(w, url);
  return w;
}
/* 按窗口实例导航（多窗口下不能用全局 $('ieFrame')） */
function ieNavTo(win, rawUrl) {
  var f = win.querySelector('.ie-frame-el');
  var addr = win.querySelector('.ie-addr-el');
  var url = String(rawUrl || '').trim();
  if (!f) return;
  if (!url) {
    f.setAttribute('src', '/ie-home');
    if (addr) addr.value = IE_HOME_URL;
    return;
  }
  if (url.charAt(0) === '/') {
    f.setAttribute('src', url);
    if (addr) addr.value = ieDisplayUrl(url);
  } else {
    f.setAttribute('src', ieProxySrc(url));
    if (addr) addr.value = url;
  }
  var ld = win.querySelector('.ie-loading-el');
  if (ld) {
    ld.classList.remove('done');
    setTimeout(function () { ld.classList.add('done'); }, 2500);
  }
}

/* ═════════════ 全站外链收编：任何指向站外的链接都在项目内打开 ═════════════
   原则（用户明确要求）：系统内部出现的链接跳转，一律在项目内完成，
   不跳转到外部浏览器。项目本身就有真实可用的内置浏览器（IE 窗口），
   外链就交给它渲染 —— 页面由本站服务端代理抓取，浏览全程留在系统内部。
   这一层是兜底：即便某个角落漏写了 target 处理，点击也不会跳出。 */
document.addEventListener('click', function (e) {
  var a = near(e.target, 'a[href]');
  if (!a) return;
  var href = a.getAttribute('href') || '';
  /* 只收编站外链接；站内路径（含 /s/口令/）照常走 */
  if (!/^https?:\\/\\//i.test(href)) return;
  /* 下载直链（/f/<id> 之类）由各自的逻辑处理，不在此拦截 */
  if (a.hasAttribute('download') || a.getAttribute('data-ext') === 'allow') return;
  e.preventDefault();
  e.stopPropagation();
  ieOpen();
  ieNavTo($('ieWin'), href);
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
      /* 与任务栏时钟同源：恒为真实时间 */
      var dd = new Date();
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
  /* 桌面图标右键「复制」出来的副本，名字带 _copy 后缀：
     副本指向的还是同一个程序，这里剥掉后缀再分发 */
  if (name && /_copy$/.test(name)) name = name.replace(/_copy$/, '');
  if (name === 'game') openWin($('gameWin'));
  else if (name === 'readme') openWin($('readmeWin'));
  else if (name === 'pc') fmOpen(false);
  else if (name === 'ie') ieOpen();
  /* 开始菜单的收藏夹：外站一律在项目内置的 IE 里打开，不跳系统浏览器 */
  else if (name === 'fav-w3b') { ieOpen(); ieNavTo($('ieWin'), 'https://w3b.pub/'); }
  else if (name === 'fav-github') { ieOpen(); ieNavTo($('ieWin'), 'https://github.com/x2it/7M-Drop'); }
  else if (name === 'qq') { if (window.QQ) window.QQ.openPanel(); }
  else if (name === 'net') { fillNet(); openWin($('netWin')); }
  else if (name === 'trash') openTrash();
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

/* ───────────── 地址解析（IE 地址栏与「运行」框共用一套）─────────────
   跟真实浏览器一致：
     · 完整网址 http(s)://…            → 原样
     · 协议相对 //host/path             → 补 https:
     · 域名简写 example.com / a.b.cn/x  → 自动补 https://
     · 本站绝对路径 /s/口令/            → 直连（不代理）
     · 纯口令（字母数字）               → 拼成分享链接
   注意顺序：域名判断必须在口令判断之前，否则 baidu.com 会被当成口令。 */
function parseAddr(v) {
  var s = String(v || '').trim();
  if (!s) return null;
  if (/^https?:\\/\\//i.test(s)) {
    var p = null;
    try { p = new URL(s).pathname; } catch (err) { p = null; }
    /* 本站的分享链接直连，不走代理 */
    if (p && p.indexOf('/s/') === 0) {
      return { kind: 'local', url: p.indexOf('embed') < 0 ? p + '?embed=1' : p };
    }
    return { kind: 'web', url: s };
  }
  if (/^\\/\\//.test(s)) return { kind: 'web', url: 'https:' + s };
  if (s.charAt(0) === '/') return { kind: 'local', url: s };
  /* 域名简写：含点即为域名（口令不含点，所以两者不会混淆）
     注意：这段在 HOME_JS 模板字符串里，正则里的 \ 必须写成 \\，
     否则模板求值时转义被吃掉，正则会失效。 */
  if (/^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+(:[0-9]+)?(\\/[^\\s]*)?$/.test(s)) {
    return { kind: 'web', url: 'https://' + s };
  }
  if (/^[A-Za-z0-9]{6,40}$/.test(s)) return { kind: 'local', url: '/s/' + s + '/' };
  return null;
}

/* ───────────── 运行：口令 / 链接跳转 ───────────── */
function runGo() {
  var v = $('runInput').value.trim();
  if (!v) return;
  var a = parseAddr(v);
  if (!a) {
    msgbox('运行', '无法识别的地址。\\n\\n支持：\\n· 完整网址 https://example.com\\n· 域名简写 example.com（自动补 https://）\\n· 10 位文件口令\\n· /s/口令/ 链接', 'err');
    return;
  }
  closeWin($('runWin'));
  /* 外站网址不接管整个桌面（那会把用户踢出项目），
     改为在项目内置的 IE 窗口里打开；只有站内路径才直接导航。 */
  if (a.kind === 'web') {
    msgbox('运行', '正在 Internet Explorer 中打开：\\n' + a.url, 'info');
    setTimeout(function () { ieOpen(); ieNavTo($('ieWin'), a.url); }, 400);
    return;
  }
  msgbox('运行', '正在打开：' + a.url, 'info');
  setTimeout(function () { location.href = a.url; }, 400);
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
      var d = new Date();
      return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' +
              p2(d.getHours()) + ':' + p2(d.getMinutes());
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
/* ───────────── 网上邻居：真·网络入口（真 Win98 这里就是浏览网络的地方）─────────────
   之前这里只罗列本机网络信息，属于"能看不能用"的半吊子。
   现在给出真正可点的站点，点开由项目内置的 IE 窗口渲染：
   外链经本站服务端代理抓回来（外站普遍禁止 iframe 直嵌），
   整个浏览过程留在系统内部，不跳系统浏览器。 */
var NET_SITES = [
  { name: '知行工作室 · 官网', url: 'https://w3b.pub/', note: 'w3b.pub' },
  { name: '7M-Drop · 开源仓库', url: 'https://github.com/x2it/7M-Drop', note: 'github.com' },
  { name: 'ICANN · 域名注册局', url: 'https://www.icann.org/', note: 'icann.org' },
  { name: 'IANA · 端口与协议', url: 'https://www.iana.org/', note: 'iana.org' }
];
function fillNet() {
  var con = navigator.connection;
  var rows = [
    ['主机', location.host],
    ['协议', location.protocol.replace(':', '').toUpperCase()],
    ['连接', navigator.onLine ? '已连接' : '离线'],
    ['线路', con && con.effectiveType ? con.effectiveType.toUpperCase() : '未知'],
    ['邻居', '仅发现本机（127.0.0.1）']
  ];
  var html = rows.map(function (r) {
    return '<div class="sys-row"><span class="sys-k">' + r[0] + ':</span><span class="sys-v"></span></div>';
  }).join('');
  /* 站点列表：可点的真链接（真 98 的网上邻居就是图标+名称） */
  html += '<div class="net-label">站点（点击在 Internet Explorer 中打开）</div>';
  html += '<div class="net-list">' + NET_SITES.map(function (s, i) {
    return '<div class="net-item" data-net="' + i + '" tabindex="0" role="button">' +
      '<span class="net-ico"></span>' +
      '<span class="net-txt"><b>' + s.name + '</b><i>' + s.note + '</i></span></div>';
  }).join('') + '</div>';
  $('netGrid').innerHTML = html;
  var vs = $('netGrid').querySelectorAll('.sys-v');
  for (var i = 0; i < rows.length; i++) vs[i].textContent = rows[i][1];
  $('netGrid').querySelectorAll('.net-item').forEach(function (el) {
    function go() {
      var s = NET_SITES[Number(el.getAttribute('data-net'))];
      if (!s) return;
      closeWin($('netWin'));
      ieOpen();
      ieNavTo($('ieWin'), s.url);
    }
    el.addEventListener('click', go);
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  });
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
/* ═════════════ 桌面图标右键菜单（按图标类型分化，杜绝假功能与错误关联）═════════════
   真 Win98 里不同对象的右键菜单本就不同：
     · 系统命名空间根（我的电脑/网上邻居/回收站）：不可重命名/复制/删除，也没有"新窗口"
     · IE 浏览器：可真正开第二个窗口（opennew）
     · 普通应用/游戏/文档：可重命名、复制、删除、打开回收站、属性
   每一项都真实生效；「清空回收站」仅在回收站非空时才出现。 */
var iconCtx = $('iconCtx');
var iconCtxTarget = null;
var ICON_CTX_DEFS = {
  pc:     [['open','打开'], ['sep'], ['props','属性']],
  net:    [['open','打开'], ['sep'], ['props','属性']],
  trash:  [['open','打开'], ['sep'], ['empty','清空回收站'], ['sep'], ['props','属性']],
  ie:     [['open','打开'], ['opennew','在新窗口中打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  mines:  [['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  game:   [['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  saver:  [['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  install:[['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  readme: [['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  qq:     [['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']],
  dos:    [['open','打开'], ['sep'], ['rename','重命名'], ['copy','复制'], ['del','删除'], ['openrb','打开回收站'], ['sep'], ['props','属性']]
};
function iconCtxDef(app) {
  if (ICON_CTX_DEFS[app]) return ICON_CTX_DEFS[app];
  if (app && /_copy$/.test(app)) return iconCtxDef(app.replace(/_copy$/, ''));
  return [['open','打开'], ['sep'], ['props','属性']];
}
function showIconCtx(x, y, ic) {
  iconCtxTarget = ic;
  var app = ic.getAttribute('data-app') || '';
  var def = iconCtxDef(app);
  var rbCount = rbRead().length;
  iconCtx.innerHTML = def.map(function (it) {
    if (it[0] === 'sep') return '<div class="ctx-sep"></div>';
    if (it[0] === 'empty' && !rbCount) return '';
    return '<div class="ctxi" data-ctx="' + it[0] + '">' + it[1] + '</div>';
  }).join('');
  iconCtx.hidden = false;
  var mw = iconCtx.offsetWidth, mh = iconCtx.offsetHeight;
  iconCtx.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
  iconCtx.style.top = Math.min(y, window.innerHeight - mh - 40) + 'px';
  bringTopZ(iconCtx);
  /* 选中被右键的图标（真 98 也是这样） */
  document.querySelectorAll('.dicon.sel').forEach(function (o) { o.classList.remove('sel'); });
  ic.classList.add('sel');
}
/* 图标重命名/复制的持久化（localStorage） */
function iconCustomKey() { return 'desktopIconNames'; }
function iconCustomGet() {
  var raw = null;
  try { raw = localStorage.getItem(iconCustomKey()); } catch (e) { raw = null; }
  var o = {};
  if (raw) { try { var p = JSON.parse(raw); if (p && typeof p === 'object') o = p; } catch (e) { o = {}; } }
  return o;
}
function iconCustomSet(o) {
  try { localStorage.setItem(iconCustomKey(), JSON.stringify(o)); } catch (e) { /* 无存储权限则不持久化 */ }
}
/* ═════════════ 回收站：被删除的桌面图标，可还原 / 可彻底删除 ═════════════
   真源在 localStorage，桌面 DOM 只是它的呈现：
     · desktopIconHidden  = 回收站条目 [{app,name,ico,at}]（兼容旧版字符串数组）
     · desktopIconRemoved = 已彻底删除的 app（刷新后也不会自己回来）
   每一项操作都真实落盘，绝不做「点了没反应」的假按钮。 */
function rbKey() { return 'desktopIconHidden'; }
function rbRemovedKey() { return 'desktopIconRemoved'; }
function rbEsc(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function rbJsonGet(key) {
  var raw = null;
  try { raw = localStorage.getItem(key); } catch (e) { return []; }
  var a = [];
  if (raw) { try { var p = JSON.parse(raw); if (Array.isArray(p)) a = p; } catch (e) { a = []; } }
  return a;
}
function rbJsonSet(key, a) {
  try { localStorage.setItem(key, JSON.stringify(a)); } catch (e) { /* 无存储权限则本次会话内仍生效 */ }
}
function rbIconOf(ic) {
  var el = ic && ic.querySelector('.ico');
  if (!el) return 'ico-note';
  var m = String(el.className).match(/ico-[a-z0-9-]+/);
  return m ? m[0] : 'ico-note';
}
function rbFindIcon(app) {
  var all = document.querySelectorAll('.dicon');
  for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-app') === app) return all[i];
  return null;
}
/* 读回收站并规范化：旧数据是字符串数组，这里补出名称 / 图标 / 时间 */
function rbRead() {
  var raw = rbJsonGet(rbKey()), out = [], seen = {};
  for (var i = 0; i < raw.length; i++) {
    var x = raw[i], o;
    if (typeof x === 'string') o = { app: x, name: '', ico: '', at: 0 };
    else if (x && typeof x === 'object' && x.app)
      o = { app: String(x.app), name: String(x.name || ''), ico: String(x.ico || ''), at: Number(x.at) || 0 };
    else continue;
    if (seen[o.app]) continue;
    seen[o.app] = 1;
    var ic = rbFindIcon(o.app);
    if (!o.name) { var lb = ic && ic.querySelector('.dlabel'); o.name = lb ? lb.textContent.trim() : o.app; }
    if (!o.ico) o.ico = rbIconOf(ic);
    out.push(o);
  }
  return out;
}
function rbWrite(items) { rbJsonSet(rbKey(), items); }
function rbRemovedGet() {
  return rbJsonGet(rbRemovedKey()).filter(function (x) { return typeof x === 'string'; });
}
function rbRemovedSet(a) { rbJsonSet(rbRemovedKey(), a); }
function rbSnapshot(ic) {
  var app = ic.getAttribute('data-app');
  var lb = ic.querySelector('.dlabel');
  return { app: app, name: lb ? lb.textContent.trim() : app, ico: rbIconOf(ic), at: Date.now() };
}
/* 移入回收站：记录删除时的名称与图标，刷新后仍能原样还原 */
function rbAdd(ic) {
  var snap = rbSnapshot(ic);
  var items = rbRead().filter(function (o) { return o.app !== snap.app; });
  items.push(snap);
  rbWrite(items);
  rbRemovedSet(rbRemovedGet().filter(function (a) { return a !== snap.app; }));
  ic.hidden = true;
  rbSyncIcon();
}
function rbRebuildIcon(o) {
  var host = document.querySelector('.dgroup');
  var trash = rbFindIcon('trash');
  if (!host) return null;
  var el = document.createElement('div');
  el.className = 'dicon';
  el.setAttribute('data-app', o.app);
  el.setAttribute('tabindex', '0');
  var ico = document.createElement('span');
  ico.className = 'ico ' + (/^ico-[a-z0-9-]+$/.test(o.ico) ? o.ico : 'ico-note');
  var lb = document.createElement('span');
  lb.className = 'dlabel';
  lb.textContent = o.name;
  el.appendChild(ico); el.appendChild(lb);
  if (trash && trash.parentNode === host) host.insertBefore(el, trash);
  else host.appendChild(el);
  markIconA11y(el);
  return el;
}
/* 还原：条目移出回收站；节点不存在时（刷新后的副本图标）按存档重建一个真节点 */
function rbRestore(apps) {
  var items = rbRead(), picked = {}, kept = [], i;
  for (i = 0; i < apps.length; i++) picked[apps[i]] = 1;
  for (i = 0; i < items.length; i++) if (!picked[items[i].app]) kept.push(items[i]);
  rbWrite(kept);
  for (i = 0; i < items.length; i++) {
    var o = items[i];
    if (!picked[o.app]) continue;
    var ic = rbFindIcon(o.app) || rbRebuildIcon(o);
    if (ic) {
      var lb = ic.querySelector('.dlabel');
      if (lb) lb.textContent = o.name;
      ic.hidden = false;
    }
  }
  applyIconCustom(); rbSyncIcon();
}
/* 彻底删除：移出回收站并写入永久移除名单，刷新后不会自己回来 */
function rbPurge(apps) {
  var picked = {}, i;
  for (i = 0; i < apps.length; i++) picked[apps[i]] = 1;
  rbWrite(rbRead().filter(function (o) { return !picked[o.app]; }));
  var rm = rbRemovedGet();
  for (i = 0; i < apps.length; i++) if (rm.indexOf(apps[i]) < 0) rm.push(apps[i]);
  rbRemovedSet(rm);
  applyIconCustom(); rbSyncIcon();
}
/* 桌面回收站图标：空桶 / 满桶随真实内容切换（现成的两套像素图） */
function rbSyncIcon() {
  var ic = rbFindIcon('trash');
  var el = ic && ic.querySelector('.ico');
  if (!el) return;
  var full = rbRead().length > 0;
  el.classList.toggle('ico-trash', !full);
  el.classList.toggle('ico-trashfull', full);
}
/* 应用名称 + 回收站状态（启动时与每次操作后都跑） */
function applyIconCustom() {
  var names = iconCustomGet();
  var hidden = {}, removed = {};
  rbRead().forEach(function (o) { hidden[o.app] = 1; });
  rbRemovedGet().forEach(function (a) { removed[a] = 1; });
  document.querySelectorAll('.dicon').forEach(function (ic) {
    var app = ic.getAttribute('data-app');
    if (removed[app]) { if (ic.parentNode) ic.parentNode.removeChild(ic); return; }
    var lb = ic.querySelector('.dlabel');
    if (lb && names[app]) lb.textContent = names[app];
    ic.hidden = !!hidden[app];
  });
  rbSyncIcon();
}

/* ── 回收站窗口：列表、全选、还原、彻底删除、清空（每一项都真实生效）── */
function rbFmtTime(at) {
  if (!at) return '—';
  var d = new Date(at);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
         p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function rbSelected() {
  var out = [], all = document.querySelectorAll('#rbList .rb-ck');
  for (var i = 0; i < all.length; i++) if (all[i].checked) out.push(all[i].value);
  return out;
}
function rbUpdateBar() {
  var items = rbRead(), sel = rbSelected(), all = $('rbAll');
  if (all) {
    all.checked = items.length > 0 && sel.length === items.length;
    all.indeterminate = sel.length > 0 && sel.length < items.length;
    all.disabled = items.length === 0;
  }
  var cnt = $('rbCount');
  if (cnt) cnt.textContent = '已选 ' + sel.length + ' / ' + items.length;
  var r = $('rbRestore'), p = $('rbPurge'), e = $('rbEmpty');
  if (r) r.disabled = sel.length === 0;
  if (p) p.disabled = sel.length === 0;
  if (e) e.disabled = items.length === 0;
  var st = $('rbStatus');
  if (st) st.textContent = items.length + ' 个对象' + (sel.length ? '（已选 ' + sel.length + ' 个）' : '');
}
function renderTrash() {
  var items = rbRead(), box = $('rbList'), tip = $('rbEmptyTip'), h = '';
  if (!box) return;
  for (var i = 0; i < items.length; i++) {
    var o = items[i];
    h += '<label class="rb-row" data-app="' + rbEsc(o.app) + '">' +
           '<span class="rb-c rb-check"><input type="checkbox" class="rb-ck" value="' + rbEsc(o.app) + '"></span>' +
           '<span class="rb-c rb-name"><span class="rb-icow"><span class="ico ' + rbEsc(o.ico) + '"></span></span>' +
             '<span class="rb-txt">' + rbEsc(o.name) + '</span></span>' +
           '<span class="rb-c rb-from">桌面</span>' +
           '<span class="rb-c rb-at">' + rbEsc(rbFmtTime(o.at)) + '</span>' +
         '</label>';
  }
  box.innerHTML = h;
  if (tip) tip.hidden = items.length > 0;
  box.hidden = items.length === 0;
  rbUpdateBar();
}
function openTrash() { renderTrash(); openWin($('rbWin')); }
function rbAct(mode) {
  var sel = rbSelected(), items, i;
  if (mode === 'restore') {
    if (!sel.length) return;
    rbRestore(sel);
  } else if (mode === 'purge') {
    if (!sel.length) return;
    if (!window.confirm('彻底删除选中的 ' + sel.length + ' 项？此操作不可恢复。')) return;
    rbPurge(sel);
  } else if (mode === 'empty') {
    items = rbRead();
    if (!items.length) return;
    if (!window.confirm('清空回收站？这 ' + items.length + ' 项将被彻底删除，不可恢复。')) return;
    var apps = [];
    for (i = 0; i < items.length; i++) apps.push(items[i].app);
    rbPurge(apps);
  }
  renderTrash();
}
/* 工具条事件：一次绑定，列表用委托 */
(function bindTrash() {
  var all = $('rbAll'), list = $('rbList');
  if (all) all.addEventListener('change', function () {
    var cks = document.querySelectorAll('#rbList .rb-ck');
    for (var i = 0; i < cks.length; i++) cks[i].checked = all.checked;
    rbUpdateBar();
  });
  if (list) list.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('rb-ck')) rbUpdateBar();
  });
  var r = $('rbRestore'); if (r) r.addEventListener('click', function () { rbAct('restore'); });
  var p = $('rbPurge');   if (p) p.addEventListener('click', function () { rbAct('purge'); });
  var e = $('rbEmpty');   if (e) e.addEventListener('click', function () { rbAct('empty'); });
})();
/* 图标右键（桌面空白处的右键不受影响） */
$('desk').addEventListener('contextmenu', function (e) {
  var ic = near(e.target, '.dicon');
  if (!ic) return;
  e.preventDefault();
  e.stopPropagation();
  showIconCtx(e.clientX, e.clientY, ic);
});
/* 长按（触屏）也出图标菜单 */
$('desk').addEventListener('touchstart', function (e) {
  var ic = near(e.target, '.dicon');
  if (!ic) return;
  var t = e.touches[0];
  lpTimer = setTimeout(function () { showIconCtx(t.clientX, t.clientY, ic); }, 550);
}, { passive: true });
iconCtx.addEventListener('click', function (e) {
  var it = near(e.target, '.ctxi');
  if (!it || !iconCtxTarget) return;
  var act = it.getAttribute('data-ctx');
  var ic = iconCtxTarget;
  var app = ic.getAttribute('data-app');
  iconCtx.hidden = true;
  if (act === 'open') {
    openApp(app);
  } else if (act === 'opennew') {
    /* 仅 IE 提供此菜单项，开的是 IE 的第二个真实窗口（不再错误地打开文件分享页） */
    if (app === 'ie') ieNewWindow(IE_HOME_URL);
    else openApp(app);
  } else if (act === 'rename') {
    var lb = ic.querySelector('.dlabel');
    if (!lb) return;
    var old = lb.textContent;
    var nn = window.prompt('重命名（留空则恢复默认名称）', old);
    if (nn === null) return;
    var names = iconCustomGet();
    if (!nn.trim()) delete names[app];
    else names[app] = nn.trim().slice(0, 24);
    iconCustomSet(names);
    applyIconCustom();
  } else if (act === 'copy') {
    var names2 = iconCustomGet();
    var base = (ic.querySelector('.dlabel') || {}).textContent || app;
    names2[app + '_copy'] = base + ' 副本';
    iconCustomSet(names2);
    /* 复制 = 复制一个真的图标节点（同一个 app，两个图标） */
    var clone = ic.cloneNode(true);
    clone.setAttribute('data-app', app + '_copy');
    clone.removeAttribute('id');
    ic.parentNode.insertBefore(clone, ic.nextSibling);
    applyIconCustom();
    markIconA11y(clone);
  } else if (act === 'del') {
    var rbName = ((ic.querySelector('.dlabel') || {}).textContent || app).trim();
    rbAdd(ic);
    if (!$('rbWin').hidden) renderTrash();
    msgbox('桌面', '已把「' + rbName + '」移到回收站。' + String.fromCharCode(10, 10) +
      '双击桌面「回收站」可以还原，也可以彻底删除。', 'info');
  } else if (act === 'openrb') {
    openTrash();
  } else if (act === 'empty') {
    var rbItems = rbRead();
    if (!rbItems.length) { msgbox('回收站', '回收站是空的。', 'info'); return; }
    if (!window.confirm('清空回收站？这 ' + rbItems.length + ' 项将被彻底删除，不可恢复。')) return;
    var rbApps = [];
    for (var rbi = 0; rbi < rbItems.length; rbi++) rbApps.push(rbItems[rbi].app);
    rbPurge(rbApps);
    if (!$('rbWin').hidden) renderTrash();
    msgbox('回收站', '回收站已清空。', 'info');
  } else if (act === 'props') {
    var lb2 = ic.querySelector('.dlabel');
    msgbox('属性', '名称：' + ((lb2 && lb2.textContent) || app) + '\\n类型：快捷方式\\n位置：桌面\\n\\n这是桌面上的一个程序快捷方式，双击即可打开。', 'info');
  }
});

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
  /* 图标右键菜单同样要点空白即走。此前只关了桌面空白右键菜单（ctxMenu），
     图标菜单（iconCtx）漏了 —— 点空白它一直挂着，真·假功能。 */
  if (!iconCtx.hidden && !near(e.target, '.ctxmenu')) { iconCtx.hidden = true; iconCtxTarget = null; }
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
  /* IE：菜单项全部对应真实动作，不做装饰性假菜单 */
  'help-ie': ['<div class="ctxi" data-act="about-ie">关于 Internet Explorer</div>',
              '<div class="ctx-sep"></div>',
              '<div class="ctxi" data-act="ie-help-site">项目主页 · w3b.pub</div>'],
  'file-ie': ['<div class="ctxi" data-act="ie-new">新窗口打开</div>',
               '<div class="ctxi" data-act="ie-source">查看源代码</div>',
               '<div class="ctx-sep"></div>',
               '<div class="ctxi" data-act="quit">关闭</div>'],
  'edit-ie': ['<div class="ctxi" data-act="ie-copy">复制地址</div>',
               '<div class="ctxi" data-act="ie-select">全选地址</div>'],
  'view-ie': ['<div class="ctxi" data-act="ie-refresh">刷新</div>',
               '<div class="ctxi" data-act="ie-stop">停止</div>',
               '<div class="ctx-sep"></div>',
               '<div class="ctxi" data-act="ie-source">查看源代码</div>'],
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
  /* 克隆出来的 IE 窗口没有 id（id 会重复），靠 .ie-clone 标记识别，
     否则它的菜单会退化成通用模板，内容串台 */
  var isIe = id === 'ieWin' || (win && win.classList.contains('ie-clone'));
  if (base === 'help') {
    if (id === 'readmeWin') return 'help-readme';
    if (id === 'pcWin') return 'help-pc';
    if (id === 'mineWin') return 'help-mine';
    if (isIe) return 'help-ie';
    return 'help-readme';
  }
  if (isIe && (base === 'file' || base === 'edit' || base === 'view' || base === 'fav')) {
    return base + '-ie';
  }
  return base;
}
/* 菜单点击用事件委托：克隆出的 IE 窗口自动获得同样的下拉菜单，
   不用再逐窗口补绑定（否则第二个窗口的菜单点了没反应）。 */
document.addEventListener('click', function (e) {
  var mu = near(e.target, '.mu');
  if (!mu) return;
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
    /* IE 窗口（首个或克隆体）——菜单动作要作用在「所属的那个窗口」上 */
    var ieWin = mu.closest('#ieWin, .ie-clone');
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
      else if (a === 'about-ie') msgbox('关于 Internet Explorer', 'Internet Explorer 5.0（网页仿真版）。\\n地址栏可输入口令 / 路径 / 网址。\\n站外网址由本站服务端代取后在本窗口内渲染，\\n因此浏览全程留在项目内，不会跳出到系统浏览器。\\n前进后退走真实导航历史。', 'info');
      else if (a === 'help2') msgbox('扫雷玩法', '左键挖开，右键插旗。\\n数字表示周围 8 格的地雷数。\\n首点必不踩雷。\\n菜单「游戏」可切换三档难度。\\n触屏：长按插旗，或用下方「模式」按钮切换。', 'info');
      /* ── IE 专属：全部作用于「所属的那个 IE 窗口」 ── */
      else if (a === 'ie-refresh') {
        var ie = ieWin && ieWin.querySelector('.ie-frame-el');
        if (ie) ie.setAttribute('src', ie.getAttribute('src'));
      }
      else if (a === 'ie-stop') {
        /* 真停止：把 iframe 换到 about:blank 并断掉加载，
           否则「停止」就是个永远点不动的装饰按钮 */
        var sf = ieWin && ieWin.querySelector('.ie-frame-el');
        var ss = ieWin && ieWin.querySelector('.ie-status-el');
        if (sf) { sf.setAttribute('src', 'about:blank'); if (ss) ss.textContent = '已停止'; }
      }
      else if (a === 'ie-new') {
        var na = ieWin && ieWin.querySelector('.ie-addr-el');
        ieNewWindow(na ? na.value : (IE_HOME_URL));
      }
      else if (a === 'ie-copy') {
        var av = ieWin && ieWin.querySelector('.ie-addr-el');
        var v = av ? av.value : '';
        try { navigator.clipboard.writeText(v); msgbox('Internet Explorer', '地址已复制到剪贴板。\\n' + v, 'info'); }
        catch (err) { msgbox('Internet Explorer', '复制失败，请手动选择地址栏内容。', 'err'); }
      }
      else if (a === 'ie-select') {
        var ad = ieWin && ieWin.querySelector('.ie-addr-el');
        if (ad) { ad.focus(); ad.select(); }
      }
      else if (a === 'ie-source') {
        var sa = ieWin && ieWin.querySelector('.ie-addr-el');
        ieShowSource(sa ? sa.value : IE_HOME_URL);
      }
      else if (a === 'ie-help-site') { ieOpen(); ieNavTo($('ieWin'), 'https://w3b.pub/'); }
      else if (a === 'ie-home') {
        var iw = ieWin || $('ieWin');
        ieNavTo(iw, BOOT.guestUrl + '?embed=1');
      }
      else if (a === 'ie-file') {
        var iw2 = ieWin || $('ieWin');
        ieNavTo(iw2, BOOT.guestUrl);
      }
      /* 收藏夹：外站一律经项目内置的代理渲染，不开系统浏览器 */
      else if (a === 'fav-w3b') { ieOpen(); ieNavTo($('ieWin'), 'https://w3b.pub/'); }
      else if (a === 'fav-github') { ieOpen(); ieNavTo($('ieWin'), 'https://github.com/x2it/7M-Drop'); }
    });
  });
document.addEventListener('pointerdown', function (e) {
  if (!near(e.target, '.menubar')) {
    document.querySelectorAll('.mdrop').forEach(function (d) { d.remove(); });
    document.querySelectorAll('.mu.open').forEach(function (m) { m.classList.remove('open'); });
  }
});

/* ───────────── 桌面图标：单击选中，再点打开（兼容双击/触屏） ─────────────
   用事件委托：右键菜单「复制」出来的图标无需再单独绑定，
   点一下就能用（否则复制出来的图标是个死东西）。 */
var lastIcon = null, lastIconT = 0;
/* 图标是纯 div，屏幕阅读器读不出它是可点的。
   role/aria-label 在运行时从标签文本取，新增图标不用再单独维护。 */
function markIconA11y(ic) {
  if (!ic) return;
  ic.setAttribute('role', 'button');
  var lb = ic.querySelector('.dlabel');
  if (lb && lb.textContent) ic.setAttribute('aria-label', lb.textContent.trim());
}
document.querySelectorAll('.dicon').forEach(markIconA11y);
$('desk').addEventListener('click', function (e) {
  var ic = near(e.target, '.dicon');
  if (!ic) return;
  var now = Date.now();
  /* 双击判定窗口：桌面端 450ms 足够；触屏端要放宽。
     原因：移动浏览器对未声明 touch-action:manipulation 的元素有 300ms 点击延迟，
     两次点击的间隔天然被拉长，450ms 会导致「怎么点都打不开」。
     这里给触屏放宽到 700ms，同时给 .dicon 声明 touch-action 消除延迟。 */
  var win = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) ? 700 : 450;
  if (lastIcon === ic && now - lastIconT < win) {
    openApp(ic.getAttribute('data-app'));
    ic.classList.remove('sel');
    lastIcon = null;
  } else {
    document.querySelectorAll('.dicon.sel').forEach(function (o) { o.classList.remove('sel'); });
    ic.classList.add('sel');
    lastIcon = ic;
    lastIconT = now;
  }
});
$('desk').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var ic = near(e.target, '.dicon');
  if (!ic) return;
  e.preventDefault();
  openApp(ic.getAttribute('data-app'));
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

/* ═════════════ 右下角音量调节（真实仿真：滑块改变所有 Web Audio 合成音的增益，非假 UI） ═════════════ */
window.__VOL__ = parseFloat(localStorage.getItem('vol'));
if (!(window.__VOL__ >= 0)) window.__VOL__ = 0.7;
window.__MUTED__ = localStorage.getItem('muted') === '1';
(function () {
  var volBtn = document.getElementById('volBtn'),
      volPop = document.getElementById('volPop'),
      volRange = document.getElementById('volRange'),
      volPct = document.getElementById('volPct'),
      volMute = document.getElementById('volMute'),
      volGlyph = document.getElementById('volGlyph');
  function renderVolGlyph() {
    var muted = window.__MUTED__ || (window.__VOL__ || 0) <= 0.001;
    volGlyph.innerHTML = muted
      ? '<svg viewBox="0 0 16 16" width="14" height="14" shape-rendering="crispEdges"><path d="M2 6h2l3-3v10l-3-3H2z" fill="#222"/><line x1="9.5" y1="4" x2="14" y2="12" stroke="#222" stroke-width="1.4"/></svg>'
      : '<svg viewBox="0 0 16 16" width="14" height="14" shape-rendering="crispEdges"><path d="M2 6h2l3-3v10l-3-3H2z" fill="#222"/><path d="M10 5 Q12 8 10 11" fill="none" stroke="#222" stroke-width="1.2"/><path d="M12 3.5 Q15 8 12 12.5" fill="none" stroke="#222" stroke-width="1.2"/></svg>';
  }
  volRange.value = Math.round((window.__VOL__ || 0.7) * 100);
  volPct.textContent = volRange.value + '%';
  volMute.checked = window.__MUTED__;
  renderVolGlyph();
  volBtn.addEventListener('click', function (e) { e.stopPropagation(); volPop.hidden = !volPop.hidden; });
  volRange.addEventListener('input', function () {
    window.__VOL__ = Math.max(0, Math.min(1, volRange.value / 100));
    try { localStorage.setItem('vol', String(window.__VOL__)); } catch (e) {}
    volPct.textContent = volRange.value + '%';
    if (window.__VOL__ > 0.001 && window.__MUTED__) { window.__MUTED__ = false; volMute.checked = false; try { localStorage.setItem('muted', '0'); } catch (e) {} }
    renderVolGlyph();
  });
  volMute.addEventListener('change', function () {
    window.__MUTED__ = volMute.checked;
    try { localStorage.setItem('muted', window.__MUTED__ ? '1' : '0'); } catch (e) {}
    renderVolGlyph();
  });
  document.addEventListener('pointerdown', function (e) {
    if (!volPop.hidden && !near(e.target, '#volPop') && !near(e.target, '#volBtn')) volPop.hidden = true;
  });
})();

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
   用 replaceState 抹掉参数，免得用户刷新又开一局。
   另外支持 /?ie=<网址>：直接打开内置浏览器并载入该网址，
   供项目内其它页面（如分享页页脚）把外链交给桌面壳的 IE 处理，
   从而全程不跳出到系统浏览器。 */
(function deepLink() {
  var m = /[?&]app=([a-z]+)/.exec(location.search);
  var mIe = /[?&]ie=([^&]+)/.exec(location.search);
  if (!m && !mIe) return;
  var app = m ? m[1] : '';
  setTimeout(function () {
    if (mIe) {
      var url = decodeURIComponent(mIe[1]);
      ieOpen();
      ieNavTo($('ieWin'), url);
    }
    if (app) {
      var icon = document.querySelector('.dicon[data-app="' + app + '"]');
      if (icon) openApp(app);
    }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }, 400);
})();

/* ═════════════ PWA：Service Worker 注册 ═════════════
   根页位于 /，'./sw.js' 解析为 /sw.js，作用域 ./ = 根。
   SW 注册是 beforeinstallprompt 触发的前提——没有它，
   「安装」按钮与「安装到桌面」图标永远收不到安装事件。 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    /* updateViaCache:'none' —— 否则浏览器会用 HTTP 缓存里的旧 sw.js，
       新版本永远装不上（表现为「改了没反应」）。
       检测到新 SW 就立刻接管并刷新一次：旧 SW 手里可能还攥着旧 CSS，
       不刷新就会一直渲染旧样式。 */
    navigator.serviceWorker.register(withSC('./sw.js'), { scope: './', updateViaCache: 'none' })
      .then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              /* 已有 controller 说明是「更新」而非首次安装：
                 跳过等待 → 新 SW 接管 → 强制刷新一次拿最新资源 */
              nw.postMessage({ type: 'skip-waiting' });
              navigator.serviceWorker.addEventListener('controllerchange', function once() {
                navigator.serviceWorker.removeEventListener('controllerchange', once);
                location.reload();
              });
            }
          });
        });
      })
      .catch(function () { /* SW 失败不影响页面正常使用 */ });
  });

  /* ── 版本自愈：实际生效的 CSS 与页面声明的不一致 → 清缓存重来 ──
     这条是「用户说改了没反应」的终极兜底。
     场景：旧 SW 仍在接管，页面 HTML 是新的（带 ?v=新哈希），
     但 CSS 是旧 SW 从缓存里翻出来的旧版 —— 两者混搭，布局错乱。
     检测方式：页面声明的版本号 vs CSS 里自带的版本标记。
     不一致就删掉所有缓存并强制刷新一次，之后就一致了。 */
  (function selfHealVersion() {
    var want = (document.querySelector('link[rel=stylesheet][href*="?v="]') || {}).href;
    if (!want) return;
    var ver = want.split('?v=')[1];
    if (!ver) return;
    fetch('/home.css?v=' + ver, { cache: 'reload' })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        /* CSS 里带一行版本标记（构建时注入）；对不上就是拿到了旧版 */
        var m = txt.match(/--shell-ver:\s*([a-f0-9]+)/);
        if (!m) return;                       /* 没标记就不判断，兼容旧构建 */
        if (m[1] === ver) return;              /* 一致，无需处理 */
        if (sessionStorage.getItem('drop-healed') === ver) return;  /* 已自愈过，别循环 */
        try { sessionStorage.setItem('drop-healed', ver); } catch (e) {}
        if (navigator.serviceWorker && caches) {
          caches.keys().then(function (ks) {
            Promise.all(ks.map(function (k) { return caches.delete(k); }));
          }).catch(function () {});
        }
        location.reload(true);
      })
      .catch(function () { /* 取不到就维持现状，不折腾用户 */ });
  })();
}

/* 启动时应用桌面图标的个性化（重命名 / 已删除），
   否则刷新后自定义状态就不见了 */
try { applyIconCustom(); } catch (e) { /* 个性化失败不影响桌面正常显示 */ }

/* QQ 模块（见下方 QQ_JS）需要复用窗口管理原语，但两边各自是 IIFE，
   按既有约定（window.__ieNav）导出一个小 façade。 */
window.W98 = {
  openWin: openWin, closeWin: closeWin, bringTop: bringTop,
  taskBtnFor: taskBtnFor, msgbox: msgbox, tickClock: tickClock, fillSys: fillSys,
  /* 内置浏览器相关：导出以便调试与外部调用（QQ 模块也复用） */
  ieOpen: ieOpen, ieNavTo: ieNavTo, ieNewWindow: ieNewWindow, ieShowSource: ieShowSource,
  /* 地址解析与收藏栏：供调试与外部调用 */
  parseAddr: parseAddr, ieRenderFavBar: ieRenderFavBar, ieFavList: ieFavList
};
})();
`;

/* ══════════════════════════════ 在线聊天 IM══════════════════════════════
   本段由 _build.js 从 _qqsrc.js 自动内联，请勿手改；
   要改聊天逻辑，改 _qqsrc.js 后重跑 node _build.js。
   下发路径：/home.js = HOME_JS + QQ_JS。 */
const QQ_JS = `/* ═══════════════ 在线聊天 IM（真实用户 / 单聊 / 群聊）═══════════════
   没有任何预设好友、剧本、自动打字、假在线状态。
     · 好友列表 = 服务端 /api/qq/hello 返回的真实在线用户，一个都不编；
     · 消息全部经服务端收发、带 TTL，过期由服务端 sweep 清除，本地不留假存档；
     · 身份 = 7mdid 设备凭证（服务端签发，每浏览器唯一、不可伪造）；
     · 权限 = 每人只删自己的消息 / 改自己的资料；管理员可全局管理；
     · 界面沿用 Win98 立体控件语言，每个可见控件都对应一个真实行为。
   数据在线：刷新页面后由 /api/qq/poll?since=0 从服务端回补历史。
*/
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function closestEl(el, sel) {
    while (el && el !== document.body) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }
  var LS = 'qq95-';
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(LS + k);
      localStorage.setItem(LS + k, v);
      return v;
    } catch (e) { return null; }
  }

  /* ─────────── 一、视觉素材（像素头像 / 表情，纯样式，非数据）─────────── */
  var AV = {
    A: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    B: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hhssmmssh.', 'hhsssssshh', 'hhhsssshhh', 'hhccccccch', 'hcccccccch', '.cccccccc.'],
    C: ['cccccccccc', 'cccccccccc', 'chhssssshh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    D: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hkkkkkkkkh', 'hkkkkkkkkh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    E: ['..kkkkkk..', '.kk....kk.', 'kk..hh..kk', 'kk..hh..kk', 'kk..hhhhkk', 'kk....hhkk', 'kk......kk', '.kk....kk.', '..kkkkkk..', '..........']
  };
  var PALS = [
    { h: '#2b2b2b', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' },
    { h: '#1a1a1a', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#d88ab0' },
    { h: '#241a12', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' },
    { h: '#d8b23a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#7a4a9a' },
    { h: '#3a2a1a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#2a2a34' }
  ];
  var GROUP_PAL = { h: '#2a2a34', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#a03030' };
  function palOf(id) {
    var n = 0, s = String(id || '');
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return PALS[n % PALS.length];
  }
  var avCache = {};
  function avHtml(who) {
    var pal = who.pal || PALS[0];
    var key = (who.av || 'A') + '|' + pal.h + pal.s + pal.k + pal.m + pal.c;
    if (!avCache[key]) {
      var pat = AV[who.av] || AV.A, r = [];
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
  var FACES = ['微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
    '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '酷', '冷汗', '抓狂', '吐',
    '偷笑', '愉快', '白眼', '傲慢', '饥饿', '困', '惊恐', '流汗', '憨笑', '奋斗',
    '咒骂', '疑问', '嘘', '晕', '疯了', '衰', '骷髅', '敲打', '再见', '擦汗',
    '抠鼻', '鼓掌', '糗大了', '坏笑', '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈',
    '快哭了', '阴险', '亲亲', '吓', '可怜'];

  /* ─────────── 二、音效（真实事件触发，零文件）─────────── */
  var actx = null;
  function ac() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!actx) actx = new C();
    if (actx.state === 'suspended' && actx.resume) actx.resume();
    return actx;
  }
  function tone(freq, delay, dur, type, vol) {
    var c = ac(); if (!c) return;
    var t = c.currentTime + delay;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    var v = vol * (window.__VOL__ == null ? 0.7 : window.__VOL__) * (window.__MUTED__ ? 0 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function sound(kind) {
    if (!state.sound) return;
    if (kind === 'msg') { tone(988, 0, 0.09, 'square', 0.06); tone(784, 0.11, 0.10, 'square', 0.06); }
    else if (kind === 'send') tone(620, 0, 0.05, 'sine', 0.05);
    else if (kind === 'knock') { tone(300, 0, 0.09, 'triangle', 0.08); tone(240, 0.13, 0.10, 'triangle', 0.08); }
    else if (kind === 'sys') tone(440, 0, 0.06, 'sine', 0.05);
  }
  function syncSound() { $('qqSound').textContent = '音效:' + (state.sound ? '开' : '关'); }
  function toggleSound() {
    state.sound = !state.sound;
    store('sound', state.sound ? '1' : '0');
    syncSound();
    if (state.sound) sound('sys');
  }

  /* ─────────── 三、时间 ─────────── */
  function fmtTime(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function fmtFull(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(t) { var d = new Date(t); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

  /* ─────────── 四、状态（聊天记录只在内存，真源在服务端）─────────── */
  var state = {
    sound: true, cur: null, lastCur: null,
    chats: {}, unread: {}, tab: 'friend', find: '', fold: {},
    started: false, booted: false, online: false,
    me: null, users: [], groups: [], admin: false, seq: 0,
    ttlHours: 24, presenceSec: 45, maxText: 500, purgeArmed: false
  };
  var friends = [];
  var timers = { hello: null, poll: null };
  var lastDay = '';
  function chatRec(id) { if (!state.chats[id]) state.chats[id] = { msgs: [] }; return state.chats[id]; }
  function totalUnread() { var n = 0; for (var k in state.unread) if (state.unread.hasOwnProperty(k)) n += state.unread[k]; return n; }
  function friendById(id) { for (var i = 0; i < friends.length; i++) if (friends[i].id === id) return friends[i]; return null; }
  function shortId(id) { return String(id || '').slice(0, 8).toUpperCase(); }

  /* 服务端真实在线用户 / 真实群 → 面板会话对象；不编造任何人 */
  function syncFriends() {
    var f = [];
    for (var i = 0; i < state.users.length; i++) {
      var u = state.users[i];
      if (u.me) continue;
      f.push({ id: u.id, name: u.name, sign: u.sign || '', av: 'A', pal: palOf(u.id),
               group: '在线用户', on: true, isGroup: false, qq: shortId(u.id), status: u.status });
    }
    for (var j = 0; j < state.groups.length; j++) {
      var g = state.groups[j];
      f.push({ id: 'G' + g.id, gid: g.id, name: g.name, sign: g.members + ' 名成员',
               av: 'D', pal: GROUP_PAL, group: '我的群聊', on: true, isGroup: true,
               qq: shortId(g.id), mine: g.mine, members: g.members });
    }
    friends = f;
  }
  function roomOf(id) {
    var f = friendById(id);
    if (!f || !state.me) return '';
    if (f.isGroup) return 'group:' + f.gid;
    return 'dm:' + [state.me.id, f.id].sort().join(':');
  }
  function convIdOf(room) {
    if (!state.me) return null;
    var d = /^dm:([0-9a-f]{32}):([0-9a-f]{32})$/.exec(room);
    if (d) {
      if (d[1] !== state.me.id && d[2] !== state.me.id) return null;  // 管理员也不读他人私聊
      return d[1] === state.me.id ? d[2] : d[1];
    }
    var g = /^group:([A-Za-z0-9_-]+)$/.exec(room);
    return g ? 'G' + g[1] : null;
  }

  /* ─────────── 五、网络层（HOME_JS 的 withSC 已包装 fetch，凭证自动透传）─────────── */
  function api(path, method, body) {
    var opt = { method: method || 'GET', cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, code: r.status, j: j }; })
        .catch(function () { return { ok: false, code: r.status, j: {} }; });
    });
  }
  function setConn(ok, msg) {
    var was = state.online;
    state.online = ok;
    var t = $('qqTyping');
    if (!ok) { t.hidden = false; $('qqTypingText').textContent = msg || '与服务器断开，正在重试…'; }
    else t.hidden = true;
    renderOnline();
    return was;
  }
  function hello() {
    return api('/api/qq/hello').then(function (r) {
      if (!r.ok || !r.j.ok) { setConn(false, '连接失败，正在重试…'); return; }
      var was = setConn(true);
      state.me = r.j.me; state.users = r.j.users || []; state.groups = r.j.groups || [];
      state.admin = !!r.j.admin;
      state.ttlHours = r.j.ttlHours || 24;
      state.presenceSec = r.j.presenceSec || 45;
      state.maxText = r.j.maxText || 500;
      syncFriends();
      $('qqMyName').textContent = state.me.name;
      $('qqMySign').textContent = state.me.sign || '点击修改个性签名';
      $('qqMyAv').innerHTML = avHtml({ av: 'A', pal: palOf(state.me.id) });
      $('qqState').value = state.me.status || 'online';
      $('qqAdminRow').hidden = !state.admin;
      renderPanel(); renderOnline();
      if (state.cur) { renderChatTitle(); renderChatHead(); renderChatSide(); }
      renderTray(); renderTaskFlash();
      if (!state.booted) {
        state.booted = true;
        poll(true);
        if (!was) hintIfOpen('已连上聊天服务器。消息 ' + state.ttlHours + ' 小时后自动清除。');
      } else if (!was) {
        hintIfOpen('已重新连上聊天服务器。');
      }
    }).catch(function () { setConn(false, '连接失败，正在重试…'); });
  }
  function poll(reset) {
    var since = reset ? 0 : state.seq;
    return api('/api/qq/poll?since=' + since).then(function (r) {
      if (!r.ok || !r.j.ok) return;
      var msgs = r.j.msgs || [], max = state.seq, changed = false;
      for (var i = 0; i < msgs.length; i++) {
        var sm = msgs[i];
        if (sm.seq > max) max = sm.seq;
        var conv = convIdOf(sm.room);
        if (!conv) continue;
        var rec = chatRec(conv);
        var dup = false;
        for (var z = 0; z < rec.msgs.length; z++) if (rec.msgs[z].seq === sm.seq) { dup = true; break; }
        if (dup) continue;
        var mine = state.me && sm.from === state.me.id;
        var m = { seq: sm.seq, w: mine ? 'me' : 'you', who: sm.fromName,
                  text: sm.text, t: sm.at * 1000, owner: sm.owner, room: sm.room };
        rec.msgs.push(m);
        if (rec.msgs.length > 200) rec.msgs.shift();
        changed = true;
        if (state.cur === conv) appendRow(m);
        if (!mine) {
          if (state.cur !== conv) {
            state.unread[conv] = (state.unread[conv] || 0) + 1;
            renderPanel(); renderTray(); renderTaskFlash();
          }
          if (!reset) sound('msg');
        }
      }
      state.seq = Math.max(state.seq, max);
      if (changed && reset && state.cur) renderLog();
    }).catch(function () {});
  }
  function startLoops() {
    stopLoops();
    timers.hello = setInterval(hello, Math.max(5000, Math.floor(state.presenceSec * 1000 / 3)));
    timers.poll = setInterval(function () { if (!document.hidden && state.online) poll(false); }, 2000);
  }
  function stopLoops() {
    if (timers.hello) clearInterval(timers.hello);
    if (timers.poll) clearInterval(timers.poll);
    timers.hello = timers.poll = null;
  }

  /* ─────────── 六、面板渲染 ─────────── */
  var GROUPS = ['在线用户'];
  function matchKw(f, kw) {
    if (!kw) return true;
    return (f.name + ' ' + f.sign + ' ' + (f.qq || '')).toLowerCase().indexOf(kw) >= 0;
  }
  function friendRow(fr) {
    var u = state.unread[fr.id] || 0;
    return '<div class="qq-f' + (state.cur === fr.id ? ' sel' : '') + '" data-f="' + fr.id + '" tabindex="0">' +
      '<span class="qq-f-av">' + avHtml(fr) + '</span>' +
      '<span class="qq-f-main">' +
      '<span class="qq-f-name">' + esc(fr.name) + '</span>' +
      '<span class="qq-f-sign">' + esc(fr.sign) + '</span>' +
      '</span>' +
      (u ? '<span class="qq-badge">' + (u > 99 ? '99+' : u) + '</span>' : '') +
      '</div>';
  }
  function secHtml(key, title, list) {
    var fkey = key + '|' + title;
    var fold = !!state.fold[fkey];
    var html = '<div class="qq-gname' + (fold ? ' fold' : '') + '" data-g="' + esc(fkey) + '" tabindex="0">' +
      '<span class="qq-gtri"></span>' + esc(title) +
      '<span class="qq-gnum">' + list.length + '/' + list.length + '</span></div>';
    if (fold) return html;
    for (var j = 0; j < list.length; j++) html += friendRow(list[j]);
    return html;
  }
  function emptyHtml(kw) {
    if (kw) return '<div class="qq-empty">没有找到「' + esc(state.find) + '」</div>';
    if (!state.online) return '<div class="qq-empty">正在连接聊天服务器…</div>';
    return '<div class="qq-empty">当前只有你在线。把这个页面的链接发给别人，就能一起聊。</div>';
  }
  function renderPanel() {
    var box = $('qqGroups');
    var kw = (state.find || '').toLowerCase().replace(/^\\s+|\\s+$/g, '');
    var html = '', i, list;
    if (state.tab === 'group') {
      list = friends.filter(function (f) { return f.isGroup && matchKw(f, kw); });
      html = list.length ? secHtml('g', '我的群聊', list) :
        (kw ? emptyHtml(kw) : '<div class="qq-empty">还没有群。主菜单里「新建群聊」，再把在线的人拉进来。</div>');
    } else if (state.tab === 'recent') {
      var rec = [];
      for (i = 0; i < friends.length; i++) {
        var r = chatRec(friends[i].id);
        if (r.msgs.length) rec.push({ f: friends[i], t: r.msgs[r.msgs.length - 1].t });
      }
      rec.sort(function (a, b) { return b.t - a.t; });
      list = rec.map(function (x) { return x.f; }).filter(function (f) { return matchKw(f, kw); });
      html = list.length ? secHtml('r', '最近联系人', list) :
        (kw ? emptyHtml(kw) : '<div class="qq-empty">还没有会话。点一个在线的人开始聊。</div>');
    } else {
      var hit = 0;
      for (i = 0; i < GROUPS.length; i++) {
        list = friends.filter(function (f) { return !f.isGroup && f.group === GROUPS[i] && matchKw(f, kw); });
        if (!list.length && kw) continue;
        hit += list.length;
        html += secHtml('g' + i, GROUPS[i], list);
      }
      if (!hit) html = emptyHtml(kw);
    }
    box.innerHTML = html;
  }
  function renderOnline() {
    var el = $('qqOnline');
    if (!state.started) { el.textContent = '未上线 · 双击 IM 图标连接'; return; }
    if (!state.online) { el.textContent = '连接中断 · 重试中'; return; }
    var n = state.users.length;
    el.textContent = '在线 ' + n + ' 人' + (n <= 1 ? '（只有你）' : '') +
      ' · 消息 ' + state.ttlHours + 'h 后自动清除';
  }

  /* ─────────── 七、会话渲染 ─────────── */
  function scrollLog() { var l = $('qqLog'); l.scrollTop = l.scrollHeight; }
  function rowHtml(m) {
    var me = m.w === 'me';
    var who = me ? (state.me ? state.me.name : '我') : (m.who || '对方');
    var canDel = !!(state.admin || (state.me && m.owner === state.me.id));
    return '<div class="qq-row' + (me ? ' me' : '') + '">' +
      '<div class="qq-bhead"><span class="qq-bwho">' + esc(who) + '</span>' +
      '<span class="qq-btime">' + esc(fmtFull(m.t)) + '</span>' +
      (canDel ? '<button class="btn95 qq-del" data-seq="' + m.seq + '" title="删除这条消息">删</button>' : '') +
      '</div>' +
      '<div class="qq-btxt">' + esc(m.text) + '</div></div>';
  }
  function appendRow(m) {
    var log = $('qqLog');
    var empty = log.querySelector('.qq-empty');
    if (empty) empty.parentNode.removeChild(empty);
    var k = dayKey(m.t);
    if (k !== lastDay) { lastDay = k; log.insertAdjacentHTML('beforeend', '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>'); }
    if (m.w === 'sys') log.insertAdjacentHTML('beforeend', '<div class="qq-sys">' + esc(m.text) + '</div>');
    else log.insertAdjacentHTML('beforeend', rowHtml(m));
    scrollLog();
  }
  function renderLog() {
    var rec = chatRec(state.cur), log = $('qqLog');
    if (!rec.msgs.length) {
      log.innerHTML = '<div class="qq-empty">还没有消息。发出第一句话吧。</div>';
      lastDay = ''; return;
    }
    var html = '', last = '';
    for (var i = 0; i < rec.msgs.length; i++) {
      var m = rec.msgs[i], k = dayKey(m.t);
      if (k !== last) { last = k; html += '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>'; }
      html += m.w === 'sys' ? '<div class="qq-sys">' + esc(m.text) + '</div>' : rowHtml(m);
    }
    log.innerHTML = html; lastDay = last; scrollLog();
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

  /* ─────────── 八、聊天窗 ─────────── */
  function renderChatTitle() {
    var f = friendById(state.cur); if (!f) return;
    $('qqChatTitle').textContent = f.isGroup ? ('群聊：' + f.name) : ('与 ' + f.name + ' 对话');
  }
  function renderChatHead() {
    var f = friendById(state.cur); if (!f) return;
    $('qqChatAv').innerHTML = avHtml(f);
    $('qqChatName').textContent = f.name + '（' + f.qq + '）';
    $('qqChatSign').textContent = f.isGroup ? (f.members + ' 名成员 · 群消息全员可见') : (f.sign || '在线');
  }
  /* 右侧资料栏：真实资料 + 真实操作（邀请在线用户 / 退出或解散群） */
  function renderChatSide() {
    var f = friendById(state.cur), box = $('qqChatSide');
    if (!f) { box.innerHTML = ''; return; }
    var h = '<span class="qq-av">' + avHtml(f) + '</span>' +
      '<div class="qq-ch-sname">' + esc(f.name) + '</div>' +
      '<div class="qq-ch-srow"><b>ID</b> ' + esc(f.qq) + '</div>' +
      '<div class="qq-ch-srow"><b>状态</b> ' + (f.isGroup ? '群聊' : (f.status === 'hidden' ? '隐身' : '在线')) + '</div>';
    if (f.isGroup) {
      h += '<div class="qq-ch-srow"><b>成员</b> ' + f.members + ' 人</div>' +
        '<div class="qq-ch-srow"><b>身份</b> ' +
        (state.admin && !f.mine ? '管理员' : (f.mine ? '群主' : '成员')) + '</div>' +
        '<div class="qq-ch-srow">点名字邀请在线的人：</div>';
      var n = 0;
      for (var i = 0; i < state.users.length; i++) {
        var u = state.users[i];
        if (u.me) continue;
        h += '<div class="qq-f" data-invite="' + u.id + '" tabindex="0"><span class="qq-f-main"><span class="qq-f-name">＋ ' + esc(u.name) + '</span></span></div>';
        n++;
      }
      if (!n) h += '<div class="qq-ch-srow">暂无其他在线用户</div>';
      h += '<div class="qq-ch-srow"><button class="btn95" data-act="leave">' +
        (f.mine || state.admin ? '解散群' : '退出群') + '</button></div>';
    } else {
      h += '<div class="qq-ch-srow"><b>签名</b> ' + esc(f.sign || '—') + '</div>' +
        '<div class="qq-ch-srow">消息 ' + state.ttlHours + ' 小时后自动清除</div>';
    }
    box.innerHTML = h;
  }
  function openChat(id) {
    var f = friendById(id); if (!f) return;
    state.cur = id; state.lastCur = id; state.unread[id] = 0;
    renderPanel(); renderTray(); renderTaskFlash();
    renderChatTitle(); renderChatHead(); renderChatSide();
    W98.openWin($('qqChatWin'));
    renderLog();
    if (!chatRec(id).msgs.length) hint('还没有消息。发出第一句话吧 · ' + state.ttlHours + ' 小时后自动清除。');
  }
  function ensureTray() {
    if ($('qqTray')) return;
    var t = document.createElement('span');
    t.className = 'trayico'; t.id = 'qqTray'; t.title = 'IM 即时通讯';
    t.innerHTML = '<span class="ico ico-qq ico-qq-s"></span>';
    t.addEventListener('click', function () { openPanel(); });
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); trayMenu(e.clientX, e.clientY); });
    $('trayIcons').appendChild(t);
  }
  function openPanel() {
    if (!state.started) {
      state.started = true;
      ensureTray();
      hello().then(startLoops);
    }
    W98.openWin($('qqWin'));
    renderPanel(); renderOnline(); renderTray(); renderTaskFlash();
  }
  function renderTray() {
    var t = $('qqTray'); if (!t) return;
    var n = totalUnread();
    t.classList.toggle('unread', n > 0);
    t.title = n > 0 ? 'IM · ' + n + ' 条未读' : 'IM 即时通讯';
  }
  function renderTaskFlash() {
    var w = $('qqWin'), btn = w && w._taskBtn;
    if (btn) btn.classList.toggle('flash', totalUnread() > 0 && w.hidden);
  }

  /* ─────────── 九、真实行为：发送 / 资料 / 群 / 删除 / 管理 ─────────── */
  function sendMsg() {
    var inp = $('qqIn');
    var text = inp.value.replace(/^\\s+|\\s+$/g, '');
    if (!text || !state.cur) return;
    var room = roomOf(state.cur);
    if (!room) { hintIfOpen('会话已失效，请刷新在线列表'); return; }
    var btn = $('qqSendBtn'); btn.disabled = true;
    api('/api/qq/say', 'POST', { room: room, text: text }).then(function (r) {
      btn.disabled = false;
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '发送失败，消息未发出'); return; }
      inp.value = '';
      sound('send');
      poll(false);     // 由服务端回显，本地不造消息
    }).catch(function () { btn.disabled = false; hintIfOpen('网络异常，消息未发出'); });
  }
  function inlineEdit(el, onSave) {
    if (el._editing) return;
    el._editing = true;
    var old = el.textContent;
    var inp = document.createElement('input');
    inp.className = 'qq-inp'; inp.value = old;
    inp.setAttribute('aria-label', '编辑');
    el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
    function done(save) {
      if (!el._editing) return;
      el._editing = false;
      var v = inp.value.replace(/^\\s+|\\s+$/g, '');
      el.textContent = (save && v) ? v : old;
      if (save && v && v !== old) onSave(v);
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', function () { done(true); });
  }
  function setProfile(patch) {
    return api('/api/qq/profile', 'POST', patch).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '修改失败'); return false; }
      return hello();
    });
  }
  function askGroup() {
    hideMenu();
    var box = $('qqGroups');
    if ($('qqNewGroupBox')) return;
    var d = document.createElement('div');
    d.className = 'qq-search'; d.id = 'qqNewGroupBox';
    d.innerHTML = '<input class="qq-inp" id="qqNewGroupIn" placeholder="群名，回车创建" maxlength="24">' +
      '<button class="btn95" id="qqNewGroupOk">创建</button>' +
      '<button class="btn95" id="qqNewGroupNo">取消</button>';
    box.insertBefore(d, box.firstChild);
    var inp = $('qqNewGroupIn'); inp.focus();
    function close() { if (d.parentNode) d.parentNode.removeChild(d); }
    function go() {
      var name = inp.value.replace(/^\\s+|\\s+$/g, '');
      close();
      api('/api/qq/group', 'POST', { action: 'create', name: name }).then(function (r) {
        if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '建群失败'); return; }
        hello().then(function () {
          // openChat 已给出「还没有消息」提示，这里不再叠一条重复的黄字
          if (r.j.group) openChat('G' + r.j.group.id);
        });
      });
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      else if (e.key === 'Escape') close();
    });
    $('qqNewGroupOk').addEventListener('click', go);
    $('qqNewGroupNo').addEventListener('click', close);
  }
  function invite(id, gid) {
    api('/api/qq/group', 'POST', { action: 'invite', gid: gid, members: [id] }).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '邀请失败'); return; }
      hintIfOpen('已邀请入群。');
      hello();
    });
  }
  function leaveGroup(gid, isOwner) {
    api('/api/qq/group', 'POST', {
      action: (isOwner || state.admin) ? 'dismiss' : 'leave', gid: gid
    }).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '操作失败'); return; }
      state.cur = null;
      W98.closeWin($('qqChatWin'));
      hello();
    });
  }
  function delMsg(seq) {
    api('/api/qq/delete', 'POST', { seq: seq }).then(function (r) {
      if (!r.ok || !r.j.deleted) { hintIfOpen((r.j && r.j.error) || '无权删除该消息'); return; }
      for (var k in state.chats) {
        state.chats[k].msgs = state.chats[k].msgs.filter(function (x) { return x.seq !== seq; });
      }
      if (state.cur) renderLog();
    });
  }
  function adminPurge() {
    var row = $('qqAdminRow');
    if (!state.purgeArmed) {
      state.purgeArmed = true;
      row.textContent = '再点一次确认：清空全部消息';
      setTimeout(function () { state.purgeArmed = false; row.textContent = '管理员：清空全部消息'; }, 6000);
      return;
    }
    state.purgeArmed = false;
    row.textContent = '管理员：清空全部消息';
    api('/api/qq/admin', 'POST', { action: 'purge' }).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '清理失败'); return; }
      state.chats = {}; state.seq = 0;
      if (state.cur) renderLog();
      hintIfOpen('已清空 ' + r.j.deleted + ' 条消息。');
      hello();
    });
    hideMenu();
  }

  /* ─────────── 十、菜单 / 表情 / 退出 ─────────── */
  function hideTrayMenu() { var m = $('qqTrayMenu'); if (m) m.parentNode.removeChild(m); }
  function trayMenu(x, y) {
    hideTrayMenu();
    var m = document.createElement('div');
    m.className = 'ctxmenu'; m.id = 'qqTrayMenu';
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - 150)) + 'px';
    m.style.top = Math.max(4, y - 108) + 'px';
    m.innerHTML = '<div class="ctxi" data-a="open">打开面板</div>' +
      '<div class="ctxi" data-a="sound">' + (state.sound ? '关闭音效' : '开启音效') + '</div>' +
      '<div class="ctx-sep"></div><div class="ctxi" data-a="quit">退出 IM</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var it = closestEl(e.target, '.ctxi'); if (!it) return;
      var a = it.getAttribute('data-a'); hideTrayMenu();
      if (a === 'open') openPanel();
      else if (a === 'sound') toggleSound();
      else if (a === 'quit') quitQQ();
    });
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideTrayMenu(); document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function hideMenu() { $('qqMenu').hidden = true; }
  function toggleMenu() {
    var m = $('qqMenu');
    m.hidden = !m.hidden;
    if (m.hidden) return;
    var b = $('qqMenuBtn').getBoundingClientRect();
    var w = $('qqWin').getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(b.left - w.left, w.width - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, b.top - w.top - m.offsetHeight - 4) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideMenu(); document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function hideFace() { var b = $('qqFaceBox'); if (b) b.parentNode.removeChild(b); }
  function showFace(btn) {
    hideFace();
    var box = document.createElement('div');
    box.className = 'qq-face'; box.id = 'qqFaceBox';
    var html = '';
    for (var i = 0; i < FACES.length; i++) html += '<span class="qq-face-i" data-f="' + esc(FACES[i]) + '">' + esc(FACES[i]) + '</span>';
    box.innerHTML = html;
    box.addEventListener('click', function (ev) {
      var it = closestEl(ev.target, '.qq-face-i'); if (!it) return;
      $('qqIn').value += '/' + it.getAttribute('data-f') + ' ';
      $('qqIn').focus(); hideFace();
    });
    document.body.appendChild(box);
    var r = btn.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 184)) + 'px';
    box.style.top = Math.max(4, r.top - 150) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideFace(); document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function quitQQ() {
    stopLoops();
    state.started = false; state.booted = false; state.online = false;
    state.seq = 0; state.me = null; state.users = []; state.groups = []; state.admin = false;
    state.cur = null; state.unread = {}; state.chats = {};
    friends = [];
    var t = $('qqTray'); if (t) t.parentNode.removeChild(t);
    $('qqTyping').hidden = true;
    W98.closeWin($('qqWin')); W98.closeWin($('qqChatWin'));
    renderPanel(); renderOnline(); renderTaskFlash();
  }
  /* ─────────── 十一、初始化 ─────────── */
  function init() {
    state.sound = store('sound') !== '0';
    syncSound();
    $('qqMyAv').innerHTML = avHtml({ av: 'A', pal: PALS[0] });
    $('qqTabIcoF').innerHTML = avHtml({ av: 'A', pal: PALS[0] });
    $('qqTabIcoG').innerHTML = avHtml({ av: 'D', pal: GROUP_PAL });
    $('qqTabIcoR').innerHTML = avHtml({ av: 'E', pal: { k: '#2b6ea8', h: '#2b6ea8', s: '#f2c89b', m: '#a05050', c: '#3a6ea5' } });
    renderOnline(); renderPanel();

    $('qqSound').addEventListener('click', toggleSound);
    $('qqState').addEventListener('change', function () {
      var v = $('qqState').value;
      setProfile({ status: v }).then(function () {
        hintIfOpen(v === 'hidden' ? '已隐身：别人的在线列表里看不到你，管理员仍可见。' : '已上线：别人能看到你在线。');
      });
    });
    $('qqMyName').addEventListener('click', function () {
      inlineEdit(this, function (v) { setProfile({ name: v }); });
    });
    $('qqMySign').addEventListener('click', function () {
      inlineEdit(this, function (v) { setProfile({ sign: v }); });
    });
    $('qqGroups').addEventListener('click', function (e) {
      var g = closestEl(e.target, '.qq-gname');
      if (g) { var k = g.getAttribute('data-g'); state.fold[k] = !state.fold[k]; renderPanel(); return; }
      var row = closestEl(e.target, '.qq-f');
      if (row && !row.getAttribute('data-invite')) openChat(row.getAttribute('data-f'));
    });
    $('qqTabs').addEventListener('click', function (e) {
      var tab = closestEl(e.target, '.qq-tab'); if (!tab) return;
      state.tab = tab.getAttribute('data-tab');
      var kids = $('qqTabs').children;
      for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('on', kids[i] === tab);
      renderPanel();
    });
    $('qqFind').addEventListener('input', function () { state.find = $('qqFind').value; renderPanel(); });

    $('qqMenuBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
    $('qqMenu').addEventListener('click', function (e) { e.stopPropagation(); });
    $('qqQuitRow').addEventListener('click', function () { hideMenu(); quitQQ(); });
    $('qqNewGroupRow').addEventListener('click', askGroup);
    $('qqProfileRow').addEventListener('click', function () {
      hideMenu(); inlineEdit($('qqMyName'), function (v) { setProfile({ name: v }); });
    });
    $('qqRefreshRow').addEventListener('click', function () {
      hideMenu(); hello(); hintIfOpen('已刷新在线列表。');
    });
    $('qqAdminRow').addEventListener('click', adminPurge);

    $('qqFontBtn').addEventListener('click', function () {
      var big = $('qqLog').classList.toggle('big');
      this.classList.toggle('on', big);
    });
    $('qqFaceBtn').addEventListener('click', function (e) { e.stopPropagation(); showFace(this); });
    $('qqCloseBtn').addEventListener('click', function () { W98.closeWin($('qqChatWin')); });
    $('qqSendBtn').addEventListener('click', sendMsg);
    $('qqIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMsg(); }
    });
    /* 消息行「删」：本人删自己的，管理员删任意 */
    $('qqLog').addEventListener('click', function (e) {
      var b = closestEl(e.target, '.qq-del');
      if (b) delMsg(Number(b.getAttribute('data-seq')));
    });
    /* 群资料栏：邀请 / 退出或解散 */
    $('qqChatSide').addEventListener('click', function (e) {
      var inv = closestEl(e.target, '.qq-f[data-invite]');
      if (inv) {
        var f = friendById(state.cur);
        if (f && f.isGroup) invite(inv.getAttribute('data-invite'), f.gid);
        return;
      }
      var act = closestEl(e.target, '[data-act="leave"]');
      if (act) {
        var g = friendById(state.cur);
        if (g && g.isGroup) leaveGroup(g.gid, g.mine || state.admin);
      }
    });
  }
  init();

  /* 给 HOME_JS 的钩子用：openApp / closeWin / tickClock / fillSys / 任务栏按钮 */
  window.QQ = {
    openPanel: openPanel,
    /* 关闭聊天窗不再停轮询：真实聊天必须持续收消息，否则会漏信。
       保留这个空接口只为兼容桌面 closeWin 钩子。 */
    stopPlay: function () {},
    syncFlash: renderTaskFlash
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
  + 'body{margin:0;background:#c0c0c0;font:13px/1.7 "MS Sans Serif",Tahoma,"Microsoft YaHei",sans-serif;}'
  + '.wrap{max-width:520px;margin:10px auto;padding:0 12px;}'
  /* 起始页按 Win98 经典「链接列表页」做：一块白纸 + 若干链接行，
     不堆卡片、不堆大按钮 —— 与整套 98 界面同一种语言 */
  + '.page{background:#fff;border:2px solid;border-color:#dfdfdf #808080 #808080 #dfdfdf;'
  + 'box-shadow:2px 2px 0 #0a0a0a;padding:14px 18px 16px;}'
  + 'h1{font-size:17px;margin:0 0 10px;color:#000080;}'
  + 'hr{border:0;border-top:1px solid #808080;border-bottom:1px solid #fff;margin:0 0 10px;}'
  + '.lnk{display:block;padding:3px 4px;color:#000080;text-decoration:none;font-size:13px;}'
  + '.lnk:hover{background:#000080;color:#fff;}'
  + '.lnk .u{color:#404040;font-size:11px;margin-left:6px;}'
  + '.lnk:hover .u{color:#c0c0c0;}'
  + '.tip{font-size:11px;color:#505050;margin:12px 0 0;padding-top:8px;'
  + 'border-top:1px dotted #b0b0b0;}'
  + '.foot{margin-top:10px;font-size:11px;color:#5a5a5a;text-align:center;}'
  + '</style></head><body><div class="wrap"><div class="page">'
  + '<h1>知行工作室</h1>'
  /* 主页里的外链一律交回桌面壳导航（走站内代理渲染），
     不用 target=_blank —— 那会跳出到系统浏览器，与「项目内沉浸式」相违。
     官网只出现一次：标题即品牌，下面直接是链接，不再重复「官方网站」行。 */
  + '<hr>'
  + '<a class="lnk" href="#" onclick="parent.postMessage({__7md:1,type:\'nav\',url:\'https://w3b.pub/\'},\'*\');return false">'
  + '知行工作室官网<span class="u">w3b.pub</span></a>'
  + '<a class="lnk" href="#" onclick="parent.postMessage({__7md:1,type:\'nav\',url:\'\'},\'*\');return false">'
  + '7喵快传 · 文件服务<span class="u">上传与分享文件</span></a>'
  + '<p class="tip">网页在本窗口内直接打开，不离开本系统。'
  + '地址栏可输入网址或 10 位文件口令，回车即达。</p>'
  + '<div class="foot">(C) 1998-2026 知行工作室</div>'
  + '</div></div></body></html>';

/* ── IE 内嵌代理：把外站收进项目内部渲染 ─────────────────────────────
   外站几乎都带 X-Frame-Options: DENY 或 CSP frame-ancestors 'none'，
   直接塞进 iframe 只会得到一块白板（GitHub 实测确认）。所以由服务端
   代抓 HTML，剥掉这两道门禁，再以本站身份下发：iframe 里显示的是
   「本站的一个页面」，于是「看网站」这件事全程留在项目内部，
   不会跳到系统浏览器 —— 这才是内置浏览器该有的样子。

   安全：
     · 代理页给 iframe 套 sandbox（无 allow-same-origin），外站脚本只能
       活在自己的沙箱里，读不到本项目的 DOM 与本地存储；
     · 代理只取 http/https，且域名解析结果落在内网/回环/链路本地一律
       拒绝（防 SSRF：否则本站会变成打内网的跳板）；
     · 响应体有体积上限与超时，错误一律回项目内的 98 风格错误页。 */
const PROXY_MAX_BYTES = 6 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 20000;
const PROXY_MAX_HOP = 5;

/* 内网 / 回环 / 链路本地 / CGNAT / 组播 地址一律不代理 */
function isPrivateAddr(ip) {
  const s = String(ip || '').toLowerCase();
  if (s.includes(':')) {
    if (s === '::1' || s === '::') return true;
    if (/^f[cd]/.test(s)) return true;                 /* fc00::/7 唯一本地 */
    if (/^fe[89ab]/.test(s)) return true;              /* fe80::/10 链路本地 */
    if (s.startsWith('::ffff:')) return isPrivateAddr(s.slice(7));
    return false;
  }
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;   /* 本机 / 私有 A */
  if (a === 169 && b === 254) return true;              /* 链路本地（云 metadata） */
  if (a === 172 && b >= 16 && b <= 31) return true;     /* 私有 B */
  if (a === 192 && b === 168) return true;              /* 私有 C */
  if (a === 100 && b >= 64 && b <= 127) return true;    /* CGNAT */
  if (a >= 224) return true;                            /* 组播 / 保留 */
  return false;
}

function proxyDecodeBody(buf, ct) {
  let cs = (/(?:charset=)([A-Za-z0-9_-]+)/i.exec(ct || '') || [])[1];
  if (!cs) {
    const head = buf.subarray(0, 4096).toString('latin1');
    cs = (/<meta[^>]+charset=["']?([A-Za-z0-9_-]+)/i.exec(head) || [])[1];
  }
  cs = (cs || 'utf-8').toLowerCase();
  if (cs === 'utf8') cs = 'utf-8';
  if (cs === 'utf-8') return buf.toString('utf8');
  /* Node 自带 ICU，gb18030 / big5 / shift_jis 等常见编码都能解 */
  try { return new TextDecoder(cs, { fatal: false }).decode(buf); } catch (e) { return buf.toString('utf8'); }
}

/* 桥接脚本：把页面里的跳转交回桌面壳统一处理（桌面壳才有历史栈与地址栏） */
const PROXY_BRIDGE_JS = `<script>(function(){
  function post(m){ try{ parent.postMessage(Object.assign({__7md:1}, m), '*'); }catch(e){} }
  function abs(href){ try{ var a=document.createElement('a'); a.href=href; return a.href; }catch(e){ return null; } }
  /* ① 链接点击：全部拦下。target=_blank 也不例外 —— 交给桌面壳在项目内开窗口，
        绝不让浏览器真的弹出系统浏览器。 */
  document.addEventListener('click', function(e){
    var t=e.target;
    while(t && t.tagName!=='A' && t!==document.documentElement) t=t.parentNode;
    if(!t || t.tagName!=='A') return;
    var h=t.getAttribute('href');
    if(!h || h.charAt(0)==='#') return;
    var u=abs(t.href);
    if(!u) return;
    e.preventDefault(); e.stopPropagation();
    var blank=(t.getAttribute('target')||'').toLowerCase()==='_blank';
    post({type:'nav', url:u, blank:blank});
  }, true);
  /* ② window.open：不让它真的开窗，改成「当前页跳转」，
        由桌面壳决定是本窗口导航还是开项目内的新窗口。 */
  var _open=window.open;
  window.open=function(u,t,f){
    var a=abs(u||'');
    if(a){ post({type:'nav', url:a, blank:true}); return null; }
    if(_open){ try{ return _open.call(window,u,t,f); }catch(e){} }
    return null;
  };
  /* ③ 表单提交：GET 拼进地址交回桌面壳；POST 明说不支持，不静默吞掉。 */
  document.addEventListener('submit', function(e){
    e.preventDefault();
    var f=e.target;
    if(!f || !f.action) return;
    if((f.method||'get').toLowerCase()!=='get'){
      post({type:'note', msg:'该表单需要提交数据（如登录、上传），应用内暂不支持。\\n可在系统浏览器中打开该网址。'});
      return;
    }
    var u=abs(f.action);
    if(!u) return;
    try{ var q=new URL(u); new FormData(f).forEach(function(v,k){ q.searchParams.append(k,v); }); u=q.href; }catch(err){}
    post({type:'nav', url:u});
  }, true);
  var REAL='';
  try{ REAL=new URL(location.href).searchParams.get('u')||''; }catch(e){}
  /* 页面标题可能为空（不少站点用 JS 动态生成，或干脆没有），
     这时回传域名，桌面壳据此显示「域名 - Internet Explorer」 */
  var ttl=document.title||'';
  if(!ttl && REAL){ try{ ttl=new URL(REAL).hostname; }catch(e){} }
  post({type:'info', url:REAL||location.href, title:ttl});
})();<\/script>`;

/* 把外站 HTML 改造成「可在本项目内安全渲染」的版本 */
function proxyRewriteHtml(html, finalUrl) {
  let out = html;
  /* 外站自带的 CSP meta 会连 frame-ancestors 一起生效，
     连内联桥接脚本也会被它拦掉 —— 全部摘掉，代理页的策略由响应头统一给 */
  out = out.replace(/<meta[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  out = out.replace(/<meta[^>]*http-equiv=["']?x-frame-options["']?[^>]*>/gi, '');
  /* 统一 utf-8（正文已转码） */
  out = out.replace(/<meta[^>]*charset=["']?[A-Za-z0-9_-]+["']?[^>]*>/gi, '<meta charset="utf-8">');
  out = out.replace(/<meta[^>]*http-equiv=["']?content-type["']?[^>]*>/gi, '');
  /* 原站自己的 <base> 会把相对路径带偏，摘掉换成我们的 */
  out = out.replace(/<base\b[^>]*>/gi, '');
  /* 相对路径按最终 URL 的目录解析；重定向后才是真正的资源位置 */
  let dir;
  try { dir = new URL('.', finalUrl).href; } catch (e) { dir = finalUrl; }
  const baseTag = '<base href="' + dir.replace(/"/g, '&quot;') + '">';
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, '<head$1>' + baseTag);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html([^>]*)>/i, '<html$1><head>' + baseTag + '</head>');
  else out = baseTag + out;
  /* 注入桥接脚本：跳转交回桌面壳，页面因此永远留在项目内部 */
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, PROXY_BRIDGE_JS + '</body>');
  else out += PROXY_BRIDGE_JS;
  return out;
}

/* 代理失败时的项目内错误页（98 风格，绝不给白屏） */
const IE_ERROR_HTML = (msg) => '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><style>'
  + 'html{scrollbar-width:none}html::-webkit-scrollbar{width:0;height:0;display:none}'
  + 'body{margin:0;background:#c0c0c0;font:13px/1.6 "MS Sans Serif",Tahoma,"Microsoft YaHei",sans-serif;}'
  + '.wrap{max-width:520px;margin:10px auto;padding:0 12px;}'
  + '.page{background:#fff;border:2px solid;border-color:#dfdfdf #808080 #808080 #dfdfdf;'
  + 'box-shadow:2px 2px 0 #0a0a0a;padding:14px 18px 16px;}'
  + 'h1{font-size:16px;margin:0 0 10px;color:#000080;}'
  + 'p{font-size:12px;color:#404040;margin:0 0 10px;line-height:1.8;}'
  /* 与 IE 起始页同一套链接行语言，不另起一套按钮样式 */
  + '.lnk{display:block;padding:3px 4px;color:#000080;text-decoration:none;font-size:13px;}'
  + '.lnk:hover{background:#000080;color:#fff;}'
  + '.tip{font-size:11px;color:#5a5a5a;margin-top:10px;padding-top:8px;'
  + 'border-top:1px dotted #b0b0b0;}'
  + '</style></head><body><div class="wrap"><div class="page">'
  + '<h1>无法显示该网页</h1><p>' + String(msg).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;')) + '</p>'
  + '<p>出于安全考虑，本站只代理公开可访问的 http/https 网页；'
  + '需要登录、需要提交表单或拒绝被内嵌的站点，请改用系统浏览器打开。</p>'
  + '<a class="lnk" href="#" onclick="parent.postMessage({__7md:1,type:\'nav\',url:\'\'},\'*\');return false">'
  + '返回 IE 起始页</a>'
  + '<div class="tip">Internet Explorer 5.0（网页仿真版）· 代理请求由本站服务端代发</div>'
  + '</div></div></body></html>';

async function proxyFetchHtml(target, hop) {
  hop = hop || 0;
  if (hop > PROXY_MAX_HOP) throw new Error('重定向次数过多');
  let url;
  try { url = new URL(target); } catch (e) { throw new Error('网址格式不正确'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http / https 网址');
  let addrs;
  try { addrs = await dns.promises.lookup(url.hostname, { all: true }); }
  catch (e) { throw new Error('域名解析失败'); }
  if (!addrs || !addrs.length) throw new Error('域名解析失败');
  for (const a of addrs) if (isPrivateAddr(a.address)) throw new Error('该地址位于内网，出于安全考虑不予代理');
  const addr = addrs[0];
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  const res = await new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win98; rv:11.0) Gecko/19980101 Firefox/11.0',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'accept-encoding': 'gzip, deflate',
        'host': url.host,
      },
      servername: url.hostname,
      /* 固定用已校验过的解析结果，避免 DNS rebinding 绕过内网校验 */
      lookup: (h, o, cb) => {
        /* Node 20+ 解析器会以 all:true 调用，期望返回地址数组 */
        if (o && o.all) return cb(null, [{ address: addr.address, family: addr.family }]);
        return cb(null, addr.address, addr.family);
      },
      timeout: PROXY_TIMEOUT_MS,
    }, (r) => {
      const st = r.statusCode || 0;
      if (st >= 300 && st < 400 && r.headers.location) {
        r.resume();
        try { resolve({ redirect: new URL(r.headers.location, url).toString() }); }
        catch (e) { reject(new Error('重定向地址无效')); }
        return;
      }
      const ct = String(r.headers['content-type'] || '');
      const ce = String(r.headers['content-encoding'] || '').toLowerCase();
      if (!/text\/html|application\/xhtml/i.test(ct)) {
        r.resume();
        resolve({ notHtml: true, status: st });
        return;
      }
      const chunks = [];
      let len = 0, over = false;
      r.on('data', (c) => {
        len += c.length;
        if (len > PROXY_MAX_BYTES) { over = true; r.destroy(); return; }
        chunks.push(c);
      });
      r.on('end', () => { if (!over) resolve({ html: Buffer.concat(chunks), ct, ce, status: st }); });
      r.on('close', () => { if (over) resolve({ tooBig: true }); });
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    req.end();
  });

  if (res.redirect) return proxyFetchHtml(res.redirect, hop + 1);
  if (res.tooBig) throw new Error('页面体积过大，无法在应用内显示');
  if (res.notHtml) throw new Error('该地址不是网页（' + (res.status || '') + '）');

  let buf = res.html;
  /* content-encoding 来自响应头，不在 content-type 里 —— 早先从 ct 匹配导致
     gzip 响应没解压，页面成了二进制乱码（28KB → 8KB 且满屏乱码）。 */
  if (/gzip/.test(res.ce || '')) {
    try { buf = zlib.gunzipSync(buf); } catch (e) { throw new Error('页面解码失败'); }
  } else if (/deflate/.test(res.ce || '')) {
    try { buf = zlib.inflateSync(buf); } catch (e) { throw new Error('页面解码失败'); }
  }
  const html = proxyDecodeBody(buf, res.ct);
  /* raw：改写前的原文（"查看源代码"要在项目内看真源码，不能看改写版） */
  return { html: proxyRewriteHtml(html, target), raw: html, finalUrl: target };
}

async function handleIeProxy(req, res, url) {
  const target = url.searchParams.get('u') || '';
  const raw = url.searchParams.get('raw');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(IE_ERROR_HTML('缺少目标网址。'));
  }
  try {
    /* 首发常因 TLS 握手抖动而超时（实测 GitHub 首次连接会挂），
       重试一次即可命中正常路径 */
    let out;
    try { out = await proxyFetchHtml(target, 0); }
    catch (e1) {
      if (!/超时|ECONNRESET|EPIPE|socket hang up/i.test(String(e1 && e1.message))) throw e1;
      out = await proxyFetchHtml(target, 0);
    }
    /* 「查看源代码」：回原文（纯文本），在项目内的源码窗里看 */
    if (raw) {
      const rawBuf = Buffer.from(out.raw, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': rawBuf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(rawBuf);
    }
    const body = Buffer.from(out.html, 'utf8');
    /* 注意：这里刻意不下发 X-Frame-Options，也不设 frame-ancestors ——
       代理页要被 sandbox iframe 装载，opaque origin 下 SAMEORIGIN 会被误判为跨站。
       沙箱（见 iframe 的 sandbox 属性）才是这里的隔离手段。 */
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src * data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; "
        + "style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src *; "
        + 'frame-src *; media-src * blob:; object-src \'none\'; form-action *; base-uri *',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(body);
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(IE_ERROR_HTML(e && e.message ? e.message : '代理请求失败'));
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const sc = shareCode(req);   // 平台分享凭证：透传到页面每一个请求，不依赖 Cookie
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
        return sendAsset(res, 'text/html; charset=utf-8', homePageHtml(sc));
      }
      if (pathname === '/home.css') return sendAsset(res, 'text/css; charset=utf-8', homeCssHtml());
      /* /home.js = HOME_JS（桌面本体）+ QQ_JS（IM 聊天模块），同一份 IIFE 纪律 */
      if (pathname === '/home.js') return sendAsset(res, 'application/javascript; charset=utf-8', HOME_JS + '\n' + QQ_JS);
      if (pathname === '/favicon.ico') return sendAsset(res, 'image/svg+xml', FAVICON);
      // IE 内嵌代理：把外站抓回来在本项目内渲染（详见 handleIeProxy 注释）
      if (pathname === '/ie-proxy') return handleIeProxy(req, res, url);
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
        return sendAsset(res, 'application/manifest+json; charset=utf-8', rootManifestJson(sc));
      }
      if (pathname === '/sw.js') {
        // VERSION 由外壳内容哈希派生：前端内容一变缓存名就换代，
        // 彻底治好「PWA 装完后永远命中旧外壳（CSS/JS 不更新）」这个顽疾；
        // 同一构建重启不换名，避免无谓的缓存重放。
        const buf = Buffer.from(ROOT_SW_JS.replace('__BUILD_ID__', shellVersion()), 'utf8');
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
      // 在线聊天：真实用户 / 单聊 / 群聊。挂在根段（QQ 在桌面里），
      // 身份与权限复用 7mdid + canManage，凭证透传由前端 withSC 统一处理。
      if (pathname.indexOf('/api/qq/') === 0) return handleQQ(req, res, url);
      return sendAsset(res, 'text/html; charset=utf-8', homePageHtml(sc).replace('<body>', '<body class="nf">'), 404);
    }
    if (req.method === 'POST') {
      // 登录发生在此之前还没有任何口令，所以挂在根段而非 /s/<口令>/ 下。
      if (pathname === '/api/admin-login') return handleAdminLogin(req, res);
      if (pathname.indexOf('/api/qq/') === 0) return handleQQ(req, res, url);
    }
    return notFound(res);
  }
  const role = roleFor(m[1]);
  if (!role) return notFound(res);
  // 可信环境（显式配置的 IP）自动提权为管理员：识别到安全环境就有它的权限。
  req.__isAdmin = (role === 'admin') || trustedEnv(req);
  const P = perms(req.__isAdmin ? 'admin' : role);
  const rest = m[2] || '/';
  // 每个进入分享页的请求都确保持有设备凭证：页面导航首屏即自动签发，无感、免登录。
  // 静态资源跳过签发（cookie 已由先到的页面响应写入），避免首屏并发各签一个身份。
  const isAsset = /^\/(app\.css|app\.js|qr\.js|favicon\.ico|sw\.js|manifest\.webmanifest|icons\/)/.test(rest);
  ensureOwner(req, res, !isAsset);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (rest === '/' || rest === '/index.html') return sendAsset(res, 'text/html; charset=utf-8', pageHtml(m[1], sc));
    // 文件页：同一个 SPA，客户端按路径自动打开对应文件的预览。
    // 分享链接与二维码指向这里，而不是 /d/<id>（那是强制下载的直链）。
    // 必须精确匹配 id，否则会把 /f/app.js 这类相对资源请求也吞成 HTML。
    if (/^\/f\/[A-Za-z0-9_-]+$/.test(rest)) {
      if (!P.canList) return notFound(res);
      return sendAsset(res, 'text/html; charset=utf-8', pageHtml(m[1], sc));
    }
    if (rest === '/app.css') return sendAsset(res, 'text/css; charset=utf-8', CSS);
    if (rest === '/app.js') return sendAsset(res, 'application/javascript; charset=utf-8', APP_JS);
    if (rest === '/qr.js') return sendAsset(res, 'application/javascript; charset=utf-8', QR_JS);
    if (rest === '/favicon.ico') return sendAsset(res, 'image/svg+xml', FAVICON);
    // ── PWA：manifest / Service Worker / 图标 ──
    if (rest === '/manifest.webmanifest') {
      return sendAsset(res, 'application/manifest+json; charset=utf-8', manifestJson(m[1], sc));
    }
    if (rest === '/sw.js') {
      // SW 脚本：no-cache 让浏览器及时检测更新；不挂 CSP（SW 有独立上下文，
      // 挂了反而会限制其内部 fetch/cache 行为）。
      // VERSION 随外壳内容哈希变化，避免「PWA 装完永远旧外壳」。
      const buf = Buffer.from(SW_JS.replace('__BUILD_ID__', shellVersion()), 'utf8');
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
      return sendJson(res, 200, listPayload(P, req));
    }
    // 自描述元信息：Agent 的入口。不受 canList 限制，拿到链接就能自举。
    if (rest === '/api/meta') {
      return sendJson(res, 200, metaPayload(P, baseUrlFor(req, m[1])));
    }
    // 断点续传：网络恢复后查询会话已收到第几片，从那片接着传。
    if (rest === '/api/status') return handleStatus(req, res, url);
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
    // 解锁 / 续期不属于「写入」：访客拿到分享链接也应能输提取码、给临期文件续命。
    if (rest === '/api/unlock') return handleUnlock(req, res);
    if (rest === '/api/renew') return handleRenew(req, res);
    const isWrite = rest === '/api/put' || rest === '/api/init' || rest === '/api/chunk' ||
      rest === '/api/finish' || rest === '/api/cancel' || rest === '/api/text';
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
    if (rest === '/api/cancel') return handleCancel(req, res);
    if (rest === '/api/finish') return handleFinish(req, res, m[1]);
    if (rest === '/api/text') {
      // 文字分享同样写盘，之前漏了限流：脚本可以不受约束地刷满磁盘。
      if (rateLimited(clientIp(req))) {
        return sendJson(res, 429, { error: '操作过于频繁，请稍后再试' });
      }
      return handleText(req, res, m[1]);
    }
    if (rest === '/api/delete') {
      // 不再按链接角色一刀切：访客也能删自己上传的，逐条归属校验在 handleDelete。
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
  '        <button class="tb-btn tb-install download" id="tbInstall" type="button" hidden aria-label="安装到桌面" title="安装到桌面"></button>',
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
  '      <fieldset class="panel upopt" id="upOpt">',
  '        <legend>上传设置</legend>',
  '        <div class="upopt-row">',
  '          <label for="expSel">保留时长</label>',
  '          <select id="expSel"></select>',
  '        </div>',
  '        <div class="upopt-row">',
  '          <label for="pwInput">访问密码</label>',
  '          <input id="pwInput" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空 = 不设密码">',
  '          <button id="pwToggle" type="button" class="mini">显示</button>',
  '        </div>',
  '        <p class="upopt-note" id="upOptNote">默认保留 24 小时，可在上方改档位（1 小时 / 6 小时 / 1 天 / 3 天 / 7 天 / 30 天 / 永久）；一次上传共用同一时长与密码。你传的文件只有你和管理员能改时长、续期、删除。</p>',
  '      </fieldset>',
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
  '        <div class="list-bar" id="listBar">',
  '          <span class="lb-group">',
  '            <label class="lb-sel"><input type="checkbox" id="selAll"><span>全选</span></label>',
  '            <span class="lb-count" id="selCount"></span>',
  '            <button type="button" class="lb-del" id="delSel" disabled>删除选中</button>',
  '          </span>',
  '          <button id="refresh" type="button" class="lb-refresh">刷新</button>',
  '        </div>',
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
  '      <span>© 2026 <a href="#" id="studioLink" rel="noopener noreferrer">知行工作室</a></span>',
  '    </div>',
  '',
  '  </div>',
  '</div>',
  '',
  '<div id="viewer" class="mask viewer" hidden>',
  '  <div class="dialog viewer-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="viewerName">预览</span>',
  '      <button id="viewerFs" class="tb-btn fs" type="button" aria-label="全屏" title="全屏 / 退出全屏"></button>',
  '      <button id="viewerClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
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
  '      <button id="qrClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
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
  '      <button id="infoClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <div class="info-body">',
  '        <div class="info-row"><span class="info-k">当前身份</span><span class="info-v" id="infoRole">…</span></div>',
  '        <p class="info-note" id="infoNote"></p>',
  '        <ul class="perm-list" id="infoPerms"></ul>',
  '        <div class="info-row"><span class="info-k">单文件上限</span><span class="info-v" id="infoMax">…</span></div>',
  '        <div class="info-row"><span class="info-k">保留时长</span><span class="info-v" id="infoTtl">…</span></div>',
  '        <div class="info-row"><span class="info-k">可选档位</span><span class="info-v" id="infoExpChoices">…</span></div>',
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
  '<div id="askModal" class="mask" hidden>',
  '  <div class="dialog ask-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="askTitle">…</span>',
  '      <button id="askClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <p class="ask-note" id="askNote"></p>',
  '      <div id="askPwWrap" class="ask-field" hidden>',
  '        <label for="askPw">访问密码</label>',
  '        <input id="askPw" type="password" autocomplete="off" spellcheck="false" placeholder="请输入访问密码">',
  '      </div>',
  '      <div id="askExpWrap" class="ask-field" hidden>',
  '        <label for="askExp">保留时长</label>',
  '        <select id="askExp"></select>',
  '      </div>',
  '      <div class="dlg-foot"><button id="askOk" class="wide" type="button">确定</button></div>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="sheet" class="mask mask-bottom" hidden>',
  '  <div class="dialog sheet-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="sheetName">操作</span>',
  '      <button id="sheetClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
  '    </div>',
  '    <div class="dlg-body sheet-body">',
  '      <button class="sheet-item" data-act="preview" type="button">预览</button>',
  '      <button class="sheet-item" data-act="download" type="button">下载</button>',
  '      <button class="sheet-item" data-act="copylink" type="button">复制分享链接（打开先看）</button>',
  '      <button class="sheet-item" data-act="copydirect" type="button">复制直链（直接下载）</button>',
  '      <button class="sheet-item" data-act="renew" type="button">续期 / 改保留时长…</button>',
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
  /* 统一控制按钮图标（与桌面壳同一套，杜绝 ×/✕/□ 混用） */
  --ico-x:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5' stroke='%23000' stroke-width='2' stroke-linecap='square'/%3E%3C/svg%3E");
  --ico-min:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='3' y='9.5' width='8' height='2' fill='%23000'/%3E%3C/svg%3E");
  /* --ico-max（方框）保留备用，当前统一用 --ico-expand（四角箭头） */
  --ico-max:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='3' y='3' width='8' height='8' fill='none' stroke='%23000' stroke-width='1.4'/%3E%3Crect x='3' y='3' width='8' height='1.6' fill='%23000'/%3E%3C/svg%3E");
  --ico-restore:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='5' y='4' width='6' height='6' fill='none' stroke='%23000' stroke-width='1.3'/%3E%3Crect x='3' y='2' width='6' height='6' fill='none' stroke='%23000' stroke-width='1.3'/%3E%3C/svg%3E");
  --ico-expand:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M2 5V2H5 M9 2H12V5 M12 9V12H9 M5 12H2V9' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square'/%3E%3C/svg%3E");
  --ico-download:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M7 2V9 M4 6.5 7 9.5 10 6.5' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square' stroke-linejoin='miter'/%3E%3Crect x='3' y='11' width='8' height='1.8' fill='%23000'/%3E%3C/svg%3E");
  --ico-down:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M7 2V9 M4 6 7 9 10 6' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square'/%3E%3Crect x='2.5' y='11' width='9' height='1.8' fill='%23000'/%3E%3C/svg%3E");
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
/* 标题占满剩余空间：多个标题栏按钮（如预览的全屏+关闭）才会成组靠右，
   而不是被 space-between 拆到中间 —— 与 Win98 的按钮排布语言一致 */
.tb-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-mode{
  font-weight:400;font-size:11px;flex:none;border-radius:0;
  background:transparent;border:1px solid transparent;color:#fff;
  padding:2px 8px;min-height:19px;box-shadow:none;
}
.tb-mode:hover{background:rgba(255,255,255,.20);border-color:rgba(255,255,255,.40)}
.tb-mode:active{box-shadow:none;padding:2px 8px;background:rgba(255,255,255,.30)}
/* 标题栏右侧动作区：安装按钮 + 模式按钮 */
.tb-actions{display:flex;align-items:center;gap:5px;flex:none}
.tb-install{font-size:0;font-weight:700;color:transparent}
.tb-install::before{content:"";position:absolute;left:50%;top:50%;width:13px;height:13px;transform:translate(-50%,-50%);background:var(--ico-download) center/contain no-repeat}
.tb-btn{
  width:16px;height:14px;min-height:0;padding:0;flex:none;position:relative;
  display:grid;place-items:center;font-size:10px;font-weight:700;line-height:1;
  background:var(--face);color:var(--text);
  box-shadow:var(--raise);
}
.tb-btn:active{box-shadow:var(--sink)}
/* 关闭 / 全屏按钮共享桌面壳那套统一图标（同一功能全站同形）
   用 ::before 承载图标，避开移动端 .tb-btn::after 的 44px 触控覆盖层 */
.tb-btn.close,.tb-btn.fs{
  color:transparent;font-size:0;
  /* 与 .wclose（扫雷/查看源码等 window95 窗口）完全一致的外观：
     经典灰立体 Win98 标题栏按钮，避免同屏出现两套关闭钮 */
  background:#c0c0c0;
  box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px #808080,inset 2px 2px #dfdfdf;
}
.tb-btn.close::before,.tb-btn.fs::before{
  content:"";position:absolute;left:50%;top:50%;z-index:1;
  width:9px;height:9px;transform:translate(-50%,-50%);
  background:var(--ico-x) center/contain no-repeat;
}
/* 全屏图标与桌面壳窗口最大化按钮完全同一个（--ico-expand 四角箭头），
   且任何状态恒定不变（含已全屏）——「放大到极限」全站一种图形，
   已放大与否由 aria-label/title 与行为表达 */
.tb-btn.fs::before{background-image:var(--ico-expand)}
.tb-btn.fs.is-full::before{background-image:var(--ico-expand)}

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
/* 存储已满：保留入口但明确"不可用"，不让用户误以为能传 */
.drop.is-full{cursor:not-allowed;opacity:.62}
.drop.is-full:hover{background:#f4f4f4}
.drop.is-full.over{background:#f4f4f4}
.drop.is-full .drop-inner{border-color:var(--sh)}
.drop.is-full .drop-title{color:var(--dis)}
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

/* ── 上传设置：时长 + 访问密码（Win98 分组框风格） ── */
.upopt{margin-top:9px}
.upopt-row{display:flex;align-items:center;gap:6px;margin:5px 0}
.upopt-row label{flex:0 0 62px;font-size:12px;color:#303030}
.upopt-row select,.upopt-row input[type=password],.upopt-row input[type=text]{
  flex:1;min-width:0;font-size:12px;min-height:27px;padding:3px 6px;
  background:var(--win);color:var(--text);box-shadow:var(--sink);border:0;border-radius:0;
}
.upopt-row select:focus,.upopt-row input:focus{outline:1px dotted var(--dk);outline-offset:-3px}
button.mini{flex:0 0 auto;font-size:11px;min-height:27px;padding:2px 9px}
.upopt-note{margin:7px 0 0;font-size:11px;color:#505050;line-height:1.5}
.upopt.locked-pw .upopt-note{color:#006000}

/* ── 列表状态：锁标 / 临期 / 已过期 ── */
.ftag{display:inline-block;margin-left:6px;padding:0 4px;font-size:10px;line-height:15px;
  border:1px solid var(--sh);background:var(--face);color:#404040;vertical-align:1px}
.ftag.lock{color:#000080;border-color:#000080}
.ftag.mine{color:#006400;border-color:#006400}
.ftag.soon{color:#a06000;border-color:#a06000}
.ftag.gone{color:#a00000;border-color:#a00000}
.row.st-soon .fsub,.row.st-gone .fsub{color:#a00000}
.row.st-gone{opacity:.68}
.ico.locked{background:repeating-linear-gradient(45deg,#e8e8e8 0 4px,#d0d0d0 4px 8px)}

/* ── 通用对话框（解锁 / 续期） ── */
.ask-dlg{width:min(360px,100%)}
.ask-note{font-size:12px;color:#303030;line-height:1.6;margin:0 0 10px}
.ask-field{margin:9px 0}
.ask-field label{display:block;font-size:12px;margin-bottom:4px}
.ask-field input,.ask-field select{
  width:100%;min-height:30px;padding:4px 7px;font-size:13px;
  background:var(--win);color:var(--text);box-shadow:var(--sink);border:0;border-radius:0;
}
.ask-field input:focus,.ask-field select:focus{outline:1px dotted var(--dk);outline-offset:-3px}
.ask-field[hidden]{display:none}
.ask-dlg .dlg-foot button{min-height:32px}

/* ── 上传队列：经典分段进度条 ── */
.queue{margin-top:9px;display:flex;flex-direction:column;gap:5px}
.qitem{background:var(--face);box-shadow:var(--raise);padding:7px 9px}
.qtop{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}
.qname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qpct{flex:none;font-variant-numeric:tabular-nums;color:#303030}
.qcancel{flex:none;width:20px;min-width:20px;height:18px;min-height:18px;padding:0;line-height:14px;font-size:14px;color:#a00000}
.qcancel:disabled{opacity:.45}
.qitem.cancelled .bar>i{background:repeating-linear-gradient(90deg,#808080 0 7px,transparent 7px 9px)}
.qitem.cancelled .qpct{color:#606060}
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
.qretry{margin-top:6px;font-size:11.5px;min-height:24px;padding:2px 10px}

/* ── 批量上传汇总条：几十个文件时只留一条总进度，不刷屏 ── */
.qsum{background:var(--face);box-shadow:var(--raise);padding:8px 9px;margin-bottom:2px}
.qsum-top{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}
.qsum-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qsum-count{flex:none;font-variant-numeric:tabular-nums;color:#303030}
.qsum.msg-ok .qsum-count{color:#006000}
.qsum.msg-err .qsum-count{color:#a00000}
.qsum-acts{display:flex;gap:5px;margin-top:7px}
.qsum-acts button{flex:1;min-width:0;font-size:11.5px;min-height:26px;padding:3px 8px}
.qsum-acts[hidden]{display:none}

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

/* ── 列表工具条：全选组（左）+ 刷新（右），同一行垂直居中 ──
   旧版把刷新 absolute 钉在 fieldset 上边框线上，批量条却在边框线下方的
   正常流里，两者天生错开一行；legend 还得硬留 padding-right 让位。
   现在全部收进一条 flex 工具条，间距/对齐由一处控制。*/
.list-bar{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  min-height:30px;margin:0 0 2px;
  /* 与下方行内复选框左边缘对齐：.list padding 2 + .row padding-left 6 */
  padding-left:8px;
}
.lb-group{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
/* 没有「可管理」的文件时隐藏批量控件，但保留刷新（服务端本就不给删他人文件） */
.list-bar:not(.show) .lb-group{display:none}
.lb-sel{
  display:inline-flex;align-items:center;gap:6px;padding:5px 0;
  cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none;
  touch-action:manipulation;
}
.lb-sel>span{font-size:12px}
.lb-count{font-size:11.5px;color:#404040;white-space:nowrap}
.lb-del,.lb-refresh{font-size:11.5px;padding:4px 10px;min-height:28px;white-space:nowrap}
.lb-del:disabled{color:var(--dis);opacity:.6;cursor:default}
.lb-refresh{margin-left:auto;position:relative}
/* 触屏：刷新热区补足 44px，按钮本体不偏移，不破坏这一行的对齐 */
.lb-refresh::after{
  content:'';position:absolute;left:50%;top:50%;
  width:100%;min-width:44px;height:44px;transform:translate(-50%,-50%);
}
/* 复选框：全站统一 20px 立体方框 + CSS 绘制对勾/半选横线，
   顶部「全选」与行内复选框尺寸、观感完全一致。*/
.lb-sel input[type=checkbox],.row-check{
  -webkit-appearance:none;appearance:none;
  width:20px;height:20px;flex:none;margin:0;padding:0;
  background:var(--win);box-shadow:var(--sink);color:var(--text);
  border:0;border-radius:0;cursor:pointer;position:relative;
  touch-action:manipulation;
}
.lb-sel input[type=checkbox]:checked::after,.row-check:checked::after{
  content:'';position:absolute;left:6px;top:2px;width:5px;height:10px;
  border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(42deg);
}
.lb-sel input[type=checkbox]:indeterminate::after,.row-check:indeterminate::after{
  content:'';position:absolute;left:4px;top:8px;width:12px;height:3px;background:currentColor;
}
/* 行 hover 变深蓝时，对勾/横线跟着文字转白 */
.row:hover .row-check{color:#fff}
.lb-sel input[type=checkbox]:focus-visible,.row-check:focus-visible{
  outline:1px dotted var(--dk);outline-offset:2px;
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

/* 链接默认无下划线，保持整页视觉统一（不被浏览器默认下划线割裂） */
a{text-decoration:none}
/* ── 页脚版权 ── */
.footer{
  padding:4px 6px 3px;text-align:center;
  font-size:11px;color:#505050;
}
.footer a{color:var(--title);text-decoration:none}
.footer a:hover{color:#000}

/* ── 对话框通用 ── */
.mask{
  position:fixed;inset:0;z-index:80;
  display:flex;align-items:center;justify-content:center;
  padding:calc(12px + var(--safe-t)) calc(12px + var(--safe-r)) calc(12px + var(--safe-b)) calc(12px + var(--safe-l));
  background:rgba(0,0,0,.42);
  animation:maskIn .12s ease-out;
}
@keyframes maskIn{from{background:rgba(0,0,0,0)}}
@media (prefers-reduced-motion:reduce){.mask{animation:none}}
.mask-bottom{align-items:flex-end}
.dialog{background:var(--face);box-shadow:var(--raise),3px 3px 0 rgba(0,0,0,.35);padding:3px;max-height:100%;display:flex;flex-direction:column}
.dlg-body{padding:10px;overflow:auto}

/* ── 预览 ── */
/* 注意：这里必须叠在 .mask 上，单独写 .viewer 会丢掉 position:fixed，
   弹层会变成文档流里的普通块，表现为「点了没反应」。 */
.viewer{background:rgba(0,0,0,.74);z-index:85}
.viewer .viewer-dlg{width:min(920px,100%);height:min(88dvh,100%);will-change:transform}
/* 全屏：真全屏 API 与 CSS 兜底都让对话框铺满视口，视频/图片随之填满；
   标题栏 ✕ 仍浮在最上层，保证任何设备都能随时退出 */
.viewer-dlg:fullscreen{width:100vw;height:100vh;max-width:none;max-height:none;border-width:0}
/* 全屏态的定位。
   注意：这里**不能用 100vw / 100dvh** —— 本页常被嵌在「我的电脑」窗口的
   iframe 里，vw/dvh 参照的是 iframe 自己的视口（手机上只有半屏宽），
   于是「全屏」只铺满 iframe 那一小块，看着就是内容挤在屏幕一侧。
   正确做法：固定定位相对 iframe 视口（inset:0 即已铺满 iframe），
   尺寸用 100%；同时 postMessage 让外层窗口也铺满全屏，
   内外一起放大才是真·全屏。 */
.viewer-dlg.is-full{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;z-index:300;border-width:0}
.viewer-dlg:fullscreen .viewer-body,.viewer-dlg.is-full .viewer-body{margin:0}
.viewer-body{
  flex:1;min-height:0;background:var(--face);box-shadow:var(--sink);margin:3px;
  display:grid;place-items:center;overflow:auto;-webkit-overflow-scrolling:touch;
}
/* 媒体本身自带深底（图片/视频），但「不支持预览」这类提示面板
   必须是 98 的浅底深字 —— 纯黑大色块是现代设计语言，与整站割裂 */
.viewer-body img{max-width:100%;max-height:100%;object-fit:contain;background:#000}
.viewer-body video{max-width:100%;max-height:100%;background:#000}
.viewer-body iframe{width:100%;height:100%;border:0;background:#fff}
.viewer-body pre{
  margin:0;width:100%;height:100%;overflow:auto;background:var(--win);color:var(--text);
  padding:9px;font:12px/1.6 "Courier New",Consolas,monospace;
  white-space:pre-wrap;word-break:break-word;text-align:left;
  -webkit-overflow-scrolling:touch;
}
.audio-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;color:#000;font-size:12px}
.audio-wrap .big{font:700 15px/1 Tahoma,sans-serif;letter-spacing:3px;color:#000080}
.audio-wrap audio{width:min(400px,78vw)}
/* 提示区：浅底深字（98 语义面板），不再用「深色卡片 + 圆角按钮」的现代风 */
.viewer-tip{color:#000;font-size:12px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
.viewer-tip .btn-like{background:var(--face);color:var(--text);text-decoration:none;
  padding:6px 14px;min-height:26px;font-size:12px;box-shadow:var(--raise);cursor:pointer}
.viewer-tip .btn-like:active{box-shadow:var(--sink);padding:7px 13px 5px 15px}
.viewer-foot{display:flex;gap:5px;padding:5px}
.viewer-foot>*{flex:1;text-align:center}
/* 窄屏上「◀ 上一个」会被折成两行（上一/个），按钮排版立刻散架 —— 文字一律单行 */
.viewer-foot button,.viewer-foot .btn-like{white-space:nowrap}
/* 底部三个按钮视觉统一：上一个/下一个带方向箭头，下载加下载图标，
   文字与图标同行中央对齐，整行等宽一致 */
.viewer-foot .btn-like::before{
  content:"";width:13px;height:13px;margin-right:5px;
  background:var(--ico-download) center/contain no-repeat;
}
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
  /* 图标跟着按钮一起放大：按钮 38×34 而图标仍是 9×9 时，
     视觉上就是「一个几乎看不见的墨点在大灰块里」 */
  .tb-btn.close::before,.tb-btn.fs::before{width:18px;height:18px}

  /* 列表工具条：触屏把按钮撑到舒适高度，整条仍与行内复选框对齐 */
  .list-bar{padding-left:9px;gap:8px;min-height:38px}
  .lb-del,.lb-refresh{font-size:12px;padding:7px 12px;min-height:36px}
  .lb-sel>span{font-size:13px}

  /* 列表行：整体加高，让整行成为可点热区 */
  .row{gap:9px;padding:11px 7px;min-height:56px}
  .row-more{width:32px;height:32px;font-size:16px}

  /* 预览底部按钮行：四枚按钮挤一排，字号收到 12px、左右留白收到最小，
     配合白-space:nowrap 保证「◀ 上一个」「下一个 ▶」在 320px 屏上也单行居中 */
  .viewer-foot{gap:4px;padding:4px}
  .viewer-foot button,.viewer-foot .btn-like{font-size:12px;padding:8px 2px;min-height:40px}
  .viewer-foot .btn-like:active{padding:9px 1px 7px 3px}
  .ico{width:32px;height:29px;font-size:9px}

  /* 状态栏：可点面板撑到 44px 高 */
  .statusbar{padding:4px}
  .sb-panel{min-height:44px;padding:4px 8px;font-size:11.5px}

  /* 页脚外链：扩大可点区域 */
  .footer{padding:10px 6px 8px}
  .footer a{display:inline-block;padding:8px 6px;min-height:32px}

  /* 刷新已移入正常流的工具条，图例不再需要为它留白 */
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
  .list-bar{gap:6px}
  .lb-del,.lb-refresh{padding:7px 9px}
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
/* 嵌在「我的电脑」窗口里时，内页自己的状态栏必须让位：
   外壳窗口底部已经有一条状态栏（身份与权限），两条并排会变成
   「上下叠两条状态栏」，像坏掉的排版。内页状态栏的内容
   （单文件上限 / 保留时长 / 已用容量）改为 postMessage 交给外壳那一格显示，
   信息不丢，排版只剩一条状态栏。 */
body.embed .statusbar{display:none}
body.embed .win-body{
  flex:1;min-height:0;overflow-y:auto;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
`;

const APP_JS = `
(function () {
  'use strict';

  // ── 平台分享凭证透传 ───────────────────────────────────────
  // 托管平台靠 ?sharecode= 授权入口、再种 SameSite=None 的 Cookie 放行后续请求。
  // 但 App 预览面板 / webview / 隐私模式常拦掉这个第三方 Cookie：入口 HTML 能开、
  // CSS/JS/API 却全部 403，页面看似打开实则瘫掉。这里把凭证从 <meta> 读出并
  // 显式挂到每一个请求上，彻底不依赖 Cookie。无凭证时 withSC 原样返回，行为不变。
  var SC = (function () {
    var m = document.querySelector('meta[name="7md-sc"]');
    if (m) return (m.getAttribute('content') || '').replace(/[^A-Za-z0-9_-]/g, '');
    var q = /[?&]sharecode=([A-Za-z0-9_-]+)/.exec(location.search);
    return q ? q[1] : '';
  })();
  function withSC(u) {
    if (!SC || typeof u !== 'string') return u;
    if (/[?&]sharecode=/.test(u)) return u;
    if (/^(data|blob|javascript|about|mailto):/i.test(u) || u.charAt(0) === '#') return u;
    if (/^(https?:)?\\/\\//i.test(u)) {
      try { if (new URL(u).origin !== location.origin) return u; } catch (e) { return u; }
    }
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + SC;
  }
  if (SC) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === 'string') input = withSC(input);
      return _fetch.call(window, input, init);
    };
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = withSC(url);
      return _xhrOpen.apply(this, arguments);
    };
  }

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

  // ── 批量删除：列表顶部工具条（与「刷新」同行） ─────────────────
  // 工具条写在 HTML 里，刷新与全选/删除是同一 flex 行的成员，垂直天然对齐。
  var selected = new Set();
  var listBar = $('listBar');
  var selAll = listBar.querySelector('#selAll');
  var selCount = listBar.querySelector('#selCount');
  var delSel = listBar.querySelector('#delSel');
  // 谁能管理：自己上传的（服务端裁决）或管理员链接。无管理权的项不提供勾选。
  function canMg(it) { return it.canManage === true || perm.role === 'admin'; }
  function updateSelBar() {
    var mg = items.filter(canMg);
    // .show 现在有真实 CSS：无「可管理」文件时隐藏批量控件，刷新按钮仍在。
    listBar.classList.toggle('show', mg.length > 0 && items.length > 0);
    var sel = mg.filter(function (it) { return selected.has(it.id); });
    selAll.checked = mg.length > 0 && sel.length === mg.length;
    selAll.indeterminate = sel.length > 0 && sel.length < mg.length;
    // 计数常驻、按钮文案固定：选中数变化不再让这一行来回抖动。
    selCount.textContent = '已选 ' + sel.length + ' / ' + mg.length;
    delSel.disabled = sel.length === 0;
  }
  selAll.addEventListener('change', function () {
    var mg = items.filter(canMg);
    if (selAll.checked) mg.forEach(function (it) { selected.add(it.id); });
    else selected.clear();
    listEl.querySelectorAll('.row-check').forEach(function (cb) {
      cb.checked = selected.has(cb.getAttribute('data-id'));
    });
    updateSelBar();
  });
  delSel.addEventListener('click', function () {
    var ids = items.filter(function (it) { return selected.has(it.id); }).map(function (it) { return it.id; });
    if (!ids.length) return;
    if (!confirm('确定删除选中的 ' + ids.length + ' 个文件？删除后无法恢复。')) return;
    fetch(BASE + '/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '删除失败'); return j; }); })
      .then(function (j) {
        selected.clear();
        toast('已删除 ' + (j.deleted ? j.deleted.length : ids.length) + ' 个');
        lastSig = ''; load();
      })
      .catch(function (e) { toast(e.message || '删除失败'); });
  });
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
  var perm = { role: 'admin', canList: true, canUpload: true, canDelete: true, canManageOwn: true };
  // 存储是否已满：由 /api/list 回传的 maxTotalMb / usedBytes 单一数据源算出，
  // 满了就禁用全部上传入口并如实改文案，不让用户白点（服务端仍是真源，会再拦一道）。
  var storageFull = false;

  /* ── 上传设置：时长 + 访问密码 ────────────────────────────────
     密码绝不写 localStorage / 不外发到任何 URL，只随上传请求一次性提交，
     服务端立刻转成不可逆摘要。时长偏好记在本地，下次打开自动沿用。 */
  var OPT_KEY = '7md.upopt.v1';
  var EXP_LABEL = { 0: '永久保留', 1: '1 小时', 6: '6 小时', 24: '1 天', 72: '3 天', 168: '7 天', 720: '30 天' };
  function expLabel(h) { return EXP_LABEL[h] || (h + ' 小时'); }
  function expChoices() {
    return (lastMeta.expChoices && lastMeta.expChoices.length) ? lastMeta.expChoices : [1, 6, 24, 72, 168, 720, 0];
  }
  // 把「默认档位」与「全部可选档位」拼成人话，供状态栏 / 信息面板 / 面板说明共用。
  // 文案完全由服务端下发的 expChoices、ttlHours 生成，不再写死 24 小时。
  function expSummaryText() {
    var def = lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久';
    var cs = expChoices().map(expLabel);
    return '默认 ' + def + '，可选 ' + cs.join(' / ');
  }
  function savedOpt() {
    try { return JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); } catch (e) { return {}; }
  }
  function fillExpSelect(sel, defH) {
    var cs = expChoices(), want = defH;
    if (cs.indexOf(want) < 0) want = cs.indexOf(lastMeta.ttlHours) >= 0 ? lastMeta.ttlHours : cs[0];
    sel.textContent = '';
    cs.forEach(function (h) {
      var o = document.createElement('option');
      o.value = String(h); o.textContent = expLabel(h);
      if (h === want) o.selected = true;
      sel.appendChild(o);
    });
  }
  function initUpOpt() {
    var s = savedOpt();
    fillExpSelect($('expSel'), Number(s.h));
    $('pwInput').value = '';                    // 密码每次进页面清空
    $('pwToggle').addEventListener('click', function () {
      var i = $('pwInput'), show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      $('pwToggle').textContent = show ? '隐藏' : '显示';
    });
    $('expSel').addEventListener('change', function () {
      try { localStorage.setItem(OPT_KEY, JSON.stringify({ h: Number($('expSel').value) })); } catch (e) {}
    });
    $('pwInput').addEventListener('input', refreshUpOptNote);
    refreshUpOptNote();
  }
  // 返回本次上传要附带的服务端参数；整批文件读的是同一份设置。
  function uploadOpt() {
    return { h: Number($('expSel').value), pw: $('pwInput').value || '' };
  }
  function refreshUpOptNote() {
    var pw = $('pwInput').value || '';
    var el = $('upOptNote');
    var base = '时长默认 ' + (lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久') +
      '，可在上方改（' + expChoices().map(expLabel).join(' / ') + '）；一次上传共用同一时长与密码。';
    el.textContent = pw
      ? '已设访问密码：本次上传的文件需要提取码；管理链接始终免密。密码不保存、刷新即清空。' + base
      : base + '留空 = 不设密码，管理链接始终免密。你传的文件只有你和管理员能改时长、续期、删除。';
    $('upOpt').classList.toggle('locked-pw', !!pw);
  }

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
  /* 状态栏专用的紧凑体积写法：去掉无意义的小数位（185.0 MB → 185 MB、
     2.00 GB → 2 GB）。手机上一格只有 200 出头的像素，小数位就是浪费。 */
  function compactSize(n) {
    n = Number(n) || 0;
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    if (n < 1073741824) return Math.round(n / 1048576) + ' MB';
    return (Math.round(n / 1073741824 * 10) / 10) + ' GB';
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
  function expState(it) {
    if (it.expired) return { cls: 'gone', text: it.canRenew ? '已过期 · 可续期' : '已过期', tag: it.canRenew ? '可续期' : '已过期' };
    if (it.expiringSoon) return { cls: 'soon', text: fmtLeft(it.expires), tag: '即将过期' };
    return { cls: '', text: fmtLeft(it.expires), tag: '' };
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
  /* 嵌入外壳窗口时，把状态栏信息交给外壳显示（内页那条已隐藏）。
     独立访问（直接打开 /s/<口令>/）时不发，页面自带状态栏照常显示。 */
  function postStatusToHost(mode, limit, quota) {
    try {
      if (!document.body.classList.contains('embed')) return;
      if (window.parent === window) return;
      /* 传给外壳的是紧凑版：外壳状态栏只有一格可用（392px 的手机上
         「单文件 20 MB · 保留 24 小时」会挤掉权限与身份） */
      window.parent.postMessage({
        __7md: 1, type: '7md:status',
        mode: mode || '', limit: limit || '', quota: quota || ''
      }, '*');
    } catch (e) { /* 跨源时忽略：外壳拿不到就显示自己的那条 */ }
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
  // 绝对 URL（图片/视频/iframe src、下载跳转、二维码、复制文本）不走 fetch 包装，
  // 必须在这里就带上凭证；相对 URL 由上面包装的 fetch/XHR 自动处理。
  function absUrl(rel) { return withSC(location.origin + BASE + rel); }
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
        if (!window.__upOptInit) { window.__upOptInit = true; initUpOpt(); }
        if (d.role) perm = d;
        // 满了就禁用上传：用服务端回传的 usedBytes / maxTotalMb 单一数据源判断，
        // 不另算、不缓存，每次刷新列表都重算（上传成功的回写会让它自动恢复）。
        storageFull = !!(d.maxTotalMb && (d.usedBytes || 0) >= d.maxTotalMb * 1048576);
        applyPerms();
        tbMode.textContent = perm.role === 'guest' ? '分享模式' : '管理模式';
        sbMode.textContent = perm.role === 'guest' ? '分享模式 · 仅管理本人文件' : '管理模式';
        sbLimit.textContent = '单文件 ' + d.maxMb + ' MB · 默认 ' +
          (d.ttlHours > 0 ? d.ttlHours + ' 小时' : '永久') + '（上传时可改档位）';
        sbQuota.textContent = d.maxTotalMb
          ? '已用 ' + fmtSize(d.usedBytes || 0) + ' / ' + d.maxTotalMb + ' MB'
          : '已用 ' + fmtSize(d.usedBytes || 0);
        filesCount.textContent = items.length ? '(' + items.length + ')' : '';
        /* 嵌入「我的电脑」窗口时，内页状态栏已隐藏（只留外壳那一条），
           这里把限制与容量信息交给外壳那一格，信息不丢。
           文案在这里直接拼好（不从渲染文本反推，避免多余空格）。 */
        postStatusToHost(
          sbMode.textContent,
          compactSize(d.maxMb * 1048576) + ' · 默认 ' + (d.ttlHours > 0 ? d.ttlHours + 'h（可改）' : '永久（可改）'),
          compactSize(d.usedBytes || 0) + (d.maxTotalMb ? ' / ' + compactSize(d.maxTotalMb * 1048576) : '')
        );
        var sig = JSON.stringify(items);
        if (sig !== lastSig) { lastSig = sig; render(); }
        maybeOpenInitialFile();
        /* 嵌入「我的电脑」窗口时：内容真正就绪，请外层收起"正在打开"遮罩。
           比 iframe 的 load 事件可靠（load 在 app.js 下载完就触发，内容还靠
           fetch 异步渲染；且动态设 iframe.src 时 load 偶发漏触发，会让遮罩卡 3 秒）。
           这里用 7md:drop-ready 让遮罩与内容对齐，消除开窗时的白屏/卡顿闪。 */
        if (EMBED && !window.__readyReported) {
          window.__readyReported = true;
          try { window.parent.postMessage({ type: '7md:drop-ready' }, '*'); } catch (e) {}
        }
      })
      .catch(function () {
        /* 即使拉取失败也收起遮罩，避免卡 3 秒兜底；状态栏会如实显示"连接中断"。 */
        if (EMBED && !window.__readyReported) {
          window.__readyReported = true;
          try { window.parent.postMessage({ type: '7md:drop-ready' }, '*'); } catch (e) {}
        }
        sbMode.textContent = '连接中断，重试中…';
      });
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
        openItem(items[i]);   // 加锁文件先弹提取码，不要直接吐预览
        return;
      }
    }
  }

  // 按当前口令的权限裁剪界面（真正的拦截在服务端）
  function applyPerms() {
    var canList = perm.canList !== false;
    var canUpload = perm.canUpload !== false;
    // 满了：上传功能存在但暂时不可用 —— 保留入口、禁用、如实改文案，不让用户白点。
    // 没上传权限：整个功能不显示。
    var upAllowed = canUpload && !storageFull;
    var panel = $('filesPanel');
    var tb = $('textPane');
    if (panel) panel.hidden = !canList;
    if (tb) tb.hidden = true;
    var dropEl = $('drop');
    document.querySelectorAll('.btnrow button, .drop').forEach(function (el) {
      el.hidden = !canUpload;            // 无权限：整块隐藏
    });
    document.querySelectorAll('.drop, #pickFile, #pickMedia').forEach(function (el) {
      el.disabled = !upAllowed;          // 满了：禁用但不隐藏，文案说明原因
    });
    if (dropEl) {
      dropEl.classList.toggle('is-full', storageFull);
      var dt = dropEl.querySelector('.drop-title');
      var ds = dropEl.querySelector('.drop-sub');
      if (storageFull) {
        if (dt) dt.textContent = '存储已满 · 暂不能上传';
        if (ds) ds.textContent = '管理员清理出空间后即可继续（已用 ' +
          fmtSize(lastMeta.usedBytes || 0) + ' / ' + (lastMeta.maxTotalMb || 0) + ' MB）';
      } else {
        if (dt) dt.textContent = '拖入文件，或点击选择';
        if (ds) ds.textContent = '支持多选 · 可粘贴截图 · 手机可直接调相册';
      }
    }
    // 没有上传权限、或存储已满时，上传设置面板都不该露出来（避免误导）
    var upOpt = $('upOpt');
    if (upOpt) upOpt.hidden = !canUpload || storageFull;
    document.body.setAttribute('data-role', perm.role || 'guest');
  }

  function render() {
    listEl.textContent = '';
    emptyEl.hidden = items.length > 0;
    items.forEach(function (it) {
      var li = document.createElement('li');
      var st = expState(it);
      li.className = 'row' + (st.cls ? ' st-' + st.cls : '');

      var ico = document.createElement('div');
      ico.className = 'ico' + (it.locked && !it.unlocked ? ' locked' : '');
      ico.textContent = it.masked ? 'PW' : typeBadge(it.name, it.kind);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var nm = document.createElement('div');
      nm.className = 'fname';
      nm.textContent = it.name;
      nm.title = it.unlocked ? it.name : '需要访问密码';
      // 归属标：一眼看出哪些是自己传的（可改时长/续期/删除）
      if (it.mine) {
        var mk = document.createElement('span');
        mk.className = 'ftag mine';
        mk.textContent = '我传的';
        mk.title = '只有你和管理员能改时长 / 续期 / 删除这个文件';
        nm.appendChild(mk);
      }
      // 锁标：一眼看出哪些文件需要提取码
      if (it.locked) {
        var lk = document.createElement('span');
        lk.className = 'ftag lock';
        lk.textContent = it.unlocked ? '已解锁' : '需密码';
        nm.appendChild(lk);
      }
      if (st.tag) {
        var tg = document.createElement('span');
        tg.className = 'ftag ' + st.cls;
        tg.textContent = st.tag;
        nm.appendChild(tg);
      }
      var sub = document.createElement('div');
      sub.className = 'fsub';
      [fmtSize(it.size), fmtTime(it.time), st.text].forEach(function (s) {
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

      // 批量删除：仅「能管理」（自己上传 / 管理员）的项显示复选框。
      // 勾选态让图标让位，避免与类型标识抢位置。
      if (canMg(it)) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'row-check';
        cb.setAttribute('data-id', it.id);
        cb.checked = selected.has(it.id);
        cb.addEventListener('click', function (e) { e.stopPropagation(); });
        cb.addEventListener('change', function (e) {
          e.stopPropagation();
          if (cb.checked) selected.add(it.id); else selected.delete(it.id);
          updateSelBar();
        });
        li.classList.add('show-check');
        li.insertBefore(cb, li.firstChild);
      }

      // 点整行一律进预览；不支持预览的类型在预览里给下载入口，
      // 这样「点一下」的行为始终一致，不会有时弹预览、有时弹操作面板
      li.classList.add('tappable');
      li.addEventListener('click', function () { openItem(it); });
      listEl.appendChild(li);
    });
    updateSelBar();
  }

  // ── 通用对话框：解锁 / 续期 ──────────────────────────────
  var askModal = $('askModal'), askCb = null;
  function openAsk(cfg) {
    askCb = cfg.onOk || null;
    $('askTitle').textContent = cfg.title || '';
    $('askNote').textContent = cfg.note || '';
    $('askPwWrap').hidden = !cfg.password;
    $('askExpWrap').hidden = !cfg.exp;
    $('askOk').textContent = cfg.okText || '确定';
    if (cfg.exp) fillExpSelect($('askExp'), cfg.expDefault);
    if (cfg.password) { $('askPw').value = ''; }
    askModal.hidden = false;
    setTimeout(function () { try { (cfg.password ? $('askPw') : $('askOk')).focus(); } catch (e) {} }, 30);
  }
  function closeAsk() { askModal.hidden = true; askCb = null; }
  function submitAsk() {
    var cb = askCb;
    if (!cb) return closeAsk();
    var val = { pw: $('askPw').value, h: Number($('askExp').value) };
    cb(val, closeAsk);
  }
  $('askOk').addEventListener('click', submitAsk);
  $('askClose').addEventListener('click', closeAsk);
  askModal.addEventListener('click', function (e) { if (e.target === askModal) closeAsk(); });
  $('askPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAsk(); });

  // 未解锁的加密文件：先弹提取码，成功后再执行原本要点开的动作。
  function openItem(it) {
    if (it.masked || (it.locked && !it.unlocked)) return askUnlock(it, function () { openViewerFresh(it.id); });
    openViewer(it);
  }
  function openViewerFresh(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) { openViewer(items[i]); return; }
  }
  function askUnlock(it, after) {
    openAsk({
      title: '需要访问密码',
      note: '这个文件已加密。输入提取码后，同一次上传的整批文件都会解锁。',
      password: true, okText: '解锁',
      onOk: function (v, close) {
        fetch(BASE + '/api/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pw: v.pw }),
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '解锁失败'); return j; }); })
          .then(function () {
            close(); toast('已解锁');
            lastSig = '';
            return load().then(function () { if (after) after(); });
          })
          .catch(function (e) { toast(e.message || '访问密码不正确'); });
      },
    });
  }

  // 续期 / 改时长：沿用该文件当前档位作为默认值，一键即可「按原设置续」。
  function askRenew(it) {
    if (!it.canRenew) { toast('文件已过续期宽限期，无法续期'); return; }
    openAsk({
      title: '续期 / 改保留时长',
      note: it.name + ' — 当前：' + expState(it).text,
      exp: true, expDefault: it.expH, okText: '续期',
      onOk: function (v, close) {
        fetch(BASE + '/api/renew', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: it.id, h: v.h }),
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '续期失败'); return j; }); })
          .then(function () { close(); toast('已续期：' + expLabel(v.h)); lastSig = ''; load(); })
          .catch(function (e) { toast(e.message || '续期失败'); });
      },
    });
  }

  // ── 操作面板 ───────────────────────────────────────────
  function openSheet(it) {
    sheetItem = it;
    sheetName.textContent = it.unlocked ? it.name : '需要访问密码';
    var needsPw = it.masked || (it.locked && !it.unlocked);
    // 归属：只有「我传的」或管理员才露管理入口。管理员链接下服务端把每项
    // canManage 都置 true；这里仍按 perm 兜底，避免旧缓存数据误导。
    var canMg = it.canManage === true || perm.role === 'admin';
    sheet.querySelector('[data-act="preview"]').hidden = needsPw || previewKind(it) === 'none';
    sheet.querySelector('[data-act="delete"]').hidden = !canMg;
    var renewBtn = sheet.querySelector('[data-act="renew"]');
    renewBtn.hidden = !canMg || !it.canRenew;
    renewBtn.textContent = needsPw ? '解锁后可续期…' : (it.expired ? '续期复活…' : '续期 / 改保留时长…');
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
    var needsPw = it.masked || (it.locked && !it.unlocked);
    // 需要提取码的动作：先解锁，成功后对新拿到的记录重放同一动作。
    if (needsPw && (act === 'preview' || act === 'download' || act === 'renew')) {
      closeSheet();
      return askUnlock(it, function () {
        var fresh = null;
        for (var i = 0; i < items.length; i++) if (items[i].id === it.id) { fresh = items[i]; break; }
        if (!fresh) return;
        if (act === 'preview') openViewer(fresh);
        else if (act === 'download') location.href = fileUrl(fresh);
        else if (act === 'renew') askRenew(fresh);
      });
    }
    closeSheet();
    if (act === 'preview') openViewer(it);
    else if (act === 'download') location.href = fileUrl(it);
    else if (act === 'copylink') copy(filePageUrl(it), '分享链接');
    else if (act === 'copydirect') copy(fileUrl(it), '直链');
    else if (act === 'qr') openQR(filePageUrl(it), it.name + ' · 打开先看，可下载');
    else if (act === 'delete') remove(it);
    else if (act === 'renew') askRenew(it);
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
      try { history.replaceState(null, '', withSC(BASE + '/')); } catch (e) { /* 忽略 */ }
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

  /* 全屏：视频预览要能沉浸式铺满，又不丢「随时关闭」的出口。
     三层兜底：① 标准 Fullscreen API（桌面，真·系统级全屏）；
     ② iOS Safari 用视频原生 webkitEnterFullscreen（标准 API 在 iOS 上对普通元素无效）；
     ③ 都不支持时退化为 CSS 兜底（对话框 fixed 铺满视口，标题栏 ✕ 仍在最上层）。 */
  var viewerDlg = viewer.querySelector('.viewer-dlg');
  function syncFsBtn() {
    var on = !!(document.fullscreenElement || viewerDlg.classList.contains('is-full'));
    /* 图标由 CSS 按 .is-full 切换（展开↔还原），不再用文本字形 */
    $('viewerFs').classList.toggle('is-full', on);
    $('viewerFs').setAttribute('aria-label', on ? '退出全屏' : '全屏');
  }
  function exitFull() {
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    if (viewerDlg.classList.contains('is-full')) {
      viewerDlg.classList.remove('is-full');
      /* 退出时通知外层把窗口还原（否则窗口会一直保持铺满） */
      try {
        if (document.body.classList.contains('embed')) {
          window.parent.postMessage({ type: '7md:embed-fullscreen', on: false }, '*');
        }
      } catch (e) { /* 独立打开时没有 parent，忽略 */ }
      syncFsBtn();
      return true;
    }
    return false;
  }
  function toggleFullscreen() {
    if (exitFull()) return;
    /* 嵌入模式（?embed=1，即被「我的电脑」窗口内嵌）：
       iframe 内的 requestFullscreen 常被浏览器拒绝，而 CSS 兜底只能铺满 iframe。
       真·全屏需要外层窗口也一起铺满 —— 通知外壳把窗口最大化，
       内外同时放大，视觉上才是整屏。 */
    var EMBED = document.body.classList.contains('embed');
    if (EMBED) {
      try {
        window.parent.postMessage({ type: '7md:embed-fullscreen', on: true }, '*');
      } catch (e) { /* 独立打开时没有 parent，忽略 */ }
    }
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
    if (!perm.shareToken) return withSC(location.href);
    var parts = BASE.split('/');
    parts[parts.length - 1] = perm.shareToken;
    return withSC(location.origin + parts.join('/') + '/');
  }
  // 管理员点二维码时给的是「分享链接」——避免把管理链接扫出去，那等于把全部管理权一起给了
  $('qrPage').addEventListener('click', function () {
    if (perm.role === 'admin' && perm.shareToken) {
      openQR(sharePageUrl(), '分享链接 · 支持上传与下载');
    } else if (perm.role === 'admin') {
      openQR(withSC(location.href), '本页链接 · 含全部管理权限，谨慎分享');
    } else {
      openQR(withSC(location.href), '分享链接 · 扫码打开');
    }
  });

  // ── 链接与权限（点标题栏右侧的身份标签）─────────────────
  function openInfo() {
    var guest = perm.role === 'guest';
    $('infoRole').textContent = guest ? '分享模式（访客）' : '管理模式（管理员）';
    $('infoNote').textContent = guest
      ? '您打开的是分享链接：可浏览、预览、上传。本设备上传的文件仅本人可管理（调整保留时长、续期与删除），身份由浏览器设备凭证自动识别，无需登录；各访客之间的文件权限相互隔离，由服务端强制执行。'
      : '你打开的是管理链接：拥有全部权限，能管理所有人的文件。只给自己用，不要发出去。要给别人就发下面那条分享链接。';

    var pl = $('infoPerms');
    pl.textContent = '';
    [
      ['浏览文件列表', perm.canList !== false],
      ['下载与在线预览', perm.canList !== false],
      ['上传文件', perm.canUpload !== false],
      ['改时长 / 续期 / 删除自己上传的', perm.canManageOwn !== false],
      ['管理所有人上传的文件', perm.canDelete === true],
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
    $('infoTtl').textContent = '默认 ' + (lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久保留') + '（上传时可改）';
    $('infoExpChoices').textContent = expChoices().map(expLabel).join(' / ');
    $('infoQuota').textContent = lastMeta.maxTotalMb
      ? fmtSize(lastMeta.usedBytes || 0) + ' / ' + lastMeta.maxTotalMb + ' MB'
      : fmtSize(lastMeta.usedBytes || 0);

    if (perm.role === 'admin' && perm.shareToken) {
      $('infoShareWrap').hidden = false;
      $('infoShareLink').textContent = sharePageUrl();
    } else {
      $('infoShareWrap').hidden = true;
    }
    $('infoSelfLink').textContent = withSC(location.href);
    // Agent 自举地址：一次请求自描述所有端点，是给 AI 用的唯一入口
    $('infoAgentLink').textContent = absUrl('/api/meta');
    $('infoModal').hidden = false;
  }
  function closeInfo() { $('infoModal').hidden = true; }

  $('tbMode').addEventListener('click', openInfo);
  $('sbMode').classList.add('clickable');
  $('sbMode').title = '查看当前链接的身份与权限';
  $('sbMode').addEventListener('click', openInfo);
  /* 嵌入模式下内页标题栏/状态栏被隐藏，入口交由外壳状态栏转发：
     外壳「我的电脑」窗口底部的「分享模式」标签点击后发来此消息，
     由内页打开「链接与权限」对话框（含 Agent 自举地址）。 */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.type === '7md:open-info') openInfo();
  });
  $('infoClose').addEventListener('click', closeInfo);
  $('infoOk').addEventListener('click', closeInfo);
  $('infoModal').addEventListener('click', function (e) {
    if (e.target === $('infoModal')) closeInfo();
  });
  $('infoCopySelf').addEventListener('click', function () { copy(withSC(location.href), '当前链接'); });
  $('infoCopyAgent').addEventListener('click', function () { copy($('infoAgentLink').textContent, 'Agent 自举地址'); });
  $('infoCopyShare').addEventListener('click', function () { copy($('infoShareLink').textContent, '分享链接'); });
  $('infoQrShare').addEventListener('click', function () {
    closeInfo();
    openQR($('infoShareLink').textContent, '分享链接 · 支持上传与下载');
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

  // ── 上传（分片 + 断点续传） ─────────────────────────────
  var RESUME_KEY = '7md.resume.v1';
  var RETRY_MAX = 12;
  var RETRY_BASE_MS = 1500;
  var CHUNK_STALL_MS = 30000;   // 单片长时间无任何字节则判卡死，触发重试

  /* 取消是「终止性」的：abort 当前请求 + 打断自动续传等待 + 阻止重试，
     绝不能被断点续传逻辑当成一次普通网络中断而复活。 */
  function isCancelled(ui) { return !!(ui && ui.cancelled && ui.cancelled()); }
  function cancelErr() { var e = new Error('已取消'); e.cancelled = true; return e; }
  function cancelSession(id) {
    if (!id) return;
    try {
      fetch(BASE + '/api/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: id }),
      }).catch(function () {});
    } catch (e) {}
  }

  function sendChunk(id, i, blob, onProg, ui) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var timer = null, settled = false;
      function clear() { if (timer) { clearTimeout(timer); timer = null; } }
      function arm() {
        clear();
        timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} }, CHUNK_STALL_MS);
      }
      xhr.open('POST', BASE + '/api/chunk?u=' + encodeURIComponent(id) + '&i=' + i);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (ui && ui.onCancel) ui.onCancel(function () { try { xhr.abort(); } catch (e) {} });
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProg(e.loaded); arm(); };
      xhr.onload = function () {
        if (settled) return; settled = true; clear();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('分片 ' + (i + 1) + ' 失败 (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () {
        if (settled) return; settled = true; clear(); reject(new Error('网络错误，请检查连接'));
      };
      xhr.onabort = function () {
        if (settled) return; settled = true; clear(); reject(new Error('连接超时或已取消'));
      };
      arm();
      xhr.send(blob);
    });
  }

  /* localStorage 保存「未完成会话」：页面被系统回收后重新选同一个文件也能续。
     浏览器不会替我们留住 File 本体，所以仍需重选一次文件。 */
  function fpOf(f) { return [f.name, f.size, f.lastModified || 0].join('|'); }
  function resumeList() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '[]'); } catch (e) { return []; }
  }
  function findResume(fp) {
    var a = resumeList();
    for (var i = 0; i < a.length; i++) if (a[i] && a[i].fp === fp) return a[i];
    return null;
  }
  function saveResume(fp, id) {
    try {
      var a = resumeList().filter(function (x) { return x && x.fp !== fp; });
      a.unshift({ fp: fp, id: id, at: Date.now() });
      if (a.length > 100) a.length = 100;   // 批量场景：一次几十个文件不该互相挤掉续传记录
      localStorage.setItem(RESUME_KEY, JSON.stringify(a));
    } catch (e) {}
  }
  function clearResume(fp) {
    try {
      localStorage.setItem(RESUME_KEY,
        JSON.stringify(resumeList().filter(function (x) { return x && x.fp !== fp; })));
    } catch (e) {}
  }

  /* 断线后必须查服务端真实进度：XHR 失败无法区分「请求没到」和「服务端
     写完了、响应在回程丢了」——后者盲目重发同一片会被 409 拒绝。
     404 = 会话确实没了；网络层失败则 reject，交上层重试，不能误判成没了。 */
  function getStatus(id) {
    return fetch(BASE + '/api/status?u=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;
        return r.json().then(function (j) {
          if (!r.ok) throw new Error('查询进度失败 HTTP ' + r.status);
          return j;
        });
      });
  }

  function initSession(file, opt) {
    var o = opt || {};
    return fetch(BASE + '/api/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream', h: o.h, pw: o.pw || '' }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('初始化失败 HTTP ' + r.status));
        return j;
      });
    });
  }

  function finishSession(id) {
    return fetch(BASE + '/api/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: id }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('完成失败 HTTP ' + r.status));
        return j;
      });
    });
  }

  // 网络恢复立即续传；浏览器不发 online 事件时，超时也会再试一次。
  function waitRetry(ms, ui) {
    return new Promise(function (resolve) {
      var done = false, t, iv;
      function fin() {
        if (done) return; done = true;
        window.removeEventListener('online', fin);
        clearTimeout(t); clearInterval(iv);
        resolve();
      }
      t = setTimeout(fin, ms);
      // 等待续传期间也要能被立即取消，不然「已取消」还要等一个退避窗口
      iv = setInterval(function () { if (isCancelled(ui)) fin(); }, 120);
      window.addEventListener('online', fin);
    });
  }

  /* 小文件（≤ 一个分片）走 /api/put 单请求上传：省掉 init→status→chunk→finish
     四次往返，批量几十个小文件时提速最明显。断线自动重发整个文件（≤8MB，
     成本远低于分片握手），因此不做断点续传；若 localStorage 里已有它的续传
     记录（上次中断过），仍交回分片路径接着传。 */
  function uploadSmall(file, ui, opt) {
    var attempts = 0;
    function once() {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var timer = null, settled = false;
        function clear() { if (timer) { clearTimeout(timer); timer = null; } }
        function arm() {
          clear();
          timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} }, CHUNK_STALL_MS);
        }
        var o = opt || { h: undefined, pw: '' };
        // 时长走 query（可见、可缓存），提取码走 header（绝不进 URL / 日志 / Referer）。
        var qs = '?name=' + encodeURIComponent(file.name) + (o.h !== undefined ? '&h=' + o.h : '');
        xhr.open('POST', BASE + '/api/put' + qs);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        if (o.pw) xhr.setRequestHeader('X-7md-Pw', o.pw);
        if (ui && ui.onCancel) ui.onCancel(function () { try { xhr.abort(); } catch (e) {} });
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) ui.progress(e.loaded / (file.size || 1));
          arm();
        };
        xhr.onload = function () {
          if (settled) return; settled = true; clear();
          var j = null;
          try { j = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) resolve(j);
          else reject(new Error((j && j.error) || ('上传失败 HTTP ' + xhr.status)));
        };
        xhr.onerror = function () {
          if (settled) return; settled = true; clear(); reject(new Error('网络错误，请检查连接'));
        };
        xhr.onabort = function () {
          if (settled) return; settled = true; clear(); reject(new Error('连接超时或已取消'));
        };
        arm();
        xhr.send(file);
      });
    }
    function run() {
      if (isCancelled(ui)) return Promise.reject(cancelErr());
      return once().catch(function (e) {
        if (isCancelled(ui)) throw cancelErr();
        attempts++;
        if (attempts > RETRY_MAX) throw e;
        // 429 是「每分钟次数」窗口，短退避没用，直接等一个窗口
        var throttled = /过于频繁|429/.test(e.message);
        var wait = throttled ? 30000 : Math.min(15000, Math.round(RETRY_BASE_MS * Math.pow(1.5, attempts - 1)));
        ui.waiting((throttled ? '上传太频繁，' : '连接中断 · ') + Math.round(wait / 1000) + ' 秒后自动重传');
        return waitRetry(wait, ui).then(run);
      });
    }
    return run();
  }

  function uploadFile(file, ui, opt) {
    var total = file.size, fp = fpOf(file);
    // 小文件且没有待续的旧会话 → 单请求上传；其余仍走分片 + 断点续传
    if (total <= CHUNK_FALLBACK && !findResume(fp)) return uploadSmall(file, ui, opt);
    var chunk = CHUNK_FALLBACK, uploadId = null, attempts = 0;

    function pumpFrom(st) {
      chunk = st.chunkSize || chunk;
      function step(i) {
        if (isCancelled(ui)) return Promise.reject(cancelErr());
        var start = i * chunk;
        if (start >= total) return Promise.resolve();
        var end = Math.min(start + chunk, total);
        return sendChunk(uploadId, i, file.slice(start, end), function (loaded) {
          ui.progress(Math.min(1, (start + loaded) / (total || 1)));
        }, ui).then(function () {
          ui.progress(Math.min(1, end / (total || 1)));
          return step(i + 1);
        });
      }
      return step(st.next);
    }

    function round() {
      var fresh = false;
      var saved = findResume(fp);
      if (!uploadId && saved) uploadId = saved.id;
      // 让队列层知道会话 id：取消时才能通知服务端立刻释放 .part 与配额。
      // 若取消恰好发生在 init 返回之前，onSession 会自己发取消请求，不留孤儿会话。
      if (uploadId && ui && ui.onSession) ui.onSession(uploadId);
      function newSession() {
        fresh = true;
        return initSession(file, opt).then(function (info) {
          uploadId = info.uploadId;
          chunk = info.chunkSize || chunk;
          if (ui && ui.onSession) ui.onSession(uploadId);
          saveResume(fp, uploadId);
          return null;
        });
      }
      return (uploadId ? Promise.resolve(null) : newSession())
        .then(function () {
          // 全新会话不必查 status（必然 next=0）：批量时每个文件省一次往返。
          // 复用旧会话 / 失败重试时仍查，用于对齐服务端真实进度。
          if (fresh) return { state: 'uploading', next: 0, received: 0, chunkSize: chunk };
          return getStatus(uploadId);
        })
        .then(function (st) {
          if (st && st.state === 'done') { clearResume(fp); return { done: true }; }
          if (!st) { clearResume(fp); uploadId = null; return newSession().then(function () { return getStatus(uploadId); }); }
          return st;
        })
        .then(function (st) {
          if (st && st.done) return;                 // finish 曾成功，别重传
          if (!st) throw new Error('无法获取上传进度');
          if (isCancelled(ui)) throw cancelErr();
          ui.progress(Math.min(1, (st.received || 0) / (total || 1)));
          return pumpFrom(st).then(function () {
            if (isCancelled(ui)) throw cancelErr();
            return finishSession(uploadId);
          });
        })
        .then(function () { clearResume(fp); });
    }

    function run() {
      if (isCancelled(ui)) return Promise.reject(cancelErr());
      return round().catch(function (e) {
        if (isCancelled(ui)) throw cancelErr();
        attempts++;
        if (attempts > RETRY_MAX) { clearResume(fp); throw e; }
        var wait = Math.min(15000, Math.round(RETRY_BASE_MS * Math.pow(1.5, attempts - 1)));
        ui.waiting('连接中断 · 已保留进度，' + Math.round(wait / 1000) + ' 秒后自动续传');
        return waitRetry(wait, ui).then(run);
      });
    }
    return run();
  }

  function makeQueueItem(name, onRetry, onCancel) {
    var el = document.createElement('div');
    el.className = 'qitem';
    var top = document.createElement('div');
    top.className = 'qtop';
    var nm = document.createElement('div'); nm.className = 'qname'; nm.textContent = name; nm.title = name;
    var pct = document.createElement('div'); pct.className = 'qpct'; pct.textContent = '0%';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'qcancel'; cancelBtn.type = 'button';
    cancelBtn.textContent = '×'; cancelBtn.title = '取消上传';
    cancelBtn.setAttribute('aria-label', '取消上传');
    cancelBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (cancelBtn.disabled) return;
      cancelBtn.disabled = true;
      if (onCancel) onCancel();
    });
    top.appendChild(nm); top.appendChild(pct); top.appendChild(cancelBtn);
    var bar = document.createElement('div'); bar.className = 'bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);
    el.appendChild(top); el.appendChild(bar);
    queueEl.appendChild(el);
    function clearNotes() {
      var m = el.querySelector('.qmsg'); if (m) m.remove();
      var b = el.querySelector('.qretry'); if (b) b.remove();
    }
    return {
      progress: function (v) {
        var p = Math.max(0, Math.min(1, v));
        fill.style.width = (p * 100).toFixed(1) + '%';
        pct.textContent = Math.round(p * 100) + '%';
        clearNotes();   // 续传/重传恢复后清掉等待提示与旧重试按钮
      },
      /* 断线时不判失败、不移除队列项：进度条保留，显示等待自动续传。 */
      waiting: function (msg) {
        el.classList.remove('err');
        var b = el.querySelector('.qretry'); if (b) b.remove();
        var m = el.querySelector('.qmsg');
        if (!m) { m = document.createElement('div'); m.className = 'qmsg'; el.appendChild(m); }
        m.textContent = msg;
        pct.textContent = '等待';
      },
      done: function () {
        cancelBtn.remove();
        pct.textContent = '完成';
        // 批量时完成项同步移除：本地/局域网下几十个文件可能在几百毫秒内
        // 全部传完，任何延时保留都会让它们叠在一起刷屏。完成反馈由汇总条
        // 的「完成 N / N」给出。单文件没有汇总条，保留 1.4 秒看清「完成」。
        if (document.querySelector('.qsum')) { el.remove(); return; }
        setTimeout(function () { if (el.isConnected) el.remove(); }, 1400);
      },
      fail: function (msg) {
        cancelBtn.remove();
        el.classList.add('err');
        pct.textContent = '失败';
        var m = el.querySelector('.qmsg');
        if (!m) { m = document.createElement('div'); m.className = 'qmsg'; el.appendChild(m); }
        m.textContent = msg;
        if (onRetry && !el.querySelector('.qretry')) {
          var btn = document.createElement('button');
          btn.className = 'qretry'; btn.type = 'button'; btn.textContent = '重试';
          btn.addEventListener('click', function () { btn.disabled = true; onRetry(); });
          el.appendChild(btn);
        }
        // 批量时失败信息容易被刷掉：保留 30 秒，汇总条还会留着计数与「重试失败项」
        setTimeout(function () { if (el.isConnected) el.remove(); }, 30000);
      },
      cancelled: function () {
        clearNotes();
        el.classList.remove('err');
        el.classList.add('cancelled');
        cancelBtn.remove();
        pct.textContent = '已取消';
        fill.style.width = '0%';
        setTimeout(function () { if (el.isConnected) el.remove(); }, 1400);
      },
      remove: function () { if (el.isConnected) el.remove(); },
    };
  }

  /* ── 批量上传：全局队列 + 固定并发 + 汇总条 ─────────────────────
     一次拖 50 个文件也只保留 CONCURRENCY 个进行中的进度条；分两批选文件
     不会再各起一组 worker 抢带宽；列表刷新合并成一次，不逐文件全量重绘。 */
  var upQueue = [], upActive = 0, upAll = [];
  var sumEl = null, sumRaf = 0, sumHideTimer = null, refreshTimer = null;

  function scheduleRefresh(immediate) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (immediate) { lastSig = ''; load(); return; }
    refreshTimer = setTimeout(function () { refreshTimer = null; lastSig = ''; load(); }, 400);
  }

  function paintSummary() {
    if (!sumEl) return;
    var total = upAll.length, done = 0, failed = 0, cancelled = 0, bytes = 0, loaded = 0;
    upAll.forEach(function (j) {
      if (j.state === 'cancelled') { cancelled++; return; }  // 取消项不占进度分母
      var sz = j.file.size || 0;
      bytes += sz; loaded += sz * (j.frac || 0);
      if (j.state === 'done') done++;
      else if (j.state === 'fail') failed++;
    });
    var active = upActive > 0 || upQueue.length > 0;
    sumEl.querySelector('.qsum-title').textContent =
      active ? '批量上传' : (failed ? '批量上传 · 有失败项' : '批量上传完成');
    var parts = '完成 ' + done + (failed ? ' · 失败 ' + failed : '') +
      (cancelled ? ' · 已取消 ' + cancelled : '');
    sumEl.querySelector('.qsum-count').textContent = active
      ? ('进行中 ' + (total - done - failed - cancelled) + ' · ' + parts + ' / ' + total)
      : (parts + ' / ' + total);
    sumEl.querySelector('.bar > i').style.width =
      (bytes ? loaded / bytes * 100 : (total ? done / total * 100 : 0)).toFixed(1) + '%';
    sumEl.classList.toggle('msg-err', failed > 0);
    sumEl.classList.toggle('msg-ok', !active && failed === 0);
    var acts = sumEl.querySelector('.qsum-acts');
    acts.hidden = false;
    acts.querySelector('[data-act="cancelAll"]').hidden = !active;
    acts.querySelector('[data-act="retry"]').hidden = !(failed > 0);
    acts.querySelector('[data-act="clear"]').hidden = active;
  }
  function updateSummary() {
    if (sumRaf) return;
    sumRaf = requestAnimationFrame(function () { sumRaf = 0; paintSummary(); });
  }
  function buildSummary() {
    var el = document.createElement('div');
    el.className = 'qsum';
    el.innerHTML = '<div class="qsum-top"><span class="qsum-title">批量上传</span>' +
      '<span class="qsum-count"></span></div><div class="bar"><i></i></div>' +
      '<div class="qsum-acts" hidden><button type="button" data-act="cancelAll">全部取消</button>' +
      '<button type="button" data-act="retry">重试失败项</button>' +
      '<button type="button" data-act="clear">清除</button></div>';
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'retry') retryFailed();
      else if (a === 'cancelAll') cancelAll();
      else clearSummary();
    });
    queueEl.insertBefore(el, queueEl.firstChild);
    return el;
  }
  function clearSummary() {
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    if (sumEl) { sumEl.remove(); sumEl = null; }
    upAll = [];
  }
  /* 取消是终止性的：abort 在途请求、把排队项从队列摘掉、通知服务端释放
     分片会话，并清掉本地续传记录——否则下次重选同一个文件还会从半截续上。 */
  function cancelJob(job) {
    if (!job || job.state === 'done' || job.state === 'fail' || job.state === 'cancelled') return;
    job.state = 'cancelled';
    job.frac = 0;
    if (job.cancelHook) { try { job.cancelHook(); } catch (e) {} job.cancelHook = null; }
    var k = upQueue.indexOf(job);
    if (k >= 0) upQueue.splice(k, 1);
    if (job.uploadId) { cancelSession(job.uploadId); job.uploadId = null; }
    try { clearResume(fpOf(job.file)); } catch (e) {}
    if (job.ui) { job.ui.cancelled(); job.ui = null; }
    updateSummary();
    if (!upQueue.length && upActive === 0) finishBatchIfIdle();
    scheduleRefresh(false);
  }
  function cancelAll() {
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    upQueue.slice().forEach(cancelJob);          // 还在排队、尚未开始的
    upAll.slice().forEach(function (j) { if (j.state === 'doing') cancelJob(j); });
    toast('已取消未完成的上传');
  }
  function requeue(job) {
    if (job.state === 'doing' || upQueue.indexOf(job) >= 0) return;
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    job.state = 'queued'; job.frac = 0;
    if (job.ui) { job.ui.remove(); job.ui = null; }
    upQueue.push(job);
    updateSummary();
    pumpUploads();
  }
  function retryFailed() {
    var failed = upAll.filter(function (j) { return j.state === 'fail'; });
    if (!failed.length) return;
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    failed.forEach(function (j) {
      j.state = 'queued'; j.frac = 0;
      if (j.ui) { j.ui.remove(); j.ui = null; }
      upQueue.push(j);
    });
    updateSummary();
    pumpUploads();
  }
  function finishBatchIfIdle() {
    if (upQueue.length || upActive > 0) return;
    scheduleRefresh(true);
    if (sumHideTimer) clearTimeout(sumHideTimer);
    var hasFail = upAll.some(function (j) { return j.state === 'fail'; });
    if (!hasFail) sumHideTimer = setTimeout(clearSummary, 3500);
  }

  function pumpUploads() {
    while (upActive < CONCURRENCY && upQueue.length) {
      (function (job) {
        upActive++; pending++;             // pending = 在途文件数，与轮询刷新判断一致
        job.state = 'doing';
        job.ui = makeQueueItem(job.file.name,
          function () { requeue(job); },
          function () { cancelJob(job); });
        var ui = {
          cancelled: function () { return job.state === 'cancelled'; },
          onCancel: function (fn) { job.cancelHook = fn; },
          onSession: function (id) {
            // init 恰好在取消之后才返回时，别让它变成没人管的孤儿会话
            if (job.state === 'cancelled') { cancelSession(id); return; }
            job.uploadId = id;
          },
          progress: function (v) {
            if (job.state === 'cancelled' || !job.ui) return;
            job.frac = Math.max(0, Math.min(1, v));
            job.ui.progress(job.frac);
            updateSummary();
          },
          waiting: function (m) { if (job.state === 'cancelled' || !job.ui) return; job.ui.waiting(m); },
        };
        uploadFile(job.file, ui, job.opt)
          .then(function (j) {
            if (job.state === 'cancelled') return;
            if (j && j.nameRepaired) toast('文件名包含无法解码的字符，已替换为可读名称');
            job.state = 'done'; job.frac = 1;
            job.ui.done();
            scheduleRefresh(false);
          })
          .catch(function (e) {
            if (job.state === 'cancelled' || (e && e.cancelled)) { job.state = 'cancelled'; return; }
            job.state = 'fail';
            job.ui.fail(e.message || '上传失败');
          })
          .then(function () {
            upActive--; pending--;
            updateSummary();
            pumpUploads();
            finishBatchIfIdle();
          });
      })(upQueue.shift());
    }
    updateSummary();
  }

  function enqueue(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return f && typeof f.size === 'number'; });
    if (!list.length) return;
    if (perm.canUpload === false) { toast('当前链接没有上传权限'); return; }
    // 上一轮已收尾（汇总条在倒计时隐藏）→ 开一轮干净的新统计；
    // 上一轮还有失败项时则合并，方便一起点「重试失败项」。
    if (sumHideTimer) {
      clearTimeout(sumHideTimer); sumHideTimer = null;
      upAll = [];
    }
    if (!sumEl) sumEl = buildSummary();
    // 整批共享：这一批所有文件读同一份「时长 + 提取码」快照，
    // 上传途中用户改面板也不会让同批文件设置不一致。
    var opt = uploadOpt();
    list.forEach(function (f) {
      var job = { file: f, state: 'queued', frac: 0, ui: null, opt: opt, cancelHook: null, uploadId: null };
      upAll.push(job);
      upQueue.push(job);
    });
    updateSummary();
    pumpUploads();
  }

  // ── 交互绑定 ───────────────────────────────────────────
  // 存储已满时所有上传入口一律短路返回：入口已禁用 + 文案说明，这里再兜底一层，
  // 绝不发起任何上传请求（服务端仍会拦，但前端不该制造"点了没反应/报 507"的错位感）。
  dropEl.addEventListener('click', function () { if (storageFull) return; fileInput.click(); });
  dropEl.addEventListener('keydown', function (e) {
    if (storageFull) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  $('pickFile').addEventListener('click', function () { if (storageFull) return; fileInput.click(); });
  $('pickMedia').addEventListener('click', function () { if (storageFull) return; mediaInput.click(); });
  fileInput.addEventListener('change', function () { if (storageFull) return; enqueue(fileInput.files); fileInput.value = ''; });
  mediaInput.addEventListener('change', function () { if (storageFull) return; enqueue(mediaInput.files); mediaInput.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) {
      e.preventDefault();
      if (storageFull) return;          // 满了不亮高亮，避免"能放进来"的错觉
      dropEl.classList.add('over');
    });
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (storageFull) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
  });
  window.addEventListener('paste', function (e) {
    if (storageFull) return;
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) enqueue(files);
  });

  $('refresh').addEventListener('click', function () { lastSig = ''; load(); });
  $('copyPage').addEventListener('click', function () { copy(withSC(location.href), '本页链接'); });

  $('textToggle').addEventListener('click', function () {
    var pane = $('textPane');
    pane.hidden = !pane.hidden;
    if (!pane.hidden) $('textInput').focus();
  });

  $('textSend').addEventListener('click', function () {
    var ta = $('textInput');
    var text = ta.value;
    if (!text.trim()) { toast('内容为空'); return; }
    var o = uploadOpt();
    fetch(BASE + '/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, h: o.h, pw: o.pw }),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
      .then(function () { ta.value = ''; $('textPane').hidden = true; toast('已生成文字链接'); lastSig = ''; load(); })
      .catch(function (e) { toast(e.message || '失败'); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!viewer.hidden) return closeViewer();
      if (!askModal.hidden) return closeAsk();
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
      navigator.serviceWorker.register(withSC('./sw.js'), { scope: './' })
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

  // 注：嵌入模式的"收起遮罩"信号已在 load() 渲染完成后统一上报（7md:drop-ready），
  // 此处不再提前发，避免内容还没渲染好就收遮罩导致白屏闪。

  // ── 页脚「知行工作室」：不跳出到系统浏览器 ──
  // 嵌在桌面壳里 → 请父窗口（Win98 桌面）用内置的 IE 打开；
  // 独立打开（手机直接访问）→ 跳桌面壳根路径带 ?ie=，由它开内置浏览器。
  var studioLink = $('studioLink');
  if (studioLink) {
    studioLink.addEventListener('click', function (e) {
      e.preventDefault();
      var url = 'https://w3b.pub/';
      var sent = false;
      try {
        if (window.parent && window.parent !== window && window.parent.postMessage) {
          window.parent.postMessage({ type: '7md:open-ie', url: url }, '*');
          sent = true;
        }
      } catch (err) { /* 跨域等异常：走下面的兜底 */ }
      if (!sent) {
        try { location.href = withSC('/?ie=' + encodeURIComponent(url)); } catch (err) { /* 忽略 */ }
      }
    });
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

function rootManifestJson(sc) {
  const u = (x) => withShareCode(x, sc);
  return JSON.stringify({
    name: '7喵快传 · Win98 桌面',
    short_name: '7喵快传',
    description: '7喵快传 · 单文件自托管文件服务，跑在 Windows 98 仿真桌面上',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: u('/'),
    scope: '/',
    id: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    theme_color: '#008080',
    background_color: '#008080',
    icons: [
      { src: u('/icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: u('/icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: u('/icons/icon-512-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: u('/favicon.ico'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    /* Android 长按图标快捷方式：直接进文件服务 / 扫雷，省一层桌面点击 */
    shortcuts: [
      { name: '文件服务', short_name: '文件', url: u('/'), description: '进入文件管理' },
      { name: '扫雷', short_name: '扫雷', url: u('/?app=mines'), description: '来一局扫雷' },
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
      /* 预缓存要**带版本号**：页面请求的是 /home.css?v=<哈希>，
         fetch 层的缓存键也是 pathname+search。若这里只存裸路径，
         离线冷启动时带版本号的请求会落空（离线白屏）。
         所以两种都存：带版本号的（日常命中）+ 裸路径的（兜底）。 */
      var vs = VERSION ? '?v=' + VERSION : '';
      var list = [];
      SHELL.forEach(function (u) {
        list.push(u + vs);
        list.push(u);
      });
      return Promise.all(list.map(function (u) {
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

/* 页面侧检测到新版本时会发这条：立即跳过等待、接管页面。
   不接的话，新 SW 会一直等到所有旧标签页关闭才生效 ——
   用户看到的仍是旧版样式，而版本号已经变了，越查越困惑。 */
self.addEventListener('message', function (e) {
  var d = e && e.data;
  if (!d || d.type !== 'skip-waiting') return;
  self.skipWaiting();
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

  // 外壳资源：cache-first，但**缓存键必须带上版本号**。
  // 踩过的坑（导致用户手机上「新版 JS + 旧版 CSS」混搭、布局错乱）：
  //   页面里 home.css / home.js 带 ?v=内容哈希 当破坏器，
  //   而预缓存用的是裸路径 '/home.css'。若按 pathname 存取，
  //   caches.match('/home.css') 会把旧版资源一直命中 ——
  //   新版本号形同虚设，服务端明明已经更新，浏览器还在用旧样式。
  // 修法：缓存键 = pathname + search（含 ?v=），版本号一变就是新键，
  // 旧条目由 activate 阶段的 caches.delete 一并清掉。
  var key = url.pathname + url.search;
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
  await loadQQ();
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
  console.log('  默认时长 : ' + (TTL_HOURS > 0 ? TTL_HOURS + ' 小时' : '永久') +
    '（可选 ' + EXP_CHOICES.filter((h) => h !== 0 || ALLOW_FOREVER)
      .map((h) => h === 0 ? '永久' : h + 'h').join('/') + '）');
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
