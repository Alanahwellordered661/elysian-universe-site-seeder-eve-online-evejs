#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BIN_DIR="$ROOT/bin"
EXE="$BIN_DIR/UniverseSiteSeeder"
EVEJS_ARG=""
SKIP_BUILD=0
NO_LAUNCH=0

say() {
  printf '\n  -> %s\n' "$1"
}

warn() {
  printf '  [!] %s\n' "$1"
}

die() {
  printf '  [x] %s\n' "$1" >&2
  exit 1
}

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --evejs)
      shift
      EVEJS_ARG="${1:-}"
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --no-launch)
      NO_LAUNCH=1
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
  shift || true
done

check_disk_space() {
  local path="$1"
  local free_kb free_gb
  free_kb="$(df -Pk "$path" | awk 'NR == 2 { print $4 }')"
  free_gb=$((free_kb / 1024 / 1024))
  printf '  Free space at %s: %s GB\n' "$path" "$free_gb"
  if [ "$free_gb" -lt 2 ]; then
    die "Less than 2GB free. Free space before installing Elysian Universe Site Seeder."
  fi
  if [ "$free_gb" -lt 10 ]; then
    warn "Full universe site state can be chunky. 10GB+ free is a comfortable target."
  fi
}

check_build_tools() {
  local system
  system="$(uname -s)"

  if ! command -v cc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
    case "$system" in
      Darwin)
        warn "A C compiler was not found. If Rust linking fails, run: xcode-select --install"
        ;;
      Linux)
        warn "A C compiler was not found. If Rust linking fails, install build tools, for example: sudo apt install build-essential pkg-config"
        ;;
      *)
        warn "A C compiler was not found. Rust may ask for native build tools."
        ;;
    esac
  fi

  case "$system" in
    Darwin)
      if ! xcode-select -p >/dev/null 2>&1; then
        warn "Xcode command line tools were not detected. Run: xcode-select --install"
      fi
      ;;
    Linux)
      if ! command -v pkg-config >/dev/null 2>&1; then
        warn "pkg-config was not found. Install it with your distro build tools."
        return
      fi

      local missing=""
      local dep
      for dep in x11 xi xcursor xrandr xinerama xkbcommon wayland-client; do
        if ! pkg-config --exists "$dep" >/dev/null 2>&1; then
          missing="$missing $dep"
        fi
      done
      if [ -n "$missing" ]; then
        warn "Some Linux GUI/linker libraries were not found by pkg-config:$missing"
        warn "Debian/Ubuntu usually need: sudo apt install pkg-config libx11-dev libxi-dev libxcursor-dev libxrandr-dev libxinerama-dev libxkbcommon-dev libwayland-dev"
      fi
      ;;
  esac
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    node --version
    return
  fi
  die "Node.js was not found. Install Node.js LTS from https://nodejs.org, then run ./Install.sh again."
}

ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    cargo --version
    return
  fi

  warn "Rust/Cargo was not found."
  if ! command -v curl >/dev/null 2>&1; then
    die "Install Rust from https://rustup.rs, then run ./Install.sh again."
  fi

  printf '  Install Rust now with rustup? [Y/n] '
  read -r answer
  case "${answer:-Y}" in
    n|N|no|NO|No)
      die "Install Rust from https://rustup.rs, then run ./Install.sh again."
      ;;
  esac

  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  command -v cargo >/dev/null 2>&1 || die "cargo was not found after Rust installation. Open a new terminal and run ./Install.sh again."
  cargo --version
}

resolve_evejs_root() {
  local candidate="${EVEJS_ARG:-${EVEJS_PATH:-}}"
  local data_dir

  if [ -z "$candidate" ]; then
    printf '  Paste your EVE JS folder path: '
    read -r candidate
  fi

  candidate="$(expand_path "$candidate")"
  [ -d "$candidate" ] || die "That folder does not exist: $candidate"
  candidate="$(cd "$candidate" && pwd -P)"
  data_dir="$candidate/server/src/newDatabase/data"

  [ -f "$data_dir/dungeonAuthority/data.json" ] || die "Missing $data_dir/dungeonAuthority/data.json"
  [ -f "$data_dir/dungeonRuntimeState/data.json" ] || die "Missing $data_dir/dungeonRuntimeState/data.json"
  [ -f "$data_dir/miningRuntimeState/data.json" ] || die "Missing $data_dir/miningRuntimeState/data.json"
  [ -f "$candidate/server/src/config/index.js" ] || die "Missing $candidate/server/src/config/index.js"
  [ -f "$candidate/server/src/services/dungeon/dungeonUniverseRuntime.js" ] || die "Missing dungeon universe runtime service."
  [ -f "$candidate/server/src/services/mining/miningResourceSiteService.js" ] || die "Missing mining resource site service."

  printf '%s\n' "$candidate"
}

ensure_binary() {
  if [ -x "$EXE" ]; then
    printf '  Binary already exists: %s\n' "$EXE"
    return
  fi

  [ "$SKIP_BUILD" -eq 0 ] || die "Binary is missing and --skip-build was used."
  [ -f "$ROOT/Cargo.toml" ] || die "Source files are missing. Download the source checkout or use a release package with a bundled binary."

  ensure_rust
  check_build_tools

  say "Building release binary"
  (cd "$ROOT" && cargo build --release --locked)

  mkdir -p "$BIN_DIR"
  if [ -f "$ROOT/target/release/universe-site-seed" ]; then
    cp "$ROOT/target/release/universe-site-seed" "$EXE"
  elif [ -f "$ROOT/target/release/universe_site_seed" ]; then
    cp "$ROOT/target/release/universe_site_seed" "$EXE"
  else
    die "Rust build finished but the universe-site-seed binary was not found."
  fi
  chmod +x "$EXE"
}

write_config() {
  local evejs_root="$1"
  mkdir -p "$ROOT/config"
  printf '%s\n' "$evejs_root" > "$ROOT/config/evejs.path"
  printf '  Saved EVE JS path: %s\n' "$evejs_root"
}

run_health_check() {
  local evejs_root="$1"
  say "Running read-only health check"
  EVEJS_REPO_ROOT="$evejs_root" "$EXE" --health-check
}

say "Elysian Universe Site Seeder setup"
check_disk_space "$ROOT"
ensure_node
evejs_root="$(resolve_evejs_root)"
check_disk_space "$evejs_root"
ensure_binary
write_config "$evejs_root"
run_health_check "$evejs_root"

say "Ready"
printf '  Start it any time with: ./StartUniverseSeeder.sh\n'

if [ "$NO_LAUNCH" -eq 0 ]; then
  printf '  Launch the app now? [Y/n] '
  read -r answer
  case "${answer:-Y}" in
    n|N|no|NO|No) ;;
    *) EVEJS_REPO_ROOT="$evejs_root" "$EXE" ;;
  esac
fi
