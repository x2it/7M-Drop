'use strict';
const fs = require('fs');
const path = require('path');

const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const out = path.join(__dirname, 'cloudflared.exe');

(async () => {
  console.log('下载: ' + url);
  const r = await fetch(url, { redirect: 'follow' });
  console.log('HTTP ' + r.status + '  content-length=' + r.headers.get('content-length'));
  if (!r.ok) { console.error('下载失败'); process.exit(1); }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log('已保存: ' + out + '  (' + (buf.length / 1048576).toFixed(1) + ' MB)');
  console.log('magic: ' + buf.subarray(0, 2).toString('hex'));
})().catch((e) => { console.error('异常: ' + e.message); process.exit(1); });
