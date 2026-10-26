#!/usr/bin/env bash
# Runs a Windows installer with one click, as a user does, then checks the
# install, the installer's two reports to the stand-in host, that the app keeps
# the installer's id and starts, and that it uninstalls.
#
# Usage: windows-install-check.sh <installer.exe> <requests.log> <version>
set -euo pipefail

installer=$1
requests=$2
version=$3
home="$(cygpath -u "$USERPROFILE")/.abacusai-bot"
programs="$(cygpath -u "$LOCALAPPDATA")/Programs"
shopt -s nullglob

fail() {
  echo "::error::$*"
  exit 1
}
running() { tasklist //FI "IMAGENAME eq AbacusBot.exe" //NH | grep -qi 'AbacusBot\.exe'; }
stop_app() {
  taskkill //F //T //IM AbacusBot.exe > /dev/null 2>&1 || true
  for _ in $(seq 1 30); do running || return 0; sleep 1; done
  fail "the app did not exit"
}

previous=$(cat "$home/device-id" 2>/dev/null || true)
seen=$(wc -l < "$requests")

echo "Installing with $(basename "$installer")"
"$installer"

installed=("$programs"/*/AbacusBot.exe)
[ "${#installed[@]}" -gt 0 ] || fail "nothing was installed under $programs"
exe=${installed[0]}
echo "Installed $exe"

[ -f "$home/device-id" ] || fail "the installer wrote no device-id"
id=$(cat "$home/device-id")
[[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "device-id is not a uuid: '$id'"
if [ -n "$previous" ] && [ "$id" != "$previous" ]; then
  fail "the installer replaced the existing id $previous with $id"
fi
echo "Install id $id"

reports=$(tail -n +"$((seen + 1))" "$requests")
echo "$reports"
query="install=${id}&v=${version}&os=win32&arch=x64&build=installer"
start=$(echo "$reports" | grep -nxF "GET /api/v1/_abacusaibotFunnelStep?step=installer_start&${query}" | head -1 | cut -d: -f1 || true)
finish=$(echo "$reports" | grep -nxF "GET /api/v1/_abacusaibotFunnelStep?step=installer_done&${query}" | head -1 | cut -d: -f1 || true)
[ -n "$start" ] || fail "no installer_start report for this install"
[ -n "$finish" ] || fail "no installer_done report for this install"
[ "$start" -lt "$finish" ] || fail "installer_done arrived before installer_start"

# The one-click installer starts the app when it finishes.
for _ in $(seq 1 90); do running && break; sleep 1; done
running || fail "the installer did not start the app"
stop_app

# The packaged app ignores the host override, so its own report is read from
# its log; its id is the file the installer wrote, if it still holds.
log=$(mktemp)
ABACUSAI_BOT_SMOKE_TEST=1 env -u ABACUSAI_BOT_ABACUS_HOST "$exe" > "$log" 2>&1 &
pid=$!
for _ in $(seq 1 120); do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
if kill -0 "$pid" 2> /dev/null; then
  cat "$log"
  stop_app
  fail "the app's smoke run exceeded its bound"
fi
wait "$pid" || true
cat "$log"
grep -qF '[smoke] main process ready' "$log" || fail "the app did not reach ready"
grep -qF '[smoke] renderer ready' "$log" || fail "the renderer did not reach ready"
grep -qF '[funnel] app_opened' "$log" || fail "the app did not report app_opened"
[ "$(cat "$home/device-id")" = "$id" ] || fail "the app replaced the installer's id"
stop_app

uninstallers=("$(dirname "$exe")"/Uninstall*.exe)
[ "${#uninstallers[@]}" -gt 0 ] || fail "no uninstaller beside $exe"
"${uninstallers[0]}" //S
for _ in $(seq 1 60); do [ -e "$exe" ] || break; sleep 1; done
[ ! -e "$exe" ] || fail "uninstall left $exe"
echo "Uninstalled"
