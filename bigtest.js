'use strict';
const crypto = require('crypto');

const BASE = process.argv[2];
const TOKEN = process.argv[3];
const MB = Number(process.argv[4] || 20);
const P = BASE + '/s/' + TOKEN;

(async () => {
  const size = MB * 1024 * 1024 + 12345;
  const payload = crypto.randomBytes(size);
  const wantHash = crypto.createHash('sha256').update(payload).digest('hex');

  console.log('上传 ' + (size / 1048576).toFixed(2) + ' MB -> ' + BASE);

  let r = await fetch(P + '/api/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '大文件测试.bin', size, type: 'application/octet-stream' }),
  });
  const info = await r.json();
  if (!r.ok) throw new Error('init 失败: ' + JSON.stringify(info));
  const chunk = info.chunkSize;
  const totalChunks = Math.ceil(size / chunk);
  console.log('分片大小 ' + (chunk / 1048576) + ' MB, 共 ' + totalChunks + ' 片');

  const t0 = Date.now();
  let sent = 0, i = 0;
  while (sent < size) {
    const end = Math.min(sent + chunk, size);
    const t1 = Date.now();
    const res = await fetch(P + '/api/chunk?u=' + info.uploadId + '&i=' + i, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload.subarray(sent, end),
    });
    const body = await res.text();
    if (!res.ok) throw new Error('分片 ' + i + ' 失败 HTTP ' + res.status + ' ' + body);
    const secs = (Date.now() - t1) / 1000;
    console.log('  片 ' + (i + 1) + '/' + totalChunks + '  ' +
      ((end - sent) / 1048576).toFixed(2) + ' MB  ' + secs.toFixed(2) + 's  ' +
      (((end - sent) / 1048576) / secs).toFixed(2) + ' MB/s');
    sent = end; i++;
  }

  r = await fetch(P + '/api/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: info.uploadId }),
  });
  const fin = await r.json();
  if (!r.ok) throw new Error('finish 失败: ' + JSON.stringify(fin));
  console.log('服务端收到 ' + (fin.item.size / 1048576).toFixed(2) + ' MB');
  if (fin.item.size !== size) throw new Error('大小不符: ' + fin.item.size + ' != ' + size);

  const tDl = Date.now();
  const dl = await fetch(P + '/d/' + fin.item.id);
  const got = Buffer.from(await dl.arrayBuffer());
  const secsDl = (Date.now() - tDl) / 1000;
  const gotHash = crypto.createHash('sha256').update(got).digest('hex');

  console.log('下载 ' + (got.length / 1048576).toFixed(2) + ' MB  ' + secsDl.toFixed(2) + 's  ' +
    ((got.length / 1048576) / secsDl).toFixed(2) + ' MB/s');
  console.log('上传耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  if (gotHash !== wantHash) {
    console.log('SHA256 不匹配!\n  期望 ' + wantHash + '\n  实际 ' + gotHash);
    process.exit(1);
  }
  console.log('SHA256 一致: ' + wantHash.slice(0, 16) + '…  ✅ 大文件多分片完整无误');

  await fetch(P + '/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: fin.item.id }),
  });
  console.log('已清理测试文件');
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
