// ───────────────────────── 前端 ─────────────────────────

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">',
  '<meta name="theme-color" content="#008080">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="robots" content="noindex,nofollow">',
  '<title>7喵快传</title>',
  '<link rel="icon" href="./favicon.ico">',
  '<link rel="apple-touch-icon" href="./icons/icon-192.png">',
  '<link rel="manifest" href="./manifest.webmanifest">',
  '<link rel="stylesheet" href="./app.css">',
  '</head>',
  '<body>',
  '<div class="desk">',
  '  <div class="window">',
  '',
  '    <div class="titlebar">',
  '      <span class="tb-title">7喵快传</span>',
  '      <span class="tb-actions">',
  '        <button class="tb-btn tb-install" id="tbInstall" type="button" hidden aria-label="安装到桌面" title="安装到桌面">⬇</button>',
  '        <button class="tb-mode" id="tbMode" type="button" title="查看当前链接的身份与权限">…</button>',
  '      </span>',
  '    </div>',
  '',
  '    <div class="win-body">',
  '',
  '      <div class="toolbar">',
  '        <button id="qrPage" type="button">二维码分享</button>',
  '        <button id="copyPage" type="button">复制本页链接</button>',
  '      </div>',
  '',
  '      <div id="drop" class="drop" tabindex="0" role="button" aria-label="选择要上传的文件">',
  '        <div class="drop-inner">',
  '          <div class="drop-title">拖入文件，或点击选择</div>',
  '          <div class="drop-sub">支持多选 · 可粘贴截图 · 手机可直接调相册</div>',
  '        </div>',
  '        <input id="file" type="file" multiple hidden>',
  '        <input id="media" type="file" accept="image/*,video/*" multiple hidden>',
  '      </div>',
  '',
  '      <div class="btnrow">',
  '        <button id="pickMedia" type="button">照片 / 视频</button>',
  '        <button id="pickFile" type="button">选择文件</button>',
  '        <button id="textToggle" type="button">发一段文字</button>',
  '      </div>',
  '',
  '      <div id="textPane" class="textpane" hidden>',
  '        <textarea id="textInput" rows="4" placeholder="粘贴文字、代码或链接，生成一个可分享的短链…"></textarea>',
  '        <div class="textpane-actions"><button id="textSend" type="button">生成链接</button></div>',
  '      </div>',
  '',
  '      <div id="queue" class="queue"></div>',
  '',
  '      <fieldset class="panel" id="filesPanel">',
  '        <legend>文件列表<span id="filesCount"></span></legend>',
  '        <div class="panel-tools"><button id="refresh" type="button">刷新</button></div>',
  '        <ul id="list" class="list"></ul>',
  '        <p id="empty" class="empty">还没有文件<span>上传后会出现在这里</span></p>',
  '      </fieldset>',
  '',
  '    </div>',
  '',
  '    <div class="statusbar">',
  '      <div class="sb-panel" id="sbMode">…</div>',
  '      <div class="sb-panel sb-mid" id="sbLimit">…</div>',
  '      <div class="sb-panel sb-mid" id="sbQuota">…</div>',
  '    </div>',
  '',
  '    <div class="footer">',
  '      <span>© 2026 <a href="https://w3b.pub" target="_blank" rel="noopener noreferrer">知行工作室</a></span>',
  '    </div>',
  '',
  '  </div>',
  '</div>',
  '',
  '<div id="viewer" class="mask viewer" hidden>',
  '  <div class="dialog viewer-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="viewerName">预览</span>',
  '      <button id="viewerClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div id="viewerBody" class="viewer-body"></div>',
  '    <div class="viewer-foot">',
  '      <button id="viewerPrev" type="button">◀ 上一个</button>',
  '      <a id="viewerDl" class="btn-like" download>下载</a>',
  '      <button id="viewerNext" type="button">下一个 ▶</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="qrModal" class="mask" hidden>',
  '  <div class="dialog qr-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="qrTitle">扫码打开</span>',
  '      <button id="qrClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <div class="qr-box"><canvas id="qrCanvas" width="560" height="560"></canvas></div>',
  '      <p id="qrUrl" class="qr-url"></p>',
  '      <button id="qrCopy" type="button" class="wide">复制链接</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="infoModal" class="mask" hidden>',
  '  <div class="dialog info-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title">链接与权限</span>',
  '      <button id="infoClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <div class="info-body">',
  '        <div class="info-row"><span class="info-k">当前身份</span><span class="info-v" id="infoRole">…</span></div>',
  '        <p class="info-note" id="infoNote"></p>',
  '        <ul class="perm-list" id="infoPerms"></ul>',
  '        <div class="info-row"><span class="info-k">单文件上限</span><span class="info-v" id="infoMax">…</span></div>',
  '        <div class="info-row"><span class="info-k">保留时长</span><span class="info-v" id="infoTtl">…</span></div>',
  '        <div class="info-row"><span class="info-k">已用容量</span><span class="info-v" id="infoQuota">…</span></div>',
  '      </div>',
  '      <div id="infoShareWrap" hidden>',
  '        <div class="info-label">分享链接（发给别人用这个）</div>',
  '        <div class="info-link" id="infoShareLink"></div>',
  '        <div class="info-btns">',
  '          <button id="infoCopyShare" type="button">复制</button>',
  '          <button id="infoQrShare" type="button">二维码</button>',
  '        </div>',
  '      </div>',
  '      <div class="info-label">Agent / 命令行入口（给 AI 用）</div>',
  '      <div class="info-link" id="infoAgentLink"></div>',
  '      <div class="info-btns"><button id="infoCopyAgent" type="button">复制自举地址</button></div>',
  '      <p class="info-note">把这个地址交给 AI，再让它运行下面这行，它就能传文件上来并把链接给你：</p>',
  '      <code class="info-code">node drop.js &lt;文件路径&gt;</code>',
  '      <div class="info-label">当前链接</div>',
  '      <div class="info-link" id="infoSelfLink"></div>',
  '      <div class="info-btns"><button id="infoCopySelf" type="button">复制当前链接</button></div>',
  '      <div class="dlg-foot"><button id="infoOk" class="wide" type="button">关闭</button></div>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="sheet" class="mask mask-bottom" hidden>',
  '  <div class="dialog sheet-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="sheetName">操作</span>',
  '      <button id="sheetClose" class="tb-btn" type="button" aria-label="关闭">✕</button>',
  '    </div>',
  '    <div class="dlg-body sheet-body">',
  '      <button class="sheet-item" data-act="preview" type="button">预览</button>',
  '      <button class="sheet-item" data-act="download" type="button">下载</button>',
  '      <button class="sheet-item" data-act="copylink" type="button">复制分享链接（打开先看）</button>',
  '      <button class="sheet-item" data-act="copydirect" type="button">复制直链（直接下载）</button>',
  '      <button class="sheet-item" data-act="qr" type="button">二维码分享</button>',
  '      <button class="sheet-item" data-act="delete" type="button">删除</button>',
  '      <button class="sheet-item sheet-cancel" data-act="cancel" type="button">取消</button>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="toast" class="toast" hidden></div>',
  '',
  '<script src="./qr.js"></script>',
  '<script src="./app.js"></script>',
  '</body>',
  '</html>',
].join('\n');

