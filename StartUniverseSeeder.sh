#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXE="$ROOT/bin/UniverseSiteSeeder"
CONFIG="$ROOT/config/evejs.path"

if [ ! -x "$EXE" ] || [ ! -f "$CONFIG" ]; then
  "$ROOT/Install.sh" --no-launch
fi

EVEJS_ROOT="$(sed -n '1p' "$CONFIG")"
if [ -z "$EVEJS_ROOT" ] || [ ! -d "$EVEJS_ROOT" ]; then
  "$ROOT/Install.sh" --no-launch
  EVEJS_ROOT="$(sed -n '1p' "$CONFIG")"
fi

EVEJS_REPO_ROOT="$EVEJS_ROOT" "$EXE" "$@"
