#!/usr/bin/env node
'use strict';

/**
 * 快传自测：覆盖鉴权、分片上传、下载、Range、文字分享、删除。
 * 用法: node selftest.js [baseUrl] [token]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const TOKEN = process.argv[3];
if (!TOKEN) {
  console.error('用法: node selftest.js <baseUrl> <管理口令>');
  process.exit(2);
}
const P = BASE + '/s/' + TOKEN;

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
}

(async function run() {
  console.log('\n快传自测 @ ' + P + '\n');

  // 1. healthz 无需口令
  let r = await jfetch(BASE + '/healthz');
  ok('GET /healthz 公开可访问', r.status === 200 && r.text.trim() === 'ok', 'status=' + r.status);

  // 2. 错误口令应 404
  r = await jfetch(BASE + '/s/wrong-token/api/list');
  ok('错误口令返回 404', r.status === 404, 'status=' + r.status);

  // 3. 正确口令首页
  r = await jfetch(P + '/');
  ok('首页返回 HTML', r.status === 200 && /快传/.test(r.text), 'status=' + r.status);
  r = await jfetch(P + '/app.css');
  ok('样式表可加载', r.status === 200 && r.headers.get('content-type').includes('text/css'));
  r = await jfetch(P + '/app.js');
  ok('脚本可加载', r.status === 200 && r.headers.get('content-type').includes('javascript'));

  // 4. 分片上传（中文名 + 二进制 + 跨多个分片）
  const NAME = '测试文件-中文名.bin';
  const payload = Buffer.alloc(1024 * 1024 + 777);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

  r = await jfetch(P + '/api/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, size: payload.length, type: 'application/octet-stream' }),
  });
  ok('init 返回 uploadId', r.status === 200 && r.json && r.json.uploadId, 'status=' + r.status + ' body=' + r.text.slice(0, 120));
  const uploadId = r.json.uploadId;
  const chunkSize = r.json.chunkSize;

  // 故意乱序，应被拒绝
  r = await jfetch(P + '/api/chunk?u=' + uploadId + '&i=5', { method: 'POST', body: payload.slice(0, 10) });
  ok('乱序分片被拒绝 (409)', r.status === 409, 'status=' + r.status);

  let sent = 0;
  let idx = 0;
  while (sent < payload.length) {
    const end = Math.min(sent + chunkSize, payload.length);
    const res = await fetch(P + '/api/chunk?u=' + uploadId + '&i=' + idx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload.slice(sent, end),
    });
    if (res.status !== 200) { ok('分片 ' + idx + ' 上传', false, 'status=' + res.status); break; }
    await res.text();
    sent = end;
    idx++;
  }
  ok('全部分片上传完成 (' + idx + ' 片)', sent === payload.length);

  r = await jfetch(P + '/api/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
  ok('finish 成功', r.status === 200 && r.json && r.json.ok, 'status=' + r.status + ' body=' + r.text.slice(0, 160));
  const fileId = r.json && r.json.item && r.json.item.id;
  ok('返回文件名保持中文', r.json && r.json.item && r.json.item.name === NAME, r.json && r.json.item && r.json.item.name);
  ok('返回大小一致', r.json && r.json.item && r.json.item.size === payload.length, r.json && r.json.item && r.json.item.size);

  // 5. 列表
  r = await jfetch(P + '/api/list');
  ok('列表包含刚上传的文件', r.status === 200 && r.json.items.some((x) => x.id === fileId));

  // 6. 完整下载并比对字节
  let dl = await fetch(P + '/d/' + fileId);
  let buf = Buffer.from(await dl.arrayBuffer());
  ok('下载内容与上传一致', dl.status === 200 && buf.equals(payload), 'status=' + dl.status + ' len=' + buf.length + '/' + payload.length);
  ok('Content-Disposition 含中文名', /filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));

  // 7. Range 请求
  dl = await fetch(P + '/d/' + fileId, { headers: { Range: 'bytes=100-199' } });
  buf = Buffer.from(await dl.arrayBuffer());
  ok('Range 返回 206 且长度 100', dl.status === 206 && buf.length === 100, 'status=' + dl.status + ' len=' + buf.length);
  ok('Range 内容正确', buf.equals(payload.slice(100, 200)));
  ok('Range 头正确', (dl.headers.get('content-range') || '').startsWith('bytes 100-199/'));

  dl = await fetch(P + '/d/' + fileId, { headers: { Range: 'bytes=999999999-' } });
  ok('越界 Range 返回 416', dl.status === 416, 'status=' + dl.status);
  await dl.text();

  // 8. 文字分享
  const TEXT = '这是一段测试文字 <script>alert(1)</script>';
  r = await jfetch(P + '/api/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: TEXT }),
  });
  ok('文字分享创建成功', r.status === 200 && r.json && r.json.item, 'status=' + r.status);
  const textId = r.json.item.id;
  r = await jfetch(P + '/v/' + textId);
  ok('文字内容可读回', r.status === 200 && r.text === TEXT);
  ok('文字以纯文本返回', (r.headers.get('content-type') || '').includes('text/plain'));

  // 9. 危险类型降级：上传 .html 走 inline 应变成 text/plain
  const htmlBody = Buffer.from('<script>alert(1)</script>', 'utf8');
  r = await jfetch(P + '/api/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'xss.html', size: htmlBody.length, type: 'text/html' }),
  });
  const hId = r.json.uploadId;
  await fetch(P + '/api/chunk?u=' + hId + '&i=0', { method: 'POST', body: htmlBody });
  r = await jfetch(P + '/api/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: hId }),
  });
  const htmlId = r.json.item.id;
  r = await jfetch(P + '/v/' + htmlId);
  ok('HTML 预览被降级为纯文本', (r.headers.get('content-type') || '').includes('text/plain'), r.headers.get('content-type'));
  r = await jfetch(P + '/d/' + htmlId);
  ok('HTML 下载为附件', (r.headers.get('content-disposition') || '').startsWith('attachment'));

  // 10. 删除
  r = await jfetch(P + '/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: fileId }),
  });
  ok('删除成功', r.status === 200);
  r = await jfetch(P + '/d/' + fileId);
  ok('删除后下载返回 404', r.status === 404, 'status=' + r.status);

  // 清理测试残留
  for (const id of [textId, htmlId]) {
    await jfetch(P + '/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  }

  // 11. 会话不存在
  r = await jfetch(P + '/api/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: 'nope' }),
  });
  ok('不存在的上传会话返回 404', r.status === 404, 'status=' + r.status);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自测异常:', e);
  process.exit(1);
});