const CSS = `
/* ── 90 年代 Windows 复古：全部立体感用 1px 线条（box-shadow）实现 ── */
*,*::before,*::after{box-sizing:border-box}
:root{
  --face:#c0c0c0; --hi:#ffffff; --lt:#dfdfdf; --sh:#808080; --dk:#0a0a0a;
  --title:#000080; --title2:#1084d0; --win:#ffffff; --text:#000000;
  --dis:#808080; --sel:#000080; --desk:#008080;
  --safe-t:env(safe-area-inset-top,0px);
  --safe-b:env(safe-area-inset-bottom,0px);
  --safe-l:env(safe-area-inset-left,0px);
  --safe-r:env(safe-area-inset-right,0px);
  --raise:inset -1px -1px var(--dk),inset 1px 1px var(--hi),inset -2px -2px var(--sh),inset 2px 2px var(--lt);
  --sink:inset 1px 1px var(--sh),inset -1px -1px var(--hi),inset 2px 2px var(--dk),inset -2px -2px var(--lt);
  --groove:inset 1px 1px var(--dk),inset -1px -1px var(--hi),inset 2px 2px var(--sh),inset -2px -2px var(--lt);
}
html{-webkit-text-size-adjust:100%;overflow-x:hidden}
html,body{margin:0;padding:0}
/* ── 隐藏式滚动条：整页只保留一个滚动上下文，且不画滚动条轨道 ──
   滚轮 / 触屏滑动照常可用；视觉上由窗口边框与页面留白承担"可滚"暗示。 */
*{scrollbar-width:none;scrollbar-color:transparent transparent}
::-webkit-scrollbar{width:0;height:0;display:none}
::-webkit-scrollbar-button{display:none}
body{
  background:var(--desk);
  color:var(--text);
  min-height:100dvh;
  font:13px/1.45 "MS Sans Serif",Tahoma,"SimSun","宋体","Microsoft YaHei",sans-serif;
  -webkit-tap-highlight-color:transparent;
  /* 兜底：任何意外超宽元素都不产生横向滚动条 */
  overflow-x:hidden;
  max-width:100%;
  /* 触屏：阻止下拉刷新/滚动链穿透，页面本体不上下弹动 */
  overscroll-behavior-y:none;
}
/* 离线提示条：断网时如实告知当前展示的是缓存内容 */
body[data-net="off"]::before{
  content:'离线模式 · 正在显示已缓存内容';
  display:block;background:var(--face);color:var(--dis);
  box-shadow:var(--sink);font-size:11px;padding:4px 8px;text-align:center;
}
img,canvas,video{max-width:100%}
button,input,textarea,select{font-family:inherit}
[hidden]{display:none !important}

/* ── 触屏基础层 ──
   touch-action:manipulation 让浏览器放弃等待双击缩放，
   从而消除点击延迟（移动端最常见的"点了没反应"感）；
   按钮/图标同时禁止长按选中与系统菜单，避免打断操作。 */
button,.tb-btn,.tb-mode,.row-more,.ico,.sb-panel.clickable,.sheet-item,.btn-like,.drop,.row.tappable{
  touch-action:manipulation;
  -webkit-user-select:none;user-select:none;
  -webkit-touch-callout:none;
}
input,textarea{touch-action:auto}

.desk{
  min-height:100dvh;
  padding:calc(14px + var(--safe-t)) calc(14px + var(--safe-r)) calc(14px + var(--safe-b)) calc(14px + var(--safe-l));
  display:flex;justify-content:center;align-items:flex-start;
}

.window{
  width:100%;max-width:820px;min-width:0;
  background:var(--face);
  box-shadow:var(--raise);
  padding:3px;
}
.titlebar{
  background:linear-gradient(90deg,var(--title),var(--title2));
  color:#fff;font-weight:700;font-size:12px;
  padding:3px 3px 3px 5px;
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  min-height:24px;
}
/* 不加 letter-spacing：原版 MS Sans Serif 没有字距，
   而且中文加字距后会明显显得松散 */
.tb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-mode{
  font-weight:400;font-size:11px;flex:none;border-radius:0;
  background:transparent;border:1px solid transparent;color:#fff;
  padding:2px 8px;min-height:19px;box-shadow:none;
}
.tb-mode:hover{background:rgba(255,255,255,.20);border-color:rgba(255,255,255,.40)}
.tb-mode:active{box-shadow:none;padding:2px 8px;background:rgba(255,255,255,.30)}
/* 标题栏右侧动作区：安装按钮 + 模式按钮 */
.tb-actions{display:flex;align-items:center;gap:5px;flex:none}
.tb-install{font-size:12px;font-weight:700}
.tb-btn{
  width:19px;height:17px;min-height:0;padding:0;flex:none;
  display:grid;place-items:center;font-size:10px;font-weight:700;line-height:1;
  background:var(--face);color:var(--text);
  box-shadow:var(--raise);
}
.tb-btn:active{box-shadow:var(--sink)}

.win-body{padding:9px 8px 8px}

/* ── 按钮 ── */
button{
  background:var(--face);color:var(--text);border:0;border-radius:0;
  padding:6px 12px;min-height:32px;cursor:pointer;
  box-shadow:var(--raise);
  transition:none;
}
button:active{
  box-shadow:var(--sink);
  padding:7px 11px 5px 13px;
}
button:focus-visible{outline:1px dotted var(--dk);outline-offset:-4px}
button.wide{width:100%}

.toolbar{display:flex;gap:5px;margin-bottom:9px;min-width:0}
.toolbar button{flex:1;min-width:0;font-size:12px;padding:6px 8px;min-height:34px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btnrow{display:flex;gap:5px;margin-top:6px;min-width:0}
.btnrow button{flex:1;min-width:0;font-size:12px;min-height:38px;padding:6px 8px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 拖放区：下沉白底 + 内部虚线（线条化） ── */
.drop{
  background:var(--win);
  box-shadow:var(--sink);
  padding:4px;cursor:pointer;outline:none;
}
.drop:hover{background:#f4f4f4}
.drop:focus-visible{outline:1px dotted var(--dk);outline-offset:-8px}
.drop.over{background:#e8f0ff}
.drop.over .drop-inner{border-color:var(--title)}
.drop-inner{
  border:1px dashed var(--sh);
  padding:26px 14px;text-align:center;
}
.drop-title{font-size:14px;font-weight:700}
.drop-sub{color:#404040;font-size:11.5px;margin-top:5px}

.textpane{margin-top:6px;background:var(--face);box-shadow:var(--raise);padding:8px}
textarea{
  width:100%;background:var(--win);color:var(--text);border:0;border-radius:0;
  box-shadow:var(--sink);
  padding:7px;font:13px/1.5 "Courier New",Consolas,monospace;resize:vertical;
}
textarea:focus{outline:none}
.textpane-actions{display:flex;justify-content:flex-end;margin-top:7px}

/* ── 上传队列：经典分段进度条 ── */
.queue{margin-top:9px;display:flex;flex-direction:column;gap:5px}
.qitem{background:var(--face);box-shadow:var(--raise);padding:7px 9px}
.qtop{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}
.qname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qpct{flex:none;font-variant-numeric:tabular-nums;color:#303030}
.bar{
  height:16px;background:var(--win);box-shadow:var(--sink);
  padding:2px;
}
.bar>i{
  display:block;height:100%;width:0;
  background:repeating-linear-gradient(90deg,var(--title) 0 7px,transparent 7px 9px);
}
.qitem.err .bar>i{background:repeating-linear-gradient(90deg,#a00000 0 7px,transparent 7px 9px)}
.qmsg{color:#a00000;font-size:11.5px;margin-top:5px;word-break:break-all}

/* ── 分组框：列表容器 ── */
fieldset.panel{
  border:1px solid var(--sh);border-right-color:var(--hi);border-bottom-color:var(--hi);
  margin:12px 0 0;padding:9px 8px 8px;position:relative;
  /* fieldset 默认 min-inline-size:min-content 会阻止收缩并撑破窄屏，
     必须显式归零，否则移动端会出现横向溢出 */
  min-inline-size:0;min-width:0;
}
fieldset.panel legend{
  font-size:12px;font-weight:700;padding:0 6px;margin-left:2px;
  /* 长文字图例同样会撑破窄屏 */
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
#filesCount{font-weight:400;color:#404040;margin-left:5px}
.panel-tools{position:absolute;top:-2px;right:8px;display:flex;gap:4px}
.panel-tools button{font-size:11.5px;padding:2px 9px;min-height:22px;position:relative}
.panel-tools button:active{padding:3px 8px 1px 10px}
/* 触屏：热区向下扩展补足高度（按钮本身不能被 top 偏移裁切） */
.panel-tools button::after{
  content:'';position:absolute;left:50%;top:50%;
  width:100%;min-width:48px;height:44px;transform:translate(-50%,-50%);
}

/* 文件列表不再自带内部滚动（旧版列表有高度上限 + overflow 会形成
   "页面滚动条 + 列表滚动条" 两级嵌套）：列表自然撑开，整页只滚一次。 */
.list{list-style:none;margin:8px 0 0;padding:2px;background:var(--win);box-shadow:var(--sink)}
.row{
  display:flex;align-items:center;gap:9px;
  padding:7px 6px;
  border-bottom:1px dotted #b0b0b0;
  min-width:0;
}
.row:last-child{border-bottom:0}
.row.tappable{cursor:pointer}
.row:hover{background:var(--sel);color:#fff}
.row:hover .fsub{color:#d0d0d0}
.row:hover .ico{color:#fff}
.row:hover .row-more{color:#fff}

.ico{
  width:34px;height:30px;flex:none;display:grid;place-items:center;
  background:var(--win);box-shadow:var(--sink);
  font:700 9.5px/1 Tahoma,Arial,sans-serif;letter-spacing:.5px;color:var(--title);
  text-transform:uppercase;
}.meta{min-width:0;flex:1}
.fname{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fsub{color:#505050;font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;
  min-width:0;overflow-wrap:anywhere}
.row-more{
  width:30px;height:30px;min-height:0;padding:0;flex:none;
  display:grid;place-items:center;font-size:15px;line-height:1;
  background:var(--face);color:var(--text);box-shadow:var(--raise);
  position:relative;
}
/* 触屏：视觉仍是 30px 小按钮，但热区向四周扩展到约 48px，
   兼顾复古观感与手指可点性（不改变布局，用 ::after 扩大命中区） */
.row-more::after{
  content:'';position:absolute;left:50%;top:50%;
  width:48px;height:48px;transform:translate(-50%,-50%);
}
.row-more:active{box-shadow:var(--sink);padding:0}
.empty{color:#404040;font-size:12px;text-align:center;padding:20px 0;margin:0;
  display:flex;flex-direction:column;gap:3px}
.empty span{font-size:11px;color:var(--dis)}

/* ── 状态栏 ── */
.statusbar{display:flex;gap:3px;padding:3px 3px 3px}
.sb-panel{
  flex:1;min-width:0;
  padding:2px 6px;font-size:11px;
  background:var(--face);box-shadow:var(--sink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  display:flex;align-items:center;min-height:19px;
}
.sb-panel:first-child{flex:0 0 auto}

/* ── 页脚版权 ── */
.footer{
  padding:4px 6px 3px;text-align:center;
  font-size:11px;color:#505050;
}
.footer a{color:var(--title);text-decoration:underline}
.footer a:hover{color:#000}

/* ── 对话框通用 ── */
.mask{
  position:fixed;inset:0;z-index:80;
  display:flex;align-items:center;justify-content:center;
  padding:calc(12px + var(--safe-t)) calc(12px + var(--safe-r)) calc(12px + var(--safe-b)) calc(12px + var(--safe-l));
  background:rgba(0,0,0,.42);
}
.mask-bottom{align-items:flex-end}
.dialog{background:var(--face);box-shadow:var(--raise);padding:3px;max-height:100%;display:flex;flex-direction:column}
.dlg-body{padding:10px;overflow:auto}

/* ── 预览 ── */
/* 注意：这里必须叠在 .mask 上，单独写 .viewer 会丢掉 position:fixed，
   弹层会变成文档流里的普通块，表现为「点了没反应」。 */
.viewer{background:rgba(0,0,0,.74);z-index:85}
.viewer .viewer-dlg{width:min(920px,100%);height:min(88dvh,100%);will-change:transform}
.viewer-body{
  flex:1;min-height:0;background:#000;box-shadow:var(--sink);margin:3px;
  display:grid;place-items:center;overflow:auto;-webkit-overflow-scrolling:touch;
}
.viewer-body img{max-width:100%;max-height:100%;object-fit:contain}
.viewer-body video{max-width:100%;max-height:100%;background:#000}
.viewer-body iframe{width:100%;height:100%;border:0;background:#fff}
.viewer-body pre{
  margin:0;width:100%;height:100%;overflow:auto;background:var(--win);color:var(--text);
  padding:9px;font:12px/1.6 "Courier New",Consolas,monospace;
  white-space:pre-wrap;word-break:break-word;text-align:left;
  -webkit-overflow-scrolling:touch;
}
.audio-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;color:#d0d0d0;font-size:12px}
.audio-wrap .big{font:700 15px/1 Tahoma,sans-serif;letter-spacing:3px;color:#fff}
.audio-wrap audio{width:min(400px,78vw)}
.viewer-tip{color:#d0d0d0;font-size:12px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
.viewer-foot{display:flex;gap:5px;padding:5px}
.viewer-foot>*{flex:1;text-align:center}
.btn-like{
  display:flex;align-items:center;justify-content:center;
  background:var(--face);color:var(--text);text-decoration:none;
  padding:6px 12px;min-height:32px;font-size:13px;box-shadow:var(--raise);cursor:pointer;
}
.btn-like:active{box-shadow:var(--sink);padding:7px 11px 5px 13px}

/* ── 二维码 ── */
.qr-dlg{width:min(360px,100%)}
.qr-box{background:var(--win);box-shadow:var(--sink);padding:10px;display:grid;place-items:center}
.qr-box canvas{width:100%;max-width:270px;height:auto;display:block;image-rendering:pixelated}
.qr-url{
  font:11px/1.5 "Courier New",Consolas,monospace;color:#303030;
  margin:10px 0;word-break:break-all;text-align:center;
  max-height:56px;overflow:auto;
}

/* ── 链接与权限 ── */
.info-dlg{width:min(430px,100%)}
.info-body{background:var(--win);box-shadow:var(--sink);padding:9px 10px;margin-bottom:9px}
.info-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;
  padding:5px 0;border-bottom:1px dotted #cfcfcf}
.info-row:last-child{border-bottom:0}
.info-k{color:#404040;flex:none}
.info-v{font-weight:700;text-align:right;word-break:break-all}
.info-note{font-size:11.5px;color:#404040;margin:9px 0 6px;line-height:1.55}
.perm-list{list-style:none;margin:0;padding:0}
.perm-list li{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:4px 0}
.perm-yes{color:#006000}
.perm-no{color:#a00000}
.info-label{font-size:11.5px;color:#404040;margin:10px 0 4px}
.info-link{
  font:11px/1.5 "Courier New",Consolas,monospace;word-break:break-all;
  background:var(--win);box-shadow:var(--sink);padding:6px 7px;
  max-height:58px;overflow:auto;
}
.info-btns{display:flex;gap:5px;margin-top:6px}
.info-btns button{flex:1}
.info-code{
  display:block;font:11px/1.6 "Courier New",Consolas,monospace;
  background:var(--face);box-shadow:var(--sink);padding:5px 7px;margin-top:2px;
  word-break:break-all;
}
.dlg-foot{margin-top:12px}
.sb-panel.clickable{cursor:pointer}
.sb-panel.clickable:hover{background:#d4d4d4}

/* ── 操作面板 ── */
.sheet-dlg{width:min(420px,100%);margin-bottom:0}
.sheet-body{display:flex;flex-direction:column;gap:5px;padding:8px}
.sheet-item{width:100%;text-align:left;font-size:13px;padding:10px 12px;min-height:40px}
.sheet-item:active{padding:11px 11px 9px 13px}
.sheet-cancel{margin-top:3px;text-align:center}

/* ── 提示条 ── */
.toast{
  position:fixed;left:50%;bottom:calc(20px + var(--safe-b));transform:translateX(-50%);
  background:var(--face);color:var(--text);
  padding:8px 16px;font-size:12px;z-index:120;
  box-shadow:var(--raise);max-width:90vw;text-align:center;
}

/* ══ 触屏设备（手机/平板）：保证 44px 触控标准 ══
   Apple HIG 与 Material 均建议可点区域 ≥44×44。
   窄屏空间紧张，采用"视觉尺寸适度缩小、热区补足"的策略：
   按钮本体撑到 ≥44px 高，图标类用 ::after 扩热区，避免挤压排版。*/
@media (pointer:coarse), (max-width:560px){
  .desk{padding:calc(7px + var(--safe-t)) calc(7px + var(--safe-r)) calc(7px + var(--safe-b)) calc(7px + var(--safe-l))}
  .win-body{padding:8px 7px 7px}
  .sb-mid{display:none}
  .viewer .viewer-dlg{height:min(94dvh,100%)}
  .dialog{max-height:100%}

  /* 工具栏 / 按钮行：撑到 44px 高，字号保持可读 */
  .toolbar{gap:6px;margin-bottom:10px}
  .toolbar button{font-size:12px;padding:8px 6px;min-height:44px}
  .btnrow{gap:6px;margin-top:8px}
  .btnrow button{font-size:12px;padding:8px 6px;min-height:44px}

  /* 标题栏按钮：触屏撑到 44px 热区，标题栏相应加高 */
  .titlebar{min-height:44px;padding:5px 5px 5px 8px}
  .tb-mode{font-size:12px;padding:6px 12px;min-height:34px;position:relative}
  .tb-mode::after{content:'';position:absolute;left:0;top:50%;width:100%;height:44px;transform:translateY(-50%)}
  .tb-btn{width:38px;height:34px;font-size:13px;position:relative}
  .tb-btn::after{content:'';position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%)}

  /* 刷新按钮：热区补足（见 ::after 规则） */
  .panel-tools{top:-4px;right:6px}
  .panel-tools button{font-size:12px;padding:6px 12px;min-height:30px}

  /* 列表行：整体加高，让整行成为可点热区 */
  .row{gap:9px;padding:11px 7px;min-height:56px}
  .row-more{width:32px;height:32px;font-size:16px}
  .ico{width:32px;height:29px;font-size:9px}

  /* 状态栏：可点面板撑到 44px 高 */
  .statusbar{padding:4px}
  .sb-panel{min-height:44px;padding:4px 8px;font-size:11.5px}

  /* 页脚外链：扩大可点区域 */
  .footer{padding:10px 6px 8px}
  .footer a{display:inline-block;padding:8px 6px;min-height:32px}

  /* 图例让位给刷新按钮，避免重叠 */
  fieldset.panel legend{padding-right:76px}
  .fsub{gap:5px 10px}

  /* 操作面板（底部弹出）：条目撑到 48px，拇指友好 */
  .sheet-dlg{margin-bottom:calc(4px + var(--safe-b))}
  .sheet-item{min-height:48px;padding:12px 14px;font-size:14px}

  /* 预览页脚按钮 */
  .viewer-foot{gap:6px;padding:6px}
  .viewer-foot>*{min-height:44px}

  /* 输入框：字号 ≥16px 可避免 iOS 聚焦时自动放大页面 */
  textarea{font-size:16px;min-height:96px}
}

/* 极窄屏（≤400px）：只压字号与间距，不再缩小触控目标 */
@media (max-width:400px){
  .toolbar button,.btnrow button{font-size:11.5px;padding:8px 4px;min-height:44px}
  .row{gap:8px;padding:10px 6px;min-height:54px}
  .row-more{width:30px;height:30px}
  .ico{width:30px;height:27px;font-size:8.5px}
  fieldset.panel legend{padding-right:72px}
  .sb-panel{font-size:11px;padding:4px 6px}
}

/* 支持悬停的精确指针设备（桌面鼠标）才启用 hover 高亮 */
@media (hover:hover) and (pointer:fine){
  .row.tappable:hover{background:var(--sel);color:#fff}
}
@media (hover:none){
  .row:hover{background:transparent;color:var(--text)}
  .row:hover .fsub{color:#505050}
  .row:hover .ico{color:var(--title)}
  .row:hover .row-more{color:var(--text)}
  /* 触屏用按下态代替 hover，给出明确点击反馈 */
  .row.tappable:active{background:var(--sel);color:#fff}
  .row.tappable:active .fsub{color:#d0d0d0}
  .row.tappable:active .ico{color:#fff}
  .row.tappable:active .row-more{color:#fff}
  button:active,.btn-like:active{background:#b8b8b8}
}

/* ── 嵌入模式 (?embed=1) ──
   桌面把本页嵌进 iframe 当一个"窗口"用。此时外层已经提供了 95 的窗框、
   标题栏和背景，本页必须"脱壳"：让出内边距、去掉投影和宽度限制，
   否则会出现"窗中窗"两层边框叠在一起。背景改透明，桌面底色自然透进来。 */
body.embed{background:transparent;overflow:hidden;height:100vh;height:100dvh}
body.embed[data-net="off"]::before{display:none}
body.embed .desk{min-height:0;height:100%;padding:0;display:block}
body.embed .window{
  max-width:none;width:100%;height:100%;
  box-shadow:none;padding:0;
  display:flex;flex-direction:column;
}
body.embed .titlebar{display:none}
body.embed .footer{display:none}
body.embed .win-body{
  flex:1;min-height:0;overflow-y:auto;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
`;

