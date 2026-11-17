#!/usr/bin/env bash
# Deploy the staged PSP EBOOT when the PSP appears on USB.
#
# Safe to run repeatedly: it does nothing at all unless the PSP is
# detected, and it refuses to deploy unless the staged artifact hashes
# exactly to the expected value.
#
# Exit codes:
#   0  deployed (or already up to date)
#   2  PSP not connected -> nothing to do
#   3  precondition failed (hash mismatch, no PSP_GAME, etc.)
set -uo pipefail

REPO=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
VERSION="v0.9.14-alpha"
STAGED="$REPO/dist/EBOOT-$VERSION.PBP"
EXPECTED_SHA="c00643fb0bc68e8f3a8d1049209068216e01e39e3c045f25b1cdbe794165e1c3"
EXPECTED_SIZE=8146692
AURORA="aurora-wsl"
WIN_STAGE="EBOOT-$VERSION.PBP"
WSL_INTEROP_SOCKET="${WSL_INTEROP_SOCKET:-}"

log() { echo "[psp-deploy] $*"; }

# SSH-launched WSL shells do not always inherit a live Windows interop socket.
# Reuse a socket owned by an interactive WSL instance after proving it with
# cmd.exe; guessing or using the stale default produces UtilAcceptVsock timeouts.
if [ -z "$WSL_INTEROP_SOCKET" ]; then
  WSL_INTEROP_SOCKET=$(ssh -o ConnectTimeout=15 "$AURORA" '
    for socket in /run/WSL/*_interop; do
      [ -S "$socket" ] || continue
      result=$(cd /mnt/c && WSL_INTEROP="$socket" /mnt/c/Windows/System32/cmd.exe /c "echo INTEROP_OK" 2>/dev/null | tr -d "\\r\\n" || true)
      if [ "$result" = "INTEROP_OK" ]; then
        printf "%s\n" "$socket"
        exit 0
      fi
    done
    exit 1
  ' 2>/dev/null | tail -1)
fi
[ -n "$WSL_INTEROP_SOCKET" ] || { log "no working Windows interop socket"; exit 3; }
log "using Windows interop socket $WSL_INTEROP_SOCKET"

[ -f "$STAGED" ] || { log "staged build missing: $STAGED"; exit 3; }

ACTUAL_SHA=$(sha256sum "$STAGED" | awk '{print $1}')
ACTUAL_SIZE=$(stat -c%s "$STAGED")
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ] || [ "$ACTUAL_SIZE" != "$EXPECTED_SIZE" ]; then
  log "staged build does not match expected hash/size"
  log "  want $EXPECTED_SHA $EXPECTED_SIZE"
  log "  got  $ACTUAL_SHA $ACTUAL_SIZE"
  exit 3
fi

# --- is the PSP attached? ---
# The detection script is written to a path Windows PowerShell can resolve
# (C:\Users\Public). A /tmp path is a WSL path and is invisible to
# powershell.exe, and the noninteractive WSL PATH omits Windows binaries, so
# PowerShell is invoked by its absolute path.
DETECT_SCRIPT=$(cat <<'PS1'
$devs = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\VID_054C*' }
$devs | ForEach-Object { Write-Output ('USB ' + $_.InstanceId) }
$disks = Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 }
foreach ($d in $disks) {
  $game = Join-Path $d.DeviceID 'PSP\GAME'
  Write-Output ('VOLUME ' + $d.DeviceID + ' PSP_GAME=' + (Test-Path $game))
}
PS1
)
printf '%s\n' "$DETECT_SCRIPT" > /tmp/psp-detect.ps1
scp -q /tmp/psp-detect.ps1 "$AURORA:/mnt/c/Users/Public/psp-detect.ps1" || {
  log "detect script copy failed"; exit 3; }
DETECT=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$AURORA" \
  "cd /mnt/c && WSL_INTEROP='$WSL_INTEROP_SOCKET' /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Public\\psp-detect.ps1'" 2>/dev/null | tr -d '\r')
ssh -o ConnectTimeout=10 "$AURORA" "rm -f /mnt/c/Users/Public/psp-detect.ps1" >/dev/null 2>&1

if ! echo "$DETECT" | grep -q "VID_054C"; then
  log "PSP not on USB -> nothing to do"
  exit 2
fi
if ! echo "$DETECT" | grep -q "PSP_GAME=True"; then
  log "PSP attached but PSP_GAME not found -> refusing"
  exit 3
fi
log "PSP detected on USB"

# The Memory Stick drive letter is discovered, never assumed: Windows may
# mount the PSP on a different letter than last time.
DRIVE=$(echo "$DETECT" | grep -oE 'VOLUME [A-Z]:' | head -1 | awk '{print $2}')
if [ -z "$DRIVE" ]; then
  log "could not resolve the Memory Stick drive letter -> refusing"
  exit 3
fi
log "Memory Stick is $DRIVE"

# Avoid retransferring the same 8 MB build every timer tick. The device hash
# is checked only after the volume has been proven to be a PSP volume.
CURRENT=$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$AURORA" \
  "cd /mnt/c && WSL_INTEROP='$WSL_INTEROP_SOCKET' /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \"\$dst='${DRIVE}\\PSP\\GAME\\PSPBUDDY\\EBOOT.PBP'; if (Test-Path \$dst) { (Get-FileHash \$dst -Algorithm SHA256).Hash }\"" \
  2>/dev/null | tr -d '\r' | tail -1 | tr 'A-F' 'a-f')
if [ "$CURRENT" = "$EXPECTED_SHA" ]; then
  log "already deployed: $EXPECTED_SIZE bytes, sha256 $EXPECTED_SHA"
  exit 0
fi

# --- stage + deploy ---
scp -q "$STAGED" "$AURORA:/mnt/c/Users/Public/$WIN_STAGE" || {
  log "staging copy to Windows failed"; exit 3; }

PS_SCRIPT=$(cat <<PS1
\$src = 'C:\\Users\\Public\\$WIN_STAGE'
\$dst = '${DRIVE}\\PSP\\GAME\\PSPBUDDY\\EBOOT.PBP'
\$rb  = '${DRIVE}\\PSP\\GAME\\PSPBUDDY\\EBOOT.rollback.PBP'
\$newHash = (Get-FileHash \$src -Algorithm SHA256).Hash
\$curHash = \$null
if (Test-Path \$dst) { \$curHash = (Get-FileHash \$dst -Algorithm SHA256).Hash }
if (\$curHash -ne \$newHash) {
  if (\$curHash) {
    Copy-Item \$dst \$rb -Force
    Write-Output ('ROLLBACK ' + (Get-FileHash \$rb -Algorithm SHA256).Hash)
  }
  Copy-Item \$src \$dst -Force
} else {
  Write-Output 'ROLLBACK unchanged'
}
\$h = (Get-FileHash \$dst -Algorithm SHA256).Hash
\$i = Get-Item \$dst
Write-Output ('DEPLOYED ' + \$i.Length + ' ' + \$h)
Remove-Item \$src -Force
PS1
)
printf '%s\n' "$PS_SCRIPT" > /tmp/psp-deploy.ps1
scp -q /tmp/psp-deploy.ps1 "$AURORA:/mnt/c/Users/Public/psp-deploy.ps1" || {
  log "script copy failed"; exit 3; }

RESULT=$(ssh -o ConnectTimeout=20 "$AURORA" \
  "cd /mnt/c && WSL_INTEROP='$WSL_INTEROP_SOCKET' /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\\Users\\Public\\psp-deploy.ps1'" 2>&1)
ssh -o ConnectTimeout=10 "$AURORA" "rm -f /mnt/c/Users/Public/psp-deploy.ps1" >/dev/null 2>&1
# PowerShell emits CRLF; strip the stray \r so field parsing/hash compare works.
RESULT=$(printf '%s' "$RESULT" | tr -d '\r')

DEPLOY_LINE=$(echo "$RESULT" | tr -d '\r' | grep -E "^DEPLOYED " | head -1)
if [ -z "$DEPLOY_LINE" ]; then
  log "deploy script did not report success:"
  echo "$RESULT" | tr -d '\r' | tail -5
  exit 3
fi

DEVICE_SHA=$(echo "$DEPLOY_LINE" | tr -d '\r' | awk '{print tolower($3)}')
DEVICE_SIZE=$(echo "$DEPLOY_LINE" | tr -d '\r' | awk '{print $2}')
EXPECTED_SHA_LOWER=$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')
if [ "$DEVICE_SHA" != "$EXPECTED_SHA_LOWER" ] || [ "$DEVICE_SIZE" != "$EXPECTED_SIZE" ]; then
  log "DEVICE HASH MISMATCH"
  log "  want $EXPECTED_SHA $EXPECTED_SIZE"
  log "  got  $DEVICE_SHA $DEVICE_SIZE"
  exit 3
fi

log "deployed OK: $DEVICE_SIZE bytes, sha256 $DEVICE_SHA"
echo "$RESULT" | tr -d '\r' | grep -E "^ROLLBACK " | sed 's/^/[psp-deploy] rollback /'
exit 0
