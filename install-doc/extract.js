#!/usr/bin/env node
'use strict';

/**
 * 文档自洽性验证：模拟 AI 照着 drop.md 执行。
 *
 * 只靠这份 markdown，能不能把服务跑起来？
 * 本脚本解析围栏代码块、抽出 server.js 与 verify.mjs，写到干净目录。
 *
 * 用法: node extract.js [目标目录]
 */

const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', 'INSTALL.md');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '_fresh'));

if (!fs.existsSync(DOC)) {
  console.error('找不到 drop.md，先跑 node build.js');
  process.exit(1);
}

const doc = fs.readFileSync(DOC, 'utf8');
const lines = doc.split('\n');

// ── 解析围栏代码块（支持 3 个及以上反引号）────────────────
const blocks = [];
let open = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = /^(`{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);

  if (!m) {
    // 普通内容行：只有处于块内才收集（这就是之前的 bug —— 这里原本直接 continue，
    // 导致每个块的正文都是空的）
    if (open) open.body.push(line);
    continue;
  }

  if (!open) {
    open = { fence: m[1], lang: m[2] || '', start: i + 1, body: [] };
  } else if (m[1].length >= open.fence.length && m[2] === '') {
    blocks.push({ lang: open.lang, start: open.start, end: i, text: open.body.join('\n') });
    open = null;
  } else {
    // 块内出现的带语言标记围栏样行，按普通内容处理
    open.body.push(line);
  }
}
if (open) {
  console.error('错误: 第 ' + open.start + ' 行开始的围栏没有闭合');
  process.exit(1);
}

// ── 按特征识别哪块是什么 ──────────────────────────────────
const serverBlock = blocks.find((b) => b.text.includes('单文件零依赖文件中转服务器'));
const verifyBlock = blocks.find((b) => b.text.includes('精简自测'));
const shellBlocks = blocks.filter((b) => b.lang === 'bash' || b.lang === 'sh');

console.log('文档解析: ' + path.relative(process.cwd(), DOC));
console.log('  代码块总数 : ' + blocks.length);
console.log('  shell 块   : ' + shellBlocks.length);
console.log('  server.js  : ' + (serverBlock ? '第 ' + serverBlock.start + ' 行起, ' + serverBlock.text.length + ' 字节' : '未找到'));
console.log('  verify.mjs : ' + (verifyBlock ? '第 ' + verifyBlock.start + ' 行起, ' + verifyBlock.text.length + ' 字节' : '未找到'));

if (!serverBlock || !verifyBlock) {
  console.error('\n文档不自洽：缺少可提取的源码块');
  process.exit(1);
}

// ── 写出 ──────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'server.js'), serverBlock.text + '\n', 'utf8');
fs.writeFileSync(path.join(OUT, 'verify.mjs'), verifyBlock.text + '\n', 'utf8');

console.log('\n已写出到 ' + OUT + ':');
for (const f of ['server.js', 'verify.mjs']) {
  const st = fs.statSync(path.join(OUT, f));
  console.log('  ' + f.padEnd(12) + st.size + ' 字节');
}
