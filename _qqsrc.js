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
    D: ['hhhhhhhhhh', 'hhhhhhhhhh', 'hhsssssssh', 'hkkkkkkkkh', 'hkkkkkkkkh', 'hsssmmsssh', 'hssssssssh', 'cccccccccc', 'cccccccccc', 'cccccccccc'],
    /* 时钟：「最近联系人」Tab 的图标 */
    E: ['..kkkkkk..', '.kk....kk.', 'kk..hh..kk', 'kk..hh..kk', 'kk..hhhhkk', 'kk....hhkk', 'kk......kk', '.kk....kk.', '..kkkkkk..', '..........']
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
        name: '╰☆葬爱家族★冷少╮', sign: '家族不倒，葬爱到老。', group: '家族', era: 2005, on: true, qq: '4182637',
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
        name: '埖落灬晓', sign: '涐媞埖落灬晓，请不要再 call 涐。', group: '我的好友', era: 2008, on: true, qq: '5928416',
        av: 'B', pal: { h: '#1a1a1a', s: '#f7d7b5', k: '#1a1a1a', m: '#c06070', c: '#d88ab0' },
        script: [
          { f: '在吗？你看了我昨晚发的那篇日志没有。' },
          { me: '看了，就是那篇深夜请允许我最后一次堕落' },
          { f: '嗯。你说，人为什么长大以后，快乐就变得这么难。' },
          { me: '别想太多，早点睡', when: 'night', alt: '别想太多，先放一放' },
          { f: '睡不着的。一闭眼全是以前的事。你说喜欢的人最后怎么都变成了过客。' },
          { me: '会变才正常啊，我也变了很多' },
          { f: '你变得会安慰人了。以前的你，只会回一串省略号。' },
          { me: '那不是不知道怎么回嘛' },
          { f: '没关系。谢谢你今天愿意听我说这些。' },
          { me: '小事。明天你空间留言，我第一个去踩' },
          { f: '说定了。你要第一个来，还要带一朵玫瑰。', k: ['玫瑰', '第一个', '留言'] },
          { me: '带带带，玫瑰管够' },
          { f: '晚安，7喵。今天谢谢你。', when: 'night', alt: '今天就聊到这。谢谢你，7喵。' }
        ],
        fallback: ['嗯……然后呢。', '你是不是也有心事。', '大人的世界，就这样吧。', '我不想懂，真的。']
      },
      {
        name: '回忆ㄨ童年', sign: '让我们回到那时的童年。', group: '同学', era: 2003, on: true, qq: '1036428',
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
        name: '℡尐爺', sign: '尐爺涐兂所谓，呮媞涐恠迗崾郅溔糀。', group: '我的好友', era: 2008, on: false, qq: '8720415',
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
        name: '网吧网管小李', sign: '机子有问题请举手，我在吧台。', group: '网友', era: 2005, on: true, qq: '3360719',
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
        name: '毒鸡汤bot', sign: '今天也没有努力呢，真好。', group: '网友', era: 2012, on: true, qq: '1095732',
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
        name: '家族群·葬爱基地', sign: '葬爱家族总部，进来就是一家人。', group: '我的QQ群', isGroup: true, era: 2008, on: true, qq: '1208337',
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
        name: 'QQ炫舞家族·公主', sign: '舞团招新，会连击的来。', group: '家族', era: 2008, on: false, qq: '7610495',
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
        name: '老同学群·初三(2)班', sign: '常回群看看，同学录还在。', group: '我的QQ群', isGroup: true, era: 2003, on: false, qq: '4029116',
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
    lastCur: null,      // 最近打开过的好友 id（聊天窗关了也能重播）
    chats: {},          // id -> { pos, msgs: [{w,who,text,t}] }
    unread: {},         // id -> 未读数（真实收到且没看过的）
    presence: {},       // id -> 是否在线（头像/计数/派发候选都用真值）
    tab: 'friend',     // friend | group | recent —— 与真实 QQ 的三个 Tab 一致
    find: '',          // 查找联系人关键词（真的过滤列表）
    fold: {},          // 分组折叠状态（真实 QQ 点分组标题可折叠）
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
  /* 时段门槛（用户点名：没到晚上就说「晚安」显然不恰当）。
     剧本台词可挂 when: 'night' | 'day' 与 alt（不满足时段时的中性说法）；
     night = 21:00–05:00。用 eraDate() 取小时，年代穿越时仍按「当年今日的此刻」。 */
  function inWhen(w) {
    var h = eraDate().getHours();
    if (w === 'night') return h >= 21 || h < 5;
    if (w === 'day') return h >= 5 && h < 21;
    return true;
  }
  /* 演出层替换：不满足时段时把台词换成 alt，其余字段（k 关键词等）原样保留，
     不改 f.script 本身 —— 回复匹配引擎读到的仍是完整剧本。 */
  function timeFit(line) {
    if (!line || !line.when || line.alt === undefined || inWhen(line.when)) return line;
    var out = {};
    for (var k in line) if (Object.prototype.hasOwnProperty.call(line, k)) out[k] = line[k];
    if (out.me !== undefined) out.me = line.alt;
    else if (out.f !== undefined) out.f = line.alt;
    else if (out.t !== undefined) out.t = line.alt;
    return out;
  }

  /* 经典 QQ 默认表情的真实名称；插进输入框的是早期 QQ 的文本表情代码 /微笑 */
  var FACES = ['微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
    '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '酷', '冷汗', '抓狂', '吐',
    '偷笑', '愉快', '白眼', '傲慢', '饥饿', '困', '惊恐', '流汗', '憨笑', '奋斗',
    '咒骂', '疑问', '嘘', '晕', '疯了', '衰', '骷髅', '敲打', '再见', '擦汗',
    '抠鼻', '鼓掌', '糗大了', '坏笑', '左哼哼', '右哼哼', '哈欠', '鄙视', '委屈',
    '快哭了', '阴险', '亲亲', '吓', '可怜'];

  /* ─────────── 四、头像像素画 ─────────── */
  /* 头像像素画的渲染通道：CSP 的 style-src 'self' 会静默丢弃 style 属性里的
     box-shadow，连 <style> 元素的 sheet 都不给（Chromium 实测，头像整块空白）。
     而 img-src 'self' data: 本来就在白名单里（为二维码放行），所以把像素谱
     现场画成 SVG 的 data URI，用 <img> 显示——完全合规、零文件、运行时生成。
     同一幅谱+调色板只编码一次，之后复用缓存。 */
  var avCache = {};
  function avHtml(who) {
    var key = who.av + '|' + who.pal.h + who.pal.s + who.pal.k + who.pal.m + who.pal.c;
    if (!avCache[key]) {
      var pat = AV[who.av] || AV.A, pal = who.pal, r = [];
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
  /* 真实 QQ 的分组顺序；「陌生人」「黑名单」与真实 QQ 一样常驻（空的也显示） */
  var GROUPS = ['我的好友', '同学', '网友', '家族', '陌生人', '黑名单'];
  function matchKw(f, kw) {
    if (!kw) return true;
    return (f.name + ' ' + f.sign + ' ' + (f.qq || '')).toLowerCase().indexOf(kw) >= 0;
  }
  function friendRow(fr) {
    var u = state.unread[fr.id] || 0;
    var on = state.presence[fr.id] !== false;
    return '<div class="qq-f' + (on ? '' : ' off') + (state.cur === fr.id ? ' sel' : '') + '" data-f="' + fr.id + '" tabindex="0">' +
      '<span class="qq-f-av">' + avHtml(fr) + '</span>' +
      '<span class="qq-f-main">' +
      '<span class="qq-f-name">' + esc(fr.name) + '</span>' +
      '<span class="qq-f-sign">' + esc(fr.sign) + '</span>' +
      '</span>' +
      (u ? '<span class="qq-badge">' + (u > 99 ? '99+' : u) + '</span>' : '') +
      '</div>';
  }
  /* 分组标题：三角 + 名称 + 在线/总数（真实 QQ 的格式，点一下可折叠） */
  function secHtml(key, title, list, kw) {
    var fkey = key + '|' + title;
    var on = 0;
    for (var i = 0; i < list.length; i++) if (state.presence[list[i].id] !== false) on++;
    var fold = !!state.fold[fkey];
    var html = '<div class="qq-gname' + (fold ? ' fold' : '') + '" data-g="' + esc(fkey) + '" tabindex="0">' +
      '<span class="qq-gtri"></span>' + esc(title) +
      '<span class="qq-gnum">' + on + '/' + list.length + '</span></div>';
    if (fold) return html;
    for (var j = 0; j < list.length; j++) html += friendRow(list[j]);
    return html;
  }
  function emptyHtml(kw) {
    return '<div class="qq-empty">' + (kw ? '没有找到「' + esc(state.find) + '」' : '还没有联系人') + '</div>';
  }
  function renderPanel() {
    var box = $('qqGroups');
    var kw = (state.find || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    var html = '', i, list;
    if (state.tab === 'group') {
      list = friends.filter(function (f) { return f.isGroup && matchKw(f, kw); });
      html = list.length ? secHtml('g', '我的QQ群', list, kw) : emptyHtml(kw);
    } else if (state.tab === 'recent') {
      /* 最近联系人：真的按最后一次交谈时间倒序（真实 QQ 就是这个规则） */
      var rec = [];
      for (i = 0; i < friends.length; i++) {
        var r = chatRec(friends[i].id);
        if (r.msgs.length) rec.push({ f: friends[i], t: r.msgs[r.msgs.length - 1].t });
      }
      rec.sort(function (a, b) { return b.t - a.t; });
      list = rec.map(function (x) { return x.f; }).filter(function (f) { return matchKw(f, kw); });
      html = list.length ? secHtml('r', '最近联系人', list, kw) : emptyHtml(kw);
    } else {
      var hit = 0;
      for (i = 0; i < GROUPS.length; i++) {
        list = friends.filter(function (f) { return !f.isGroup && f.group === GROUPS[i] && matchKw(f, kw); });
        if (!list.length && kw) continue;      /* 查找时只留命中的分组 */
        hit += list.length;
        html += secHtml('g' + i, GROUPS[i], list, kw);
      }
      if (kw && !hit) html = emptyHtml(kw);
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
  /* 真实 QQ2008 的消息格式：「昵称 2008-07-15 20:31:12」一行，内容另起一行 */
  function fmtFull(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function rowHtml(m) {
    var f = friendById(state.cur);
    var me = m.w === 'me';
    var who = me ? PRESETS.me.name : (m.who || (f && f.name) || '对方');
    return '<div class="qq-row' + (me ? ' me' : '') + '">' +
      '<div class="qq-bhead"><span class="qq-bwho">' + esc(who) + '</span>' +
      '<span class="qq-btime">' + esc(fmtFull(m.t)) + '</span></div>' +
      '<div class="qq-btxt">' + esc(m.text) + '</div></div>';
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
      log.innerHTML = '<div class="qq-empty">还没有聊天记录。打开会话即会自动「演」出来，或自己说点什么。</div>';
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

  /* ─────────── 九、自动播放宏（打开会话即真实逐字「演」出来，聊天窗里不放任何播放按钮） ─────────── */
  function macroOn() { return state.playing; }
  function play() {
    if (state.playing) return;
    if (!state.cur) return;
    var f = friendById(state.cur);
    if (chatRec(f.id).pos >= f.script.length) {
      hint('这部剧已经看完了。可在面板主菜单「重播对话」再看一遍，或自己接着说。');
      return;
    }
    state.playing = true;
    playNext();
  }
  function pause(byUser) {
    if (!state.playing) return;
    state.playing = false;
    clearMacroTimers();
    showTyping(false);
    if (byUser) hint('已接管输入，自动播放已暂停。');
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
    var entry = timeFit(f.script[rec.pos]);
    if (!entry) {
      state.playing = false;
      hint('剧本播放完毕。可在面板主菜单「重播对话」再看一遍，或自己接着说。');
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
  /* 重播当前（或最近打开的）会话，从第一条台词重新「演」起。
     入口是面板主菜单的「重播对话」，不在聊天窗里放任何假按钮。 */
  function replayCurrent() {
    var id = state.cur || state.lastCur;
    if (!id || !friendById(id)) { hint('先打开一个会话，才能重播。'); return; }
    pause(false);
    var rec = chatRec(id);
    rec.pos = 0;
    rec.msgs = [];
    saveChat(id);
    state.partial = null;
    lastDay = '';
    if (state.cur !== id) openChat(id);   /* 没开着就先打开（openChat 末尾会自动 play） */
    else { renderLog(); play(); }
  }

  /* ─────────── 十、发送与回复引擎 ─────────── */
  function sendMsg() {
    var byMacro = state.macroSend;
    state.macroSend = false;
    var inp = $('qqIn');
    var text = inp.value.replace(/^\s+|\s+$/g, '');
    if (!text || !state.cur) return;
    /* 用户真的发了消息 → 接管；宏自己点的发送不算 */
    if (!byMacro && state.playing) pause(false);
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
        if (f.script[j].me !== undefined) { trig = timeFit(f.script[j]); break; }
      }
      if (trig) matched = textMatch(text, trig, timeFit(f.script[respIdx]));
    }
    if (matched) {
      friendTurn(f, timeFit(f.script[respIdx]), function () { rec.pos = respIdx + 1; saveChat(id); });
    } else {
      var line = pick(f.fallback);
      var fb = f.isGroup
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
  /* ── 主菜单（底部企鹅按钮）与表情面板 ── */
  function hideMenu() { $('qqMenu').hidden = true; }
  function toggleMenu() {
    var m = $('qqMenu');
    m.hidden = !m.hidden;
    if (m.hidden) return;
    /* 菜单是窗口内的 absolute 定位：坐标必须相对窗口算。
       此前误用视口坐标，窗口不在原点时菜单会整体飞出屏幕——真 bug，已修。 */
    var b = $('qqMenuBtn').getBoundingClientRect();
    var w = $('qqWin').getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(b.left - w.left, w.width - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(4, b.top - w.top - m.offsetHeight - 4) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideMenu();
        document.removeEventListener('pointerdown', once);
      });
    }, 0);
  }
  function hideFace() { var b = $('qqFaceBox'); if (b) b.parentNode.removeChild(b); }
  function showFace(btn) {
    hideFace();
    var box = document.createElement('div');
    box.className = 'qq-face';
    box.id = 'qqFaceBox';
    var html = '';
    for (var i = 0; i < FACES.length; i++) html += '<span class="qq-face-i" data-f="' + esc(FACES[i]) + '">' + esc(FACES[i]) + '</span>';
    box.innerHTML = html;
    box.addEventListener('click', function (ev) {
      var it = closestEl(ev.target, '.qq-face-i');
      if (!it) return;
      var inp = $('qqIn');
      inp.value += '/' + it.getAttribute('data-f') + ' ';
      inp.focus();
      hideFace();
    });
    document.body.appendChild(box);
    var r = btn.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 184)) + 'px';
    box.style.top = Math.max(4, r.top - 150) + 'px';
    setTimeout(function () {
      document.addEventListener('pointerdown', function once() {
        hideFace();
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
          deliver(fr, timeFit(ne.entry));
          sound('msg');
        }
      }
      dispatchTick();
    });
  }
  /* 好友在线状态会真的变：头像灰/亮、在线计数、上线敲门声都随之更新 */
  function presenceTick() {
    ambAfter(rand(45000, 90000), function () {
      var cands = friends.filter(function (f) { return !f.isGroup; });
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
    $('qqChatTitle').textContent = '与 ' + f.name + (f.qq ? '（' + f.qq + '）' : '') + ' 对话' +
      (state.era ? ' · ' + state.era : '');
  }
  /* 聊天窗口顶部：对方头像 + 昵称（QQ号）+ 个性签名 */
  function renderChatHead() {
    var f = friendById(state.cur);
    if (!f) return;
    $('qqChatAv').innerHTML = avHtml(f);
    $('qqChatName').textContent = f.name + (f.qq ? '（' + f.qq + '）' : '');
    $('qqChatSign').textContent = f.sign;
  }
  /* 右侧资料栏：真实 QQ2008 聊天窗口右侧就是这么一栏 */
  function renderChatSide() {
    var f = friendById(state.cur);
    if (!f) { $('qqChatSide').innerHTML = ''; return; }
    $('qqChatSide').innerHTML =
      '<span class="qq-av">' + avHtml(f) + '</span>' +
      '<div class="qq-ch-sname">' + esc(f.name) + '</div>' +
      '<div class="qq-ch-srow"><b>' + (f.isGroup ? '群号' : 'QQ') + '</b> ' + esc(f.qq || '-') + '</div>' +
      '<div class="qq-ch-srow"><b>分组</b> ' + esc(f.group) + '</div>' +
      '<div class="qq-ch-srow"><b>年代</b> ' + f.era + '</div>' +
      '<div class="qq-ch-srow"><b>状态</b> ' + (state.presence[f.id] !== false ? '在线' : '离线') + '</div>' +
      '<div class="qq-ch-srow">' + esc(f.sign) + '</div>';
  }
  function openChat(id) {
    if (!friendById(id)) return;
    pause(false);          /* 切换到别的会话前，先停掉当前会话的播放 */
    state.cur = id;
    state.lastCur = id;    /* 记住最近打开的会话，关窗后也能从主菜单重播 */
    state.unread[id] = 0;
    saveUnread();
    state.partial = null;
    renderPanel();
    renderTray();
    renderTaskFlash();
    renderChatTitle();
    renderChatHead();
    renderChatSide();
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
    el.textContent = saved || PRESETS.me.sign;
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
      var g = closestEl(e.target, '.qq-gname');
      if (g) {                                  /* 点分组标题 = 折叠/展开，与真实 QQ 一致 */
        var k = g.getAttribute('data-g');
        state.fold[k] = !state.fold[k];
        renderPanel();
        return;
      }
      var row = closestEl(e.target, '.qq-f');
      if (row) openChat(row.getAttribute('data-f'));
    });
    /* 三个 Tab：好友 / QQ群 / 最近联系人 */
    $('qqTabs').addEventListener('click', function (e) {
      var tab = closestEl(e.target, '.qq-tab');
      if (!tab) return;
      state.tab = tab.getAttribute('data-tab');
      var kids = $('qqTabs').children;
      for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('on', kids[i] === tab);
      renderPanel();
    });
    /* 查找联系人：真的按昵称/签名/号码过滤 */
    $('qqFind').addEventListener('input', function () {
      state.find = $('qqFind').value;
      renderPanel();
    });
    /* 主菜单 */
    $('qqMenuBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMenu();
    });
    $('qqMenu').addEventListener('click', function (e) { e.stopPropagation(); });
    $('qqQuitRow').addEventListener('click', function () { hideMenu(); quitQQ(); });
    /* 重播对话：从主菜单进入，不在聊天窗里放任何假按钮 */
    $('qqReplayRow').addEventListener('click', function () { hideMenu(); replayCurrent(); });
    /* 字体大小：真实切换（工具栏 A 按钮） */
    $('qqFontBtn').addEventListener('click', function () {
      var big = $('qqLog').classList.toggle('big');
      this.classList.toggle('on', big);
    });
    /* 表情：经典 QQ 默认表情，点一下真的把 /微笑 这样的文本代码插进输入框 */
    $('qqFaceBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      showFace(this);
    });
    $('qqCloseBtn').addEventListener('click', function () { W98.closeWin($('qqChatWin')); });
    /* Tab 图标：与真实 QQ 一样带小头像 */
    $('qqTabIcoF').innerHTML = avHtml({ av: 'A', pal: PRESETS.me.pal });
    $('qqTabIcoG').innerHTML = avHtml({ av: 'D', pal: { h: '#2a2a34', s: '#f2c89b', k: '#1a1a1a', m: '#a05050', c: '#a03030' } });
    $('qqTabIcoR').innerHTML = avHtml({ av: 'E', pal: { k: '#2b6ea8', h: '#2b6ea8' } });
    $('qqSendBtn').addEventListener('click', sendMsg);
    $('qqIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMsg(); return; }
      /* 用户真的按下任意键 → 立即接管并明说。
         宏打字只改 value + 派发 input 事件，从不派发 keydown，
         所以这里收到的每一个按键都是真人发的，无需再分辨来源。 */
      if (state.playing) pause(true);
    });

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