const APP_JS = `
(function () {
  'use strict';

  // ── 嵌入模式 (?embed=1) ──
  // 桌面把本页当"窗口内容"嵌进来。此时：
  //   1) 打上 body.embed，让 CSS 把窗框/内边距/投影全部让出去；
  //   2) **不注册 Service Worker** —— 外层根桌面已经有一个 SW，
  //      同源再注册一个会让两套 fetch 缓存策略互相打架；而且 embed 页面
  //      本来就不是一个独立的"应用"，离线能力由外层负责。
  //   3) 不触发安装提示（外层桌面才是可安装的那个应用）。
  var EMBED = /[?&]embed=1(&|$)/.test(location.search);
  if (EMBED) {
    document.body.classList.add('embed');
    try { document.documentElement.setAttribute('data-embed', '1'); } catch (e) {}
  }

  // 移动浏览器"桌面版网页"模式防御：触屏小屏设备 + 布局视口被拉到桌面宽(>=700)
  // 时，动态改写 viewport 强制回设备宽度。桌面/平板不受影响。
  try {
    var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (touch && window.screen.width <= 480 && document.documentElement.clientWidth >= 700) {
      var mv = document.querySelector('meta[name="viewport"]');
      if (mv) mv.setAttribute('content', 'width=device-width,initial-scale=1,viewport-fit=cover');
    }
  } catch (e) {}

  // 注意：不能直接用整段 pathname —— 分享链接形如 /s/<口令>/f/<id>，
  // 用整段会把 API 前缀算错（/api/list 直接 404，列表加载不出来）。
  var BASE = (function () {
    var m = /^(\\/s\\/[^/]+)/.exec(location.pathname);
    return m ? m[1] : location.pathname.replace(/\\/+$/, '');
  })();
  var CHUNK_FALLBACK = 8 * 1024 * 1024;
  var CONCURRENCY = 3;

  var $ = function (id) { return document.getElementById(id); };
  var dropEl = $('drop'), fileInput = $('file'), mediaInput = $('media');
  var listEl = $('list'), emptyEl = $('empty'), queueEl = $('queue');
  var toastEl = $('toast'), filesCount = $('filesCount'), tbMode = $('tbMode');
  var sbMode = $('sbMode'), sbLimit = $('sbLimit'), sbQuota = $('sbQuota');

  var viewer = $('viewer'), viewerBody = $('viewerBody'), viewerName = $('viewerName'), viewerDl = $('viewerDl');
  var qrModal = $('qrModal'), qrCanvas = $('qrCanvas'), qrUrl = $('qrUrl'), qrTitle = $('qrTitle');
  var sheet = $('sheet'), sheetName = $('sheetName');

  var items = [];
  var pending = 0;
  var lastSig = '';
  var sheetItem = null;
  var viewList = [];
  var viewIndex = -1;
  var openedFromPath = false;
  var lastMeta = { maxMb: '-', ttlHours: 0, maxTotalMb: 0, usedBytes: 0 };
  var perm = { role: 'admin', canList: true, canUpload: true, canDelete: true };

  // ── 工具 ───────────────────────────────────────────────
  function b64url(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtTime(ts) {
    var d = new Date(ts * 1000), p = function (x) { return x < 10 ? '0' + x : '' + x; };
    var now = new Date();
    var y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-';
    return y + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtLeft(exp) {
    if (!exp) return '永久保留';
    var s = exp - Math.floor(Date.now() / 1000);
    if (s <= 0) return '已过期';
    if (s < 3600) return Math.ceil(s / 60) + ' 分钟后过期';
    if (s < 86400) return Math.ceil(s / 3600) + ' 小时后过期';
    return Math.ceil(s / 86400) + ' 天后过期';
  }
  function ext(name) {
    var i = String(name || '').lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }
  // 用文字类型标代替彩色 emoji —— 更贴合线条化风格
  function typeBadge(name, kind) {
    if (kind === 'text') return 'TXT';
    var e = ext(name);
    if (!e) return 'BIN';
    if (/^(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/.test(e)) return 'IMG';
    if (/^(mp4|mov|mkv|avi|webm|m4v|wmv)$/.test(e)) return 'VID';
    if (/^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(e)) return 'SND';
    if (e === 'pdf') return 'PDF';
    if (/^(docx?|rtf|odt)$/.test(e)) return 'DOC';
    if (/^(xlsx?|ods)$/.test(e)) return 'XLS';
    if (/^(pptx?|odp)$/.test(e)) return 'PPT';
    if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(e)) return 'ZIP';
    if (/^(exe|msi|apk|dmg|deb|rpm)$/.test(e)) return 'EXE';
    if (/^(csv|tsv)$/.test(e)) return 'CSV';
    if (e.length <= 4) return e.toUpperCase();
    // 扩展名过长（如 env.example / backup.20251004）时截断毫无意义，
    // 改用文件名本身的前三个字母，例如 env.example -> ENV
    var base = String(name || '').replace(/^.*[\\/]/, '').replace(/^[.\\s]+/, '');
    var head = base.replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
    return (head || 'BIN').toUpperCase();
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }
  function copy(text, label) {
    var done = function () { toast((label || '已复制') + ' 到剪贴板'); };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }
  function absUrl(rel) { return location.origin + BASE + rel; }
  function fileUrl(it) { return absUrl('/d/' + it.id); }
  function viewUrl(it) { return absUrl('/v/' + it.id); }

  /* ── PWA：缩略图生成 ──
     预览图片时顺手用 canvas 生成 ≤256px 的 JPEG 缩略图，交给 SW 写进
     Cache Storage（Cache API 只能在 SW 侧写，postMessage 是官方通道）。
     视频/大图/SVG 一律跳过：控制缓存体积，也避免无谓的解码开销。 */
  function makeThumb(it) {
    if (!it || !it.id) return;
    var t = String(it.type || '').toLowerCase();
    if (t.indexOf('image/') !== 0) return;
    if (t.indexOf('image/svg') === 0) return;
    if (it.size > 4 * 1024 * 1024) return;
    if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) return;

    var im = new Image();
    im.decoding = 'async';
    im.onload = function () {
      try {
        var MAX = 256;
        var w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) return;
        var s = Math.min(1, MAX / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * s));
        var ch = Math.max(1, Math.round(h * s));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(im, 0, 0, cw, ch);
        var done = function (blob) {
          if (blob) navigator.serviceWorker.controller.postMessage(
            { type: 'thumb', id: it.id, blob: blob });
        };
        if (cv.toBlob) cv.toBlob(done, 'image/jpeg', 0.72);
      } catch (e) { /* 忽略：缩略图是纯增量优化 */ }
    };
    im.onerror = function () { /* 忽略 */ };
    im.src = viewUrl(it);
  }
  // 分享用的「文件页」：打开先预览，页面内有下载按钮。
  // 对图片/PDF 这类文件，直接把 /d/ 直链发出去会强制下载，体验很差。
  function filePageUrl(it) { return absUrl('/f/' + it.id); }

  // ── 预览类型判定（与服务端的 inline 降级保持一致）─────
  function previewKind(it) {
    if (it.kind === 'text') return 'text';
    var t = String(it.type || '').toLowerCase();
    var e = ext(it.name);
    if (t.indexOf('image/') === 0) return e === 'svg' ? 'text' : 'image';
    if (t.indexOf('video/') === 0) return 'video';
    if (t.indexOf('audio/') === 0) return 'audio';
    if (t.indexOf('application/pdf') === 0) return 'pdf';
    if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(e)) return 'image';
    if (/^(mp4|webm|mov|m4v|ogv)$/.test(e)) return 'video';
    if (/^(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (/^(txt|md|markdown|json|js|mjs|ts|jsx|tsx|css|scss|html|htm|xml|yml|yaml|log|csv|tsv|ini|conf|cfg|env|sh|bash|bat|ps1|py|java|c|h|cpp|cs|go|rs|rb|php|sql|svg|toml)$/.test(e)) return 'text';
    return 'none';
  }

  // ── 列表 ───────────────────────────────────────────────
  function load() {
    return fetch(BASE + '/api/list', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        items = d.items || [];
        lastMeta = d;
        if (d.role) perm = d;
        applyPerms();
        tbMode.textContent = perm.role === 'guest' ? '分享模式' : '管理模式';
        sbMode.textContent = perm.role === 'guest' ? '分享模式 · 不可删除' : '管理模式';
        sbLimit.textContent = '单文件 ' + d.maxMb + ' MB · ' +
          (d.ttlHours > 0 ? '保留 ' + d.ttlHours + ' 小时' : '永久保留');
        sbQuota.textContent = d.maxTotalMb
          ? '已用 ' + fmtSize(d.usedBytes || 0) + ' / ' + d.maxTotalMb + ' MB'
          : '已用 ' + fmtSize(d.usedBytes || 0);
        filesCount.textContent = items.length ? '(' + items.length + ')' : '';
        var sig = JSON.stringify(items);
        if (sig !== lastSig) { lastSig = sig; render(); }
        maybeOpenInitialFile();
      })
      .catch(function () { sbMode.textContent = '连接中断，重试中…'; });
  }

  // 从 /f/<id> 分享链接进来时，自动打开该文件的预览
  function maybeOpenInitialFile() {
    if (openedFromPath) return;
    var m = /\\/f\\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
    if (!m) return;
    var want = m[1];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === want) {
        openedFromPath = true;
        openViewer(items[i]);
        return;
      }
    }
  }

  // 按当前口令的权限裁剪界面（真正的拦截在服务端）
  function applyPerms() {
    var canList = perm.canList !== false;
    var canUpload = perm.canUpload !== false;
    var panel = $('filesPanel');
    var tb = $('textPane');
    if (panel) panel.hidden = !canList;
    if (tb) tb.hidden = true;
    document.querySelectorAll('.btnrow button, .drop').forEach(function (el) {
      el.hidden = !canUpload;
    });
    document.body.setAttribute('data-role', perm.role || 'guest');
  }

  function render() {
    listEl.textContent = '';
    emptyEl.hidden = items.length > 0;
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'row';

      var ico = document.createElement('div');
      ico.className = 'ico';
      ico.textContent = typeBadge(it.name, it.kind);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var nm = document.createElement('div');
      nm.className = 'fname';
      nm.textContent = it.name;
      nm.title = it.name;
      var sub = document.createElement('div');
      sub.className = 'fsub';
      [fmtSize(it.size), fmtTime(it.time), fmtLeft(it.expires)].forEach(function (s) {
        var sp = document.createElement('span');
        sp.textContent = s;
        sub.appendChild(sp);
      });
      meta.appendChild(nm); meta.appendChild(sub);

      var more = document.createElement('button');
      more.className = 'row-more';
      more.type = 'button';
      more.textContent = '⋯';
      more.setAttribute('aria-label', '更多操作');
      more.addEventListener('click', function (e) { e.stopPropagation(); openSheet(it); });

      li.appendChild(ico); li.appendChild(meta); li.appendChild(more);

      // 点整行一律进预览；不支持预览的类型在预览里给下载入口，
      // 这样「点一下」的行为始终一致，不会有时弹预览、有时弹操作面板
      li.classList.add('tappable');
      li.addEventListener('click', function () { openViewer(it); });
      listEl.appendChild(li);
    });
  }

  // ── 操作面板 ───────────────────────────────────────────
  function openSheet(it) {
    sheetItem = it;
    sheetName.textContent = it.name;
    sheet.querySelector('[data-act="preview"]').hidden = previewKind(it) === 'none';
    sheet.querySelector('[data-act="delete"]').hidden = perm.canDelete !== true;
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; sheetItem = null; }

  sheet.addEventListener('click', function (e) {
    if (e.target === sheet) return closeSheet();
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn || !sheetItem) return;
    var it = sheetItem;
    var act = btn.getAttribute('data-act');
    if (act === 'cancel') return closeSheet();
    closeSheet();
    if (act === 'preview') openViewer(it);
    else if (act === 'download') location.href = fileUrl(it);
    else if (act === 'copylink') copy(filePageUrl(it), '分享链接');
    else if (act === 'copydirect') copy(fileUrl(it), '直链');
    else if (act === 'qr') openQR(filePageUrl(it), it.name + ' · 打开先看，可下载');
    else if (act === 'delete') remove(it);
  });
  $('sheetClose').addEventListener('click', closeSheet);

  // ── 预览 ───────────────────────────────────────────────
  function openViewer(it) {
    // 全部文件都进预览（不支持的会显示下载入口），保证左右切换连续
    viewList = items.slice();
    viewIndex = viewList.findIndex(function (x) { return x.id === it.id; });
    if (viewIndex < 0) { viewList = [it]; viewIndex = 0; }
    paintViewer();
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeViewer() {
    viewer.hidden = true;
    viewerBody.textContent = '';
    document.body.style.overflow = '';
    // 若是从分享链接 /f/<id> 进来的，关掉后把地址还原成文件列表页
    if (openedFromPath) {
      openedFromPath = false;
      try { history.replaceState(null, '', BASE + '/'); } catch (e) { /* 忽略 */ }
    }
  }
  function stepViewer(delta) {
    if (viewList.length < 2) return;
    viewIndex = (viewIndex + delta + viewList.length) % viewList.length;
    paintViewer();
  }
  function paintViewer() {
    var it = viewList[viewIndex];
    if (!it) return;
    var kind = previewKind(it);
    viewerName.textContent = it.name;
    viewerDl.setAttribute('href', fileUrl(it));
    viewerDl.setAttribute('download', it.name);
    viewerBody.textContent = '';

    var multi = viewList.length > 1;
    $('viewerPrev').hidden = !multi;
    $('viewerNext').hidden = !multi;

    if (kind === 'image') {
      var img = document.createElement('img');
      img.src = viewUrl(it); img.alt = it.name;
      viewerBody.appendChild(img);
      makeThumb(it);
    } else if (kind === 'video') {
      var v = document.createElement('video');
      v.src = viewUrl(it); v.controls = true; v.autoplay = true;
      v.playsInline = true; v.setAttribute('playsinline', '');
      viewerBody.appendChild(v);
    } else if (kind === 'audio') {
      var wrap = document.createElement('div');
      wrap.className = 'audio-wrap';
      var big = document.createElement('div');
      big.className = 'big'; big.textContent = 'AUDIO';
      var label = document.createElement('div');
      label.textContent = it.name;
      var a = document.createElement('audio');
      a.src = viewUrl(it); a.controls = true; a.autoplay = true;
      wrap.appendChild(big); wrap.appendChild(label); wrap.appendChild(a);
      viewerBody.appendChild(wrap);
    } else if (kind === 'pdf') {
      var fr = document.createElement('iframe');
      fr.src = viewUrl(it); fr.title = it.name;
      viewerBody.appendChild(fr);
    } else if (kind === 'text') {
      var pre = document.createElement('pre');
      pre.textContent = '加载中…';
      viewerBody.appendChild(pre);
      var wantId = it.id;
      // 大文本不要整份拉进 DOM：超过 1MB 只取前 1MB（走 Range），并明确提示已截断
      var LIMIT = 1024 * 1024;
      var truncated = it.size > LIMIT;
      fetch(viewUrl(it), {
        cache: 'no-store',
        headers: truncated ? { Range: 'bytes=0-' + (LIMIT - 1) } : {},
      })
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          if (viewIndex >= 0 && viewList[viewIndex] && viewList[viewIndex].id === wantId) {
            pre.textContent = txt + (truncated
              ? '\\n\\n────────\\n（文件较大，仅预览前 1 MB，完整内容请点上方「下载」）'
              : '');
          }
        })
        .catch(function () { pre.textContent = '读取失败'; });
    } else {
      var tip = document.createElement('div');
      tip.className = 'viewer-tip';
      var t1 = document.createElement('div');
      t1.textContent = '这个类型暂不支持在线预览';
      var t2 = document.createElement('a');
      t2.className = 'btn-like';
      t2.setAttribute('href', fileUrl(it));
      t2.setAttribute('download', it.name);
      t2.textContent = '下载文件';
      tip.appendChild(t1); tip.appendChild(t2);
      viewerBody.appendChild(tip);
    }
  }

  $('viewerClose').addEventListener('click', closeViewer);
  $('viewerPrev').addEventListener('click', function () { stepViewer(-1); });
  $('viewerNext').addEventListener('click', function () { stepViewer(1); });
  viewer.addEventListener('click', function (e) {
    if (e.target === viewer) closeViewer();
  });
  /* 移动端：预览浮层下滑关闭（手机上最自然的手势）。
     只在内容未滚动到顶部、且纵向位移明显时触发，避免与内部滚动打架。 */
  (function swipeDownToClose() {
    var y0 = 0, x0 = 0, dragging = false, moved = false;
    var dlg = viewer.querySelector('.viewer-dlg');
    var body = $('viewerBody');
    viewer.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
      dragging = true; moved = false;
    }, { passive: true });
    viewer.addEventListener('touchmove', function (e) {
      if (!dragging || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - y0;
      var dx = e.touches[0].clientX - x0;
      if (Math.abs(dy) <= Math.abs(dx)) return;             // 横向滑动 = 切换上一个/下一个
      var atTop = !body || body.scrollTop <= 0;
      if (dy > 0 && atTop) {
        moved = true;
        if (dlg) dlg.style.transform = 'translateY(' + Math.min(dy, 140) + 'px)';
      }
    }, { passive: true });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      var dy = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY - y0 : 0;
      if (dlg) { dlg.style.transition = 'transform .18s ease'; dlg.style.transform = ''; }
      setTimeout(function () { if (dlg) dlg.style.transition = ''; }, 200);
      if (moved && dy > 90) closeViewer();
      moved = false;
    }
    viewer.addEventListener('touchend', end, { passive: true });
    viewer.addEventListener('touchcancel', end, { passive: true });
  })();

  // ── 二维码 ─────────────────────────────────────────────
  function openQR(text, title) {
    qrTitle.textContent = title || '扫码打开';
    qrUrl.textContent = text;
    drawQR(text);
    qrModal.hidden = false;
  }
  function drawQR(text) {
    var cv = qrCanvas;
    var size = cv.width;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
      try {
        if (window.QRCode.toCanvas(cv, text, 'M') !== false) return;
      } catch (e) { /* 落到下面的失败提示 */ }
    }
    ctx.fillStyle = '#000000';
    ctx.font = '700 22px Tahoma,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('二维码生成失败', size / 2, size / 2);
  }
  $('qrClose').addEventListener('click', function () { qrModal.hidden = true; });
  qrModal.addEventListener('click', function (e) { if (e.target === qrModal) qrModal.hidden = true; });
  $('qrCopy').addEventListener('click', function () { copy(qrUrl.textContent, '链接'); });

  function sharePageUrl() {
    if (!perm.shareToken) return location.href;
    var parts = BASE.split('/');
    parts[parts.length - 1] = perm.shareToken;
    return location.origin + parts.join('/') + '/';
  }
  // 管理员点二维码时给的是「分享链接」——避免把管理链接扫出去，那等于把删除权一起给了
  $('qrPage').addEventListener('click', function () {
    if (perm.role === 'admin' && perm.shareToken) {
      openQR(sharePageUrl(), '分享链接 · 可上传下载，不能删除');
    } else if (perm.role === 'admin') {
      openQR(location.href, '本页链接 · 含删除权限，谨慎分享');
    } else {
      openQR(location.href, '分享链接 · 扫码打开');
    }
  });

  // ── 链接与权限（点标题栏右侧的身份标签）─────────────────
  function openInfo() {
    var guest = perm.role === 'guest';
    $('infoRole').textContent = guest ? '分享模式（访客）' : '管理模式（管理员）';
    $('infoNote').textContent = guest
      ? '你打开的是分享链接：可以浏览、预览、上传，但删不掉任何文件——这是服务端强制的，不是前端把按钮藏起来了。'
      : '你打开的是管理链接：拥有全部权限，包括删除。只给自己用，不要发出去。要给别人就发下面那条分享链接。';

    var pl = $('infoPerms');
    pl.textContent = '';
    [
      ['浏览文件列表', perm.canList !== false],
      ['下载与在线预览', perm.canList !== false],
      ['上传文件', perm.canUpload !== false],
      ['删除文件', perm.canDelete === true],
    ].forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('span');
      a.textContent = r[0];
      var b = document.createElement('b');
      b.className = r[1] ? 'perm-yes' : 'perm-no';
      b.textContent = r[1] ? '允许' : '禁止';
      li.appendChild(a); li.appendChild(b);
      pl.appendChild(li);
    });

    $('infoMax').textContent = (lastMeta.maxMb || '-') + ' MB';
    $('infoTtl').textContent = lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久';
    $('infoQuota').textContent = lastMeta.maxTotalMb
      ? fmtSize(lastMeta.usedBytes || 0) + ' / ' + lastMeta.maxTotalMb + ' MB'
      : fmtSize(lastMeta.usedBytes || 0);

    if (perm.role === 'admin' && perm.shareToken) {
      $('infoShareWrap').hidden = false;
      $('infoShareLink').textContent = sharePageUrl();
    } else {
      $('infoShareWrap').hidden = true;
    }
    $('infoSelfLink').textContent = location.href;
    // Agent 自举地址：一次请求自描述所有端点，是给 AI 用的唯一入口
    $('infoAgentLink').textContent = absUrl('/api/meta');
    $('infoModal').hidden = false;
  }
  function closeInfo() { $('infoModal').hidden = true; }

  $('tbMode').addEventListener('click', openInfo);
  $('sbMode').classList.add('clickable');
  $('sbMode').title = '查看当前链接的身份与权限';
  $('sbMode').addEventListener('click', openInfo);
  $('infoClose').addEventListener('click', closeInfo);
  $('infoOk').addEventListener('click', closeInfo);
  $('infoModal').addEventListener('click', function (e) {
    if (e.target === $('infoModal')) closeInfo();
  });
  $('infoCopySelf').addEventListener('click', function () { copy(location.href, '当前链接'); });
  $('infoCopyAgent').addEventListener('click', function () { copy($('infoAgentLink').textContent, 'Agent 自举地址'); });
  $('infoCopyShare').addEventListener('click', function () { copy($('infoShareLink').textContent, '分享链接'); });
  $('infoQrShare').addEventListener('click', function () {
    closeInfo();
    openQR($('infoShareLink').textContent, '分享链接 · 可上传下载，不能删除');
  });

  // ── 删除 ───────────────────────────────────────────────
  function remove(it) {
    if (!confirm('确定删除「' + it.name + '」？删除后无法恢复。')) return;
    fetch(BASE + '/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: it.id }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || '删除失败');
        return j;
      });
    }).then(function () { toast('已删除'); lastSig = ''; load(); })
      .catch(function (e) { toast(e.message || '删除失败'); });
  }

  // ── 上传 ───────────────────────────────────────────────
  function sendChunk(id, i, blob, onProg) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + '/api/chunk?u=' + encodeURIComponent(id) + '&i=' + i);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProg(e.loaded); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('分片 ' + (i + 1) + ' 失败 (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('网络错误，请检查连接')); };
      xhr.onabort = function () { reject(new Error('已取消')); };
      xhr.send(blob);
    });
  }

  function uploadFile(file, ui) {
    var chunk = CHUNK_FALLBACK;
    return fetch(BASE + '/api/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('初始化失败 HTTP ' + r.status));
        return j;
      });
    }).then(function (info) {
      if (info.chunkSize) chunk = info.chunkSize;
      var total = file.size, sent = 0;
      function step(i) {
        if (sent >= total) return Promise.resolve();
        var start = i * chunk;
        var end = Math.min(start + chunk, total);
        return sendChunk(info.uploadId, i, file.slice(start, end), function (loaded) {
          ui.progress((sent + loaded) / (total || 1));
        }).then(function () {
          sent = end;
          ui.progress(total ? sent / total : 1);
          return step(i + 1);
        });
      }
      return step(0).then(function () {
        return fetch(BASE + '/api/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: info.uploadId }),
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error(j.error || ('完成失败 HTTP ' + r.status));
            return j;
          });
        });
      });
    });
  }

  function makeQueueItem(name) {
    var el = document.createElement('div');
    el.className = 'qitem';
    var top = document.createElement('div');
    top.className = 'qtop';
    var nm = document.createElement('div'); nm.className = 'qname'; nm.textContent = name; nm.title = name;
    var pct = document.createElement('div'); pct.className = 'qpct'; pct.textContent = '0%';
    top.appendChild(nm); top.appendChild(pct);
    var bar = document.createElement('div'); bar.className = 'bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);
    el.appendChild(top); el.appendChild(bar);
    queueEl.appendChild(el);
    return {
      progress: function (v) {
        var p = Math.max(0, Math.min(1, v));
        fill.style.width = (p * 100).toFixed(1) + '%';
        pct.textContent = Math.round(p * 100) + '%';
      },
      done: function () {
        pct.textContent = '完成';
        setTimeout(function () { el.remove(); }, 1400);
      },
      fail: function (msg) {
        el.classList.add('err');
        pct.textContent = '失败';
        var m = document.createElement('div'); m.className = 'qmsg'; m.textContent = msg;
        el.appendChild(m);
        setTimeout(function () { el.remove(); }, 7000);
      },
    };
  }

  function enqueue(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return f && typeof f.size === 'number'; });
    if (!list.length) return;
    if (perm.canUpload === false) { toast('当前链接没有上传权限'); return; }
    var i = 0;
    function worker() {
      if (i >= list.length) return Promise.resolve();
      var file = list[i++];
      var ui = makeQueueItem(file.name);
      return uploadFile(file, ui)
        .then(function () { ui.done(); pending--; lastSig = ''; load(); })
        .catch(function (e) { ui.fail(e.message || '上传失败'); pending--; })
        .then(worker);
    }
    var runners = [];
    for (var k = 0; k < Math.min(CONCURRENCY, list.length); k++) { pending++; runners.push(worker()); }
    Promise.all(runners).then(function () { lastSig = ''; load(); });
  }

  // ── 交互绑定 ───────────────────────────────────────────
  dropEl.addEventListener('click', function () { fileInput.click(); });
  dropEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  $('pickFile').addEventListener('click', function () { fileInput.click(); });
  $('pickMedia').addEventListener('click', function () { mediaInput.click(); });
  fileInput.addEventListener('change', function () { enqueue(fileInput.files); fileInput.value = ''; });
  mediaInput.addEventListener('change', function () { enqueue(mediaInput.files); mediaInput.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add('over'); });
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
  });
  window.addEventListener('paste', function (e) {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) enqueue(files);
  });

  $('refresh').addEventListener('click', function () { lastSig = ''; load(); });
  $('copyPage').addEventListener('click', function () { copy(location.href, '本页链接'); });

  $('textToggle').addEventListener('click', function () {
    var pane = $('textPane');
    pane.hidden = !pane.hidden;
    if (!pane.hidden) $('textInput').focus();
  });

  $('textSend').addEventListener('click', function () {
    var ta = $('textInput');
    var text = ta.value;
    if (!text.trim()) { toast('内容为空'); return; }
    fetch(BASE + '/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
      .then(function () { ta.value = ''; $('textPane').hidden = true; toast('已生成文字链接'); lastSig = ''; load(); })
      .catch(function (e) { toast(e.message || '失败'); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!viewer.hidden) return closeViewer();
      if (!$('infoModal').hidden) return closeInfo();
      if (!qrModal.hidden) return void (qrModal.hidden = true);
      if (!sheet.hidden) return closeSheet();
    }
    if (!viewer.hidden && viewList.length > 1) {
      if (e.key === 'ArrowLeft') stepViewer(-1);
      if (e.key === 'ArrowRight') stepViewer(1);
    }
  });

  /* ───────────── 触屏增强 ───────────── */
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  if (isTouch) {
    // 1) 滑动防误触：手指在滚动列表上滑动后抬起，不应触发该行的"点击进预览"。
    //    以 touchstart 起点为基准，位移超过阈值即判定为滚动，屏蔽随后的 click。
    var MOVE_TOL = 10; // px
    var tStart = null, tMoved = false;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tStart = null; return; }
      tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      tMoved = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!tStart || e.touches.length !== 1) return;
      var dx = Math.abs(e.touches[0].clientX - tStart.x);
      var dy = Math.abs(e.touches[0].clientY - tStart.y);
      if (dx > MOVE_TOL || dy > MOVE_TOL) tMoved = true;
    }, { passive: true });
    // 捕获阶段拦截：一旦判定为滑动，吃掉这次 click
    document.addEventListener('click', function (e) {
      if (!tMoved) return;
      tMoved = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    // 2) 遮罩层整片可点关闭：给弹层加一个更大的"点击背景关闭"区域，
    //    手机上没有 ESC 键，背景关闭是最自然的手势。
    [viewer, qrModal, $('infoModal'), sheet].forEach(function (layer) {
      if (!layer) return;
      layer.addEventListener('touchend', function (e) {
        // 仅当手指本身落在遮罩（不是对话框内部）时才关闭
        if (e.target !== layer) return;
        var t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        var el = document.elementFromPoint(t.clientX, t.clientY);
        if (el === layer) {
          if (layer === sheet) closeSheet();
          else if (layer === viewer) closeViewer();
          else layer.hidden = true;
        }
      }, { passive: true });
    });

    // 3) 双击缩放抑制：桌面版网页模式下，双击常被误判为缩放，
    //    对按钮/列表这类交互元素直接屏蔽后续双击。
    document.addEventListener('dblclick', function (e) {
      var t = e.target;
      if (t.closest && t.closest('button,.row-more,.ico,.tappable,.sheet-item')) e.preventDefault();
    }, { passive: false });

    // 4) 可视区域变化（手机键盘弹出/收起）时，让输入区滚动到可见位置，
    //    否则 iOS 聚焦输入框后会被键盘完全遮住。
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var ta = $('textInput');
        if (!document.activeElement || document.activeElement !== ta) return;
        var pane = $('textPane');
        if (pane && !pane.hidden) {
          setTimeout(function () { pane.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 120);
        }
      });
    }
  }

  /* ───────────── PWA：SW 注册 / 安装按钮 / 离线状态 ───────────── */
  // 注册 Service Worker（./sw.js 相对 <base> 解析为 /s/<口令>/sw.js，
  // 作用域天然落在本口令目录内，不影响其他口令与首页）。
  // embed 模式下跳过：外层桌面已有自己的 SW，同源双注册会互相打架。
  if (!EMBED && 'serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .catch(function () { /* SW 失败不影响页面正常使用 */ });
    });
  }

  // 安装按钮：Chromium 系捕获 beforeinstallprompt 后走原生安装流程；
  // iOS Safari 没有该事件，点击时如实给出「添加到主屏幕」的手动引导。
  var deferredPrompt = null;
  var installBtn = EMBED ? null : $('tbInstall');

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          deferredPrompt = null;
          installBtn.hidden = true;
        }).catch(function () {});
        return;
      }
      toast('iOS：点浏览器底部「分享」→「添加到主屏幕」');
    });
  }

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    if (installBtn) installBtn.hidden = true;
    toast('已安装到桌面');
  });

  // iOS：无 beforeinstallprompt 事件，但未以独立模式运行时也亮出按钮做引导
  var standalone = window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;
  if (installBtn && !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    installBtn.hidden = false;
  }

  // 离线状态条：断网时 body[data-net=off] 顶部如实提示当前是缓存内容
  function paintNet() {
    document.body.setAttribute('data-net', navigator.onLine ? 'on' : 'off');
  }
  window.addEventListener('online', function () { paintNet(); lastSig = ''; load(); });
  window.addEventListener('offline', paintNet);
  paintNet();

  // 嵌入模式下向桌面外层报到：外层据此收起"正在载入"遮罩。
  // 用 '*' 而不指定 origin：同源 iframe，且外层只需要知道"好了"。
  if (EMBED) {
    try { window.parent.postMessage({ type: 'drop-ready' }, '*'); } catch (e) {}
  }

  load();
  setInterval(function () {
    if (!pending && viewer.hidden && sheet.hidden && qrModal.hidden && $('infoModal').hidden) load();
  }, 5000);
})();
`;

