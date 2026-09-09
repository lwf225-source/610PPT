#!/bin/zsh

set -euo pipefail

SERVICE_LABEL="${PPT_WORKBENCH_SERVICE_LABEL:-com.610ppt.workbench}"
DATA_DIR="${PPT_WORKBENCH_DATA_DIR:-$HOME/Library/Application Support/610PPT}"
if [[ ! "$SERVICE_LABEL" =~ '^[A-Za-z0-9.-]+$' ]]; then
  echo "后台服务标识无效。" >&2
  exit 1
fi
TARGET_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"

launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
if [[ -f "$TARGET_PLIST" ]]; then rm "$TARGET_PLIST"; fi

echo "610PPT 后台服务已停止并移除。"
echo "本地项目和设置已保留：$DATA_DIR"
