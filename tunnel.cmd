@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   正在申请 Cloudflare 免费隧道...
echo   稍等约 10 秒，下方 trycloudflare.com 地址即为公网入口。
echo.
echo   拿到地址后：
echo     分享给别人 = 公网地址 + /s/ + 分享口令 + /
echo     自己管理   = 公网地址 + /s/ + 管理口令 + /
echo.

cloudflared.exe tunnel --url http://localhost:8080 --no-autoupdate
pause
