@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 机器人 QQ 桥
echo 启动桥接进程。Ctrl+C 退出。
echo 控制台: http://127.0.0.1:3899
echo.
node src\index.mjs
echo.
echo 桥接进程已退出。
pause
