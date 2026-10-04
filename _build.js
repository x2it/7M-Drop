'use strict';

/**
 * 构建脚本：把前端源码 _newui.js + 二维码编码器 qr.js
 * 组装进单文件 server.js。
 *
 * 用法: node _build.js
 *
 * server.js 的服务端逻辑是「真源」，本脚本只替换两个代码块之间的前端段：
 *   // ───── 前端 ─────   ...   // ───── 启动 ─────
 * 因此可以反复运行，不会破坏后端。
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const TARGET = path.join(DIR, 'server.js');
const UI_SRC = path.join(DIR, '_newui.js');
const QR_SRC = path.join(DIR, 'qr.js');

const START = '// ───────────────────────── 前端 ─────────────────────────';
const END = '// ───────────────────────── 启动 ─────────────────────────';

function fail(msg) { console.error('构建失败: ' + msg); process.exit(1); }

// ── 1. 读源码 ────────────────────────────────────────────────
let ui = fs.readFileSync(UI_SRC, 'utf8');
const qr = fs.readFileSync(QR_SRC, 'utf8');

// ── 2. 安全检查：qr.js 会被塞进模板字符串，不能含反引号或 ${ ──
const tick = String.fromCharCode(96);
if (qr.indexOf(tick) >= 0) fail('qr.js 含有反引号，无法安全内联');
if (qr.indexOf('$' + '{') >= 0) fail('qr.js 含有 ${ 组合，无法安全内联');

// ── 3. 注入二维码源码 ────────────────────────────────────────
if (ui.indexOf('__QR_JS__') < 0) fail('_newui.js 里找不到 __QR_JS__ 占位符');
// 必须用函数式替换：替换串里的 $& / $` / $' 在 String.replace 中有特殊含义
ui = ui.replace('__QR_JS__', function () { return qr.trim(); });

// 注入后再次确认结果里没有未转义的反引号被引入
const injected = ui.slice(ui.indexOf('const QR_JS'), ui.indexOf('const FAVICON'));
if (injected.split(tick).length !== 3) {
  fail('注入后的 QR_JS 段反引号数量异常（应为 2 个，即一对定界符）');
}

// ── 4. 拼接进 server.js ──────────────────────────────────────
const src = fs.readFileSync(TARGET, 'utf8');
const i = src.indexOf(START);
const j = src.indexOf(END);
if (i < 0) fail('server.js 里找不到前端起始标记');
if (j < 0) fail('server.js 里找不到启动段标记');
if (j < i) fail('标记顺序异常');

const out = src.slice(0, i) + ui.replace(/\s+$/, '') + '\n\n' + src.slice(j);
fs.writeFileSync(TARGET, out, 'utf8');

// ── 5. 构建后自检：把真正会被下发到浏览器的字符串单独解析一遍 ──────────
// server.js 语法正确 ≠ 这些字符串的内容是合法 JS。
// 模板字符串里一个没转义的 \n 就能让整站脚本静默失效：页面看起来正常，
// 却没有任何行为，控制台只有一句 SyntaxError。这个坑踩过一次，固化成检查。
//
// 关键：不能按源文件文本切片 —— server.js 里的模板字符串含转义序列
// （例如 \\/ 要到运行时才变成 \/），按原文切片会得到假阳性。
// 必须放进 vm 求值，拿到真实字符串再解析。
const vm = require('vm');

let uiValues;
try {
  uiValues = vm.runInContext(
    ui.replace(/\s+$/, '') + '\n;({ PAGE: PAGE, CSS: CSS, APP_JS: APP_JS, QR_JS: QR_JS })',
    vm.createContext({}),
    { filename: 'frontend.js' }
  );
} catch (e) {
  fail('前端段无法求值: ' + e.message);
}

for (const name of ['APP_JS', 'QR_JS']) {
  const code = uiValues[name];
  if (typeof code !== 'string') fail('拿不到 ' + name + ' 的字符串值');
  try {
    new vm.Script(code, { filename: name + '.js' });
  } catch (e) {
    const head = String(e.stack).split('\n').slice(0, 4).join('\n        ');
    fail(name + ' 不是合法 JS —— 它会原样下发给浏览器，整站脚本会静默失效。\n        ' + head);
  }
}
console.log('  浏览器端脚本自检: APP_JS / QR_JS 语法均通过');

console.log('构建完成');
console.log('  server.js     : ' + out.length + ' 字节 / ' + out.split('\n').length + ' 行');
console.log('  内联 qr.js    : ' + qr.length + ' 字节');
console.log('  前端段        : ' + ui.length + ' 字节');
