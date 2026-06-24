#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "正在啟動圖片工具…"
echo "啟動後請在瀏覽器開啟: http://127.0.0.1:${PORT}"
echo "關閉此視窗即會停止服務。"
echo ""
if lsof -ti :${PORT} >/dev/null 2>&1; then
  echo "埠 ${PORT} 已被占用，嘗試改用 8888…"
  PORT=8888
fi
open "http://127.0.0.1:${PORT}" 2>/dev/null || true
python3 -m http.server "${PORT}" --bind 127.0.0.1
