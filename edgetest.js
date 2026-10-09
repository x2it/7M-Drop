'use strict';
/**
 * 边界与安全回归（14 项）—— 用真实 HTTP 请求打到运行中的实例。
 *
 * 覆盖单元测试容易漏、但线上真会被踩到的路径：
 *   - 请求体畸形 vs 超限必须区分（400 / 413），不能一律 413
 *   - 文件名路径穿越：name 只做展示，落盘一律按随机 id，穿越不出目录
 *   - Content-Disposition 防注入（引号 / CRLF / ../ 不能破坏响应头）
 *   - Range 后缀请求 bytes=-N 语义正确
 *   - 权限：游客不能删、meta 不泄露 shareUrl 与文件列表、伪造 token 拿不到数据
 *   - 方法与路由：GET /api/put、未知 id 一律 404
 *
 * 用法：node edgetest.js [BASE] [ADMIN_TOKEN] [GUEST_TOKEN]
 * 默认打 http://127.0.0.1:3000，与本地开发实例对齐。
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const ADM = process.argv[3] || 'wby6sg8pm0';
const GUE = process.argv[4] || 'guest1234';

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

async function req(method, path, opts) {
  const r = await fetch(BASE + path, Object.assign({ method: method }, opts));
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON 响应忽略 */ }
  return { status: r.status, body: body, headers: r.headers };
}

const jsonPost = (path, obj) => req('POST', path, {
  headers: { 'content-type': 'application/json' },
  body: typeof obj === 'string' ? obj : JSON.stringify(obj),
});

async function cleanup(id) {
  if (id) await jsonPost(`/s/${ADM}/api/delete`, { id: id });
}

(async () => {
  console.log('边界与安全回归 → ' + BASE + '\n');

  // ── 请求体错误分类：畸形 JSON 与超限必须区分 ──
  let r = await jsonPost(`/s/${ADM}/api/text`, { text: '   ' });
  ok('空文本返回 400 内容为空', r.status === 400 && /内容为空/.test(r.body.error || ''), r.status + ' ' + JSON.stringify(r.body));

  r = await jsonPost(`/s/${ADM}/api/text`, '{bad json');
  ok('畸形 JSON 返回 400（不是 413）', r.status === 400, r.status + ' ' + JSON.stringify(r.body));

  // ── 文件名路径穿越：展示名清洗 + 落盘按 id ──
  r = await req('PUT', `/s/${ADM}/api/put?name=` + encodeURIComponent('../../etc/passwd'), { body: 'PWNED' });
  ok('穿越文件名可正常上传', r.status === 200, r.status + ' ' + JSON.stringify(r.body));
  if (r.status === 200) {
    const item = r.body.item;
    // 真正的防穿越不变量：展示名不含路径分隔符、且不以 . 开头（不会变成 ../
    // 隐藏文件）。中间的 .. （如 my..file）本身无害，落盘又一律按随机 id。
    ok('穿越名被清洗（无分隔符、不以点开头）',
      !/[\/\\]/.test(item.name) && !item.name.startsWith('.'), item.name);
    const d = await fetch(BASE + `/s/${ADM}/d/${item.id}`);
    ok('穿越上传后内容可下载且正确', (await d.text()) === 'PWNED');
    const cd = d.headers.get('content-disposition') || '';
    ok('Content-Disposition 不含 ../', !/\.\.\//.test(cd) && /filename=/.test(cd), cd);
    await cleanup(item.id);
  }

  // ── Content-Disposition 防头注入 ──
  r = await req('PUT', `/s/${ADM}/api/put?name=` + encodeURIComponent('a"b\r\nc.txt'), { body: 'x' });
  ok('危险字符文件名可上传', r.status === 200, r.status);
  if (r.status === 200) {
    const id = r.body.item.id;
    const d = await fetch(BASE + `/s/${ADM}/d/${id}`);
    const cd = d.headers.get('content-disposition') || '';
    const firstPart = cd.split(';')[0];
    ok('CRLF/引号未破坏 CD 头', !/[\r\n]/.test(cd) && !/"/.test(firstPart), cd);
    await cleanup(id);
  }

  // ── Range 后缀：bytes=-N 取末尾 N 字节 ──
  r = await req('PUT', `/s/${ADM}/api/put?name=range.bin`, { body: '0123456789' });
  ok('range 测试文件可上传', r.status === 200, r.status);
  if (r.status === 200) {
    const id = r.body.item.id;
    const d = await fetch(BASE + `/s/${ADM}/d/${id}`, { headers: { range: 'bytes=-5' } });
    const slice = await d.text();
    ok('bytes=-5 返回末尾 5 字节 (206)', d.status === 206 && slice === '56789', d.status + ' ' + JSON.stringify(slice));
    await cleanup(id);
  }

  // ── 404 与方法/路由边界 ──
  r = await req('GET', `/s/${ADM}/d/nope_nope`);
  ok('下载不存在 id → 404', r.status === 404, r.status);

  r = await req('GET', `/s/${ADM}/api/put`);
  ok('GET /api/put（方法不允许）→ 404', r.status === 404, r.status);

  r = await req('GET', `/s/whatever_token/api/list`);
  ok('伪造 token 访问 → 404', r.status === 404, r.status);

  // ── 权限隔离 ──
  r = await jsonPost(`/s/${GUE}/api/delete`, { id: 'x' });
  ok('游客删除 → 403', r.status === 403, r.status + ' ' + JSON.stringify(r.body));

  r = await req('GET', `/s/${GUE}/api/meta`);
  ok('游客 meta 不泄露 shareUrl', r.status === 200 && !r.body.shareUrl, JSON.stringify(r.body && r.body.shareUrl));
  ok('游客 meta 不回传文件列表', r.status === 200 && !r.body.items, 'has items=' + !!(r.body && r.body.items));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();