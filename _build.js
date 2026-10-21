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

// ── 3b. QQ_JS：由 _qqsrc.js 重新内联进 server.js（HOME_JS 之后） ────────
// 与前端段同源的理由：源码里正常写 \n，内联时统一转义，
// 避免手抄三万多字节时漏一处转义，让 /home.js 静默失效。
const QQ_SRC = path.join(DIR, '_qqsrc.js');
const qqSrc = fs.readFileSync(QQ_SRC, 'utf8');
const tickQ = String.fromCharCode(96);
if (qqSrc.indexOf(tickQ) >= 0) fail('_qqsrc.js 含有反引号，请改用字符串拼接');
if (qqSrc.indexOf('$' + '{') >= 0) fail('_qqsrc.js 含有 ${ 组合，无法安全内联');
const qqEsc = qqSrc.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const qqBlock =
  '/* ' + '═'.repeat(30) + ' 复古 QQ（仿 2008）' + '═'.repeat(30) + '\n' +
  '   本段由 _build.js 从 _qqsrc.js 自动内联，请勿手改；\n' +
  '   要改预设对话 / 逻辑，改 _qqsrc.js 后重跑 node _build.js。\n' +
  '   下发路径：/home.js = HOME_JS + QQ_JS。 */\n' +
  'const QQ_JS = `' + qqEsc.trim() + '`;';

// ── 4. 拼接进 server.js ──────────────────────────────────────
const src = fs.readFileSync(TARGET, 'utf8');
const i = src.indexOf(START);
const j = src.indexOf(END);
if (i < 0) fail('server.js 里找不到前端起始标记');
if (j < 0) fail('server.js 里找不到启动段标记');
if (j < i) fail('标记顺序异常');

const out = src.slice(0, i) + ui.replace(/\s+$/, '') + '\n\n' + src.slice(j);
fs.writeFileSync(TARGET, out, 'utf8');

// ── 4b. 把重新生成的 QQ_JS 段写回 server.js ───────────────────────────
// HOME_PAGE / HOME_CSS / HOME_JS / QQ_JS 都在前端边界之外，本脚本不动它们的主体，
// 只整段替换 QQ_JS（它的两个边界标记写死在下面的注释里）。
(function inlineQQ() {
  let cur = fs.readFileSync(TARGET, 'utf8');
  const QQ_HEAD = '/* ' + '═'.repeat(30) + ' 复古 QQ（仿 2008）' + '═'.repeat(30);
  const QQ_TAIL = '\nconst HOME_PAGE_404';
  const a = cur.indexOf(QQ_HEAD);
  const b = cur.indexOf(QQ_TAIL);
  if (a < 0 || b < 0 || b < a) fail('server.js 里找不到 QQ_JS 段边界（应为「复古 QQ」注释起到 HOME_PAGE_404 之前）');
  cur = cur.slice(0, a) + qqBlock + cur.slice(b);
  fs.writeFileSync(TARGET, cur, 'utf8');
  console.log('  内联 _qqsrc.js : ' + qqSrc.length + ' 字节 → QQ_JS');
})();


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
    ui.replace(/\s+$/, '') + '\n;({ PAGE: PAGE, CSS: CSS, APP_JS: APP_JS, QR_JS: QR_JS, SW_JS: SW_JS })',
    vm.createContext({}),
    { filename: 'frontend.js' }
  );
} catch (e) {
  fail('前端段无法求值: ' + e.message);
}

for (const name of ['APP_JS', 'QR_JS', 'SW_JS']) {
  const code = uiValues[name];
  if (typeof code !== 'string') fail('拿不到 ' + name + ' 的字符串值');
  try {
    new vm.Script(code, { filename: name + '.js' });
  } catch (e) {
    const head = String(e.stack).split('\n').slice(0, 4).join('\n        ');
    fail(name + ' 不是合法 JS —— 它会原样下发给浏览器，整站脚本会静默失效。\n        ' + head);
  }
}
console.log('  浏览器端脚本自检: APP_JS / QR_JS / SW_JS 语法均通过');