// 由 build 脚本注入 qr.js 的完整源码（已用真实解码器 jsQR 验证：11/11 通过）
const QR_JS = `__QR_JS__`;


const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">' +
  '<rect width="32" height="32" fill="#008080"/>' +
  // Win95 四色旗：斜切平行四边形（顶边比底边右移 4 = 飘动感），黑描边硬像素
  '<path d="M6 5 L14 5 L10 14 L2 14 Z" fill="#d4000a" stroke="#0a0a0a" stroke-width="1"/>' +
  '<path d="M18 3 L26 3 L22 12 L14 12 Z" fill="#007c30" stroke="#0a0a0a" stroke-width="1"/>' +
  '<path d="M5 18 L13 18 L9 27 L1 27 Z" fill="#0050be" stroke="#0a0a0a" stroke-width="1"/>' +
  '<path d="M17 16 L25 16 L21 25 L13 25 Z" fill="#ffd500" stroke="#0a0a0a" stroke-width="1"/>' +
  '</svg>';

// ───────────────── PWA Service Worker ─────────────────
// 作用域 = SW 自身所在目录（/s/<口令>/），天然按口令隔离，首页不受影响。
// 策略：外壳 cache-first（离线可开）、导航 network-first（断网回退壳）、
// /api/* /v/* /d/* 一律 network-only（列表必须实时、私人文件不进缓存）。
// 注意：本模板串内禁止出现反引号与 ${（与 QR_JS 同一构建纪律）。
const SW_JS = `
'use strict';
var VERSION = '__BUILD_ID__';
var SHELL_CACHE = 'drop-shell-' + VERSION;
var THUMB_CACHE = 'drop-thumb-' + VERSION;
var SHELL = ['./', './app.css', './app.js', './qr.js', './favicon.ico', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  var keep = [SHELL_CACHE, THUMB_CACHE];
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (keep.indexOf(k) < 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 页面预览图片后会送来 canvas 生成的缩略图（≤256px JPEG），写进专用缓存。
// cache key 用 /thumb/<id>，与原图 /v/<id> 完全隔离，绝不污染原图预览。
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'thumb' || !d.id || !d.blob) return;
  e.waitUntil(
    caches.open(THUMB_CACHE).then(function (c) {
      return c.put('/thumb/' + d.id, new Response(d.blob, {
        headers: { 'Content-Type': d.blob.type || 'image/jpeg', 'Cache-Control': 'max-age=31536000' }
      }));
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航请求：network-first，断网时回退到缓存的应用外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('./').then(function (r) { return r || Response.error(); });
      })
    );
    return;
  }

  var path = url.pathname;

  // 缩略图：纯缓存读取（不会真的发起网络请求）
  if (path.indexOf('/thumb/') >= 0) {
    e.respondWith(
      caches.match(path).then(function (r) { return r || new Response('', { status: 404 }); })
    );
    return;
  }

  // 应用外壳：cache-first，未命中回源并回填
  if (/\\.(css|js|webmanifest|ico|png|svg)$/.test(path) || path.charAt(path.length - 1) === '/') {
    e.respondWith(
      caches.match(req).then(function (r) {
        if (r) return r;
        return fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
  // 其余（/api/*、/v/*、/d/* 等）：不拦截，直连网络
});
`;
