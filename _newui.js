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
  '<title>7喵快传 · 一个文件，一个桌面</title>',
  '<meta name="description" content="一个文件，一个桌面 —— 单文件、零依赖的自托管文件中转服务，带一套能装进手机的 Win98 桌面。">',
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
  '        <button class="tb-btn tb-install download" id="tbInstall" type="button" hidden aria-label="安装到桌面" title="安装到桌面"></button>',
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
  '      <fieldset class="panel upopt" id="upOpt">',
  '        <legend>上传设置</legend>',
  '        <div class="upopt-row">',
  '          <label for="expSel">保留时长</label>',
  '          <select id="expSel"></select>',
  '        </div>',
  '        <div class="upopt-row">',
  '          <label for="pwInput">访问密码</label>',
  '          <input id="pwInput" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空 = 不设密码">',
  '          <button id="pwToggle" type="button" class="mini">显示</button>',
  '        </div>',
  '        <p class="upopt-note" id="upOptNote">默认保留 24 小时，可在上方改档位（1 小时 / 6 小时 / 1 天 / 3 天 / 7 天 / 30 天 / 永久）；一次上传共用同一时长与密码。你传的文件只有你和管理员能改时长、续期、删除。</p>',
  '      </fieldset>',
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
  '        <div class="list-bar" id="listBar">',
  '          <span class="lb-group">',
  '            <label class="lb-sel"><input type="checkbox" id="selAll"><span>全选</span></label>',
  '            <span class="lb-count" id="selCount"></span>',
  '            <button type="button" class="lb-del" id="delSel" disabled>删除选中</button>',
  '          </span>',
  '          <button id="refresh" type="button" class="lb-refresh">刷新</button>',
  '        </div>',
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
  '      <span>© 2026 <a href="#" id="studioLink" rel="noopener noreferrer">知行工作室</a></span>',
  '    </div>',
  '',
  '  </div>',
  '</div>',
  '',
  '<div id="viewer" class="mask viewer" hidden>',
  '  <div class="dialog viewer-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="viewerName">预览</span>',
  '      <button id="viewerFs" class="tb-btn fs" type="button" aria-label="全屏" title="全屏 / 退出全屏"></button>',
  '      <button id="viewerClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
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
  '      <button id="qrClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
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
  '      <button id="infoClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <div class="info-body">',
  '        <div class="info-row"><span class="info-k">当前身份</span><span class="info-v" id="infoRole">…</span></div>',
  '        <p class="info-note" id="infoNote"></p>',
  '        <ul class="perm-list" id="infoPerms"></ul>',
  '        <div class="info-row"><span class="info-k">单文件上限</span><span class="info-v" id="infoMax">…</span></div>',
  '        <div class="info-row"><span class="info-k">保留时长</span><span class="info-v" id="infoTtl">…</span></div>',
  '        <div class="info-row"><span class="info-k">可选档位</span><span class="info-v" id="infoExpChoices">…</span></div>',
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
  '<div id="askModal" class="mask" hidden>',
  '  <div class="dialog ask-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="askTitle">…</span>',
  '      <button id="askClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
  '    </div>',
  '    <div class="dlg-body">',
  '      <p class="ask-note" id="askNote"></p>',
  '      <div id="askPwWrap" class="ask-field" hidden>',
  '        <label for="askPw">访问密码</label>',
  '        <input id="askPw" type="password" autocomplete="off" spellcheck="false" placeholder="请输入访问密码">',
  '      </div>',
  '      <div id="askExpWrap" class="ask-field" hidden>',
  '        <label for="askExp">保留时长</label>',
  '        <select id="askExp"></select>',
  '      </div>',
  '      <div class="dlg-foot"><button id="askOk" class="wide" type="button">确定</button></div>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<div id="sheet" class="mask mask-bottom" hidden>',
  '  <div class="dialog sheet-dlg">',
  '    <div class="titlebar">',
  '      <span class="tb-title" id="sheetName">操作</span>',
  '      <button id="sheetClose" class="tb-btn close" type="button" aria-label="关闭"></button>',
  '    </div>',
  '    <div class="dlg-body sheet-body">',
  '      <button class="sheet-item" data-act="preview" type="button">预览</button>',
  '      <button class="sheet-item" data-act="download" type="button">下载</button>',
  '      <button class="sheet-item" data-act="copylink" type="button">复制分享链接（打开先看）</button>',
  '      <button class="sheet-item" data-act="copydirect" type="button">复制直链（直接下载）</button>',
  '      <button class="sheet-item" data-act="renew" type="button">续期 / 改保留时长…</button>',
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
  /* 统一控制按钮图标（与桌面壳同一套，杜绝 ×/✕/□ 混用） */
  --ico-x:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5' stroke='%23000' stroke-width='2' stroke-linecap='square'/%3E%3C/svg%3E");
  --ico-min:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='3' y='9.5' width='8' height='2' fill='%23000'/%3E%3C/svg%3E");
  /* --ico-max（方框）保留备用，当前统一用 --ico-expand（四角箭头） */
  --ico-max:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='3' y='3' width='8' height='8' fill='none' stroke='%23000' stroke-width='1.4'/%3E%3Crect x='3' y='3' width='8' height='1.6' fill='%23000'/%3E%3C/svg%3E");
  --ico-restore:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Crect x='5' y='4' width='6' height='6' fill='none' stroke='%23000' stroke-width='1.3'/%3E%3Crect x='3' y='2' width='6' height='6' fill='none' stroke='%23000' stroke-width='1.3'/%3E%3C/svg%3E");
  --ico-expand:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M2 5V2H5 M9 2H12V5 M12 9V12H9 M5 12H2V9' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square'/%3E%3C/svg%3E");
  --ico-download:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M7 2V9 M4 6.5 7 9.5 10 6.5' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square' stroke-linejoin='miter'/%3E%3Crect x='3' y='11' width='8' height='1.8' fill='%23000'/%3E%3C/svg%3E");
  --ico-down:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M7 2V9 M4 6 7 9 10 6' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='square'/%3E%3Crect x='2.5' y='11' width='9' height='1.8' fill='%23000'/%3E%3C/svg%3E");
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
/* 标题占满剩余空间：多个标题栏按钮（如预览的全屏+关闭）才会成组靠右，
   而不是被 space-between 拆到中间 —— 与 Win98 的按钮排布语言一致 */
.tb-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-mode{
  font-weight:400;font-size:11px;flex:none;border-radius:0;
  background:transparent;border:1px solid transparent;color:#fff;
  padding:2px 8px;min-height:19px;box-shadow:none;
}
.tb-mode:hover{background:rgba(255,255,255,.20);border-color:rgba(255,255,255,.40)}
.tb-mode:active{box-shadow:none;padding:2px 8px;background:rgba(255,255,255,.30)}
/* 标题栏右侧动作区：安装按钮 + 模式按钮 */
.tb-actions{display:flex;align-items:center;gap:5px;flex:none}
.tb-install{font-size:0;font-weight:700;color:transparent}
.tb-install::before{content:"";position:absolute;left:50%;top:50%;width:13px;height:13px;transform:translate(-50%,-50%);background:var(--ico-download) center/contain no-repeat}
.tb-btn{
  width:16px;height:14px;min-height:0;padding:0;flex:none;position:relative;
  display:grid;place-items:center;font-size:10px;font-weight:700;line-height:1;
  background:var(--face);color:var(--text);
  box-shadow:var(--raise);
}
.tb-btn:active{box-shadow:var(--sink)}
/* 关闭 / 全屏按钮共享桌面壳那套统一图标（同一功能全站同形）
   用 ::before 承载图标，避开移动端 .tb-btn::after 的 44px 触控覆盖层 */
.tb-btn.close,.tb-btn.fs{
  color:transparent;font-size:0;
  /* 与 .wclose（扫雷/查看源码等 window95 窗口）完全一致的外观：
     经典灰立体 Win98 标题栏按钮，避免同屏出现两套关闭钮 */
  background:#c0c0c0;
  box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px #808080,inset 2px 2px #dfdfdf;
}
.tb-btn.close::before,.tb-btn.fs::before{
  content:"";position:absolute;left:50%;top:50%;z-index:1;
  width:9px;height:9px;transform:translate(-50%,-50%);
  background:var(--ico-x) center/contain no-repeat;
}
/* 全屏图标与桌面壳窗口最大化按钮完全同一个（--ico-expand 四角箭头），
   且任何状态恒定不变（含已全屏）——「放大到极限」全站一种图形，
   已放大与否由 aria-label/title 与行为表达 */
