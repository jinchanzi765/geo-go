#!/bin/bash
# GEO Go 启动脚本（Mac）：双击运行，关掉这个窗口工具就停止
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js。请先去 https://nodejs.org 下载安装 LTS 版（20 以上），装好后再双击本文件。"
  open "https://nodejs.org/zh-cn/download"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi
V=$(node -p "process.versions.node.split('.')[0]")
if [ "$V" -lt 20 ]; then
  echo "你的 Node.js 版本太旧（$(node -v)），需要 20 以上。请去 https://nodejs.org 下载新版。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi
(sleep 2; open "http://localhost:${PORT:-3000}") &
node server.js
read -n 1 -s -r -p "工具已停止，按任意键关闭…"
