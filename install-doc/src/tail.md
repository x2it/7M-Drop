---

## 八、实测踩过的坑（请勿重蹈）

以下都是真实调试出来的，不是理论风险。

### 1. `HOST` 千万别设成 `0.0.0.0`

服务绑 `0.0.0.0` 只吃 IPv4。而 Windows 上 `localhost` 会优先解析成 `::1`，
于是任何走 `localhost` 的隧道客户端（典型如 Serveo 的 `ssh -R 80:localhost:8080`）
连不上本机，公网一律返回 **502**。

绑 `::` 是双栈，IPv4 / IPv6 都吃。代码里已做「绑不上自动回退 `0.0.0.0` 并打日志」。

### 2. npm 上的 `cloudflared` 包可能是个坏存根

`npm i -g cloudflared` 装出来的 `bin/cloudflared.exe` 可能只有约 2 MB 且无法执行，
报「不是此操作系统平台的有效应用程序」。真正的二进制约 **53 MB**。

直接从官方 release 下载才可靠：

```bash
# Windows
curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
# Linux
curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
```

### 3. Cloudflare 免费隧道单请求上限约 100 MB

所以上传**必须分片**（本实现用 8 MB 一片）。不分片的话大文件会直接失败。

### 4. CSS 里 `display:grid` / `display:flex` 会让 `[hidden]` 失效

作者样式优先级高于浏览器 UA 样式表。`<div hidden class="modal">` 上的 `hidden`
会被 `.modal{display:flex}` 覆盖，导致弹窗一进页面就糊在内容上。

**必须**补一条全局 `[hidden]{display:none !important}`。

纯接口测试永远发现不了这类问题，要用无头浏览器真实渲染一次并截图确认。

### 5. 无头浏览器 `--window-size` 有最小宽度，别用它测移动端

实测 Edge/Chrome 无头模式即使传 `--window-size=390`，页面 `innerWidth` 仍是 **500**，
而 `--screenshot` 会按 390 裁切输出。结果就是**看起来右边被切掉了一大块**，
让人误判成移动端横向溢出。

正确做法是用 CDP 的 `Emulation.setDeviceMetricsOverride` 做真机仿真：

```
Emulation.setDeviceMetricsOverride { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
```

然后用 `Page.captureScreenshot` 出图。用 `--window-size` 得到的移动端截图结论不可信。

---

## 九、三种链接形态，别发错

| 链接 | 形如 | 用途 |
|---|---|---|
| **文件页** | `/s/<口令>/f/<id>` | **分享给别人一律用这个**。打开先预览，页面内有下载按钮 |
| 直链 | `/s/<口令>/d/<id>` | 强制下载。给 curl、嵌站、需要直接下载的场景 |
| 预览流 | `/s/<口令>/v/<id>` | `inline` 输出，给 `<img>` / `<video>` / `<iframe>` 用 |

界面上文件行的 `⋯` 面板提供两个复制按钮，分别对应前两种；二维码指向文件页。

**为什么要多一层文件页**：对图片、PDF 这类可预览的文件，直接把 `/d/` 直链发出去
等于强迫对方先存盘再看。这一层是必须的，不是花哨。

### 深路径的坑：相对资源会解析错

文件页是 `/s/<口令>/f/<id>`，比首页深一层。首页里的 `./app.js`、`./app.css`
在这个深度下会被解析到 `/s/<口令>/f/app.js`。如果你的路由用 `startsWith('/f/')`
匹配，这些请求会被吞成 HTML 返回 **200**，浏览器拿到 `text/html` 当脚本执行，
页面整个失去行为——而且**不报错**，极难排查。

两件事都要做：

1. 路由精确匹配 id：`/^\/f\/[A-Za-z0-9_-]+$/`，不要用 `startsWith`
2. 给页面注入 `<base href="/s/<口令>/">` 修正相对地址

同理，前端算 API 前缀时不能直接取整段 `location.pathname`，
必须只取 `/s/<口令>` 这一段，否则 `/api/list` 会打成 404。

---

## 十、权限模型：为什么是两个口令

单口令的模型有个死结：**你为了让人下载，必须把口令发出去；而那个口令同时带着删除权。**
再加一层「删除口令」也没用——第二个密码还是在同一条链路上。

所以拆成两级，且由**服务端**强制：

| | 管理口令 | 分享口令 |
|---|---|---|
| 看列表 / 下载 | ✅ | ✅（可用 `GUEST_LIST=0` 关闭） |
| 上传 | ✅ | ✅（可用 `GUEST_UPLOAD=0` 关闭） |
| **删除** | ✅ | ❌ 直接 403 |

要点：

- 前端会按权限隐藏删除按钮，但这只是体验；**真正的拦截在路由层**，改前端没用。
- 界面上管理员点「二维码分享」给的是**分享链接**，不是当前页地址——
  否则等于把删除权一起扫给对方了。
- 口令比较用 `crypto.timingSafeEqual`，且口令错时返回 404 而不是 401，不暴露服务存在。

---

## 十一、可选：暴露到公网

```bash
cloudflared tunnel --url http://localhost:8080 --no-autoupdate
```

终端会打印形如 `https://xxx-yyy-zzz.trycloudflare.com` 的地址。

完整访问地址 = `公网地址 + /s/ + 口令 + /`（管理口令和分享口令各一个地址）

**提前告诉用户这些限制：**

- 地址**每次重启都变**，且无法指定。想要固定域名，必须自己拥有域名并托管到 Cloudflare
- Quick tunnel **无可用性承诺**，不适合当生产依赖
- 实测速度约 0.5–2 MB/s，随线路波动；下载不限速
- 免费隧道不占 Cloudflare 流量配额

---

## 十二、安全清单

- **管理口令 = 密码**，只留在用户自己手里；对外一律用分享链接
- 分成两级后，即便分享链接外泄，对方也删不掉文件
- 提醒用户：发链接前检查待传文件里有没有真实凭据（`.env`、`database.sql` 之类）
- 文件默认 24 小时自动清理；要长期保存把 `TTL_HOURS` 设为 `0`
- `data/` 是明文存储，机器被入侵则文件泄露
- 访客能上传时，总容量上限（`MAX_TOTAL_MB`）和限流（`RATE_INIT_PER_MIN`）是防塞盘的第一道闸

---

## 十三、卸载

删掉整个目录即可。没有写注册表、没有全局依赖、没有系统服务。
若配了 systemd / 计划任务，一并移除。

