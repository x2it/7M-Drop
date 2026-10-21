/* ═══════════════ 复古 QQ（仿 2008）· 数据 + 模块 ═══════════════
   第一原则（用户明确要求）：无假功能、无假数据、真实仿真。
   这里发生的每一件事都是真的：
     · 自动播放 = 真的逐字修改输入框 value、真的派发 input 事件、
       真的让发送按钮获得焦点并真的 click，消息真的进对话流；
     · 未读数 / 正在输入 / 头像灰掉 / 托盘与任务栏闪动 / 时间戳，
       全部由真实事件与真实时钟驱动，没有任何写死的装饰性数字；
     · 用户一旦真的打字或点发送，自动播放立即暂停并明说，
       用户发的消息真实入流，对方按剧本或兜底台词真实回复。
   年代穿越：era 为空 = 真实日期；选了年份后，任务栏时钟、系统属性、
   MS-DOS 的 date、本模块所有时间戳，统一按「当年今日的此刻」计算。
   真实文件的修改时间来自服务端 index.json，不参与伪造。

   ── 想自己加好玩的对话？改下面的 PRESETS 就行 ──
   script 是有序剧本：{ me: '我说的' } 与 { f: '对方说的' }（群聊用
   { g: '说话人', t: '内容' }）交替；fallback 是接不上时的兜底回复；
   k 挂在对方台词上，表示「用户输入含这些关键词就算接上剧本」。 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function closestEl(el, sel) {
    while (el && el !== document.body) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /* ─────────── 一、预设数据（自定义入口） ─────────── */
  var AV = {
    A: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    B: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hseksseksh', 'hhssmmssh.', 'hhsssssshh', 'hhhsssshhh', 'hhccccccch', 'hcccccccch', '.cccccccc.'],
    C: ['cccccccccc', 'cccccccccc', 'chhssssshh', 'hseksseksh', 'hssssssssh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    D: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hkkkkkkkkh', 'hkkkkkkkkh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc']
  };

  var PRESETS = {
    me: {
      name: '7喵',
      sign: '涐喟蕩漾，涐恠攵芾裡等哪囙兲。',
      av: 'A',
      pal: { h: '#2b2b2b', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' }
    },
    friends: [
      {
        name: '╰☆葬爱家族★冷少╮', sign: '家族不倒，葬爱到老。', group: '家族', era: 2005, on: true,
        av: 'D', pal: { h: '#3a2a1a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#2a2a34' },
        script: [
          { f: '在吗？家族今晚还聚会吗，别跟我说你又忘了。' },
          { me: '没忘。老地方，网吧二楼包间，八点是吧' },
          { f: '嗯。今晚有正事：新族规下来了，统一换火星文头像。' },
          { me: '……我头像上周刚换，怎么又换' },
          { f: '审美要跟上。你那杀马特刘海过时了，现在流行离子烫。' },
          { me: '离子烫多少钱' },
          { f: '网吧楼下阿强那儿三十块，报我名字送定型啫喱。' },
          { me: '行，下班我去烫一个' },
          { f: '对了，你空间日志今天访问量破三百了，评论区全在问背景音乐。' },
          { me: '那首飞向别人的床？' },
          { f: '换爱情买卖吧，现在全场都在放，不换就 out 了。', k: ['爱情买卖', '换'] },
          { me: '明天还要上课，先撤了' },
          { f: '去吧。族谱给你留了一页，周日晚记得来签到。' }
        ],
        fallback: ['呵呵，你说什么呢。', '家族的事，你不懂。', '先去洗个头，再说正事。', '嗯嗯，然后呢？', '这话咱线下聊，群里不方便。']
      },
      {
        name: '埖落灬晓', sign: '涐媞埖落灬晓，请不要再 call 涐。', group: '我的好友', era: 2008, on: true,
        av: 'B', pal: { h: '#1a1a1a', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#d88ab0' },
        script: [
          { f: '在吗？你看了我昨晚发的那篇日志没有。' },
          { me: '看了，就是那篇深夜请允许我最后一次堕落' },
          { f: '嗯。你说，人为什么长大以后，快乐就变得这么难。' },
          { me: '别想太多，早点睡' },
          { f: '睡不着的。一闭眼全是以前的事。你说喜欢的人最后怎么都变成了过客。' },
          { me: '会变才正常啊，我也变了很多' },
          { f: '你变得会安慰人了。以前的你，只会回一串省略号。' },
          { me: '那不是不知道怎么回嘛' },
          { f: '没关系。谢谢你今天愿意听我说这些。' },
          { me: '小事。明天你空间留言，我第一个去踩' },
          { f: '说定了。你要第一个来，还要带一朵玫瑰。', k: ['玫瑰', '第一个', '留言'] },
          { me: '带带带，玫瑰管够' },
          { f: '晚安，7喵。今天谢谢你。' }
        ],
        fallback: ['嗯……然后呢。', '你是不是也有心事。', '大人的世界，就这样吧。', '我不想懂，真的。']
      },
      {
        name: '回忆ㄨ童年', sign: '让我们回到那时的童年。', group: '老同学', era: 2003, on: true,
        av: 'A', pal: { h: '#241a12', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a6ea5' },
        script: [
          { f: '在吗？同学录我做好了，刚给你寄了一张。' },
          { me: '收到了！还是那种带香味的纸' },
          { f: '嗯，我挑了挺久。你填的最喜欢的明星是周杰伦？' },
          { me: '对啊，叶惠美那张专辑我天天听' },
          { f: '我写的是最大的愿望：考上重点高中。你说我们能考上吗。' },
          { me: '肯定能，你成绩那么好' },
          { f: '借你吉气。对了，毕业册上你给我写的留言，我看了三遍。' },
          { me: '写的什么还记得吗' },
          { f: '愿你永远像现在这样笑。就这一句，我记到现在。', k: ['笑', '愿你'] },
          { me: '那你现在还会那样笑吗' },
          { f: '会啊。只要你别忘了周末回同学录就行。' },
          { me: '忘不了。周末老地方，学校后门小卖部见' },
          { f: '好，我带新买的复读机，我们听晴天。' }
        ],
        fallback: ['呵呵，跟小时候一样。', '这事我记得，你再想想。', '周末见，不许爽约。', '同学录你填了吗？']
      },
      {
        name: '℡尐爺', sign: '尐爺涐兂所谓，呮媞涐恠迗崾郅溔糀。', group: '我的好友', era: 2008, on: false,
        av: 'C', pal: { h: '#d8b23a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#7a4a9a' },
        script: [
          { f: '涐看沵最近都不上线，是把涐忘了？' },
          { me: '没有，最近天天加班' },
          { f: '加班有加班费吗？我们网吧周末活动，包夜四十还送泡面。' },
          { me: '这么便宜，网速稳不稳' },
          { f: '电信三兆，劲舞团不卡。上次你那套连击还是我教的。' },
          { me: '那是我天赋好不好' },
          { f: '是手熟。周六夜机我给你留包厢，来不来？' },
          { me: '来，我带一个同学' },
          { f: '行，人多不好分机子，一个刚刚好。' },
          { me: '你最近还玩炫舞吗' },
          { f: '玩啊，涐的舞团今晚有活动，你要不要来蹭个连击？' },
          { me: '不了，我手残' },
          { f: '不存在的，我带你就说定在一起，主要手要快。' }
        ],
        fallback: ['芣袸炷，莪帶沵。', '你说你的，我听着呢。', '这事就这么定了。', '尐爷我无所谓。']
      },
      {
        name: '网吧网管小李', sign: '机子有问题请举手，我在吧台。', group: '网友', era: 2005, on: true,
        av: 'A', pal: { h: '#1a1a1a', s: '#e8bd8f', k: '#1a1a1a', m: '#8a5050', c: '#5a5a5a' },
        script: [
          { f: '在吗？三楼七号机耳机又没声音了，我过去看看。' },
          { me: '我在三号机，这边也接触不良' },
          { f: '老毛病，二楼那排机子都三四年了，将就用。' },
          { me: '昨晚是不是又有人通宵砍传奇' },
          { f: '可不是，打到早上六点，非说爆了屠龙，半个网吧都去围观。' },
          { me: '真爆了？' },
          { f: '爆个屁，是盗号的钓鱼。现在的骗子专盯中学生。' },
          { me: '那你多在群里提醒一下' },
          { f: '我每小时滚一次字幕：凡是要账号的都是骗子。听不听随他们。' },
          { me: '辛苦了李哥' },
          { f: '对了，你上周落在吧台的 U 盘我收着，明天来拿。' },
          { me: '谢了，明天补你一瓶可乐' },
          { f: '可乐就不用了，下次包夜给你算内部价。' }
        ],
        fallback: ['我在吧台，喊我一声。', '机子的事好说。', '现在的孩子，防骗意识得加强。', '知道了，我处理。']
      },
      {
        name: '毒鸡汤bot', sign: '今天也没有努力呢，真好。', group: '我的好友', era: 2012, on: true,
        av: 'C', pal: { h: '#d8b23a', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#3a8a5a' },
        script: [
          { f: '朋友，你又打开手机了。说好的学习呢？' },
          { me: '我就歇五分钟' },
          { f: '五分钟前你也是这么说的。拖延是会上瘾的，年轻人。' },
          { me: '……你怎么知道' },
          { f: '我知道的还有很多。比如你现在正躺着，而且电量不到百分之二十。' },
          { me: '这你都能猜到' },
          { f: '因为五年前的你，也是这样一年一年熬过来的。喝口鸡汤：努力不一定会成功，但不努力一定很舒服。' },
          { me: '这汤有毒' },
          { f: '毒就对了，苦口良药。你上个月立的 flag 叫什么来着，早睡？' },
          { me: '别揭短' },
          { f: '好，说点正经的：你真正想做的事，今天做了一分钟没有？' },
          { me: '做了一点' },
          { f: '那就行。一天一分钟，一年也是六个多小时。' },
          { me: '你这算法是毒鸡汤门派的吧' },
          { f: '谢谢夸奖。明天记得再来，我每天都在。' }
        ],
        fallback: ['嗯，我听着。', '这碗汤你必须喝。', '别狡辩，我见得多了。', '明天会更好——大概吧。', '你努力的样子，连你自己都骗。']
      },
      {
        name: '家族群·葬爱基地', sign: '葬爱家族总部，进来就是一家人。', group: '群组', era: 2008, on: true,
        members: ['家族管理·龙少', '葬爱家族·冷少', 'QQ炫舞家族·公主', '网吧网管小李', '℡尐爺'],
        av: 'D', pal: { h: '#2a2a34', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#a03030' },
        script: [
          { g: '家族管理·龙少', t: '今晚八点，家族全员火星文头像检查，别给我掉链子。' },
          { g: '葬爱家族·冷少', t: '收到，我挨个通知。' },
          { g: 'QQ炫舞家族·公主', t: '我刚换了新头像，「埖仺兲悾」，大家看看标不标准。' },
          { g: '家族管理·龙少', t: '标准。公主这审美，家族门面担当。' },
          { g: '网吧网管小李', t: '提醒一句：群里那个「家族秘书」加好友要礼物的，是骗子，别转钱。' },
          { g: '葬爱家族·冷少', t: '对，上周已经有人被骗 Q 币了。要礼物的直接踢。' },
          { g: '℡尐爺', t: '尐爷已经无所谓，请看我的新签名。' },
          { g: '家族管理·龙少', t: '尐爺你先把字打对，签名是给别人看的。' },
          { g: '℡尐爺', t: '你懂什么，这叫风格。' },
          { me: '刚下班，今晚聚会我准时到' },
          { g: '葬爱家族·冷少', t: '来了就好。老规矩，迟到罚一瓶可乐。' },
          { g: 'QQ炫舞家族·公主', t: '我带舞团的姐妹来围观，可以吗龙少。' },
          { g: '家族管理·龙少', t: '欢迎。人多热闹，但别刷屏，群邮件我还要看。' }
        ],
        fallback: ['收到。', '龙少说得对。', '＋1', '哈哈哈哈', '葬爱基地，永不言败。']
      },
      {
        name: 'QQ炫舞家族·公主', sign: '舞团招新，会连击的来。', group: '家族', era: 2008, on: false,
        av: 'B', pal: { h: '#6b3f1d', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#c03030' },
        script: [
          { f: '在吗？舞团周末有活动，来不来凑个人头。' },
          { me: '什么活动' },
          { f: '家族联谊赛，双人舞。我跟人组一队，你来当第二队。' },
          { me: '我手残，连击最高才 89' },
          { f: '89 可以了，我们舞团平均才 60。你来了就是主力。' },
          { me: '你这主力标准真低' },
          { f: '要求不高，会按空格就行。来了姐教你卡拍子。' },
          { me: '卡拍子是什么' },
          { f: '节奏到点前 0.1 秒按下去，判定直接 perfect。这个要练。' },
          { me: '听起来好玄学' },
          { f: '比玄学多一点，是肌肉记忆。周末来，我开个小房间单独教你。' },
          { me: '行，周末见' },
          { f: '对了，你游戏名还是 7喵 吗？我给你在舞团群挂个名。' }
        ],
        fallback: ['来嘛，就差你了。', '姐带你，怕什么。', 'perfect 的感觉，试过一次就上瘾。', '周末别忘了。']
      },
      {
        name: '老同学群·初三(2)班', sign: '常回群看看，同学录还在。', group: '群组', era: 2003, on: false,
        members: ['班主任·王老师', '回忆ㄨ童年', '前排学霸', '后排睡神'],
        av: 'A', pal: { h: '#241a12', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#4a7a3a' },
        script: [
          { g: '班主任·王老师', t: '同学们，下周三下午同学会，能来的在群里接个龙。' },
          { g: '回忆ㄨ童年', t: '王老师好，我来！' },
          { g: '前排学霸', t: '我来。正好带相机，给大家拍照。' },
          { g: '后排睡神', t: '我……我尽量。那天要上班。' },
          { g: '班主任·王老师', t: '上班也来坐坐，二十年聚会不容易。' },
          { g: '前排学霸', t: '老师，您当年说「你们是我带过最差的一届」，还算数吗。' },
          { g: '班主任·王老师', t: '我说的是最差，但也最舍不得。你们都长大了。' },
          { g: '后排睡神', t: '老师您这话一说，我眼睛有点酸。' },
          { me: '老师，我一定到。我带瓜子。' },
          { g: '回忆ㄨ童年', t: '7喵 你来就热闹了，还是当年那个捣蛋鬼。' },
          { g: '班主任·王老师', t: '好，那就周三。地址我单独发你们，别忘了。' },
          { g: '前排学霸', t: '建议按当年的座位坐，王老师还坐讲台边。' },
          { g: '后排睡神', t: '同意！我再睡一次，就一次。' }
        ],
        fallback: ['王老师说得对。', '＋1', '必须来。', '青春啊。']
      }
    ]
  };

  /* ─────────── 二、状态与持久化 ─────────── */
  var LS = 'qq95-';
  var ERAS = ['2003', '2005', '2008', '2012'];
  var friends = [];
  var state = {
    era: '',            // '' = 真实日期；否则为穿越年份
    sound: true,
    status: 'online',   // online | hidden（隐身：暂停派发新消息）
    cur: null,          // 当前打开的好友 id
    chats: {},          // id -> { pos, msgs: [{w,who,text,t}] }
    unread: {},         // id -> 未读数（真实收到且没看过的）
    presence: {},       // id -> 是否在线（头像/计数/派发候选都用真值）
    playing: false,
    stepping: false,
    macroSend: false,   // 宏即将真实点击发送（发送路径据此区分来源）
    partial: null,      // 暂停时保留的半截输入 { text, i }
    started: false      // QQ 是否已启动（决定托盘图标与来信派发）
  };
  /* 两个定时器池：宏（播放）暂停只清自己的，不能把环境定时器
     （来信派发 / 在线状态 / 二次确认）一起杀死 */
  var macroTimers = [];
  var ambientTimers = [];
  var lastDay = '';

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(LS + k);
      localStorage.setItem(LS + k, v);
      return v;
    } catch (e) { return null; }
  }
  function after(ms, fn) { var t = setTimeout(fn, ms); macroTimers.push(t); return t; }
  function ambAfter(ms, fn) { var t = setTimeout(fn, ms); ambientTimers.push(t); return t; }
  function clearMacroTimers() { for (var i = 0; i < macroTimers.length; i++) clearTimeout(macroTimers[i]); macroTimers = []; }

  function chatRec(id) {
    if (!state.chats[id]) {
      var rec = { pos: 0, msgs: [] };
      var raw = store('chat-' + id);
      if (raw) {
        try {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') {
            rec.pos = o.pos || 0;
            rec.msgs = Array.isArray(o.msgs) ? o.msgs : [];
          }
        } catch (e) { /* 损坏的记录当作空记录，不假装有数据 */ }
      }
      state.chats[id] = rec;
    }
    return state.chats[id];
  }
  function saveChat(id) {
    var rec = state.chats[id];
    if (rec) store('chat-' + id, JSON.stringify({ pos: rec.pos, msgs: rec.msgs.slice(-120) }));
  }
  function saveUnread() { store('unread', JSON.stringify(state.unread)); }
  function friendById(id) {
    for (var i = 0; i < friends.length; i++) if (friends[i].id === id) return friends[i];
    return null;
  }
  function totalUnread() {
    var n = 0;
    for (var k in state.unread) if (state.unread.hasOwnProperty(k)) n += state.unread[k];
    return n;
  }

  /* ─────────── 三、时间（真实时钟 / 年代穿越同源） ─────────── */
  function eraDate() {
    var d = new Date();
    if (!state.era) return d;
    var y = parseInt(state.era, 10);
    var e = new Date(y, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    if (e.getMonth() !== d.getMonth()) {
      /* 2 月 29 日在非闰年年份会滚到 3 月 1 日，夹回 2 月 28 日 */
      e = new Date(y, d.getMonth(), 28, d.getHours(), d.getMinutes(), d.getSeconds());
    }
    return e;
  }
  function now() { return eraDate().getTime(); }
  function fmtTime(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(t) { var d = new Date(t); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

  /* ─────────── 四、头像像素画 ─────────── */
  function shadowOf(pat, pal) {
    var out = [];
    for (var y = 0; y < pat.length; y++) {
      for (var x = 0; x < pat[y].length; x++) {
        var c = pal[pat[y].charAt(x)];
        if (c) out.push((x * 2) + 'px ' + (y * 2) + 'px 0 ' + c);
      }
    }
    return out.join(',');
  }
  function avHtml(who) {
    return '<i class="qq-avpx" style="box-shadow:' + shadowOf(AV[who.av] || AV.A, who.pal) + '"></i>';
  }

  /* ─────────── 五、音效（Web Audio 合成，零文件零依赖） ─────────── */
  /* CSP 的 media-src 'self' 不允许 data: 音频，只能用 OscillatorNode 现场合成。
     经典 QQ 消息音「滴滴」、发送轻响、好友上线敲门声，全部由真实事件触发。 */
  var actx = null;
  function ac() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!actx) actx = new C();
    if (actx.state === 'suspended' && actx.resume) actx.resume();
    return actx;
  }
  function tone(freq, delay, dur, type, vol) {
    var c = ac();
    if (!c) return;
    var t = c.currentTime + delay;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function sound(kind) {
    if (!state.sound) return;
    if (kind === 'msg') { tone(988, 0, 0.09, 'square', 0.06); tone(784, 0.11, 0.10, 'square', 0.06); }
    else if (kind === 'send') { tone(620, 0, 0.05, 'sine', 0.05); }
    else if (kind === 'knock') { tone(300, 0, 0.09, 'triangle', 0.08); tone(240, 0.13, 0.10, 'triangle', 0.08); }
    else if (kind === 'sys') { tone(440, 0, 0.06, 'sine', 0.05); }
  }
  function syncSound() { $('qqSound').textContent = '音效:' + (state.sound ? '开' : '关'); }
  function toggleSound() {
    state.sound = !state.sound;
    store('sound', state.sound ? '1' : '0');
    syncSound();
    if (state.sound) sound('sys');
  }

  /* ─────────── 六、面板渲染 ─────────── */
  function renderPanel() {
    var box = $('qqGroups');
    var order = [], byGroup = {};
    for (var i = 0; i < friends.length; i++) {
      var f = friends[i];
      if (!byGroup[f.group]) { byGroup[f.group] = []; order.push(f.group); }
      byGroup[f.group].push(f);
    }
    var html = '';
    for (var g = 0; g < order.length; g++) {
      html += '<div class="qq-gname">' + esc(order[g]) + '</div>';
      var list = byGroup[order[g]];
      for (var j = 0; j < list.length; j++) {
        var fr = list[j];
        var u = state.unread[fr.id] || 0;
        var on = state.presence[fr.id] !== false;
        html += '<div class="qq-f' + (on ? '' : ' off') + (state.cur === fr.id ? ' sel' : '') + '" data-f="' + fr.id + '" tabindex="0">' +
          '<span class="qq-f-av">' + avHtml(fr) + '</span>' +
          '<span class="qq-f-main">' +
          '<span class="qq-f-name">' + esc(fr.name) + '<i class="qq-f-era"> · ' + fr.era + '</i></span>' +
          '<span class="qq-f-sign">' + esc(fr.sign) + '</span>' +
          '</span>' +
          (u ? '<span class="qq-badge">' + (u > 99 ? '99+' : u) + '</span>' : '') +
          '</div>';
      }
    }
    box.innerHTML = html;
  }
  function renderOnline() {
    var n = 0;
    for (var i = 0; i < friends.length; i++) if (state.presence[friends[i].id] !== false) n++;
    $('qqOnline').textContent = state.status === 'hidden'
      ? '已隐身 · 暂停收新消息（在线 ' + n + ' 人）'
      : '在线 ' + n + ' 人';
  }

  /* ─────────── 七、会话渲染 ─────────── */
  function scrollLog() { var l = $('qqLog'); l.scrollTop = l.scrollHeight; }
  function rowHtml(m) {
    var f = friendById(state.cur);
    var me = m.w === 'me';
    var av = me ? avHtml(PRESETS.me) : avHtml(f);
    var who = (!me && f && f.group === '群组') ? '<span class="qq-bwho">' + esc(m.who) + '</span>' : '';
    return '<div class="qq-row' + (me ? ' me' : '') + '">' +
      '<span class="qq-msg-av">' + av + '</span>' +
      '<span class="qq-bwrap">' + who +
      '<span class="qq-bubble">' + esc(m.text) + '</span>' +
      '<span class="qq-btime">' + esc(fmtTime(m.t)) + '</span></span></div>';
  }
  function appendRow(m) {
    var log = $('qqLog');
    var empty = log.querySelector('.qq-empty');
    if (empty) empty.parentNode.removeChild(empty);
    var k = dayKey(m.t);
    if (k !== lastDay) {
      lastDay = k;
      log.insertAdjacentHTML('beforeend', '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>');
    }
    if (m.w === 'sys') log.insertAdjacentHTML('beforeend', '<div class="qq-sys">' + esc(m.text) + '</div>');
    else log.insertAdjacentHTML('beforeend', rowHtml(m));
    scrollLog();
  }
  function renderLog() {
    var rec = chatRec(state.cur);
    var log = $('qqLog');
    if (!rec.msgs.length) {
      log.innerHTML = '<div class="qq-empty">还没有聊天记录。点 ▶ 播放，或自己说点什么。</div>';
      lastDay = '';
      return;
    }
    var html = '', last = '';
    for (var i = 0; i < rec.msgs.length; i++) {
      var m = rec.msgs[i];
      var k = dayKey(m.t);
      if (k !== last) { last = k; html += '<div class="qq-sep">—— ' + esc(dayLabel(m.t)) + ' ——</div>'; }
      html += m.w === 'sys' ? '<div class="qq-sys">' + esc(m.text) + '</div>' : rowHtml(m);
    }
    log.innerHTML = html;
    lastDay = last;
    scrollLog();
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
  function showTyping(on) { $('qqTyping').hidden = !on; }

  /* ─────────── 八、消息流转 ─────────── */
  function pushMsg(id, msg) {
    var rec = chatRec(id);
    rec.msgs.push(msg);
    saveChat(id);
    if (state.cur === id) appendRow(msg);
  }
  function deliver(f, entry) {
    var msg = entry.g !== undefined
      ? { w: 'g', who: entry.g, text: entry.t, t: now() }
      : { w: 'you', text: entry.f, t: now() };
    pushMsg(f.id, msg);
    if (state.cur === f.id) {
      scrollLog();
    } else {
      state.unread[f.id] = (state.unread[f.id] || 0) + 1;
      saveUnread();
      renderPanel();
      renderTray();
      renderTaskFlash();
    }
  }
  /* 找到下一条对方台词（群/单人通用） */
  function nextFriendEntry(f) {
    var rec = chatRec(f.id);
    for (var i = rec.pos; i < f.script.length; i++) {
      if (f.script[i].f !== undefined || f.script[i].g !== undefined) return { entry: f.script[i], i: i };
    }
    return null;
  }

  /* ─────────── 九、自动播放宏（真实逐字输入 + 真实点击发送） ─────────── */
  function macroOn() { return state.playing || state.stepping; }
  function syncCtrl() {
    $('qqPlayBtn').disabled = state.playing;
    $('qqPauseBtn').disabled = !state.playing;
    $('qqStepBtn').disabled = state.playing;
  }
  function play() {
    if (state.playing) return;
    if (!state.cur) return;
    var f = friendById(state.cur);
    if (chatRec(f.id).pos >= f.script.length) {
      hint('这部剧已经播完了。可以 ↺ 重播，或自己接着说。');
      return;
    }
    state.playing = true;
    syncCtrl();
    playNext();
  }
  function pause(byUser) {
    if (!state.playing && !state.stepping) return;
    state.playing = false;
    state.stepping = false;
    clearMacroTimers();
    showTyping(false);
    syncCtrl();
    if (byUser) hint('已暂停自动播放 —— 你可以直接输入，点 ▶ 继续');
  }
  function stopPlay() {
    pause(false);
    state.cur = null;
    showTyping(false);
  }
  function playNext() {
    if (!state.playing || !state.cur) return;
    var f = friendById(state.cur);
    var rec = chatRec(f.id);
    var entry = f.script[rec.pos];
    if (!entry) {
      state.playing = false;
      syncCtrl();
      hint('剧本播放完毕。可以 ↺ 重播，或自己接着说。');
      return;
    }
    if (entry.f !== undefined || entry.g !== undefined) {
      friendTurn(f, entry, function () { rec.pos++; saveChat(f.id); if (state.playing) after(rand(600, 1200), playNext); });
    } else {
      myTurn(f, entry, function (sent) {
        if (sent) { rec.pos++; saveChat(f.id); }
        if (state.playing) after(rand(600, 1200), playNext);
      });
    }
  }
  /* 对方发言：先「正在输入…」，再真的入流 + 消息音 */
  function friendTurn(f, entry, done) {
    if (state.cur === f.id) showTyping(true);
    after(rand(800, 1600), function () {
      showTyping(false);
      deliver(f, entry);
      sound('msg');
      if (done) done();
    });
  }
  /* 我方发言：逐字打进输入框（真实 value + 真实 input 事件），
     然后让发送按钮真的获得焦点并真的 click —— 与用户手动发送同一条路径 */
  function myTurn(f, entry, done) {
    var inp = $('qqIn');
    var text = entry.me;
    var i = state.partial && state.partial.text === text ? state.partial.i : 0;
    if (!i) inp.value = '';
    inp.focus();
    (function tick() {
      if (!macroOn()) { if (done) done(false); return; }
      if (i >= text.length) {
        state.partial = null;
        after(rand(120, 260), function () {
          if (!macroOn()) { if (done) done(false); return; }
          state.macroSend = true;
          $('qqSendBtn').focus();
          $('qqSendBtn').click();
          if (done) done(true);
        });
        return;
      }
      inp.value += text.charAt(i);
      i++;
      state.partial = { text: text, i: i };
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      after(rand(55, 130), tick);
    })();
  }
  /* 单步：只演下一条（从当前指针开始，含没演完的那条） */
  function step() {
    pause(false);
    if (!state.cur) return;
    var f = friendById(state.cur);
    var rec = chatRec(f.id);
    var entry = f.script[rec.pos];
    if (!entry) { hint('剧本已经播完了。'); return; }
    state.stepping = true;
    syncCtrl();
    if (entry.f !== undefined || entry.g !== undefined) {
      friendTurn(f, entry, function () { rec.pos++; saveChat(f.id); state.stepping = false; syncCtrl(); });
    } else {
      myTurn(f, entry, function (sent) {
        if (sent) { rec.pos++; saveChat(f.id); }
        state.stepping = false;
        syncCtrl();
      });
    }
  }
  /* 重播 / 清空：二次确认（按钮变成「再点一次确认」，3 秒后复位） */
  var armed = null, armTimer = null;
  function arm(btn, key, label, action) {
    if (armed !== key) {
      armed = key;
      btn.textContent = '再点一次确认';
      clearTimeout(armTimer);
      armTimer = setTimeout(function () { armed = null; btn.textContent = label; }, 3000);
      return;
    }
    armed = null;
    btn.textContent = label;
    action();
  }
  function replay() {
    arm($('qqReplayBtn'), 'replay', '↺ 重播', function () {
      pause(false);
      var rec = chatRec(state.cur);
      rec.pos = 0;
      rec.msgs = [];
      saveChat(state.cur);
      lastDay = '';
      renderLog();
      hint('已重播。');
      play();
    });
  }
  function clearLog() {
    arm($('qqClearBtn'), 'clear', '清空记录', function () {
      pause(false);
      var rec = chatRec(state.cur);
      rec.pos = 0;
      rec.msgs = [];
      saveChat(state.cur);
      state.partial = null;
      lastDay = '';
      renderLog();
      hint('记录已清空。');
    });
  }

  /* ─────────── 十、发送与回复引擎 ─────────── */
  function sendMsg() {
    var byMacro = state.macroSend;
    state.macroSend = false;
    var inp = $('qqIn');
    var text = inp.value.replace(/^\s+|\s+$/g, '');
    if (!text || !state.cur) return;
    /* 用户真的发了消息 → 接管；宏自己点的发送不算 */
    if (!byMacro && (state.playing || state.stepping)) pause(false);
    state.partial = null;
    inp.value = '';
    pushMsg(state.cur, { w: 'me', text: text, t: now() });
    sound('send');
    if (!byMacro) replyTo(state.cur, text);
  }
  /* 接得上剧本 → 按剧本回应；接不上 → 符合作语气场面的兜底回复，指针不动。
     不假装「AI 听懂了」，但对话体验始终连贯。 */
  function textMatch(text, trig, resp) {
    if (text === trig.me) return true;
    if (text.length >= 2 && (text.indexOf(trig.me) >= 0 || trig.me.indexOf(text) >= 0)) return true;
    var keys = (resp && resp.k) || trig.k;
    if (keys) for (var i = 0; i < keys.length; i++) if (text.indexOf(keys[i]) >= 0) return true;
    return false;
  }
  function replyTo(id, text) {
    var f = friendById(id);
    var rec = chatRec(id);
    var at = f.script[rec.pos];
    var respIdx = -1;
    if (at && at.me !== undefined) {
      /* 轮到我方发言：用户这句话顶替了剧本台词，往后找对方该回的那句 */
      for (var i = rec.pos + 1; i < f.script.length; i++) {
        if (f.script[i].f !== undefined || f.script[i].g !== undefined) { respIdx = i; break; }
      }
    } else if (at) {
      /* 正轮到对方说这句：用户插了句话，对得上就按剧本说 */
      respIdx = rec.pos;
    }
    var matched = false, trig = null;
    if (respIdx >= 0) {
      for (var j = respIdx - 1; j >= 0; j--) {
        if (f.script[j].me !== undefined) { trig = f.script[j]; break; }
      }
      if (trig) matched = textMatch(text, trig, f.script[respIdx]);
    }
    if (matched) {
      friendTurn(f, f.script[respIdx], function () { rec.pos = respIdx + 1; saveChat(id); });
    } else {
      var line = pick(f.fallback);
      var fb = f.group === '群组'
        ? { g: pick(f.members || [f.name]), t: line }
        : { f: line };
      friendTurn(f, fb, function () {});
    }
  }

  /* ─────────── 十一、托盘与任务栏闪动 ─────────── */
  function ensureTray() {
    if ($('qqTray')) return;
    var t = document.createElement('span');
    t.className = 'trayico';
    t.id = 'qqTray';
    t.title = 'QQ';
    t.innerHTML = '<span class="ico ico-qq ico-qq-s"></span>';
    t.addEventListener('click', function () { openPanel(); });
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); trayMenu(e.clientX, e.clientY); });
    $('trayIcons').appendChild(t);
  }
  function renderTray() {
    var t = $('qqTray');
    if (!t) return;
    var n = totalUnread();
    t.classList.toggle('unread', n > 0);
    t.title = n > 0 ? 'QQ · ' + n + ' 条未读' : 'QQ';
  }
  function renderTaskFlash() {
    var w = $('qqWin');
    var btn = w && w._taskBtn;
    if (btn) btn.classList.toggle('flash', totalUnread() > 0 && w.hidden);
  }
  function hideTrayMenu() {
    var m = $('qqTrayMenu');
    if (m) m.parentNode.removeChild(m);
  }
  function trayMenu(x, y) {
    hideTrayMenu();
    var m = document.createElement('div');
    m.className = 'ctxmenu';
    m.id = 'qqTrayMenu';
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - 150)) + 'px';
    m.style.top = Math.max(4, y - 108) + 'px';
    m.innerHTML = '<div class="ctxi" data-a="open">打开面板</div>' +
      '<div class="ctxi" data-a="sound">' + (state.sound ? '关闭音效' : '开启音效') + '</div>' +
      (state.era ? '<div class="ctxi" data-a="era">退出穿越 · 回真实日期</div>' : '') +
      '<div class="ctx-sep"></div>' +
      '<div class="ctxi" data-a="quit">退出 QQ</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var it = closestEl(e.target, '.ctxi');
      if (!it) return;
      var a = it.getAttribute('data-a');
      hideTrayMenu();
      if (a === 'open') openPanel();
      else if (a === 'sound') toggleSound();
      else if (a === 'era') { $('qqEra').value = ''; state.era = ''; store('era', ''); applyEra(); }
      else if (a === 'quit') quitQQ();
    });
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideTrayMenu();
        document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function quitQQ() {
    stopPlay();
    clearMacroTimers();
    for (var i = 0; i < ambientTimers.length; i++) clearTimeout(ambientTimers[i]);
    ambientTimers = [];
    state.started = false;
    var t = $('qqTray');
    if (t) t.parentNode.removeChild(t);
    W98.closeWin($('qqWin'));
    W98.closeWin($('qqChatWin'));
    renderTaskFlash();
  }

  /* ─────────── 十二、来信派发（后台真实到达） ─────────── */
  function dispatchTick() {
    ambAfter(rand(16000, 38000), function () {
      /* 隐身不收信；页面隐藏时也不派发（与文件列表轮询同一省电原则） */
      if (state.status === 'online' && !document.hidden) {
        var cands = [];
        for (var i = 0; i < friends.length; i++) {
          var f = friends[i];
          if (state.presence[f.id] === false) continue;
          if (state.cur === f.id) continue;
          if (!nextFriendEntry(f)) continue;
          cands.push(f);
        }
        if (cands.length) {
          var fr = pick(cands);
          var ne = nextFriendEntry(fr);
          var rec = chatRec(fr.id);
          /* 磁带永远按顺序前进：跳过中间未播的「我方」台词，
             等价于「对方没等你回话就又发来一条」——这正是真实场景 */
          rec.pos = ne.i + 1;
          saveChat(fr.id);
          deliver(fr, ne.entry);
          sound('msg');
        }
      }
      dispatchTick();
    });
  }
  /* 好友在线状态会真的变：头像灰/亮、在线计数、上线敲门声都随之更新 */
  function presenceTick() {
    ambAfter(rand(45000, 90000), function () {
      var cands = friends.filter(function (f) { return f.group !== '群组'; });
      if (cands.length && Math.random() < 0.35) {
        var f = pick(cands);
        var on = state.presence[f.id] !== false;
        state.presence[f.id] = !on;
        renderPanel();
        renderOnline();
        if (!on && !$('qqWin').hidden) sound('knock');
      }
      presenceTick();
    });
  }

  /* ─────────── 十三、打开会话 / 面板 ─────────── */
  function renderChatTitle() {
    var f = friendById(state.cur);
    if (!f) return;
    $('qqChatTitle').textContent = (f.group === '群组' ? f.name + '（群）' : '与 ' + f.name + ' 对话') +
      (state.era ? ' · ' + state.era : '');
  }
  function openChat(id) {
    if (!friendById(id)) return;
    pause(false);          /* 切换到别的会话前，先停掉当前会话的播放 */
    state.cur = id;
    state.unread[id] = 0;
    saveUnread();
    state.partial = null;
    renderPanel();
    renderTray();
    renderTaskFlash();
    renderChatTitle();
    W98.openWin($('qqChatWin'));
    renderLog();
    /* 用户要求：打开好友消息之后自动输入 —— 打开即自动播放 */
    play();
  }
  function openPanel() {
    if (!state.started) {
      state.started = true;
      ensureTray();
      dispatchTick();
      hintIfOpen('QQ 已启动。好友会陆续发来消息，托盘图标有未读时会闪动。');
    }
    W98.openWin($('qqWin'));
    renderPanel();
    renderOnline();
    /* 打开面板时同步托盘与任务栏闪动：从托盘唤回时窗口已可见，
       任务栏按钮必须停止闪动，否则会出现「窗口开着、按钮狂闪」的假状态 */
    renderTray();
    renderTaskFlash();
  }

  /* ─────────── 十四、年代穿越 ─────────── */
  function applyEra() {
    W98.tickClock();
    if (state.cur) renderChatTitle();
    /* 系统属性窗口开着就同步刷新它的「系统日期」行 */
    if (!$('sysWin').hidden && W98.fillSys) W98.fillSys();
    hintIfOpen(state.era
      ? '已穿越到 ' + state.era + ' 年：任务栏时钟、系统属性、MS-DOS 的 date 同步显示当年的今天。'
      : '已回到真实日期。');
    if (state.era) sound('sys');
  }
  function buildEraOptions() {
    var sel = $('qqEra');
    for (var i = 0; i < ERAS.length; i++) {
      var o = document.createElement('option');
      o.value = ERAS[i];
      o.textContent = ERAS[i] + ' 年';
      sel.appendChild(o);
    }
    sel.value = state.era;
    sel.addEventListener('change', function () {
      state.era = sel.value;
      store('era', state.era);
      applyEra();
    });
  }

  /* ─────────── 十五、我的个性签名（真的可改、真的持久化） ─────────── */
  function initMySign() {
    var el = $('qqMySign');
    var saved = store('sign');
    if (saved) el.textContent = saved;
    el.title = '点击修改个性签名';
    el.addEventListener('click', function () {
      if (el._editing) return;
      el._editing = true;
      var old = el.textContent;
      var inp = document.createElement('input');
      inp.className = 'qq-era';
      inp.value = old;
      inp.setAttribute('aria-label', '修改个性签名');
      el.textContent = '';
      el.appendChild(inp);
      inp.focus();
      inp.select();
      function done(save) {
        if (!el._editing) return;
        el._editing = false;
        var v = inp.value.replace(/^\s+|\s+$/g, '');
        el.textContent = (save && v) ? v : old;
        if (save && v) store('sign', v);
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        else if (e.key === 'Escape') { done(false); }
      });
      inp.addEventListener('blur', function () { done(true); });
    });
  }

  /* ─────────── 十六、初始化 ─────────── */
  function init() {
    friends = PRESETS.friends.map(function (f, i) {
      f.id = 'f' + i;
      state.presence[f.id] = f.on !== false;
      return f;
    });
    state.era = store('era') || '';
    state.sound = store('sound') !== '0';
    state.status = store('status') || 'online';
    var u = store('unread');
    if (u) { try { state.unread = JSON.parse(u) || {}; } catch (e) { state.unread = {}; } }

    $('qqMyAv').innerHTML = avHtml(PRESETS.me);
    buildEraOptions();
    initMySign();
    syncSound();
    renderOnline();
    renderPanel();
    syncCtrl();

    $('qqSound').addEventListener('click', toggleSound);
    $('qqState').addEventListener('change', function () {
      state.status = $('qqState').value;
      store('status', state.status);
      renderOnline();
      hintIfOpen(state.status === 'hidden'
        ? '已隐身：暂停接收新消息，切回在线后恢复。'
        : '已上线：恢复接收新消息。');
    });
    $('qqGroups').addEventListener('click', function (e) {
      var row = closestEl(e.target, '.qq-f');
      if (row) openChat(row.getAttribute('data-f'));
    });
    $('qqSendBtn').addEventListener('click', sendMsg);
    $('qqIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMsg(); return; }
      /* 用户真的按下任意键 → 立即接管并明说。
         宏打字只改 value + 派发 input 事件，从不派发 keydown，
         所以这里收到的每一个按键都是真人发的，无需再分辨来源。 */
      if (state.playing) pause(true);
    });
    $('qqPlayBtn').addEventListener('click', function () { play(); });
    $('qqPauseBtn').addEventListener('click', function () { pause(false); });
    $('qqStepBtn').addEventListener('click', step);
    $('qqReplayBtn').addEventListener('click', replay);
    $('qqClearBtn').addEventListener('click', clearLog);

    presenceTick();
  }
  init();

  /* 给 HOME_JS 的钩子用（openApp / closeWin / tickClock / fillSys / minWin / 任务栏按钮） */
  window.QQ = {
    openPanel: openPanel,
    stopPlay: stopPlay,
    syncFlash: renderTaskFlash,
    eraDate: eraDate,
    get era() { return state.era; }
  };
})();
