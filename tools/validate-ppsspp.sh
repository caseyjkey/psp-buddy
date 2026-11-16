#!/usr/bin/env bash
# Fast local PSP validation loop.
#
# This copies one verified EBOOT into an isolated PPSSPP game directory and
# launches it. It never writes to a physical PSP or to the user's normal
# PPSSPP save/config directory.
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
EBOOT=${1:-"$ROOT_DIR/dist/EBOOT-v0.9.12-alpha.PBP"}
PPSSPP_BIN=${PPSSPP_BIN:-ppsspp}
EMU_HOME=${PPSSPP_HOME:-"${XDG_CACHE_HOME:-$HOME/.cache}/psp-buddy-ppsspp"}
GAME_DIR="$EMU_HOME/PSP/GAME/PSPBUDDY"
LOG_FILE="$EMU_HOME/ppsspp.log"

if [[ ! -f "$EBOOT" ]]; then
  echo "missing EBOOT: $EBOOT" >&2
  exit 2
fi
if ! command -v "$PPSSPP_BIN" >/dev/null 2>&1; then
  echo "PPSSPP not found: $PPSSPP_BIN" >&2
  echo "Install it with: sudo pacman -S ppsspp ppsspp-assets" >&2
  exit 3
fi

mkdir -p "$GAME_DIR"
install -m 0644 "$EBOOT" "$GAME_DIR/EBOOT.PBP"
SOURCE_SHA=$(sha256sum "$EBOOT" | awk '{print $1}')
COPIED_SHA=$(sha256sum "$GAME_DIR/EBOOT.PBP" | awk '{print $1}')
if [[ "$SOURCE_SHA" != "$COPIED_SHA" ]]; then
  echo "isolated EBOOT hash mismatch" >&2
  exit 4
fi

echo "PPSSPP validation copy: $GAME_DIR/EBOOT.PBP"
echo "EBOOT: $(stat -c '%s bytes' "$EBOOT"), sha256 $SOURCE_SHA"
echo "Press O in PSP Buddy to exercise the SIM scene; press Esc to exit PPSSPP."
echo "Log: $LOG_FILE"

# PPSSPP reads its home/config from this isolated directory. Extra arguments
# can be supplied through PPSSPP_ARGS when a local build uses different CLI
# flags (for example: PPSSPP_ARGS='--fullscreen').
# shellcheck disable=SC2206
EXTRA_ARGS=(${PPSSPP_ARGS:-})
exec env XDG_CONFIG_HOME="$EMU_HOME/config" XDG_DATA_HOME="$EMU_HOME/data" \
  "$PPSSPP_BIN" "${EXTRA_ARGS[@]}" "$GAME_DIR/EBOOT.PBP" \
  >"$LOG_FILE" 2>&1
