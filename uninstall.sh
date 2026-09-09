#!/bin/zsh
set -euo pipefail
ROOT_DIR="${0:A:h}"
exec "$ROOT_DIR/scripts/uninstall-workbench-service.zsh" "$@"