// ── 5b. HOME_JS（根桌面）也在边界外，本脚本不写它，但必须自检 ──
// 踩过的坑：HOME_JS 是模板字符串，里面的换行要写成 \\n；
// 一旦写成 \n，模板求值阶段就把它变成真实换行，下发的 /home.js 变成
// 非法 JS —— 页面渲染完全正常（HTML/CSS 都对），却没有任何行为，
// 控制台只有一句 SyntaxError。比全站白屏更难发现，所以固化成检查。
(function checkHomeJs() {
  const s = fs.readFileSync(TARGET, 'utf8');
  const head = 'const HOME_JS = `';
  const tail = 'const HOME_PAGE_404';
  const i = s.indexOf(head);
  const j = s.indexOf(tail);
  if (i < 0 || j < 0 || j < i) {
    console.log('  [warn] 找不到 HOME_JS 段，跳过检查');
    return;
  }
  const body = s.slice(i + head.length, s.lastIndexOf('`', j));
  // 先按模板字符串求值，拿到浏览器真正会收到的文本
  let delivered;
  try {
    delivered = vm.runInContext('`' + body + '`', vm.createContext({}), { filename: 'home-template.js' });
  } catch (e) {
    fail('HOME_JS 模板无法求值: ' + e.message);
  }
  try {
    new vm.Script(delivered, { filename: 'home.js' });
  } catch (e) {
    const head2 = String(e.stack).split('\n').slice(0, 4).join('\n        ');
    fail('HOME_JS 求值后不是合法 JS —— /home.js 会静默失效。\n        多半是模板里的 \\n 漏写成了 \\n。\n        ' + head2);
  }
  console.log('  根桌面脚本自检: HOME_JS 语法通过 (' + delivered.length + ' 字节下发)');
})();

// ── 5c. QQ_JS 自检：/home.js = HOME_JS + QQ_JS，后者同样必须逐字节合法 ──
(function checkQQJs() {
  const s = fs.readFileSync(TARGET, 'utf8');
  const head = 'const QQ_JS = `';
  const tail = '\nconst HOME_PAGE_404';
  const i = s.indexOf(head);
  const j = s.indexOf(tail);
  if (i < 0 || j < 0 || j < i) { console.log('  [warn] 找不到 QQ_JS 段，跳过检查'); return; }
  const body = s.slice(i + head.length, s.lastIndexOf('`', j));
  let delivered;
  try {
    delivered = vm.runInContext('`' + body + '`', vm.createContext({}), { filename: 'qq-template.js' });
  } catch (e) {
    fail('QQ_JS 模板无法求值: ' + e.message);
  }
  try {
    new vm.Script(delivered, { filename: 'qq.js' });
  } catch (e) {
    fail('QQ_JS 求值后不是合法 JS —— QQ 功能会整块静默失效。\n        ' + String(e.stack).split('\n').slice(0, 4).join('\n        '));
  }
  // 合并下发后整体再解析一遍：两个脚本拼接处不能有语法冲突
  const home = (function () {
    const hh = 'const HOME_JS = `';
    const tt = '\nconst HOME_PAGE_404';
    const x = s.indexOf(hh);
    const y = s.indexOf(tt);
    if (x < 0 || y < x) return '';
    const bd = s.slice(x + hh.length, s.lastIndexOf('`', y));
    return vm.runInContext('`' + bd + '`', vm.createContext({}), { filename: 'home-template.js' });
  })();
  try {
    new vm.Script(home + '\n' + delivered, { filename: 'home+qq.js' });
  } catch (e) {
    fail('HOME_JS + QQ_JS 合并后不是合法 JS。\n        ' + String(e.stack).split('\n').slice(0, 4).join('\n        '));
  }
  console.log('  复古 QQ 脚本自检: QQ_JS 语法通过 (' + delivered.length + ' 字节下发)');
})();

console.log('构建完成');
console.log('  server.js     : ' + out.length + ' 字节 / ' + out.split('\n').length + ' 行');
console.log('  内联 qr.js    : ' + qr.length + ' 字节');
console.log('  前端段        : ' + ui.length + ' 字节');
