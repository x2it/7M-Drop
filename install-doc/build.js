#!/usr/bin/env node
'use strict';

/**
 * 生成器：把 src/ 的正文、server.js 源码、verify.mjs 组装成
 * 一份「丢给 AI 就能装」的单文档 drop.md。
 *
 * 用法:  node build.js
 *
 * 为什么要生成而不是手写：
 *   1. 文档里的代码必须和真实源码永远一致，手抄必然漂移
 *   2. 自动挑选围栏长度，避免代码里含 ``` 时提前闭合
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const SERVER_SRC = path.join(ROOT, '..', 'server.js');
const OUT = path.join(ROOT, '..', 'INSTALL.md');

/** 选一个比正文里最长反引号串还长的围栏，保证不会被提前闭合 */
function fenceFor(text) {
  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((m, s) => Math.max(m, s.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function read(p) {
  if (!fs.existsSync(p)) {
    console.error('缺少源文件: ' + p);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8').replace(/\s+$/, '');
}

const head = read(path.join(SRC, 'head.md'));
const mid = read(path.join(SRC, 'mid.md'));
const tail = read(path.join(SRC, 'tail.md'));
const verify = read(path.join(SRC, 'verify.mjs'));
const server = read(SERVER_SRC);

const fServer = fenceFor(server);
const fVerify = fenceFor(verify);

const doc = [
  head,
  '',
  fServer + 'javascript',
  server,
  fServer,
  '',
  mid,
  '',
  fVerify + 'javascript',
  verify,
  fVerify,
  '',
  tail,
  '',
].join('\n');

fs.writeFileSync(OUT, doc, 'utf8');

const kb = (Buffer.byteLength(doc, 'utf8') / 1024).toFixed(1);
const lines = doc.split('\n').length;

console.log('已生成: ' + OUT);
console.log('  大小    : ' + kb + ' KB / ' + lines + ' 行');
console.log('  server.js 围栏: ' + fServer.length + ' 个反引号');
console.log('  verify.mjs 围栏: ' + fVerify.length + ' 个反引号');
