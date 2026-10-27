@echo off
chcp 65001 >nul
cd /d "%~dp0napcat\app"
title NapCat - 100000002
echo 正在拉起 QQ + NapCat ... 这个窗口不要关。
echo 登录成功后，会在 127.0.0.1:3001 提供 OneBot WebSocket。
echo.
call launcher-user.bat 100000002
