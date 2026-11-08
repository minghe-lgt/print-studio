@echo off
chcp 65001 >nul
title 打印小站 · 3D打印工作室管理
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py app.py
) else (
  python app.py
)
echo.
echo 程序已退出。如果上方有红色报错，请截图联系帮你搭建的人。
pause
