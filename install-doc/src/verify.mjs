#!/usr/bin/env node
'use strict';

/**
 * 快传精简自测 —— 证明服务真的能用，而不是「看起来启动了」。
 *
 * 用法:  node verify.mjs <baseUrl> <token>
 * 例:    node verify.mjs http://127.0.0.1:8080 <你设置的访问口令>
 *
 * 退出码 0 = 全部通过；1 = 有失败；2 = 用法错误。
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TOKEN = process.argv[3];

if (!TOKEN) {
  console.error('用法: node verify.mjs <baseUrl> <token>');
  process.exit(2);
}

const P = BASE + '/s/' + TOKEN;
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

async function req(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, headers: r.headers, text, json };
}

const postJSON = (url, body) => req(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

(async function run() {
  console.log('\n快传自测 @ ' + P + '\n');

  // ── 1. 路由与鉴权 ──────────────────────────────────────
  let r = await req(BASE + '/healthz');
  ok('健康检查可访问', r.status === 200 && r.text.trim() === 'ok', 'status=' + r.status);

  r = await req(BASE + '/s/wrong-token/api/list');
  ok('错误口令返回 404', r.status === 404, 'status=' + r.status);

  r = await req(P + '/');
  ok('首页返回 HTML', r.status === 200 && r.text.indexOf('快传') >= 0, 'status=' + r.status);

  r = await req(P + '/app.css');
  ok('样式表可加载', r.status === 200 && (r.headers.get('content-type') || '').includes('text/css'));

  r = await req(P + '/app.js');
  ok('脚本可加载', r.status === 200 && (r.headers.get('content-type') || '').includes('javascript'));

  // ── 2. 分片上传（含中文名与二进制内容）────────────────
  const NAME = '验证文件-中文名.bin';
  const payload = Buffer.alloc(1024 * 1024 + 777);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

  r = await postJSON(P + '/api/init', { name: NAME, size: payload.length, type: 'application/octet-stream' });
  ok('init 返回 uploadId', r.status === 200 && r.json && r.json.uploadId, 'status=' + r.status);
  if (!r.json || !r.json.uploadId) { return finish(); }

  const uploadId = r.json.uploadId;
  const chunkSize = r.json.chunkSize || 8 * 1024 * 1024;

  r = await req(P + '/api/chunk?u=' + uploadId + '&i=5', { method: 'POST', body: payload.subarray(0, 10) });
  ok('乱序分片被拒绝 (409)', r.status === 409, 'status=' + r.status);

  let sent = 0;
  let idx = 0;
  while (sent < payload.length) {
    const end = Math.min(sent + chunkSize, payload.length);
    const res = await fetch(P + '/api/chunk?u=' + uploadId + '&i=' + idx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload.subarray(sent, end),
    });
    await res.text();
    if (res.status !== 200) { ok('分片 ' + idx + ' 上传', false, 'status=' + res.status); break; }
    sent = end;
    idx++;
  }
  ok('全部分片上传完成', sent === payload.length, sent + '/' + payload.length);

  r = await postJSON(P + '/api/finish', { uploadId });
  ok('finish 成功', r.status === 200 && r.json && r.json.ok, 'status=' + r.status);
  if (!r.json || !r.json.item) { return finish(); }

  const fileId = r.json.item.id;
  ok('文件名保持中文', r.json.item.name === NAME, r.json.item.name);
  ok('大小一致', r.json.item.size === payload.length, String(r.json.item.size));

  // ── 3. 下载完整性与 Range ──────────────────────────────
  r = await req(P + '/api/list');
  ok('列表包含该文件', r.status === 200 && r.json.items.some((x) => x.id === fileId));

  let dl = await fetch(P + '/d/' + fileId);
  let buf = Buffer.from(await dl.arrayBuffer());
  ok('下载内容与上传一致', dl.status === 200 && buf.equals(payload), 'len=' + buf.length);
  ok('含 RFC 5987 文件名头', /filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''));

  dl = await fetch(P + '/d/' + fileId, { headers: { Range: 'bytes=100-199' } });
  buf = Buffer.from(await dl.arrayBuffer());
  ok('Range 返回 206 且长度正确', dl.status === 206 && buf.length === 100, 'status=' + dl.status);
  ok('Range 内容正确', buf.equals(payload.subarray(100, 200)));
  ok('Content-Range 头正确', (dl.headers.get('content-range') || '').indexOf('bytes 100-199/') === 0);

  dl = await fetch(P + '/d/' + fileId, { headers: { Range: 'bytes=999999999-' } });
  ok('越界 Range 返回 416', dl.status === 416, 'status=' + dl.status);
  await dl.text();

  // ── 4. 文字分享与危险类型降级 ──────────────────────────
  const TEXT = '验证文字 <script>alert(1)</script>';
  r = await postJSON(P + '/api/text', { text: TEXT });
  ok('文字分享创建成功', r.status === 200 && r.json && r.json.item, 'status=' + r.status);
  const textId = r.json && r.json.item && r.json.item.id;

  if (textId) {
    r = await req(P + '/v/' + textId);
    ok('文字内容可读回', r.status === 200 && r.text === TEXT);
    ok('文字以纯文本返回', (r.headers.get('content-type') || '').includes('text/plain'));
  }

  const html = Buffer.from('<script>alert(1)</script>', 'utf8');
  r = await postJSON(P + '/api/init', { name: 'xss.html', size: html.length, type: 'text/html' });
  const hId = r.json && r.json.uploadId;
  let htmlId = null;
  if (hId) {
    await fetch(P + '/api/chunk?u=' + hId + '&i=0', { method: 'POST', body: html });
    r = await postJSON(P + '/api/finish', { uploadId: hId });
    htmlId = r.json && r.json.item && r.json.item.id;
  }
  if (htmlId) {
    r = await req(P + '/v/' + htmlId);
    ok('HTML 预览降级为纯文本', (r.headers.get('content-type') || '').includes('text/plain'), r.headers.get('content-type'));
    r = await req(P + '/d/' + htmlId);
    ok('HTML 下载为附件', (r.headers.get('content-disposition') || '').indexOf('attachment') === 0);
  } else {
    ok('HTML 降级用例', false, '未能创建测试文件');
  }

  // ── 5. 删除 ────────────────────────────────────────────
  r = await postJSON(P + '/api/delete', { id: fileId });
  ok('删除成功', r.status === 200);
  r = await req(P + '/d/' + fileId);
  ok('删除后下载返回 404', r.status === 404, 'status=' + r.status);

  for (const id of [textId, htmlId]) {
    if (id) await postJSON(P + '/api/delete', { id });
  }

  r = await postJSON(P + '/api/finish', { uploadId: 'nope' });
  ok('不存在的上传会话返回 404', r.status === 404, 'status=' + r.status);

  finish();
})().catch(function (e) {
  console.error('\n自测异常: ' + e.message);
  process.exit(1);
});

function finish() {
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
}
