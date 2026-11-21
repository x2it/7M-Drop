/* ═══════════════ 在线聊天 IM（真实用户 / 单聊 / 群聊）═══════════════
   没有任何预设好友、剧本、自动打字、假在线状态。
     · 好友列表 = 服务端 /api/qq/hello 返回的真实在线用户，一个都不编；
     · 消息全部经服务端收发、带 TTL，过期由服务端 sweep 清除，本地不留假存档；
     · 身份 = 7mdid 设备凭证（服务端签发，每浏览器唯一、不可伪造）；
     · 权限 = 每人只删自己的消息 / 改自己的资料；管理员可全局管理；
     · 界面沿用 Win98 立体控件语言，每个可见控件都对应一个真实行为。
   数据在线：刷新页面后由 /api/qq/poll?since=0 从服务端回补历史。
*/
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function closestEl(el, sel) {
    while (el && el !== document.body) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }
  var LS = 'qq95-';
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(LS + k);
      localStorage.setItem(LS + k, v);
      return v;
    } catch (e) { return null; }
  }

  /* ─────────── 一、视觉素材（像素头像 / 表情，纯样式，非数据）─────────── */
  var AV = {
    A: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    B: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hhssmmssh.', 'hhsssssshh', 'hhhsssshhh', 'hhccccccch', 'hcccccccch', '.cccccccc.'],
    C: ['cccccccccc', 'cccccccccc', 'chhssssshh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    D: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hkkkkkkkkh', 'hkkkkkkkkh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    E: ['..kkkkkk..', '.kk....kk.', 'kk..hh..kk', 'kk..hh..kk', 'kk..hhhhkk', 'kk....hhkk', 'kk......kk', '.kk....kk.', '..kkkkkk..', '..........']
  };
  var PALS = [
    { h: '#2b2b2b', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' },
    { h: '#1a1a1a', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#d88ab0' },
    { h: '#241a12', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' },
    { h: '#d8b23a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#7a4a9a' },
    { h: '#3a2a1a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#2a2a34' }
  ];
  var GROUP_PAL = { h: '#2a2a34', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#a03030' };
  function palOf(id) {
    var n = 0, s = String(id || '');
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return PALS[n % PALS.length];
  }
  var avCache = {};
  function avHtml(who) {
    var pal = who.pal || PALS[0];
    var key = (who.av || 'A') + '|' + pal.h + pal.s + pal.k + pal.m + pal.c;
    if (!avCache[key]) {
      var pat = AV[who.av] || AV.A, r = [];
      for (var y = 0; y < pat.length; y++)
        for (var x = 0; x < pat[y].length; x++) {
          var c = pal[pat[y].charAt(x)];
          if (c) r.push('<rect x="' + (x * 2) + '" y="' + (y * 2) + '" width="2" height="2" fill="' + c + '"/>');
        }
      var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20' shape-rendering='crispEdges'>" + r.join('') + '</svg>';
      avCache[key] = 'data:image/svg+xml;base64,' + btoa(svg);
    }
    return '<img class="qq-avimg" src="' + avCache[key] + '" alt="" aria-hidden="true">';
  }
  var FACES = ['微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
    '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '酷', '冷汗', '抓狂', '吐',
    '偷笑', '愉快', '白眼', '傲慢', '饥饿', '困', '惊恐', '流汗', '憨笑', '奋斗',
    '咒骂', '疑问', '嘘', '晕', '疯了', '衰', '骷髅', '敲打', '再见', '擦汗',
    '抠鼻', '鼓掌', '糗大了', '坏笑', '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈',
    '快哭了', '阴险', '亲亲', '吓', '可怜'];

  /* ─────────── 二、音效（真实事件触发，零文件）─────────── */
  var actx = null;
  function ac() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!actx) actx = new C();
    if (actx.state === 'suspended' && actx.resume) actx.resume();
    return actx;
  }
  function tone(freq, delay, dur, type, vol) {
    var c = ac(); if (!c) return;
    var t = c.currentTime + delay;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    var v = vol * (window.__VOL__ == null ? 0.7 : window.__VOL__) * (window.__MUTED__ ? 0 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function sound(kind) {
    if (!state.sound) return;
    if (kind === 'msg') { tone(988, 0, 0.09, 'square', 0.06); tone(784, 0.11, 0.10, 'square', 0.06); }
    else if (kind === 'send') tone(620, 0, 0.05, 'sine', 0.05);
    else if (kind === 'knock') { tone(300, 0, 0.09, 'triangle', 0.08); tone(240, 0.13, 0.10, 'triangle', 0.08); }
    else if (kind === 'sys') tone(440, 0, 0.06, 'sine', 0.05);
  }
  function syncSound() { $('qqSound').textContent = '音效:' + (state.sound ? '开' : '关'); }
  function toggleSound() {
    state.sound = !state.sound;
    store('sound', state.sound ? '1' : '0');
    syncSound();
    if (state.sound) sound('sys');
  }

  /* ─────────── 三、时间 ─────────── */
  function fmtTime(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function fmtFull(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(t) { var d = new Date(t); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

  /* ─────────── 四、状态（聊天记录只在内存，真源在服务端）─────────── */
  var state = {
    sound: true, cur: null, lastCur: null,
    chats: {}, unread: {}, tab: 'friend', find: '', fold: {},
    started: false, booted: false, online: false,
    me: null, users: [], groups: [], admin: false, seq: 0,
    ttlHours: 24, presenceSec: 45, maxText: 500, purgeArmed: false
  };
  var friends = [];
  var timers = { hello: null, poll: null };
  var lastDay = '';
  function chatRec(id) { if (!state.chats[id]) state.chats[id] = { msgs: [] }; return state.chats[id]; }
  function totalUnread() { var n = 0; for (var k in state.unread) if (state.unread.hasOwnProperty(k)) n += state.unread[k]; return n; }
  function friendById(id) { for (var i = 0; i < friends.length; i++) if (friends[i].id === id) return friends[i]; return null; }
  function shortId(id) { return String(id || '').slice(0, 8).toUpperCase(); }

  /* 服务端真实在线用户 / 真实群 → 面板会话对象；不编造任何人 */
  function syncFriends() {
    var f = [];
    for (var i = 0; i < state.users.length; i++) {
      var u = state.users[i];
      if (u.me) continue;
      f.push({ id: u.id, name: u.name, sign: u.sign || '', av: 'A', pal: palOf(u.id),
               group: '在线用户', on: true, isGroup: false, qq: shortId(u.id), status: u.status });
    }
    for (var j = 0; j < state.groups.length; j++) {
      var g = state.groups[j];
      f.push({ id: 'G' + g.id, gid: g.id, name: g.name, sign: g.members + ' 名成员',
               av: 'D', pal: GROUP_PAL, group: '我的群聊', on: true, isGroup: true,
               qq: shortId(g.id), mine: g.mine, members: g.members });
    }
    friends = f;
  }
  function roomOf(id) {
    var f = friendById(id);
    if (!f || !state.me) return '';
    if (f.isGroup) return 'group:' + f.gid;
    return 'dm:' + [state.me.id, f.id].sort().join(':');
  }
  function convIdOf(room) {
    if (!state.me) return null;
    var d = /^dm:([0-9a-f]{32}):([0-9a-f]{32})$/.exec(room);
    if (d) {
      if (d[1] !== state.me.id && d[2] !== state.me.id) return null;  // 管理员也不读他人私聊
      return d[1] === state.me.id ? d[2] : d[1];
    }
    var g = /^group:([A-Za-z0-9_-]+)$/.exec(room);
    return g ? 'G' + g[1] : null;
  }

  /* ─────────── 五、网络层（HOME_JS 的 withSC 已包装 fetch，凭证自动透传）─────────── */
  function api(path, method, body) {
    var opt = { method: method || 'GET', cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, code: r.status, j: j }; })
        .catch(function () { return { ok: false, code: r.status, j: {} }; });
    });
  }
  function setConn(ok, msg) {
    var was = state.online;
    state.online = ok;
    var t = $('qqTyping');
    if (!ok) { t.hidden = false; $('qqTypingText').textContent = msg || '与服务器断开，正在重试…'; }
    else t.hidden = true;
    renderOnline();
    return was;
  }
  function hello() {
    return api('/api/qq/hello').then(function (r) {
      if (!r.ok || !r.j.ok) { setConn(false, '连接失败，正在重试…'); return; }
      var was = setConn(true);
      state.me = r.j.me; state.users = r.j.users || []; state.groups = r.j.groups || [];
      state.admin = !!r.j.admin;
      state.ttlHours = r.j.ttlHours || 24;
      state.presenceSec = r.j.presenceSec || 45;
      state.maxText = r.j.maxText || 500;
      syncFriends();
      $('qqMyName').textContent = state.me.name;
      $('qqMySign').textContent = state.me.sign || '点击修改个性签名';
      $('qqMyAv').innerHTML = avHtml({ av: 'A', pal: palOf(state.me.id) });
      $('qqState').value = state.me.status || 'online';
      $('qqAdminRow').hidden = !state.admin;
      renderPanel(); renderOnline();
      if (state.cur) { renderChatTitle(); renderChatHead(); renderChatSide(); }
      renderTray(); renderTaskFlash();
      if (!state.booted) {
        state.booted = true;
        poll(true);
        if (!was) hintIfOpen('已连上聊天服务器。消息 ' + state.ttlHours + ' 小时后自动清除。');
      } else if (!was) {
        hintIfOpen('已重新连上聊天服务器。');
      }
    }).catch(function () { setConn(false, '连接失败，正在重试…'); });
  }
  function poll(reset) {
    var since = reset ? 0 : state.seq;
    return api('/api/qq/poll?since=' + since).then(function (r) {
      if (!r.ok || !r.j.ok) return;
      var msgs = r.j.msgs || [], max = state.seq, changed = false;
      for (var i = 0; i < msgs.length; i++) {
        var sm = msgs[i];
        if (sm.seq > max) max = sm.seq;
        var conv = convIdOf(sm.room);
        if (!conv) continue;
        var rec = chatRec(conv);
        var dup = false;
        for (var z = 0; z < rec.msgs.length; z++) if (rec.msgs[z].seq === sm.seq) { dup = true; break; }
        if (dup) continue;
        var mine = state.me && sm.from === state.me.id;
        var m = { seq: sm.seq, w: mine ? 'me' : 'you', who: sm.fromName,
                  text: sm.text, t: sm.at * 1000, owner: sm.owner, room: sm.room };
        rec.msgs.push(m);
        if (rec.msgs.length > 200) rec.msgs.shift();
        changed = true;
        if (state.cur === conv) appendRow(m);
        if (!mine) {
          if (state.cur !== conv) {
            state.unread[conv] = (state.unread[conv] || 0) + 1;
            renderPanel(); renderTray(); renderTaskFlash();
          }
          if (!reset) sound('msg');
        }
      }
      state.seq = Math.max(state.seq, max);
      if (changed && reset && state.cur) renderLog();
    }).catch(function () {});
  }
  function startLoops() {
    stopLoops();
    timers.hello = setInterval(hello, Math.max(5000, Math.floor(state.presenceSec * 1000 / 3)));
    timers.poll = setInterval(function () { if (!document.hidden && state.online) poll(false); }, 2000);
  }
  function stopLoops() {
    if (timers.hello) clearInterval(timers.hello);
    if (timers.poll) clearInterval(timers.poll);
    timers.hello = timers.poll = null;
  }

  /* ─────────── 六、面板渲染 ─────────── */
  var GROUPS = ['在线用户'];
  function matchKw(f, kw) {
    if (!kw) return true;
    return (f.name + ' ' + f.sign + ' ' + (f.qq || '')).toLowerCase().indexOf(kw) >= 0;
  }
  function friendRow(fr) {
    var u = state.unread[fr.id] || 0;
    return '<div class="qq-f' + (state.cur === fr.id ? ' sel' : '') + '" data-f="' + fr.id + '" tabindex="0">' +
      '<span class="qq-f-av">' + avHtml(fr) + '</span>' +
      '<span class="qq-f-main">' +
      '<span class="qq-f-name">' + esc(fr.name) + '</span>' +
      '<span class="qq-f-sign">' + esc(fr.sign) + '</span>' +
      '</span>' +
      (u ? '<span class="qq-badge">' + (u > 99 ? '99+' : u) + '</span>' : '') +
      '</div>';
  }
  function secHtml(key, title, list) {
    var fkey = key + '|' + title;
    var fold = !!state.fold[fkey];
    var html = '<div class="qq-gname' + (fold ? ' fold' : '') + '" data-g="' + esc(fkey) + '" tabindex="0">' +
      '<span class="qq-gtri"></span>' + esc(title) +
      '<span class="qq-gnum">' + list.length + '/' + list.length + '</span></div>';
    if (fold) return html;
    for (var j = 0; j < list.length; j++) html += friendRow(list[j]);
    return html;
  }
  function emptyHtml(kw) {
    if (kw) return '<div class="qq-empty">没有找到「' + esc(state.find) + '」</div>';
    if (!state.online) return '<div class="qq-empty">正在连接聊天服务器…</div>';
    return '<div class="qq-empty">当前只有你在线。把这个页面的链接发给别人，就能一起聊。</div>';
  }
  function renderPanel() {
    var box = $('qqGroups');
    var kw = (state.find || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    var html = '', i, list;
    if (state.tab === 'group') {
      list = friends.filter(function (f) { return f.isGroup && matchKw(f, kw); });
      html = list.length ? secHtml('g', '我的群聊', list) :
        (kw ? emptyHtml(kw) : '<div class="qq-empty">还没有群。主菜单里「新建群聊」，再把在线的人拉进来。</div>');
    } else if (state.tab === 'recent') {
      var rec = [];
      for (i = 0; i < friends.length; i++) {
        var r = chatRec(friends[i].id);
        if (r.msgs.length) rec.push({ f: friends[i], t: r.msgs[r.msgs.length - 1].t });
      }
      rec.sort(function (a, b) { return b.t - a.t; });
      list = rec.map(function (x) { return x.f; }).filter(function (f) { return matchKw(f, kw); });
      html = list.length ? secHtml('r', '最近联系人', list) :
        (kw ? emptyHtml(kw) : '<div class="qq-empty">还没有会话。点一个在线的人开始聊。</div>');
    } else {
      var hit = 0;
      for (i = 0; i < GROUPS.length; i++) {
        list = friends.filter(function (f) { return !f.isGroup && f.group === GROUPS[i] && matchKw(f, kw); });
        if (!list.length && kw) continue;
        hit += list.length;
        html += secHtml('g' + i, GROUPS[i], list);
      }
      if (!hit) html = emptyHtml(kw);
    }
    box.innerHTML = html;
  }
  function renderOnline() {
    var el = $('qqOnline');
    if (!state.started) { el.textContent = '未上线 · 双击 IM 图标连接'; return; }
    if (!state.online) { el.textContent = '连接中断 · 重试中'; return; }
    var n = state.users.length;
    el.textContent = '在线 ' + n + ' 人' + (n <= 1 ? '（只有你）' : '') +
      ' · 消息 ' + state.ttlHours + 'h 后自动清除';
  }

  /* ─────────── 七、会话渲染 ─────────── */
  function scrollLog() { var l = $('qqLog'); l.scrollTop = l.scrollHeight; }
  function rowHtml(m) {
    var me = m.w === 'me';
    var who = me ? (state.me ? state.me.name : '我') : (m.who || '对方');
    var canDel = !!(state.admin || (state.me && m.owner === state.me.id));
    return '<div class="qq-row' + (me ? ' me' : '') + '">' +
      '<div class="qq-bhead"><span class="qq-bwho">' + esc(who) + '</span>' +
      '<span class="qq-btime">' + esc(fmtFull(m.t)) + '</span>' +
      (canDel ? '<button class="btn95 qq-del" data-seq="' + m.seq + '" title="删除这条消息">删</button>' : '') +
      '</div>' +
      '<div class="qq-btxt">' + esc(m.text) + '</div></div>';
  }
  function appendRow(m) {
    var log = $('qqLog');
    var empty = log.querySelector('.qq-empty');
    if (empty) empty.parentNode.removeChild(empty);
    var k = dayKey(m.t);
    if (k !== lastDay) { lastDay = k; log.insertAdjacentHTML('beforeend', '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>'); }
    if (m.w === 'sys') log.insertAdjacentHTML('beforeend', '<div class="qq-sys">' + esc(m.text) + '</div>');
    else log.insertAdjacentHTML('beforeend', rowHtml(m));
    scrollLog();
  }
  function renderLog() {
    var rec = chatRec(state.cur), log = $('qqLog');
    if (!rec.msgs.length) {
      log.innerHTML = '<div class="qq-empty">还没有消息。发出第一句话吧。</div>';
      lastDay = ''; return;
    }
    var html = '', last = '';
    for (var i = 0; i < rec.msgs.length; i++) {
      var m = rec.msgs[i], k = dayKey(m.t);
      if (k !== last) { last = k; html += '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>'; }
      html += m.w === 'sys' ? '<div class="qq-sys">' + esc(m.text) + '</div>' : rowHtml(m);
    }
    log.innerHTML = html; lastDay = last; scrollLog();
  }
  function hint(text) {
    var log = $('qqLog');
    var empty = log.querySelector('.qq-empty');
    if (empty) empty.parentNode.removeChild(empty);
    log.insertAdjacentHTML('beforeend', '<div class="qq-sys">' + esc(text) + '</div>');
    scrollLog();
  }
  function hintIfOpen(text) {
    var w = $('qqChatWin');
    if (w && !w.hidden && state.cur) hint(text);
  }

  /* ─────────── 八、聊天窗 ─────────── */
  function renderChatTitle() {
    var f = friendById(state.cur); if (!f) return;
    $('qqChatTitle').textContent = f.isGroup ? ('群聊：' + f.name) : ('与 ' + f.name + ' 对话');
  }
  function renderChatHead() {
    var f = friendById(state.cur); if (!f) return;
    $('qqChatAv').innerHTML = avHtml(f);
    $('qqChatName').textContent = f.name + '（' + f.qq + '）';
    $('qqChatSign').textContent = f.isGroup ? (f.members + ' 名成员 · 群消息全员可见') : (f.sign || '在线');
  }
  /* 右侧资料栏：真实资料 + 真实操作（邀请在线用户 / 退出或解散群） */
  function renderChatSide() {
    var f = friendById(state.cur), box = $('qqChatSide');
    if (!f) { box.innerHTML = ''; return; }
    var h = '<span class="qq-av">' + avHtml(f) + '</span>' +
      '<div class="qq-ch-sname">' + esc(f.name) + '</div>' +
      '<div class="qq-ch-srow"><b>ID</b> ' + esc(f.qq) + '</div>' +
      '<div class="qq-ch-srow"><b>状态</b> ' + (f.isGroup ? '群聊' : (f.status === 'hidden' ? '隐身' : '在线')) + '</div>';
    if (f.isGroup) {
      h += '<div class="qq-ch-srow"><b>成员</b> ' + f.members + ' 人</div>' +
        '<div class="qq-ch-srow"><b>身份</b> ' +
        (state.admin && !f.mine ? '管理员' : (f.mine ? '群主' : '成员')) + '</div>' +
        '<div class="qq-ch-srow">点名字邀请在线的人：</div>';
      var n = 0;
      for (var i = 0; i < state.users.length; i++) {
        var u = state.users[i];
        if (u.me) continue;
        h += '<div class="qq-f" data-invite="' + u.id + '" tabindex="0"><span class="qq-f-main"><span class="qq-f-name">＋ ' + esc(u.name) + '</span></span></div>';
        n++;
      }
      if (!n) h += '<div class="qq-ch-srow">暂无其他在线用户</div>';
      h += '<div class="qq-ch-srow"><button class="btn95" data-act="leave">' +
        (f.mine || state.admin ? '解散群' : '退出群') + '</button></div>';
    } else {
      h += '<div class="qq-ch-srow"><b>签名</b> ' + esc(f.sign || '—') + '</div>' +
        '<div class="qq-ch-srow">消息 ' + state.ttlHours + ' 小时后自动清除</div>';
    }
    box.innerHTML = h;
  }
  function openChat(id) {
    var f = friendById(id); if (!f) return;
    state.cur = id; state.lastCur = id; state.unread[id] = 0;
    renderPanel(); renderTray(); renderTaskFlash();
    renderChatTitle(); renderChatHead(); renderChatSide();
    W98.openWin($('qqChatWin'));
    renderLog();
    if (!chatRec(id).msgs.length) hint('还没有消息。发出第一句话吧 · ' + state.ttlHours + ' 小时后自动清除。');
  }
  function ensureTray() {
    if ($('qqTray')) return;
    var t = document.createElement('span');
    t.className = 'trayico'; t.id = 'qqTray'; t.title = 'IM 即时通讯';
    t.innerHTML = '<span class="ico ico-qq ico-qq-s"></span>';
    t.addEventListener('click', function () { openPanel(); });
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); trayMenu(e.clientX, e.clientY); });
    $('trayIcons').appendChild(t);
  }
  function openPanel() {
    if (!state.started) {
      state.started = true;
      ensureTray();
      hello().then(startLoops);
    }
    W98.openWin($('qqWin'));
    renderPanel(); renderOnline(); renderTray(); renderTaskFlash();
  }
  function renderTray() {
    var t = $('qqTray'); if (!t) return;
    var n = totalUnread();
    t.classList.toggle('unread', n > 0);
    t.title = n > 0 ? 'IM · ' + n + ' 条未读' : 'IM 即时通讯';
  }
  function renderTaskFlash() {
    var w = $('qqWin'), btn = w && w._taskBtn;
    if (btn) btn.classList.toggle('flash', totalUnread() > 0 && w.hidden);
  }

  /* ─────────── 九、真实行为：发送 / 资料 / 群 / 删除 / 管理 ─────────── */
  function sendMsg() {
    var inp = $('qqIn');
    var text = inp.value.replace(/^\s+|\s+$/g, '');
    if (!text || !state.cur) return;
    var room = roomOf(state.cur);
    if (!room) { hintIfOpen('会话已失效，请刷新在线列表'); return; }
    var btn = $('qqSendBtn'); btn.disabled = true;
    api('/api/qq/say', 'POST', { room: room, text: text }).then(function (r) {
      btn.disabled = false;
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '发送失败，消息未发出'); return; }
      inp.value = '';
      sound('send');
      poll(false);     // 由服务端回显，本地不造消息
    }).catch(function () { btn.disabled = false; hintIfOpen('网络异常，消息未发出'); });
  }
  function inlineEdit(el, onSave) {
    if (el._editing) return;
    el._editing = true;
    var old = el.textContent;
    var inp = document.createElement('input');
    inp.className = 'qq-inp'; inp.value = old;
    inp.setAttribute('aria-label', '编辑');
    el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
    function done(save) {
      if (!el._editing) return;
      el._editing = false;
      var v = inp.value.replace(/^\s+|\s+$/g, '');
      el.textContent = (save && v) ? v : old;
      if (save && v && v !== old) onSave(v);
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', function () { done(true); });
  }
  function setProfile(patch) {
    return api('/api/qq/profile', 'POST', patch).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '修改失败'); return false; }
      return hello();
    });
  }
  function askGroup() {
    hideMenu();
    var box = $('qqGroups');
    if ($('qqNewGroupBox')) return;
    var d = document.createElement('div');
    d.className = 'qq-search'; d.id = 'qqNewGroupBox';
    d.innerHTML = '<input class="qq-inp" id="qqNewGroupIn" placeholder="群名，回车创建" maxlength="24">' +
      '<button class="btn95" id="qqNewGroupOk">创建</button>' +
      '<button class="btn95" id="qqNewGroupNo">取消</button>';
    box.insertBefore(d, box.firstChild);
    var inp = $('qqNewGroupIn'); inp.focus();
    function close() { if (d.parentNode) d.parentNode.removeChild(d); }
    function go() {
      var name = inp.value.replace(/^\s+|\s+$/g, '');
      close();
      api('/api/qq/group', 'POST', { action: 'create', name: name }).then(function (r) {
        if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '建群失败'); return; }
        hello().then(function () {
          // openChat 已给出「还没有消息」提示，这里不再叠一条重复的黄字
          if (r.j.group) openChat('G' + r.j.group.id);
        });
      });
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      else if (e.key === 'Escape') close();
    });
    $('qqNewGroupOk').addEventListener('click', go);
    $('qqNewGroupNo').addEventListener('click', close);
  }
  function invite(id, gid) {
    api('/api/qq/group', 'POST', { action: 'invite', gid: gid, members: [id] }).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '邀请失败'); return; }
      hintIfOpen('已邀请入群。');
      hello();
    });
  }
  function leaveGroup(gid, isOwner) {
    api('/api/qq/group', 'POST', {
      action: (isOwner || state.admin) ? 'dismiss' : 'leave', gid: gid
    }).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '操作失败'); return; }
      state.cur = null;
      W98.closeWin($('qqChatWin'));
      hello();
    });
  }
  function delMsg(seq) {
    api('/api/qq/delete', 'POST', { seq: seq }).then(function (r) {
      if (!r.ok || !r.j.deleted) { hintIfOpen((r.j && r.j.error) || '无权删除该消息'); return; }
      for (var k in state.chats) {
        state.chats[k].msgs = state.chats[k].msgs.filter(function (x) { return x.seq !== seq; });
      }
      if (state.cur) renderLog();
    });
  }
  function adminPurge() {
    var row = $('qqAdminRow');
    if (!state.purgeArmed) {
      state.purgeArmed = true;
      row.textContent = '再点一次确认：清空全部消息';
      setTimeout(function () { state.purgeArmed = false; row.textContent = '管理员：清空全部消息'; }, 6000);
      return;
    }
    state.purgeArmed = false;
    row.textContent = '管理员：清空全部消息';
    api('/api/qq/admin', 'POST', { action: 'purge' }).then(function (r) {
      if (!r.ok || !r.j.ok) { hintIfOpen((r.j && r.j.error) || '清理失败'); return; }
      state.chats = {}; state.seq = 0;
      if (state.cur) renderLog();
      hintIfOpen('已清空 ' + r.j.deleted + ' 条消息。');
      hello();
    });
    hideMenu();
  }

  /* ─────────── 十、菜单 / 表情 / 退出 ─────────── */
  function hideTrayMenu() { var m = $('qqTrayMenu'); if (m) m.parentNode.removeChild(m); }
  function trayMenu(x, y) {
    hideTrayMenu();
    var m = document.createElement('div');
    m.className = 'ctxmenu'; m.id = 'qqTrayMenu';
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - 150)) + 'px';
    m.style.top = Math.max(4, y - 108) + 'px';
    m.innerHTML = '<div class="ctxi" data-a="open">打开面板</div>' +
      '<div class="ctxi" data-a="sound">' + (state.sound ? '关闭音效' : '开启音效') + '</div>' +
      '<div class="ctx-sep"></div><div class="ctxi" data-a="quit">退出 IM</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var it = closestEl(e.target, '.ctxi'); if (!it) return;
      var a = it.getAttribute('data-a'); hideTrayMenu();
      if (a === 'open') openPanel();
      else if (a === 'sound') toggleSound();
      else if (a === 'quit') quitQQ();
    });
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideTrayMenu(); document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function hideMenu() { $('qqMenu').hidden = true; }
  function toggleMenu() {
    var m = $('qqMenu');
    m.hidden = !m.hidden;
    if (m.hidden) return;
    var b = $('qqMenuBtn').getBoundingClientRect();
    var w = $('qqWin').getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(b.left - w.left, w.width - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, b.top - w.top - m.offsetHeight - 4) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideMenu(); document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function hideFace() { var b = $('qqFaceBox'); if (b) b.parentNode.removeChild(b); }
  function showFace(btn) {
    hideFace();
    var box = document.createElement('div');
    box.className = 'qq-face'; box.id = 'qqFaceBox';
    var html = '';
    for (var i = 0; i < FACES.length; i++) html += '<span class="qq-face-i" data-f="' + esc(FACES[i]) + '">' + esc(FACES[i]) + '</span>';
    box.innerHTML = html;
    box.addEventListener('click', function (ev) {
      var it = closestEl(ev.target, '.qq-face-i'); if (!it) return;
      $('qqIn').value += '/' + it.getAttribute('data-f') + ' ';
      $('qqIn').focus(); hideFace();
    });
    document.body.appendChild(box);
    var r = btn.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 184)) + 'px';
    box.style.top = Math.max(4, r.top - 150) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideFace(); document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function quitQQ() {
    stopLoops();
    state.started = false; state.booted = false; state.online = false;
    state.seq = 0; state.me = null; state.users = []; state.groups = []; state.admin = false;
    state.cur = null; state.unread = {}; state.chats = {};
    friends = [];
    var t = $('qqTray'); if (t) t.parentNode.removeChild(t);
    $('qqTyping').hidden = true;
    W98.closeWin($('qqWin')); W98.closeWin($('qqChatWin'));
    renderPanel(); renderOnline(); renderTaskFlash();
  }
  /* ─────────── 十一、初始化 ─────────── */
  function init() {
    state.sound = store('sound') !== '0';
    syncSound();
    $('qqMyAv').innerHTML = avHtml({ av: 'A', pal: PALS[0] });
    $('qqTabIcoF').innerHTML = avHtml({ av: 'A', pal: PALS[0] });
    $('qqTabIcoG').innerHTML = avHtml({ av: 'D', pal: GROUP_PAL });
    $('qqTabIcoR').innerHTML = avHtml({ av: 'E', pal: { k: '#2b6ea8', h: '#2b6ea8', s: '#f2c89b', m: '#a05050', c: '#3a6ea5' } });
    renderOnline(); renderPanel();

    $('qqSound').addEventListener('click', toggleSound);
    $('qqState').addEventListener('change', function () {
      var v = $('qqState').value;
      setProfile({ status: v }).then(function () {
        hintIfOpen(v === 'hidden' ? '已隐身：别人的在线列表里看不到你，管理员仍可见。' : '已上线：别人能看到你在线。');
      });
    });
    $('qqMyName').addEventListener('click', function () {
      inlineEdit(this, function (v) { setProfile({ name: v }); });
    });
    $('qqMySign').addEventListener('click', function () {
      inlineEdit(this, function (v) { setProfile({ sign: v }); });
    });
    $('qqGroups').addEventListener('click', function (e) {
      var g = closestEl(e.target, '.qq-gname');
      if (g) { var k = g.getAttribute('data-g'); state.fold[k] = !state.fold[k]; renderPanel(); return; }
      var row = closestEl(e.target, '.qq-f');
      if (row && !row.getAttribute('data-invite')) openChat(row.getAttribute('data-f'));
    });
    $('qqTabs').addEventListener('click', function (e) {
      var tab = closestEl(e.target, '.qq-tab'); if (!tab) return;
      state.tab = tab.getAttribute('data-tab');
      var kids = $('qqTabs').children;
      for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('on', kids[i] === tab);
      renderPanel();
    });
    $('qqFind').addEventListener('input', function () { state.find = $('qqFind').value; renderPanel(); });

    $('qqMenuBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
    $('qqMenu').addEventListener('click', function (e) { e.stopPropagation(); });
    $('qqQuitRow').addEventListener('click', function () { hideMenu(); quitQQ(); });
    $('qqNewGroupRow').addEventListener('click', askGroup);
    $('qqProfileRow').addEventListener('click', function () {
      hideMenu(); inlineEdit($('qqMyName'), function (v) { setProfile({ name: v }); });
    });
    $('qqRefreshRow').addEventListener('click', function () {
      hideMenu(); hello(); hintIfOpen('已刷新在线列表。');
    });
    $('qqAdminRow').addEventListener('click', adminPurge);

    $('qqFontBtn').addEventListener('click', function () {
      var big = $('qqLog').classList.toggle('big');
      this.classList.toggle('on', big);
    });
    $('qqFaceBtn').addEventListener('click', function (e) { e.stopPropagation(); showFace(this); });
    $('qqCloseBtn').addEventListener('click', function () { W98.closeWin($('qqChatWin')); });
    $('qqSendBtn').addEventListener('click', sendMsg);
    $('qqIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMsg(); }
    });
    /* 消息行「删」：本人删自己的，管理员删任意 */
    $('qqLog').addEventListener('click', function (e) {
      var b = closestEl(e.target, '.qq-del');
      if (b) delMsg(Number(b.getAttribute('data-seq')));
    });
    /* 群资料栏：邀请 / 退出或解散 */
    $('qqChatSide').addEventListener('click', function (e) {
      var inv = closestEl(e.target, '.qq-f[data-invite]');
      if (inv) {
        var f = friendById(state.cur);
        if (f && f.isGroup) invite(inv.getAttribute('data-invite'), f.gid);
        return;
      }
      var act = closestEl(e.target, '[data-act="leave"]');
      if (act) {
        var g = friendById(state.cur);
        if (g && g.isGroup) leaveGroup(g.gid, g.mine || state.admin);
      }
    });
  }
  init();

  /* 给 HOME_JS 的钩子用：openApp / closeWin / tickClock / fillSys / 任务栏按钮 */
  window.QQ = {
    openPanel: openPanel,
    /* 关闭聊天窗不再停轮询：真实聊天必须持续收消息，否则会漏信。
       保留这个空接口只为兼容桌面 closeWin 钩子。 */
    stopPlay: function () {},
    syncFlash: renderTaskFlash
  };
})();
