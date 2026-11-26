@echo off
chcp 65001 >nul
REM GEO Go 启动脚本（Windows）：双击运行，关掉这个窗口工具就停止
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 Node.js。请先去 https://nodejs.org 下载安装 LTS 版（20 以上），装好后再双击本文件。
  start https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
start "" http://localhost:3000
node server.js
pause
