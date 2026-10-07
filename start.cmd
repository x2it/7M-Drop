@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ═══════════ 7MD（7喵快传）· 启动配置 ═══════════
REM  改完保存，双击本文件即可生效。
REM
REM  ⚠️ 第一次用请务必把下面两个口令改成你自己的随机串。
REM     这里的示例值是公开的，用示例值等于没有口令。

set PORT=8080

REM  管理口令：全部权限，含删除。只有你自己留着。
set TOKEN=change-me-admin

REM  分享口令：发给别人。可看列表 / 下载 / 上传，但不能删除。
REM  想退回单口令模式，把下面改成 same
set SHARE_TOKEN=change-me-share

REM  访客权限微调：设 0 可关闭对应能力
REM  GUEST_UPLOAD=0  -> 访客只能下载，不能上传
REM  GUEST_LIST=0    -> 访客只能上传，看不到也下不了已有文件（盲投）
set GUEST_UPLOAD=1
set GUEST_LIST=1

set TTL_HOURS=48
set MAX_MB=2048
set MAX_TOTAL_MB=5120
set RATE_INIT_PER_MIN=60

REM  监听地址保持默认（:: 双栈）。改成 0.0.0.0 会导致部分隧道报 502
set HOST=::

REM ══════════════════════════════════════════

echo.
echo   7MD · 本地文件中转服务
echo.
echo   管理链接: http://localhost:%PORT%/s/%TOKEN%/
echo   分享链接: http://localhost:%PORT%/s/%SHARE_TOKEN%/
echo   ^(完整信息与"当前已用容量"请看下方启动输出^)
echo.
echo   公网访问：另开一个窗口运行 tunnel.cmd
echo.

node server.js
pause
