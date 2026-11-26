#!/usr/bin/env bash
# 从 docs/screenshots/scenes/*.html 导出 PNG，供 README 使用。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/screenshots"
SCENES="$OUT/scenes"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "未找到 Chrome：$CHROME（可设置环境变量 CHROME）" >&2
  exit 1
fi

for html in library reader chat writing compare dashboard; do
  src="$SCENES/$html.html"
  dest="$OUT/$html.png"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1440,900 \
    --screenshot="$dest" \
    "file://$src"
  echo "→ $dest"
done