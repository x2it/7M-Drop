#!/usr/bin/env node
'use strict';

/**
 * 权限模型测试：管理口令 vs 分享口令
 * 用法: node permtest.js <baseUrl> <adminToken> <shareToken>
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const ADMIN = process.argv[3];
const GUEST = process.argv[4];

if (!ADMIN || !GUEST) {
  console.error('用法: node permtest.js <baseUrl> <adminToken> <shareToken>');
  process.exit(2);
}

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
  return { status: r.status, text, json };
}
const postJSON = (url, body) => req(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const A = BASE + '/s/' + ADMIN;
const G = BASE + '/s/' + GUEST;

(async function run() {
  console.log('\n权限模型测试\n  管理 : ' + A + '\n  分享 : ' + G + '\n');

  // ── 角色识别 ────────────────────────────────────────────
  let r = await req(A + '/api/list');
  ok('管理口令可读列表', r.status === 200, 'status=' + r.status);
  ok('管理角色 = admin', r.json && r.json.role === 'admin', r.json && r.json.role);
  ok('管理可删除', r.json && r.json.canDelete === true);
  ok('管理拿到分享口令', r.json && typeof r.json.shareToken === 'string' && r.json.shareToken.length > 0);

  r = await req(G + '/api/list');
  ok('分享口令可读列表', r.status === 200, 'status=' + r.status);
  ok('分享角色 = guest', r.json && r.json.role === 'guest', r.json && r.json.role);
  ok('分享不可删除', r.json && r.json.canDelete === false, JSON.stringify(r.json && r.json.canDelete));
  ok('分享回传不含 shareToken', r.json && r.json.shareToken === undefined);
  ok('分享可上传', r.json && r.json.canUpload === true);
  ok('分享可看列表', r.json && r.json.canList === true);

  // ── 无效口令 ────────────────────────────────────────────
  r = await req(BASE + '/s/totally-wrong/api/list');
  ok('错误口令返回 404', r.status === 404, 'status=' + r.status);

  // ── 分享口令能上传 ──────────────────────────────────────
  const data = Buffer.from('guest upload ok ' + Date.now());
  r = await postJSON(G + '/api/init', { name: '来访者上传.txt', size: data.length, type: 'text/plain' });
  ok('分享口令可 init', r.status === 200 && r.json && r.json.uploadId, 'status=' + r.status + ' ' + r.text.slice(0, 100));
  const upId = r.json && r.json.uploadId;
  let guestFileId = null;
  if (upId) {
    await fetch(G + '/api/chunk?u=' + upId + '&i=0', { method: 'POST', body: data });
    r = await postJSON(G + '/api/finish', { uploadId: upId });
    ok('分享口令可完成上传', r.status === 200 && r.json && r.json.item, 'status=' + r.status);
    guestFileId = r.json && r.json.item && r.json.item.id;
  }

  // ── 关键：分享口令不能删除 ──────────────────────────────
  if (guestFileId) {
    r = await postJSON(G + '/api/delete', { id: guestFileId });
    ok('★ 分享口令删除被服务端拒绝 (403)', r.status === 403, 'status=' + r.status + ' body=' + r.text.slice(0, 120));
    ok('  拒绝信息可读', r.json && /管理链接|删除/.test(r.json.error || ''), r.json && r.json.error);

    r = await req(G + '/d/' + guestFileId);
    ok('被拒后文件仍存在（没被误删）', r.status === 200, 'status=' + r.status);

    // 分享口令也不能删别人的文件
    const list = await req(A + '/api/list');
    const other = list.json.items.find((x) => x.id !== guestFileId);
    if (other) {
      r = await postJSON(G + '/api/delete', { id: other.id });
      ok('★ 分享口令删除他人文件同样被拒 (403)', r.status === 403, 'status=' + r.status);
    }
  }

  // ── 管理口令能删除 ──────────────────────────────────────
  if (guestFileId) {
    r = await postJSON(A + '/api/delete', { id: guestFileId });
    ok('管理口令可删除', r.status === 200, 'status=' + r.status);
    r = await req(A + '/d/' + guestFileId);
    ok('删除后确实不存在', r.status === 404, 'status=' + r.status);
  }

  // ── 分享口令也能下载 ────────────────────────────────────
  r = await postJSON(A + '/api/text', { text: '权限测试用文本 ' + Date.now() });
  const textId = r.json && r.json.item && r.json.item.id;
  if (textId) {
    r = await req(G + '/v/' + textId);
    ok('分享口令可下载/预览', r.status === 200, 'status=' + r.status);
    await postJSON(A + '/api/delete', { id: textId });
  }

  // ── /qr.js 路由存在 ─────────────────────────────────────
  r = await req(A + '/qr.js');
  ok('/qr.js 可加载', r.status === 200, 'status=' + r.status);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常: ' + e.message); process.exit(1); });
