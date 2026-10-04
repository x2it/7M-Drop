'use strict';
/** 生成一个渐变 PNG（手写编码器，零依赖），再灌几个演示文件到服务器 */
const zlib = require('zlib');

const BASE = process.argv[2];
const TOKEN = process.argv[3];
const P = BASE + '/s/' + TOKEN;

// ── 极简 PNG 编码器 ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function makePng(w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      raw[o++] = Math.round(79 + 156 * u * (1 - v));   // R
      raw[o++] = Math.round(140 - 60 * v + 60 * u);    // G
      raw[o++] = Math.round(255 - 90 * u * v);         // B
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 上传助手 ─────────────────────────────────────────────
async function put(name, type, buf) {
  const r = await fetch(P + '/api/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, size: buf.length, type }),
  });
  const info = await r.json();
  if (!r.ok) throw new Error(name + ' init: ' + JSON.stringify(info));
  const chunkSize = info.chunkSize;
  let sent = 0, i = 0;
  while (sent < buf.length) {
    const end = Math.min(sent + chunkSize, buf.length);
    const res = await fetch(P + '/api/chunk?u=' + info.uploadId + '&i=' + i, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf.subarray(sent, end),
    });
    if (!res.ok) throw new Error(name + ' chunk ' + i + ': ' + (await res.text()));
    await res.text();
    sent = end; i++;
  }
  const f = await fetch(P + '/api/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: info.uploadId }),
  });
  const fin = await f.json();
  if (!f.ok) throw new Error(name + ' finish: ' + JSON.stringify(fin));
  console.log('  已上传 ' + name + '  (' + (buf.length / 1024).toFixed(1) + ' KB)');
  return fin.item.id;
}

(async () => {
  console.log('灌入演示数据 -> ' + BASE);
  const png = makePng(640, 400);
  await put('设计稿-渐变预览.png', 'image/png', png);
  await put('接口文档-v2.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n' + 'x'.repeat(220000)));
  await put('发布包-2026.10.zip', 'application/zip', Buffer.alloc(1_350_000, 7));
  await put('会议纪要.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.alloc(48_000, 3));

  const t = await fetch(P + '/api/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '生产环境部署口令：\n  DB_HOST=10.0.3.21\n  DB_USER=app_ro\n\n注意：本周五 22:00 做数据库迁移，请提前提交变更单。' }),
  });
  const tj = await t.json();
  if (!t.ok) throw new Error('文字: ' + JSON.stringify(tj));
  console.log('  已上传 一段文字分享');

  const list = await (await fetch(P + '/api/list')).json();
  console.log('当前共 ' + list.items.length + ' 项');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