.tb-btn.fs::before{background-image:var(--ico-expand)}
.tb-btn.fs.is-full::before{background-image:var(--ico-expand)}

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
/* 存储已满：保留入口但明确"不可用"，不让用户误以为能传 */
.drop.is-full{cursor:not-allowed;opacity:.62}
.drop.is-full:hover{background:#f4f4f4}
.drop.is-full.over{background:#f4f4f4}
.drop.is-full .drop-inner{border-color:var(--sh)}
.drop.is-full .drop-title{color:var(--dis)}
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

/* ── 上传设置：时长 + 访问密码（Win98 分组框风格） ── */
.upopt{margin-top:9px}
.upopt-row{display:flex;align-items:center;gap:6px;margin:5px 0}
.upopt-row label{flex:0 0 62px;font-size:12px;color:#303030}
.upopt-row select,.upopt-row input[type=password],.upopt-row input[type=text]{
  flex:1;min-width:0;font-size:12px;min-height:27px;padding:3px 6px;
  background:var(--win);color:var(--text);box-shadow:var(--sink);border:0;border-radius:0;
}
.upopt-row select:focus,.upopt-row input:focus{outline:1px dotted var(--dk);outline-offset:-3px}
button.mini{flex:0 0 auto;font-size:11px;min-height:27px;padding:2px 9px}
.upopt-note{margin:7px 0 0;font-size:11px;color:#505050;line-height:1.5}
.upopt.locked-pw .upopt-note{color:#006000}

/* ── 列表状态：锁标 / 临期 / 已过期 ── */
.ftag{display:inline-block;margin-left:6px;padding:0 4px;font-size:10px;line-height:15px;
  border:1px solid var(--sh);background:var(--face);color:#404040;vertical-align:1px}
.ftag.lock{color:#000080;border-color:#000080}
.ftag.mine{color:#006400;border-color:#006400}
.ftag.soon{color:#a06000;border-color:#a06000}
.ftag.gone{color:#a00000;border-color:#a00000}
.row.st-soon .fsub,.row.st-gone .fsub{color:#a00000}
.row.st-gone{opacity:.68}
.ico.locked{background:repeating-linear-gradient(45deg,#e8e8e8 0 4px,#d0d0d0 4px 8px)}

/* ── 通用对话框（解锁 / 续期） ── */
.ask-dlg{width:min(360px,100%)}
.ask-note{font-size:12px;color:#303030;line-height:1.6;margin:0 0 10px}
.ask-field{margin:9px 0}
.ask-field label{display:block;font-size:12px;margin-bottom:4px}
.ask-field input,.ask-field select{
  width:100%;min-height:30px;padding:4px 7px;font-size:13px;
  background:var(--win);color:var(--text);box-shadow:var(--sink);border:0;border-radius:0;
}
.ask-field input:focus,.ask-field select:focus{outline:1px dotted var(--dk);outline-offset:-3px}
.ask-field[hidden]{display:none}
.ask-dlg .dlg-foot button{min-height:32px}

/* ── 上传队列：经典分段进度条 ── */
.queue{margin-top:9px;display:flex;flex-direction:column;gap:5px}
.qitem{background:var(--face);box-shadow:var(--raise);padding:7px 9px}
.qtop{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}
.qname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qpct{flex:none;font-variant-numeric:tabular-nums;color:#303030}
.qcancel{flex:none;width:20px;min-width:20px;height:18px;min-height:18px;padding:0;line-height:14px;font-size:14px;color:#a00000}
.qcancel:disabled{opacity:.45}
.qitem.cancelled .bar>i{background:repeating-linear-gradient(90deg,#808080 0 7px,transparent 7px 9px)}
.qitem.cancelled .qpct{color:#606060}
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
.qretry{margin-top:6px;font-size:11.5px;min-height:24px;padding:2px 10px}

/* ── 批量上传汇总条：几十个文件时只留一条总进度，不刷屏 ── */
.qsum{background:var(--face);box-shadow:var(--raise);padding:8px 9px;margin-bottom:2px}
.qsum-top{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:6px}
.qsum-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qsum-count{flex:none;font-variant-numeric:tabular-nums;color:#303030}
.qsum.msg-ok .qsum-count{color:#006000}
.qsum.msg-err .qsum-count{color:#a00000}
.qsum-acts{display:flex;gap:5px;margin-top:7px}
.qsum-acts button{flex:1;min-width:0;font-size:11.5px;min-height:26px;padding:3px 8px}
.qsum-acts[hidden]{display:none}

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

/* ── 列表工具条：全选组（左）+ 刷新（右），同一行垂直居中 ──
   旧版把刷新 absolute 钉在 fieldset 上边框线上，批量条却在边框线下方的
   正常流里，两者天生错开一行；legend 还得硬留 padding-right 让位。
   现在全部收进一条 flex 工具条，间距/对齐由一处控制。*/
.list-bar{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  min-height:30px;margin:0 0 2px;
  /* 与下方行内复选框左边缘对齐：.list padding 2 + .row padding-left 6 */
  padding-left:8px;
}
.lb-group{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
/* 没有「可管理」的文件时隐藏批量控件，但保留刷新（服务端本就不给删他人文件） */
.list-bar:not(.show) .lb-group{display:none}
.lb-sel{
  display:inline-flex;align-items:center;gap:6px;padding:5px 0;
  cursor:pointer;white-space:nowrap;-webkit-user-select:none;user-select:none;
  touch-action:manipulation;
}
.lb-sel>span{font-size:12px}
.lb-count{font-size:11.5px;color:#404040;white-space:nowrap}
.lb-del,.lb-refresh{font-size:11.5px;padding:4px 10px;min-height:28px;white-space:nowrap}
.lb-del:disabled{color:var(--dis);opacity:.6;cursor:default}
.lb-refresh{margin-left:auto;position:relative}
/* 触屏：刷新热区补足 44px，按钮本体不偏移，不破坏这一行的对齐 */
.lb-refresh::after{
  content:'';position:absolute;left:50%;top:50%;
  width:100%;min-width:44px;height:44px;transform:translate(-50%,-50%);
}
/* 复选框：全站统一 20px 立体方框 + CSS 绘制对勾/半选横线，
   顶部「全选」与行内复选框尺寸、观感完全一致。*/
.lb-sel input[type=checkbox],.row-check{
  -webkit-appearance:none;appearance:none;
  width:20px;height:20px;flex:none;margin:0;padding:0;
  background:var(--win);box-shadow:var(--sink);color:var(--text);
  border:0;border-radius:0;cursor:pointer;position:relative;
  touch-action:manipulation;
}
.lb-sel input[type=checkbox]:checked::after,.row-check:checked::after{
  content:'';position:absolute;left:6px;top:2px;width:5px;height:10px;
  border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(42deg);
}
.lb-sel input[type=checkbox]:indeterminate::after,.row-check:indeterminate::after{
  content:'';position:absolute;left:4px;top:8px;width:12px;height:3px;background:currentColor;
}
/* 行 hover 变深蓝时，对勾/横线跟着文字转白 */
.row:hover .row-check{color:#fff}
.lb-sel input[type=checkbox]:focus-visible,.row-check:focus-visible{
  outline:1px dotted var(--dk);outline-offset:2px;
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

/* 链接默认无下划线，保持整页视觉统一（不被浏览器默认下划线割裂） */
a{text-decoration:none}
/* ── 页脚版权 ── */
.footer{
  padding:4px 6px 3px;text-align:center;
  font-size:11px;color:#505050;
}
.footer a{color:var(--title);text-decoration:none}
.footer a:hover{color:#000}

/* ── 对话框通用 ── */
.mask{
  position:fixed;inset:0;z-index:80;
  display:flex;align-items:center;justify-content:center;
  padding:calc(12px + var(--safe-t)) calc(12px + var(--safe-r)) calc(12px + var(--safe-b)) calc(12px + var(--safe-l));
  background:rgba(0,0,0,.42);
  animation:maskIn .12s ease-out;
}
@keyframes maskIn{from{background:rgba(0,0,0,0)}}
@media (prefers-reduced-motion:reduce){.mask{animation:none}}
.mask-bottom{align-items:flex-end}
.dialog{background:var(--face);box-shadow:var(--raise),3px 3px 0 rgba(0,0,0,.35);padding:3px;max-height:100%;display:flex;flex-direction:column}
.dlg-body{padding:10px;overflow:auto}

/* ── 预览 ── */
/* 注意：这里必须叠在 .mask 上，单独写 .viewer 会丢掉 position:fixed，
   弹层会变成文档流里的普通块，表现为「点了没反应」。 */
.viewer{background:rgba(0,0,0,.74);z-index:85}
.viewer .viewer-dlg{width:min(920px,100%);height:min(88dvh,100%);will-change:transform}
/* 全屏：真全屏 API 与 CSS 兜底都让对话框铺满视口，视频/图片随之填满；
   标题栏 ✕ 仍浮在最上层，保证任何设备都能随时退出 */
.viewer-dlg:fullscreen{width:100vw;height:100vh;max-width:none;max-height:none;border-width:0}
/* 全屏态的定位。
   注意：这里**不能用 100vw / 100dvh** —— 本页常被嵌在「我的电脑」窗口的
   iframe 里，vw/dvh 参照的是 iframe 自己的视口（手机上只有半屏宽），
   于是「全屏」只铺满 iframe 那一小块，看着就是内容挤在屏幕一侧。
   正确做法：固定定位相对 iframe 视口（inset:0 即已铺满 iframe），
   尺寸用 100%；同时 postMessage 让外层窗口也铺满全屏，
   内外一起放大才是真·全屏。 */
.viewer-dlg.is-full{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;z-index:300;border-width:0}
.viewer-dlg:fullscreen .viewer-body,.viewer-dlg.is-full .viewer-body{margin:0}
.viewer-body{
  flex:1;min-height:0;background:var(--face);box-shadow:var(--sink);margin:3px;
  display:grid;place-items:center;overflow:auto;-webkit-overflow-scrolling:touch;
}
/* 媒体本身自带深底（图片/视频），但「不支持预览」这类提示面板
   必须是 98 的浅底深字 —— 纯黑大色块是现代设计语言，与整站割裂 */
.viewer-body img{max-width:100%;max-height:100%;object-fit:contain;background:#000}
.viewer-body video{max-width:100%;max-height:100%;background:#000}
.viewer-body iframe{width:100%;height:100%;border:0;background:#fff}
.viewer-body pre{
  margin:0;width:100%;height:100%;overflow:auto;background:var(--win);color:var(--text);
  padding:9px;font:12px/1.6 "Courier New",Consolas,monospace;
  white-space:pre-wrap;word-break:break-word;text-align:left;
  -webkit-overflow-scrolling:touch;
}
.audio-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;color:#000;font-size:12px}
.audio-wrap .big{font:700 15px/1 Tahoma,sans-serif;letter-spacing:3px;color:#000080}
.audio-wrap audio{width:min(400px,78vw)}
/* 提示区：浅底深字（98 语义面板），不再用「深色卡片 + 圆角按钮」的现代风 */
.viewer-tip{color:#000;font-size:12px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
.viewer-tip .btn-like{background:var(--face);color:var(--text);text-decoration:none;
  padding:6px 14px;min-height:26px;font-size:12px;box-shadow:var(--raise);cursor:pointer}
.viewer-tip .btn-like:active{box-shadow:var(--sink);padding:7px 13px 5px 15px}
.viewer-foot{display:flex;gap:5px;padding:5px}
.viewer-foot>*{flex:1;text-align:center}
/* 窄屏上「◀ 上一个」会被折成两行（上一/个），按钮排版立刻散架 —— 文字一律单行 */
.viewer-foot button,.viewer-foot .btn-like{white-space:nowrap}
/* 底部三个按钮视觉统一：上一个/下一个带方向箭头，下载加下载图标，
   文字与图标同行中央对齐，整行等宽一致 */
.viewer-foot .btn-like::before{
  content:"";width:13px;height:13px;margin-right:5px;
  background:var(--ico-download) center/contain no-repeat;
}
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
  /* 图标跟着按钮一起放大：按钮 38×34 而图标仍是 9×9 时，
     视觉上就是「一个几乎看不见的墨点在大灰块里」 */
  .tb-btn.close::before,.tb-btn.fs::before{width:18px;height:18px}

  /* 列表工具条：触屏把按钮撑到舒适高度，整条仍与行内复选框对齐 */
  .list-bar{padding-left:9px;gap:8px;min-height:38px}
  .lb-del,.lb-refresh{font-size:12px;padding:7px 12px;min-height:36px}
  .lb-sel>span{font-size:13px}

  /* 列表行：整体加高，让整行成为可点热区 */
  .row{gap:9px;padding:11px 7px;min-height:56px}
  .row-more{width:32px;height:32px;font-size:16px}

  /* 预览底部按钮行：四枚按钮挤一排，字号收到 12px、左右留白收到最小，
     配合白-space:nowrap 保证「◀ 上一个」「下一个 ▶」在 320px 屏上也单行居中 */
  .viewer-foot{gap:4px;padding:4px}
  .viewer-foot button,.viewer-foot .btn-like{font-size:12px;padding:8px 2px;min-height:40px}
  .viewer-foot .btn-like:active{padding:9px 1px 7px 3px}
  .ico{width:32px;height:29px;font-size:9px}

  /* 状态栏：可点面板撑到 44px 高 */
  .statusbar{padding:4px}
  .sb-panel{min-height:44px;padding:4px 8px;font-size:11.5px}

  /* 页脚外链：扩大可点区域 */
  .footer{padding:10px 6px 8px}
  .footer a{display:inline-block;padding:8px 6px;min-height:32px}

  /* 刷新已移入正常流的工具条，图例不再需要为它留白 */
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
  .list-bar{gap:6px}
  .lb-del,.lb-refresh{padding:7px 9px}
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
/* 预览浮层的标题栏不能跟着一起藏：右上角的 ✕ 是预览的出口之一，
   藏了它，视频/图片预览在内嵌窗口里就没有任何关闭入口（手机上尤其致命）。 */
body.embed .viewer .titlebar{display:flex}
body.embed .footer{display:none}
/* 嵌在「我的电脑」窗口里时，内页自己的状态栏必须让位：
   外壳窗口底部已经有一条状态栏（身份与权限），两条并排会变成
   「上下叠两条状态栏」，像坏掉的排版。内页状态栏的内容
   （单文件上限 / 保留时长 / 已用容量）改为 postMessage 交给外壳那一格显示，
   信息不丢，排版只剩一条状态栏。 */
body.embed .statusbar{display:none}
body.embed .win-body{
  flex:1;min-height:0;overflow-y:auto;
  -webkit-overflow-scrolling:touch;overscroll-behavior:contain;
}
`;

const APP_JS = `
(function () {
  'use strict';

  // ── 平台分享凭证透传 ───────────────────────────────────────
  // 托管平台靠 ?sharecode= 授权入口、再种 SameSite=None 的 Cookie 放行后续请求。
  // 但 App 预览面板 / webview / 隐私模式常拦掉这个第三方 Cookie：入口 HTML 能开、
  // CSS/JS/API 却全部 403，页面看似打开实则瘫掉。这里把凭证从 <meta> 读出并
  // 显式挂到每一个请求上，彻底不依赖 Cookie。无凭证时 withSC 原样返回，行为不变。
  var SC = (function () {
    var m = document.querySelector('meta[name="7md-sc"]');
    if (m) return (m.getAttribute('content') || '').replace(/[^A-Za-z0-9_-]/g, '');
    var q = /[?&]sharecode=([A-Za-z0-9_-]+)/.exec(location.search);
    return q ? q[1] : '';
  })();
  function withSC(u) {
    if (!SC || typeof u !== 'string') return u;
    if (/[?&]sharecode=/.test(u)) return u;
    if (/^(data|blob|javascript|about|mailto):/i.test(u) || u.charAt(0) === '#') return u;
    if (/^(https?:)?\\/\\//i.test(u)) {
      try { if (new URL(u).origin !== location.origin) return u; } catch (e) { return u; }
    }
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + SC;
  }
  if (SC) {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === 'string') input = withSC(input);
      return _fetch.call(window, input, init);
    };
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = withSC(url);
      return _xhrOpen.apply(this, arguments);
    };
  }

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

  // ── 批量删除：列表顶部工具条（与「刷新」同行） ─────────────────
  // 工具条写在 HTML 里，刷新与全选/删除是同一 flex 行的成员，垂直天然对齐。
  var selected = new Set();
  var listBar = $('listBar');
  var selAll = listBar.querySelector('#selAll');
  var selCount = listBar.querySelector('#selCount');
  var delSel = listBar.querySelector('#delSel');
  // 谁能管理：自己上传的（服务端裁决）或管理员链接。无管理权的项不提供勾选。
  function canMg(it) { return it.canManage === true || perm.role === 'admin'; }
  function updateSelBar() {
    var mg = items.filter(canMg);
    // .show 现在有真实 CSS：无「可管理」文件时隐藏批量控件，刷新按钮仍在。
    listBar.classList.toggle('show', mg.length > 0 && items.length > 0);
    var sel = mg.filter(function (it) { return selected.has(it.id); });
    selAll.checked = mg.length > 0 && sel.length === mg.length;
    selAll.indeterminate = sel.length > 0 && sel.length < mg.length;
    // 计数常驻、按钮文案固定：选中数变化不再让这一行来回抖动。
    selCount.textContent = '已选 ' + sel.length + ' / ' + mg.length;
    delSel.disabled = sel.length === 0;
  }
  selAll.addEventListener('change', function () {
    var mg = items.filter(canMg);
    if (selAll.checked) mg.forEach(function (it) { selected.add(it.id); });
    else selected.clear();
    listEl.querySelectorAll('.row-check').forEach(function (cb) {
      cb.checked = selected.has(cb.getAttribute('data-id'));
    });
    updateSelBar();
  });
  delSel.addEventListener('click', function () {
    var ids = items.filter(function (it) { return selected.has(it.id); }).map(function (it) { return it.id; });
    if (!ids.length) return;
    if (!confirm('确定删除选中的 ' + ids.length + ' 个文件？删除后无法恢复。')) return;
    fetch(BASE + '/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '删除失败'); return j; }); })
      .then(function (j) {
        selected.clear();
        toast('已删除 ' + (j.deleted ? j.deleted.length : ids.length) + ' 个');
        lastSig = ''; load();
      })
      .catch(function (e) { toast(e.message || '删除失败'); });
  });
  var toastEl = $('toast'), filesCount = $('filesCount'), tbMode = $('tbMode');
  var sbMode = $('sbMode'), sbLimit = $('sbLimit'), sbQuota = $('sbQuota');

  var viewer = $('viewer'), viewerBody = $('viewerBody'), viewerName = $('viewerName'), viewerDl = $('viewerDl');
  var currentVideo = null;   // 当前预览里的 <video>，全屏时优先用它
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
  var perm = { role: 'admin', canList: true, canUpload: true, canDelete: true, canManageOwn: true };
  // 存储是否已满：由 /api/list 回传的 maxTotalMb / usedBytes 单一数据源算出，
  // 满了就禁用全部上传入口并如实改文案，不让用户白点（服务端仍是真源，会再拦一道）。
  var storageFull = false;

  /* ── 上传设置：时长 + 访问密码 ────────────────────────────────
     密码绝不写 localStorage / 不外发到任何 URL，只随上传请求一次性提交，
     服务端立刻转成不可逆摘要。时长偏好记在本地，下次打开自动沿用。 */
  var OPT_KEY = '7md.upopt.v1';
  var EXP_LABEL = { 0: '永久保留', 1: '1 小时', 6: '6 小时', 24: '1 天', 72: '3 天', 168: '7 天', 720: '30 天' };
  function expLabel(h) { return EXP_LABEL[h] || (h + ' 小时'); }
  function expChoices() {
    return (lastMeta.expChoices && lastMeta.expChoices.length) ? lastMeta.expChoices : [1, 6, 24, 72, 168, 720, 0];
  }
  // 把「默认档位」与「全部可选档位」拼成人话，供状态栏 / 信息面板 / 面板说明共用。
  // 文案完全由服务端下发的 expChoices、ttlHours 生成，不再写死 24 小时。
  function expSummaryText() {
    var def = lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久';
    var cs = expChoices().map(expLabel);
    return '默认 ' + def + '，可选 ' + cs.join(' / ');
  }
  function savedOpt() {
    try { return JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); } catch (e) { return {}; }
  }
  function fillExpSelect(sel, defH) {
    var cs = expChoices(), want = defH;
    if (cs.indexOf(want) < 0) want = cs.indexOf(lastMeta.ttlHours) >= 0 ? lastMeta.ttlHours : cs[0];
    sel.textContent = '';
    cs.forEach(function (h) {
      var o = document.createElement('option');
      o.value = String(h); o.textContent = expLabel(h);
      if (h === want) o.selected = true;
      sel.appendChild(o);
    });
  }
  function initUpOpt() {
    var s = savedOpt();
    fillExpSelect($('expSel'), Number(s.h));
    $('pwInput').value = '';                    // 密码每次进页面清空
    $('pwToggle').addEventListener('click', function () {
      var i = $('pwInput'), show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      $('pwToggle').textContent = show ? '隐藏' : '显示';
    });
    $('expSel').addEventListener('change', function () {
      try { localStorage.setItem(OPT_KEY, JSON.stringify({ h: Number($('expSel').value) })); } catch (e) {}
    });
    $('pwInput').addEventListener('input', refreshUpOptNote);
    refreshUpOptNote();
  }
  // 返回本次上传要附带的服务端参数；整批文件读的是同一份设置。
  function uploadOpt() {
    return { h: Number($('expSel').value), pw: $('pwInput').value || '' };
  }
  function refreshUpOptNote() {
    var pw = $('pwInput').value || '';
    var el = $('upOptNote');
    var base = '时长默认 ' + (lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久') +
      '，可在上方改（' + expChoices().map(expLabel).join(' / ') + '）；一次上传共用同一时长与密码。';
    el.textContent = pw
      ? '已设访问密码：本次上传的文件需要提取码；管理链接始终免密。密码不保存、刷新即清空。' + base
      : base + '留空 = 不设密码，管理链接始终免密。你传的文件只有你和管理员能改时长、续期、删除。';
    $('upOpt').classList.toggle('locked-pw', !!pw);
  }

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
  /* 状态栏专用的紧凑体积写法：去掉无意义的小数位（185.0 MB → 185 MB、
     2.00 GB → 2 GB）。手机上一格只有 200 出头的像素，小数位就是浪费。 */
  function compactSize(n) {
    n = Number(n) || 0;
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    if (n < 1073741824) return Math.round(n / 1048576) + ' MB';
    return (Math.round(n / 1073741824 * 10) / 10) + ' GB';
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
  function expState(it) {
    if (it.expired) return { cls: 'gone', text: it.canRenew ? '已过期 · 可续期' : '已过期', tag: it.canRenew ? '可续期' : '已过期' };
    if (it.expiringSoon) return { cls: 'soon', text: fmtLeft(it.expires), tag: '即将过期' };
    return { cls: '', text: fmtLeft(it.expires), tag: '' };
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
  /* 嵌入外壳窗口时，把状态栏信息交给外壳显示（内页那条已隐藏）。
     独立访问（直接打开 /s/<口令>/）时不发，页面自带状态栏照常显示。 */
  function postStatusToHost(mode, limit, quota) {
    try {
      if (!document.body.classList.contains('embed')) return;
      if (window.parent === window) return;
      /* 传给外壳的是紧凑版：外壳状态栏只有一格可用（392px 的手机上
         「单文件 20 MB · 保留 24 小时」会挤掉权限与身份） */
      window.parent.postMessage({
        __7md: 1, type: '7md:status',
        mode: mode || '', limit: limit || '', quota: quota || ''
      }, '*');
    } catch (e) { /* 跨源时忽略：外壳拿不到就显示自己的那条 */ }
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
  // 绝对 URL（图片/视频/iframe src、下载跳转、二维码、复制文本）不走 fetch 包装，
  // 必须在这里就带上凭证；相对 URL 由上面包装的 fetch/XHR 自动处理。
  function absUrl(rel) { return withSC(location.origin + BASE + rel); }
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
        if (!window.__upOptInit) { window.__upOptInit = true; initUpOpt(); }
        if (d.role) perm = d;
        // 满了就禁用上传：用服务端回传的 usedBytes / maxTotalMb 单一数据源判断，
        // 不另算、不缓存，每次刷新列表都重算（上传成功的回写会让它自动恢复）。
        storageFull = !!(d.maxTotalMb && (d.usedBytes || 0) >= d.maxTotalMb * 1048576);
        applyPerms();
        tbMode.textContent = perm.role === 'guest' ? '分享模式' : '管理模式';
        sbMode.textContent = perm.role === 'guest' ? '分享模式 · 仅管理本人文件' : '管理模式';
        sbLimit.textContent = '单文件 ' + d.maxMb + ' MB · 默认 ' +
          (d.ttlHours > 0 ? d.ttlHours + ' 小时' : '永久') + '（上传时可改档位）';
        sbQuota.textContent = d.maxTotalMb
          ? '已用 ' + fmtSize(d.usedBytes || 0) + ' / ' + d.maxTotalMb + ' MB'
          : '已用 ' + fmtSize(d.usedBytes || 0);
        filesCount.textContent = items.length ? '(' + items.length + ')' : '';
        /* 嵌入「我的电脑」窗口时，内页状态栏已隐藏（只留外壳那一条），
           这里把限制与容量信息交给外壳那一格，信息不丢。
           文案在这里直接拼好（不从渲染文本反推，避免多余空格）。 */
        postStatusToHost(
          sbMode.textContent,
          compactSize(d.maxMb * 1048576) + ' · 默认 ' + (d.ttlHours > 0 ? d.ttlHours + 'h（可改）' : '永久（可改）'),
          compactSize(d.usedBytes || 0) + (d.maxTotalMb ? ' / ' + compactSize(d.maxTotalMb * 1048576) : '')
        );
        var sig = JSON.stringify(items);
        if (sig !== lastSig) { lastSig = sig; render(); }
        maybeOpenInitialFile();
        /* 嵌入「我的电脑」窗口时：内容真正就绪，请外层收起"正在打开"遮罩。
           比 iframe 的 load 事件可靠（load 在 app.js 下载完就触发，内容还靠
           fetch 异步渲染；且动态设 iframe.src 时 load 偶发漏触发，会让遮罩卡 3 秒）。
           这里用 7md:drop-ready 让遮罩与内容对齐，消除开窗时的白屏/卡顿闪。 */
        if (EMBED && !window.__readyReported) {
          window.__readyReported = true;
          try { window.parent.postMessage({ type: '7md:drop-ready' }, '*'); } catch (e) {}
        }
      })
      .catch(function () {
        /* 即使拉取失败也收起遮罩，避免卡 3 秒兜底；状态栏会如实显示"连接中断"。 */
        if (EMBED && !window.__readyReported) {
          window.__readyReported = true;
          try { window.parent.postMessage({ type: '7md:drop-ready' }, '*'); } catch (e) {}
        }
        sbMode.textContent = '连接中断，重试中…';
      });
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
        openItem(items[i]);   // 加锁文件先弹提取码，不要直接吐预览
        return;
      }
    }
  }

  // 按当前口令的权限裁剪界面（真正的拦截在服务端）
  function applyPerms() {
    var canList = perm.canList !== false;
    var canUpload = perm.canUpload !== false;
    // 满了：上传功能存在但暂时不可用 —— 保留入口、禁用、如实改文案，不让用户白点。
    // 没上传权限：整个功能不显示。
    var upAllowed = canUpload && !storageFull;
    var panel = $('filesPanel');
    var tb = $('textPane');
    if (panel) panel.hidden = !canList;
    if (tb) tb.hidden = true;
    var dropEl = $('drop');
    document.querySelectorAll('.btnrow button, .drop').forEach(function (el) {
      el.hidden = !canUpload;            // 无权限：整块隐藏
    });
    document.querySelectorAll('.drop, #pickFile, #pickMedia').forEach(function (el) {
      el.disabled = !upAllowed;          // 满了：禁用但不隐藏，文案说明原因
    });
    if (dropEl) {
      dropEl.classList.toggle('is-full', storageFull);
      var dt = dropEl.querySelector('.drop-title');
      var ds = dropEl.querySelector('.drop-sub');
      if (storageFull) {
        if (dt) dt.textContent = '存储已满 · 暂不能上传';
        if (ds) ds.textContent = '管理员清理出空间后即可继续（已用 ' +
          fmtSize(lastMeta.usedBytes || 0) + ' / ' + (lastMeta.maxTotalMb || 0) + ' MB）';
      } else {
        if (dt) dt.textContent = '拖入文件，或点击选择';
        if (ds) ds.textContent = '支持多选 · 可粘贴截图 · 手机可直接调相册';
      }
    }
    // 没有上传权限、或存储已满时，上传设置面板都不该露出来（避免误导）
    var upOpt = $('upOpt');
    if (upOpt) upOpt.hidden = !canUpload || storageFull;
    document.body.setAttribute('data-role', perm.role || 'guest');
  }

  function render() {
    listEl.textContent = '';
    emptyEl.hidden = items.length > 0;
    items.forEach(function (it) {
      var li = document.createElement('li');
      var st = expState(it);
      li.className = 'row' + (st.cls ? ' st-' + st.cls : '');

      var ico = document.createElement('div');
      ico.className = 'ico' + (it.locked && !it.unlocked ? ' locked' : '');
      ico.textContent = it.masked ? 'PW' : typeBadge(it.name, it.kind);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var nm = document.createElement('div');
      nm.className = 'fname';
      nm.textContent = it.name;
      nm.title = it.unlocked ? it.name : '需要访问密码';
      // 归属标：一眼看出哪些是自己传的（可改时长/续期/删除）
      if (it.mine) {
        var mk = document.createElement('span');
        mk.className = 'ftag mine';
        mk.textContent = '我传的';
        mk.title = '只有你和管理员能改时长 / 续期 / 删除这个文件';
        nm.appendChild(mk);
      }
      // 锁标：一眼看出哪些文件需要提取码
      if (it.locked) {
        var lk = document.createElement('span');
        lk.className = 'ftag lock';
        lk.textContent = it.unlocked ? '已解锁' : '需密码';
        nm.appendChild(lk);
      }
      if (st.tag) {
        var tg = document.createElement('span');
        tg.className = 'ftag ' + st.cls;
        tg.textContent = st.tag;
        nm.appendChild(tg);
      }
      var sub = document.createElement('div');
      sub.className = 'fsub';
      [fmtSize(it.size), fmtTime(it.time), st.text].forEach(function (s) {
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

      // 批量删除：仅「能管理」（自己上传 / 管理员）的项显示复选框。
      // 勾选态让图标让位，避免与类型标识抢位置。
      if (canMg(it)) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'row-check';
        cb.setAttribute('data-id', it.id);
        cb.checked = selected.has(it.id);
        cb.addEventListener('click', function (e) { e.stopPropagation(); });
        cb.addEventListener('change', function (e) {
          e.stopPropagation();
          if (cb.checked) selected.add(it.id); else selected.delete(it.id);
          updateSelBar();
        });
        li.classList.add('show-check');
        li.insertBefore(cb, li.firstChild);
      }

      // 点整行一律进预览；不支持预览的类型在预览里给下载入口，
      // 这样「点一下」的行为始终一致，不会有时弹预览、有时弹操作面板
      li.classList.add('tappable');
      li.addEventListener('click', function () { openItem(it); });
      listEl.appendChild(li);
    });
    updateSelBar();
  }

  // ── 通用对话框：解锁 / 续期 ──────────────────────────────
  var askModal = $('askModal'), askCb = null;
  function openAsk(cfg) {
    askCb = cfg.onOk || null;
    $('askTitle').textContent = cfg.title || '';
    $('askNote').textContent = cfg.note || '';
    $('askPwWrap').hidden = !cfg.password;
    $('askExpWrap').hidden = !cfg.exp;
    $('askOk').textContent = cfg.okText || '确定';
    if (cfg.exp) fillExpSelect($('askExp'), cfg.expDefault);
    if (cfg.password) { $('askPw').value = ''; }
    askModal.hidden = false;
    setTimeout(function () { try { (cfg.password ? $('askPw') : $('askOk')).focus(); } catch (e) {} }, 30);
  }
  function closeAsk() { askModal.hidden = true; askCb = null; }
  function submitAsk() {
    var cb = askCb;
    if (!cb) return closeAsk();
    var val = { pw: $('askPw').value, h: Number($('askExp').value) };
    cb(val, closeAsk);
  }
  $('askOk').addEventListener('click', submitAsk);
  $('askClose').addEventListener('click', closeAsk);
  askModal.addEventListener('click', function (e) { if (e.target === askModal) closeAsk(); });
  $('askPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAsk(); });

  // 未解锁的加密文件：先弹提取码，成功后再执行原本要点开的动作。
  function openItem(it) {
    if (it.masked || (it.locked && !it.unlocked)) return askUnlock(it, function () { openViewerFresh(it.id); });
    openViewer(it);
  }
  function openViewerFresh(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) { openViewer(items[i]); return; }
  }
  function askUnlock(it, after) {
    openAsk({
      title: '需要访问密码',
      note: '这个文件已加密。输入提取码后，同一次上传的整批文件都会解锁。',
      password: true, okText: '解锁',
      onOk: function (v, close) {
        fetch(BASE + '/api/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pw: v.pw }),
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '解锁失败'); return j; }); })
          .then(function () {
            close(); toast('已解锁');
            lastSig = '';
            return load().then(function () { if (after) after(); });
          })
          .catch(function (e) { toast(e.message || '访问密码不正确'); });
      },
    });
  }

  // 续期 / 改时长：沿用该文件当前档位作为默认值，一键即可「按原设置续」。
  function askRenew(it) {
    if (!it.canRenew) { toast('文件已过续期宽限期，无法续期'); return; }
    openAsk({
      title: '续期 / 改保留时长',
      note: it.name + ' — 当前：' + expState(it).text,
      exp: true, expDefault: it.expH, okText: '续期',
      onOk: function (v, close) {
        fetch(BASE + '/api/renew', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: it.id, h: v.h }),
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '续期失败'); return j; }); })
          .then(function () { close(); toast('已续期：' + expLabel(v.h)); lastSig = ''; load(); })
          .catch(function (e) { toast(e.message || '续期失败'); });
      },
    });
  }

  // ── 操作面板 ───────────────────────────────────────────
  function openSheet(it) {
    sheetItem = it;
    sheetName.textContent = it.unlocked ? it.name : '需要访问密码';
    var needsPw = it.masked || (it.locked && !it.unlocked);
    // 归属：只有「我传的」或管理员才露管理入口。管理员链接下服务端把每项
    // canManage 都置 true；这里仍按 perm 兜底，避免旧缓存数据误导。
    var canMg = it.canManage === true || perm.role === 'admin';
    sheet.querySelector('[data-act="preview"]').hidden = needsPw || previewKind(it) === 'none';
    sheet.querySelector('[data-act="delete"]').hidden = !canMg;
    var renewBtn = sheet.querySelector('[data-act="renew"]');
    renewBtn.hidden = !canMg || !it.canRenew;
    renewBtn.textContent = needsPw ? '解锁后可续期…' : (it.expired ? '续期复活…' : '续期 / 改保留时长…');
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
    var needsPw = it.masked || (it.locked && !it.unlocked);
    // 需要提取码的动作：先解锁，成功后对新拿到的记录重放同一动作。
    if (needsPw && (act === 'preview' || act === 'download' || act === 'renew')) {
      closeSheet();
      return askUnlock(it, function () {
        var fresh = null;
        for (var i = 0; i < items.length; i++) if (items[i].id === it.id) { fresh = items[i]; break; }
        if (!fresh) return;
        if (act === 'preview') openViewer(fresh);
        else if (act === 'download') location.href = fileUrl(fresh);
        else if (act === 'renew') askRenew(fresh);
      });
    }
    closeSheet();
    if (act === 'preview') openViewer(it);
    else if (act === 'download') location.href = fileUrl(it);
    else if (act === 'copylink') copy(filePageUrl(it), '分享链接');
    else if (act === 'copydirect') copy(fileUrl(it), '直链');
    else if (act === 'qr') openQR(filePageUrl(it), it.name + ' · 打开先看，可下载');
    else if (act === 'delete') remove(it);
    else if (act === 'renew') askRenew(it);
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
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
    viewerDlg.classList.remove('is-full');
    viewer.hidden = true;
    viewerBody.textContent = '';
    document.body.style.overflow = '';
    // 若是从分享链接 /f/<id> 进来的，关掉后把地址还原成文件列表页
    if (openedFromPath) {
      openedFromPath = false;
      try { history.replaceState(null, '', withSC(BASE + '/')); } catch (e) { /* 忽略 */ }
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
    currentVideo = null;
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
      currentVideo = v;
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

  /* 全屏：视频预览要能沉浸式铺满，又不丢「随时关闭」的出口。
     三层兜底：① 标准 Fullscreen API（桌面，真·系统级全屏）；
     ② iOS Safari 用视频原生 webkitEnterFullscreen（标准 API 在 iOS 上对普通元素无效）；
     ③ 都不支持时退化为 CSS 兜底（对话框 fixed 铺满视口，标题栏 ✕ 仍在最上层）。 */
  var viewerDlg = viewer.querySelector('.viewer-dlg');
  function syncFsBtn() {
    var on = !!(document.fullscreenElement || viewerDlg.classList.contains('is-full'));
    /* 图标由 CSS 按 .is-full 切换（展开↔还原），不再用文本字形 */
    $('viewerFs').classList.toggle('is-full', on);
    $('viewerFs').setAttribute('aria-label', on ? '退出全屏' : '全屏');
  }
  function exitFull() {
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    if (viewerDlg.classList.contains('is-full')) {
      viewerDlg.classList.remove('is-full');
      /* 退出时通知外层把窗口还原（否则窗口会一直保持铺满） */
      try {
        if (document.body.classList.contains('embed')) {
          window.parent.postMessage({ type: '7md:embed-fullscreen', on: false }, '*');
        }
      } catch (e) { /* 独立打开时没有 parent，忽略 */ }
      syncFsBtn();
      return true;
    }
    return false;
  }
  function toggleFullscreen() {
    if (exitFull()) return;
    /* 嵌入模式（?embed=1，即被「我的电脑」窗口内嵌）：
       iframe 内的 requestFullscreen 常被浏览器拒绝，而 CSS 兜底只能铺满 iframe。
       真·全屏需要外层窗口也一起铺满 —— 通知外壳把窗口最大化，
       内外同时放大，视觉上才是整屏。 */
    var EMBED = document.body.classList.contains('embed');
    if (EMBED) {
      try {
        window.parent.postMessage({ type: '7md:embed-fullscreen', on: true }, '*');
      } catch (e) { /* 独立打开时没有 parent，忽略 */ }
    }
    if (viewerDlg.requestFullscreen) {
      viewerDlg.requestFullscreen().catch(function () { viewerDlg.classList.add('is-full'); });
    } else if (currentVideo && currentVideo.webkitEnterFullscreen) {
      try { currentVideo.webkitEnterFullscreen(); } catch (e) { viewerDlg.classList.add('is-full'); }
    } else {
      viewerDlg.classList.add('is-full');
    }
    syncFsBtn();
  }
  $('viewerFs').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFsBtn);
  document.addEventListener('webkitfullscreenchange', syncFsBtn);
  /* 双击 / 双触关闭：视频、图片等内容可能占满整个预览区（内嵌窗口里更是如此），
     必须保证「双击内容本身」也能关掉预览，否则内容一撑满就找不到出口。
     自行计时判定（350ms 内同位置两次按下），不依赖 dblclick——
     iOS Safari 在部分缩放设置下根本不发 dblclick。 */
  (function doubleTapToClose() {
    var last = 0, lx = 0, ly = 0;
    viewerBody.addEventListener('pointerdown', function (e) {
      var now = Date.now();
      if (now - last < 350 && Math.abs(e.clientX - lx) < 48 && Math.abs(e.clientY - ly) < 48) {
        last = 0;
        closeViewer();
        return;
      }
      last = now; lx = e.clientX; ly = e.clientY;
    });
  })();
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
    if (!perm.shareToken) return withSC(location.href);
    var parts = BASE.split('/');
    parts[parts.length - 1] = perm.shareToken;
    return withSC(location.origin + parts.join('/') + '/');
  }
  // 管理员点二维码时给的是「分享链接」——避免把管理链接扫出去，那等于把全部管理权一起给了
  $('qrPage').addEventListener('click', function () {
    if (perm.role === 'admin' && perm.shareToken) {
      openQR(sharePageUrl(), '分享链接 · 支持上传与下载');
    } else if (perm.role === 'admin') {
      openQR(withSC(location.href), '本页链接 · 含全部管理权限，谨慎分享');
    } else {
      openQR(withSC(location.href), '分享链接 · 扫码打开');
    }
  });

  // ── 链接与权限（点标题栏右侧的身份标签）─────────────────
  function openInfo() {
    var guest = perm.role === 'guest';
    $('infoRole').textContent = guest ? '分享模式（访客）' : '管理模式（管理员）';
    $('infoNote').textContent = guest
      ? '您打开的是分享链接：可浏览、预览、上传。本设备上传的文件仅本人可管理（调整保留时长、续期与删除），身份由浏览器设备凭证自动识别，无需登录；各访客之间的文件权限相互隔离，由服务端强制执行。'
      : '你打开的是管理链接：拥有全部权限，能管理所有人的文件。只给自己用，不要发出去。要给别人就发下面那条分享链接。';

    var pl = $('infoPerms');
    pl.textContent = '';
    [
      ['浏览文件列表', perm.canList !== false],
      ['下载与在线预览', perm.canList !== false],
      ['上传文件', perm.canUpload !== false],
      ['改时长 / 续期 / 删除自己上传的', perm.canManageOwn !== false],
      ['管理所有人上传的文件', perm.canDelete === true],
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
    $('infoTtl').textContent = '默认 ' + (lastMeta.ttlHours > 0 ? lastMeta.ttlHours + ' 小时' : '永久保留') + '（上传时可改）';
    $('infoExpChoices').textContent = expChoices().map(expLabel).join(' / ');
    $('infoQuota').textContent = lastMeta.maxTotalMb
      ? fmtSize(lastMeta.usedBytes || 0) + ' / ' + lastMeta.maxTotalMb + ' MB'
      : fmtSize(lastMeta.usedBytes || 0);

    if (perm.role === 'admin' && perm.shareToken) {
      $('infoShareWrap').hidden = false;
      $('infoShareLink').textContent = sharePageUrl();
    } else {
      $('infoShareWrap').hidden = true;
    }
    $('infoSelfLink').textContent = withSC(location.href);
    // Agent 自举地址：一次请求自描述所有端点，是给 AI 用的唯一入口
    $('infoAgentLink').textContent = absUrl('/api/meta');
    $('infoModal').hidden = false;
  }
  function closeInfo() { $('infoModal').hidden = true; }

  $('tbMode').addEventListener('click', openInfo);
  $('sbMode').classList.add('clickable');
  $('sbMode').title = '查看当前链接的身份与权限';
  $('sbMode').addEventListener('click', openInfo);
  /* 嵌入模式下内页标题栏/状态栏被隐藏，入口交由外壳状态栏转发：
     外壳「我的电脑」窗口底部的「分享模式」标签点击后发来此消息，
     由内页打开「链接与权限」对话框（含 Agent 自举地址）。 */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.type === '7md:open-info') openInfo();
  });
  $('infoClose').addEventListener('click', closeInfo);
  $('infoOk').addEventListener('click', closeInfo);
  $('infoModal').addEventListener('click', function (e) {
    if (e.target === $('infoModal')) closeInfo();
  });
  $('infoCopySelf').addEventListener('click', function () { copy(withSC(location.href), '当前链接'); });
  $('infoCopyAgent').addEventListener('click', function () { copy($('infoAgentLink').textContent, 'Agent 自举地址'); });
  $('infoCopyShare').addEventListener('click', function () { copy($('infoShareLink').textContent, '分享链接'); });
  $('infoQrShare').addEventListener('click', function () {
    closeInfo();
    openQR($('infoShareLink').textContent, '分享链接 · 支持上传与下载');
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

  // ── 上传（分片 + 断点续传） ─────────────────────────────
  var RESUME_KEY = '7md.resume.v1';
  var RETRY_MAX = 12;
  var RETRY_BASE_MS = 1500;
  var CHUNK_STALL_MS = 30000;   // 单片长时间无任何字节则判卡死，触发重试

  /* 取消是「终止性」的：abort 当前请求 + 打断自动续传等待 + 阻止重试，
     绝不能被断点续传逻辑当成一次普通网络中断而复活。 */
  function isCancelled(ui) { return !!(ui && ui.cancelled && ui.cancelled()); }
  function cancelErr() { var e = new Error('已取消'); e.cancelled = true; return e; }
  function cancelSession(id) {
    if (!id) return;
    try {
      fetch(BASE + '/api/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: id }),
      }).catch(function () {});
    } catch (e) {}
  }

  function sendChunk(id, i, blob, onProg, ui) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var timer = null, settled = false;
      function clear() { if (timer) { clearTimeout(timer); timer = null; } }
      function arm() {
        clear();
        timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} }, CHUNK_STALL_MS);
      }
      xhr.open('POST', BASE + '/api/chunk?u=' + encodeURIComponent(id) + '&i=' + i);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (ui && ui.onCancel) ui.onCancel(function () { try { xhr.abort(); } catch (e) {} });
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProg(e.loaded); arm(); };
      xhr.onload = function () {
        if (settled) return; settled = true; clear();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('分片 ' + (i + 1) + ' 失败 (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () {
        if (settled) return; settled = true; clear(); reject(new Error('网络错误，请检查连接'));
      };
      xhr.onabort = function () {
        if (settled) return; settled = true; clear(); reject(new Error('连接超时或已取消'));
      };
      arm();
      xhr.send(blob);
    });
  }

  /* localStorage 保存「未完成会话」：页面被系统回收后重新选同一个文件也能续。
     浏览器不会替我们留住 File 本体，所以仍需重选一次文件。 */
  function fpOf(f) { return [f.name, f.size, f.lastModified || 0].join('|'); }
  function resumeList() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '[]'); } catch (e) { return []; }
  }
  function findResume(fp) {
    var a = resumeList();
    for (var i = 0; i < a.length; i++) if (a[i] && a[i].fp === fp) return a[i];
    return null;
  }
  function saveResume(fp, id) {
    try {
      var a = resumeList().filter(function (x) { return x && x.fp !== fp; });
      a.unshift({ fp: fp, id: id, at: Date.now() });
      if (a.length > 100) a.length = 100;   // 批量场景：一次几十个文件不该互相挤掉续传记录
      localStorage.setItem(RESUME_KEY, JSON.stringify(a));
    } catch (e) {}
  }
  function clearResume(fp) {
    try {
      localStorage.setItem(RESUME_KEY,
        JSON.stringify(resumeList().filter(function (x) { return x && x.fp !== fp; })));
    } catch (e) {}
  }

  /* 断线后必须查服务端真实进度：XHR 失败无法区分「请求没到」和「服务端
     写完了、响应在回程丢了」——后者盲目重发同一片会被 409 拒绝。
     404 = 会话确实没了；网络层失败则 reject，交上层重试，不能误判成没了。 */
  function getStatus(id) {
    return fetch(BASE + '/api/status?u=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;
        return r.json().then(function (j) {
          if (!r.ok) throw new Error('查询进度失败 HTTP ' + r.status);
          return j;
        });
      });
  }

  function initSession(file, opt) {
    var o = opt || {};
    return fetch(BASE + '/api/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream', h: o.h, pw: o.pw || '' }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('初始化失败 HTTP ' + r.status));
        return j;
      });
    });
  }

  function finishSession(id) {
    return fetch(BASE + '/api/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: id }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('完成失败 HTTP ' + r.status));
        return j;
      });
    });
  }

  // 网络恢复立即续传；浏览器不发 online 事件时，超时也会再试一次。
  function waitRetry(ms, ui) {
    return new Promise(function (resolve) {
      var done = false, t, iv;
      function fin() {
        if (done) return; done = true;
        window.removeEventListener('online', fin);
        clearTimeout(t); clearInterval(iv);
        resolve();
      }
      t = setTimeout(fin, ms);
      // 等待续传期间也要能被立即取消，不然「已取消」还要等一个退避窗口
      iv = setInterval(function () { if (isCancelled(ui)) fin(); }, 120);
      window.addEventListener('online', fin);
    });
  }

  /* 小文件（≤ 一个分片）走 /api/put 单请求上传：省掉 init→status→chunk→finish
     四次往返，批量几十个小文件时提速最明显。断线自动重发整个文件（≤8MB，
     成本远低于分片握手），因此不做断点续传；若 localStorage 里已有它的续传
     记录（上次中断过），仍交回分片路径接着传。 */
  function uploadSmall(file, ui, opt) {
    var attempts = 0;
    function once() {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var timer = null, settled = false;
        function clear() { if (timer) { clearTimeout(timer); timer = null; } }
        function arm() {
          clear();
          timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} }, CHUNK_STALL_MS);
        }
        var o = opt || { h: undefined, pw: '' };
        // 时长走 query（可见、可缓存），提取码走 header（绝不进 URL / 日志 / Referer）。
        var qs = '?name=' + encodeURIComponent(file.name) + (o.h !== undefined ? '&h=' + o.h : '');
        xhr.open('POST', BASE + '/api/put' + qs);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        if (o.pw) xhr.setRequestHeader('X-7md-Pw', o.pw);
        if (ui && ui.onCancel) ui.onCancel(function () { try { xhr.abort(); } catch (e) {} });
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) ui.progress(e.loaded / (file.size || 1));
          arm();
        };
        xhr.onload = function () {
          if (settled) return; settled = true; clear();
          var j = null;
          try { j = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) resolve(j);
          else reject(new Error((j && j.error) || ('上传失败 HTTP ' + xhr.status)));
        };
        xhr.onerror = function () {
          if (settled) return; settled = true; clear(); reject(new Error('网络错误，请检查连接'));
        };
        xhr.onabort = function () {
          if (settled) return; settled = true; clear(); reject(new Error('连接超时或已取消'));
        };
        arm();
        xhr.send(file);
      });
    }
    function run() {
      if (isCancelled(ui)) return Promise.reject(cancelErr());
      return once().catch(function (e) {
        if (isCancelled(ui)) throw cancelErr();
        attempts++;
        if (attempts > RETRY_MAX) throw e;
        // 429 是「每分钟次数」窗口，短退避没用，直接等一个窗口
        var throttled = /过于频繁|429/.test(e.message);
        var wait = throttled ? 30000 : Math.min(15000, Math.round(RETRY_BASE_MS * Math.pow(1.5, attempts - 1)));
        ui.waiting((throttled ? '上传太频繁，' : '连接中断 · ') + Math.round(wait / 1000) + ' 秒后自动重传');
        return waitRetry(wait, ui).then(run);
      });
    }
    return run();
  }

  function uploadFile(file, ui, opt) {
    var total = file.size, fp = fpOf(file);
    // 小文件且没有待续的旧会话 → 单请求上传；其余仍走分片 + 断点续传
    if (total <= CHUNK_FALLBACK && !findResume(fp)) return uploadSmall(file, ui, opt);
    var chunk = CHUNK_FALLBACK, uploadId = null, attempts = 0;

    function pumpFrom(st) {
      chunk = st.chunkSize || chunk;
      function step(i) {
        if (isCancelled(ui)) return Promise.reject(cancelErr());
        var start = i * chunk;
        if (start >= total) return Promise.resolve();
        var end = Math.min(start + chunk, total);
        return sendChunk(uploadId, i, file.slice(start, end), function (loaded) {
          ui.progress(Math.min(1, (start + loaded) / (total || 1)));
        }, ui).then(function () {
          ui.progress(Math.min(1, end / (total || 1)));
          return step(i + 1);
        });
      }
      return step(st.next);
    }

    function round() {
      var fresh = false;
      var saved = findResume(fp);
      if (!uploadId && saved) uploadId = saved.id;
      // 让队列层知道会话 id：取消时才能通知服务端立刻释放 .part 与配额。
      // 若取消恰好发生在 init 返回之前，onSession 会自己发取消请求，不留孤儿会话。
      if (uploadId && ui && ui.onSession) ui.onSession(uploadId);
      function newSession() {
        fresh = true;
        return initSession(file, opt).then(function (info) {
          uploadId = info.uploadId;
          chunk = info.chunkSize || chunk;
          if (ui && ui.onSession) ui.onSession(uploadId);
          saveResume(fp, uploadId);
          return null;
        });
      }
      return (uploadId ? Promise.resolve(null) : newSession())
        .then(function () {
          // 全新会话不必查 status（必然 next=0）：批量时每个文件省一次往返。
          // 复用旧会话 / 失败重试时仍查，用于对齐服务端真实进度。
          if (fresh) return { state: 'uploading', next: 0, received: 0, chunkSize: chunk };
          return getStatus(uploadId);
        })
        .then(function (st) {
          if (st && st.state === 'done') { clearResume(fp); return { done: true }; }
          if (!st) { clearResume(fp); uploadId = null; return newSession().then(function () { return getStatus(uploadId); }); }
          return st;
        })
        .then(function (st) {
          if (st && st.done) return;                 // finish 曾成功，别重传
          if (!st) throw new Error('无法获取上传进度');
          if (isCancelled(ui)) throw cancelErr();
          ui.progress(Math.min(1, (st.received || 0) / (total || 1)));
          return pumpFrom(st).then(function () {
            if (isCancelled(ui)) throw cancelErr();
            return finishSession(uploadId);
          });
        })
        .then(function () { clearResume(fp); });
    }

    function run() {
      if (isCancelled(ui)) return Promise.reject(cancelErr());
      return round().catch(function (e) {
        if (isCancelled(ui)) throw cancelErr();
        attempts++;
        if (attempts > RETRY_MAX) { clearResume(fp); throw e; }
        var wait = Math.min(15000, Math.round(RETRY_BASE_MS * Math.pow(1.5, attempts - 1)));
        ui.waiting('连接中断 · 已保留进度，' + Math.round(wait / 1000) + ' 秒后自动续传');
        return waitRetry(wait, ui).then(run);
      });
    }
    return run();
  }

  function makeQueueItem(name, onRetry, onCancel) {
    var el = document.createElement('div');
    el.className = 'qitem';
    var top = document.createElement('div');
    top.className = 'qtop';
    var nm = document.createElement('div'); nm.className = 'qname'; nm.textContent = name; nm.title = name;
    var pct = document.createElement('div'); pct.className = 'qpct'; pct.textContent = '0%';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'qcancel'; cancelBtn.type = 'button';
    cancelBtn.textContent = '×'; cancelBtn.title = '取消上传';
    cancelBtn.setAttribute('aria-label', '取消上传');
    cancelBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (cancelBtn.disabled) return;
      cancelBtn.disabled = true;
      if (onCancel) onCancel();
    });
    top.appendChild(nm); top.appendChild(pct); top.appendChild(cancelBtn);
    var bar = document.createElement('div'); bar.className = 'bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);
    el.appendChild(top); el.appendChild(bar);
    queueEl.appendChild(el);
    function clearNotes() {
      var m = el.querySelector('.qmsg'); if (m) m.remove();
      var b = el.querySelector('.qretry'); if (b) b.remove();
    }
    return {
      progress: function (v) {
        var p = Math.max(0, Math.min(1, v));
        fill.style.width = (p * 100).toFixed(1) + '%';
        pct.textContent = Math.round(p * 100) + '%';
        clearNotes();   // 续传/重传恢复后清掉等待提示与旧重试按钮
      },
      /* 断线时不判失败、不移除队列项：进度条保留，显示等待自动续传。 */
      waiting: function (msg) {
        el.classList.remove('err');
        var b = el.querySelector('.qretry'); if (b) b.remove();
        var m = el.querySelector('.qmsg');
        if (!m) { m = document.createElement('div'); m.className = 'qmsg'; el.appendChild(m); }
        m.textContent = msg;
        pct.textContent = '等待';
      },
      done: function () {
        cancelBtn.remove();
        pct.textContent = '完成';
        // 批量时完成项同步移除：本地/局域网下几十个文件可能在几百毫秒内
        // 全部传完，任何延时保留都会让它们叠在一起刷屏。完成反馈由汇总条
        // 的「完成 N / N」给出。单文件没有汇总条，保留 1.4 秒看清「完成」。
        if (document.querySelector('.qsum')) { el.remove(); return; }
        setTimeout(function () { if (el.isConnected) el.remove(); }, 1400);
      },
      fail: function (msg) {
        cancelBtn.remove();
        el.classList.add('err');
        pct.textContent = '失败';
        var m = el.querySelector('.qmsg');
        if (!m) { m = document.createElement('div'); m.className = 'qmsg'; el.appendChild(m); }
        m.textContent = msg;
        if (onRetry && !el.querySelector('.qretry')) {
          var btn = document.createElement('button');
          btn.className = 'qretry'; btn.type = 'button'; btn.textContent = '重试';
          btn.addEventListener('click', function () { btn.disabled = true; onRetry(); });
          el.appendChild(btn);
        }
        // 批量时失败信息容易被刷掉：保留 30 秒，汇总条还会留着计数与「重试失败项」
        setTimeout(function () { if (el.isConnected) el.remove(); }, 30000);
      },
      cancelled: function () {
        clearNotes();
        el.classList.remove('err');
        el.classList.add('cancelled');
        cancelBtn.remove();
        pct.textContent = '已取消';
        fill.style.width = '0%';
        setTimeout(function () { if (el.isConnected) el.remove(); }, 1400);
      },
      remove: function () { if (el.isConnected) el.remove(); },
    };
  }

  /* ── 批量上传：全局队列 + 固定并发 + 汇总条 ─────────────────────
     一次拖 50 个文件也只保留 CONCURRENCY 个进行中的进度条；分两批选文件
     不会再各起一组 worker 抢带宽；列表刷新合并成一次，不逐文件全量重绘。 */
  var upQueue = [], upActive = 0, upAll = [];
  var sumEl = null, sumRaf = 0, sumHideTimer = null, refreshTimer = null;

  function scheduleRefresh(immediate) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (immediate) { lastSig = ''; load(); return; }
    refreshTimer = setTimeout(function () { refreshTimer = null; lastSig = ''; load(); }, 400);
  }

  function paintSummary() {
    if (!sumEl) return;
    var total = upAll.length, done = 0, failed = 0, cancelled = 0, bytes = 0, loaded = 0;
    upAll.forEach(function (j) {
      if (j.state === 'cancelled') { cancelled++; return; }  // 取消项不占进度分母
      var sz = j.file.size || 0;
      bytes += sz; loaded += sz * (j.frac || 0);
      if (j.state === 'done') done++;
      else if (j.state === 'fail') failed++;
    });
    var active = upActive > 0 || upQueue.length > 0;
    sumEl.querySelector('.qsum-title').textContent =
      active ? '批量上传' : (failed ? '批量上传 · 有失败项' : '批量上传完成');
    var parts = '完成 ' + done + (failed ? ' · 失败 ' + failed : '') +
      (cancelled ? ' · 已取消 ' + cancelled : '');
    sumEl.querySelector('.qsum-count').textContent = active
      ? ('进行中 ' + (total - done - failed - cancelled) + ' · ' + parts + ' / ' + total)
      : (parts + ' / ' + total);
    sumEl.querySelector('.bar > i').style.width =
      (bytes ? loaded / bytes * 100 : (total ? done / total * 100 : 0)).toFixed(1) + '%';
    sumEl.classList.toggle('msg-err', failed > 0);
    sumEl.classList.toggle('msg-ok', !active && failed === 0);
    var acts = sumEl.querySelector('.qsum-acts');
    acts.hidden = false;
    acts.querySelector('[data-act="cancelAll"]').hidden = !active;
    acts.querySelector('[data-act="retry"]').hidden = !(failed > 0);
    acts.querySelector('[data-act="clear"]').hidden = active;
  }
  function updateSummary() {
    if (sumRaf) return;
    sumRaf = requestAnimationFrame(function () { sumRaf = 0; paintSummary(); });
  }
  function buildSummary() {
    var el = document.createElement('div');
    el.className = 'qsum';
    el.innerHTML = '<div class="qsum-top"><span class="qsum-title">批量上传</span>' +
      '<span class="qsum-count"></span></div><div class="bar"><i></i></div>' +
      '<div class="qsum-acts" hidden><button type="button" data-act="cancelAll">全部取消</button>' +
      '<button type="button" data-act="retry">重试失败项</button>' +
      '<button type="button" data-act="clear">清除</button></div>';
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'retry') retryFailed();
      else if (a === 'cancelAll') cancelAll();
      else clearSummary();
    });
    queueEl.insertBefore(el, queueEl.firstChild);
    return el;
  }
  function clearSummary() {
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    if (sumEl) { sumEl.remove(); sumEl = null; }
    upAll = [];
  }
  /* 取消是终止性的：abort 在途请求、把排队项从队列摘掉、通知服务端释放
     分片会话，并清掉本地续传记录——否则下次重选同一个文件还会从半截续上。 */
  function cancelJob(job) {
    if (!job || job.state === 'done' || job.state === 'fail' || job.state === 'cancelled') return;
    job.state = 'cancelled';
    job.frac = 0;
    if (job.cancelHook) { try { job.cancelHook(); } catch (e) {} job.cancelHook = null; }
    var k = upQueue.indexOf(job);
    if (k >= 0) upQueue.splice(k, 1);
    if (job.uploadId) { cancelSession(job.uploadId); job.uploadId = null; }
    try { clearResume(fpOf(job.file)); } catch (e) {}
    if (job.ui) { job.ui.cancelled(); job.ui = null; }
    updateSummary();
    if (!upQueue.length && upActive === 0) finishBatchIfIdle();
    scheduleRefresh(false);
  }
  function cancelAll() {
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    upQueue.slice().forEach(cancelJob);          // 还在排队、尚未开始的
    upAll.slice().forEach(function (j) { if (j.state === 'doing') cancelJob(j); });
    toast('已取消未完成的上传');
  }
  function requeue(job) {
    if (job.state === 'doing' || upQueue.indexOf(job) >= 0) return;
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    job.state = 'queued'; job.frac = 0;
    if (job.ui) { job.ui.remove(); job.ui = null; }
    upQueue.push(job);
    updateSummary();
    pumpUploads();
  }
  function retryFailed() {
    var failed = upAll.filter(function (j) { return j.state === 'fail'; });
    if (!failed.length) return;
    if (sumHideTimer) { clearTimeout(sumHideTimer); sumHideTimer = null; }
    failed.forEach(function (j) {
      j.state = 'queued'; j.frac = 0;
      if (j.ui) { j.ui.remove(); j.ui = null; }
      upQueue.push(j);
    });
    updateSummary();
    pumpUploads();
  }
  function finishBatchIfIdle() {
    if (upQueue.length || upActive > 0) return;
    scheduleRefresh(true);
    if (sumHideTimer) clearTimeout(sumHideTimer);
    var hasFail = upAll.some(function (j) { return j.state === 'fail'; });
    if (!hasFail) sumHideTimer = setTimeout(clearSummary, 3500);
  }

  function pumpUploads() {
    while (upActive < CONCURRENCY && upQueue.length) {
      (function (job) {
        upActive++; pending++;             // pending = 在途文件数，与轮询刷新判断一致
        job.state = 'doing';
        job.ui = makeQueueItem(job.file.name,
          function () { requeue(job); },
          function () { cancelJob(job); });
        var ui = {
          cancelled: function () { return job.state === 'cancelled'; },
          onCancel: function (fn) { job.cancelHook = fn; },
          onSession: function (id) {
            // init 恰好在取消之后才返回时，别让它变成没人管的孤儿会话
            if (job.state === 'cancelled') { cancelSession(id); return; }
            job.uploadId = id;
          },
          progress: function (v) {
            if (job.state === 'cancelled' || !job.ui) return;
            job.frac = Math.max(0, Math.min(1, v));
            job.ui.progress(job.frac);
            updateSummary();
          },
          waiting: function (m) { if (job.state === 'cancelled' || !job.ui) return; job.ui.waiting(m); },
        };
        uploadFile(job.file, ui, job.opt)
          .then(function (j) {
            if (job.state === 'cancelled') return;
            if (j && j.nameRepaired) toast('文件名包含无法解码的字符，已替换为可读名称');
            job.state = 'done'; job.frac = 1;
            job.ui.done();
            scheduleRefresh(false);
          })
          .catch(function (e) {
            if (job.state === 'cancelled' || (e && e.cancelled)) { job.state = 'cancelled'; return; }
            job.state = 'fail';
            job.ui.fail(e.message || '上传失败');
          })
          .then(function () {
            upActive--; pending--;
            updateSummary();
            pumpUploads();
            finishBatchIfIdle();
          });
      })(upQueue.shift());
    }
    updateSummary();
  }

  function enqueue(files) {
    var list = Array.prototype.slice.call(files).filter(function (f) { return f && typeof f.size === 'number'; });
    if (!list.length) return;
    if (perm.canUpload === false) { toast('当前链接没有上传权限'); return; }
    // 上一轮已收尾（汇总条在倒计时隐藏）→ 开一轮干净的新统计；
    // 上一轮还有失败项时则合并，方便一起点「重试失败项」。
    if (sumHideTimer) {
      clearTimeout(sumHideTimer); sumHideTimer = null;
      upAll = [];
    }
    if (!sumEl) sumEl = buildSummary();
    // 整批共享：这一批所有文件读同一份「时长 + 提取码」快照，
    // 上传途中用户改面板也不会让同批文件设置不一致。
    var opt = uploadOpt();
    list.forEach(function (f) {
      var job = { file: f, state: 'queued', frac: 0, ui: null, opt: opt, cancelHook: null, uploadId: null };
      upAll.push(job);
      upQueue.push(job);
    });
    updateSummary();
    pumpUploads();
  }

  // ── 交互绑定 ───────────────────────────────────────────
  // 存储已满时所有上传入口一律短路返回：入口已禁用 + 文案说明，这里再兜底一层，
  // 绝不发起任何上传请求（服务端仍会拦，但前端不该制造"点了没反应/报 507"的错位感）。
  dropEl.addEventListener('click', function () { if (storageFull) return; fileInput.click(); });
  dropEl.addEventListener('keydown', function (e) {
    if (storageFull) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  $('pickFile').addEventListener('click', function () { if (storageFull) return; fileInput.click(); });
  $('pickMedia').addEventListener('click', function () { if (storageFull) return; mediaInput.click(); });
  fileInput.addEventListener('change', function () { if (storageFull) return; enqueue(fileInput.files); fileInput.value = ''; });
  mediaInput.addEventListener('change', function () { if (storageFull) return; enqueue(mediaInput.files); mediaInput.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) {
      e.preventDefault();
      if (storageFull) return;          // 满了不亮高亮，避免"能放进来"的错觉
      dropEl.classList.add('over');
    });
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (storageFull) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) enqueue(e.dataTransfer.files);
  });
  window.addEventListener('paste', function (e) {
    if (storageFull) return;
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) enqueue(files);
  });

  $('refresh').addEventListener('click', function () { lastSig = ''; load(); });
  $('copyPage').addEventListener('click', function () { copy(withSC(location.href), '本页链接'); });

  $('textToggle').addEventListener('click', function () {
    var pane = $('textPane');
    pane.hidden = !pane.hidden;
    if (!pane.hidden) $('textInput').focus();
  });

  $('textSend').addEventListener('click', function () {
    var ta = $('textInput');
    var text = ta.value;
    if (!text.trim()) { toast('内容为空'); return; }
    var o = uploadOpt();
    fetch(BASE + '/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, h: o.h, pw: o.pw }),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
      .then(function () { ta.value = ''; $('textPane').hidden = true; toast('已生成文字链接'); lastSig = ''; load(); })
      .catch(function (e) { toast(e.message || '失败'); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!viewer.hidden) return closeViewer();
      if (!askModal.hidden) return closeAsk();
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
      navigator.serviceWorker.register(withSC('./sw.js'), { scope: './' })
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

  // 注：嵌入模式的"收起遮罩"信号已在 load() 渲染完成后统一上报（7md:drop-ready），
  // 此处不再提前发，避免内容还没渲染好就收遮罩导致白屏闪。

  // ── 页脚「知行工作室」：不跳出到系统浏览器 ──
  // 嵌在桌面壳里 → 请父窗口（Win98 桌面）用内置的 IE 打开；
  // 独立打开（手机直接访问）→ 跳桌面壳根路径带 ?ie=，由它开内置浏览器。
  var studioLink = $('studioLink');
  if (studioLink) {
    studioLink.addEventListener('click', function (e) {
      e.preventDefault();
      var url = 'https://w3b.pub/';
      var sent = false;
      try {
        if (window.parent && window.parent !== window && window.parent.postMessage) {
          window.parent.postMessage({ type: '7md:open-ie', url: url }, '*');
          sent = true;
        }
      } catch (err) { /* 跨域等异常：走下面的兜底 */ }
      if (!sent) {
        try { location.href = withSC('/?ie=' + encodeURIComponent(url)); } catch (err) { /* 忽略 */ }
      }
    });
  }

  load();
  setInterval(function () {
    // 页面被切到后台时跳过本轮：省流量省电，也少一次无谓的列表渲染。
    // online 事件已负责恢复在线后的立即刷新，不会漏数据。
    if (document.hidden) return;
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
// 缩略图缓存条数上限。只 put 不淘汰会让 THUMB_CACHE 随预览数量无限膨胀
// （每条 Cache-Control 一年、activate 又只按版本名清理旧缓存），
// 长期使用等于白占用户存储。这里做最简 LRU：每条 TTL 一年、
// 先 delete 再 put 保证刚写入的排在枚举尾部，超出上限就删头部最旧的几条。
// 误淘汰的后果仅仅是重新生成一张缩略图，无害。
var THUMB_MAX = 200;
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'thumb' || !d.id || !d.blob) return;
  e.waitUntil(
    caches.open(THUMB_CACHE).then(function (c) {
      var key = '/thumb/' + d.id;
      return c.delete(key).then(function () {
        return c.put(key, new Response(d.blob, {
          headers: { 'Content-Type': d.blob.type || 'image/jpeg', 'Cache-Control': 'max-age=31536000' }
        }));
      }).then(function () {
        return c.keys();
      }).then(function (keys) {
        if (keys.length <= THUMB_MAX) return;
        var stale = keys.slice(0, keys.length - THUMB_MAX);
        return Promise.all(stale.map(function (r) { return c.delete(r); }));
      });
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

  // 应用外壳：cache-first，未命中回源并回填。
  // 与根 SW 同一处坑：页面给静态资源加 ?v= 版本号时，按完整 request 匹配会落空，
  // 离线首启就拿不到 CSS/JS。统一按 pathname 存取，版本号只当缓存破坏器用。
  if (/\\.(css|js|webmanifest|ico|png|svg)$/.test(path) || path.charAt(path.length - 1) === '/') {
    var key = url.pathname;
    e.respondWith(
      caches.match(key).then(function (r) {
        if (r) return r;
        return fetch(req).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(key, copy); });
          }
          return res;
        });
      }).catch(function () { return fetch(req); })
    );
  }
  // 其余（/api/*、/v/*、/d/* 等）：不拦截，直连网络
});
`;
