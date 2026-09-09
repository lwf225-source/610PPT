#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
WORKBENCH_DIR="${SCRIPT_DIR:h}"
SOURCE_PLIST="$SCRIPT_DIR/com.610ppt.workbench.plist"
SERVICE_LABEL="${PPT_WORKBENCH_SERVICE_LABEL:-com.610ppt.workbench}"
PUBLIC_PORT="${PPT_WORKBENCH_API_PORT:-5176}"
ENGINE_PORT="${PPT_V1_ENGINE_PORT:-6176}"
DATA_DIR="${PPT_WORKBENCH_DATA_DIR:-$HOME/Library/Application Support/610PPT}"
TARGET_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"
NO_OPEN="${PPT_WORKBENCH_NO_OPEN:-0}"
SKIP_SETUP="${PPT_WORKBENCH_SKIP_SETUP:-0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安装脚本仅支持 macOS；Windows 请运行 install.ps1。" >&2
  exit 1
fi
if [[ ! "$SERVICE_LABEL" =~ '^[A-Za-z0-9.-]+$' ]]; then
  echo "后台服务标识无效。" >&2
  exit 1
fi
if [[ ! "$PUBLIC_PORT" =~ '^[0-9]+$' || ! "$ENGINE_PORT" =~ '^[0-9]+$' || "$PUBLIC_PORT" == "$ENGINE_PORT" ]]; then
  echo "公共端口和引擎端口必须是两个不同的数字端口。" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" || -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
  echo "请先安装 Node.js 24（包含 npm），并确认 node/npm 在 PATH 中。" >&2
  exit 1
fi
NODE_BIN="$("$NODE_BIN" -p 'process.execPath')"
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("需要 Node.js 24.x"); process.exit(1); }'
EXPECTED_BUILD_ID="$(cd "$WORKBENCH_DIR" && "$NODE_BIN" --input-type=module -e 'import { WORKBENCH_BUILD_ID } from "./shared/runtime-version.js"; process.stdout.write(WORKBENCH_BUILD_ID)')"

health_matches_release() {
  curl -fsS --max-time 1 "$HEALTH_URL" 2>/dev/null | "$NODE_BIN" -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const health = JSON.parse(input);
    if (health?.ok !== true || health?.engine !== "connected" || health?.buildId !== process.argv[1]) process.exit(1);
  } catch { process.exit(1); }
});
' "$EXPECTED_BUILD_ID"
}

render_plist() {
  "$NODE_BIN" --input-type=module - "$SOURCE_PLIST" "$WORKBENCH_DIR" "$HOME" "$DATA_DIR" "$PATH" "$SERVICE_LABEL" "$PUBLIC_PORT" "$ENGINE_PORT" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [source, workbench, home, data, inheritedPath, label, publicPort, enginePort] = process.argv.slice(2);
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const runtime = path.join(home, '.cache/codex-runtimes/codex-primary-runtime/dependencies');
const values = {
  NODE_BIN: process.execPath,
  WORKBENCH_DIR: workbench,
  USER_HOME: home,
  DATA_DIR: path.resolve(data),
  SERVICE_PATH: [path.dirname(process.execPath), `${runtime}/bin/override`, `${runtime}/bin/fallback`, inheritedPath].join(':'),
  SERVICE_LABEL: label,
  PUBLIC_PORT: publicPort,
  ENGINE_PORT: enginePort,
  ENGINE_BASE_URL: `http://127.0.0.1:${enginePort}`
};
const rendered = fs.readFileSync(source, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
  if (!Object.hasOwn(values, name)) throw new Error(`Unknown plist field: ${name}`);
  return escape(values[name]);
});
if (/\{\{[A-Z_]+\}\}/.test(rendered)) throw new Error('plist 仍有未替换字段');
process.stdout.write(rendered);
NODE
}

if [[ "${1:-}" == "--dry-run" ]]; then
  [[ $# -eq 1 ]] || { echo "用法：$0 [--dry-run|--skip-setup|--no-open]" >&2; exit 1; }
  render_plist
  exit 0
fi

for arg in "$@"; do
  case "$arg" in
    --skip-setup) SKIP_SETUP=1 ;;
    --no-open) NO_OPEN=1 ;;
    *) echo "用法：$0 [--dry-run|--skip-setup|--no-open]" >&2; exit 1 ;;
  esac
done

if [[ "$SKIP_SETUP" != "1" ]]; then
  cd "$WORKBENCH_DIR"
  "$NPM_BIN" ci
  "$NPM_BIN" run build
fi

mkdir -p "$DATA_DIR/logs" "$HOME/Library/LaunchAgents"
TEMP_PLIST="$(mktemp "$HOME/Library/LaunchAgents/.610ppt.XXXXXX")"
BACKUP_PLIST=""
cleanup() { rm -f "$TEMP_PLIST"; [[ -z "$BACKUP_PLIST" ]] || rm -f "$BACKUP_PLIST"; }
trap cleanup EXIT
render_plist > "$TEMP_PLIST"
plutil -lint "$TEMP_PLIST" >/dev/null

if [[ -f "$TARGET_PLIST" ]]; then
  BACKUP_PLIST="$(mktemp "$HOME/Library/LaunchAgents/.610ppt-backup.XXXXXX")"
  cp "$TARGET_PLIST" "$BACKUP_PLIST"
fi

launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
mv "$TEMP_PLIST" "$TARGET_PLIST"
if ! launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"; then
  if ! launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"
  fi
fi
launchctl enable "$SERVICE_TARGET"
launchctl kickstart -k "$SERVICE_TARGET"

HEALTH_URL="http://127.0.0.1:$PUBLIC_PORT/api/health"
READY=0
for _ in {1..80}; do
  if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1 && health_matches_release; then
    READY=1
    break
  fi
  sleep 0.25
done

if [[ "$READY" != "1" ]]; then
  launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
  rm -f "$TARGET_PLIST"
  if [[ -n "$BACKUP_PLIST" && -f "$BACKUP_PLIST" ]]; then
    cp "$BACKUP_PLIST" "$TARGET_PLIST"
    launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST" >/dev/null 2>&1 || true
  fi
  echo "安装后的服务未通过健康检查，已恢复原后台服务配置。" >&2
  echo "日志目录：$DATA_DIR/logs" >&2
  exit 1
fi

echo "610PPT 本地服务已安装并通过健康检查。"
echo "工作台：http://127.0.0.1:$PUBLIC_PORT/"
echo "本地数据：$DATA_DIR"
if [[ "$NO_OPEN" != "1" ]]; then open "http://127.0.0.1:$PUBLIC_PORT/"; fi
