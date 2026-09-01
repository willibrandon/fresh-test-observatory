#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture="$repo_root/fixtures/workspace"
artifact_root=${HEX1B_ARTIFACT_DIR:-"$repo_root/.artifacts/acceptance"}
terminal_id=

cleanup() {
  if [[ -n "$terminal_id" ]]; then
    hex1b terminal stop "$terminal_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"$repo_root/scripts/install-local.sh"
mkdir -p "$artifact_root"

started=$(hex1b terminal start --width 180 --height 70 --cwd "$fixture" --json -- \
  fresh --no-restore rust/src/lib.rs)
terminal_id=$(printf '%s\n' "$started" | sed -n 's/.*"id": "\([0-9][0-9]*\)".*/\1/p')
if [[ -z "$terminal_id" ]]; then
  echo "Could not read the Hex1b terminal id" >&2
  exit 1
fi

hex1b assert "$terminal_id" --text-present "Palette: Ctrl+P" --timeout 30
hex1b keys "$terminal_id" --key p --ctrl
hex1b keys "$terminal_id" --text "Test Observatory: Open"
hex1b keys "$terminal_id" --key Enter
hex1b assert "$terminal_id" --text-present "Test Observatory discovered 14 tests" --timeout 60
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/discovered.png"

hex1b keys "$terminal_id" --key p --ctrl
hex1b keys "$terminal_id" --text "Test Observatory: Run Nearest in Terminal"
hex1b keys "$terminal_id" --key Enter
hex1b assert "$terminal_id" --text-present "(exited)" --timeout 60
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/terminal-nearest.png"

hex1b keys "$terminal_id" --key p --ctrl
hex1b keys "$terminal_id" --text "Test Observatory: Show Output"
hex1b keys "$terminal_id" --key Enter
hex1b assert "$terminal_id" --text-present "test result: ok" --timeout 60
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/terminal-output-panel.png"

hex1b keys "$terminal_id" --key p --ctrl
hex1b keys "$terminal_id" --text "Test Observatory: Open"
hex1b keys "$terminal_id" --key Enter
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/after-terminal.png"
hex1b assert "$terminal_id" --text-present "1 passed, 0 failed, 0 skipped" --timeout 60

hex1b keys "$terminal_id" --text "n"
hex1b assert "$terminal_id" --text-present "1 passed, 0 failed, 0 skipped" --timeout 60
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/nearest.png"

hex1b keys "$terminal_id" --text "a"
hex1b assert "$terminal_id" --text-present "11 passed, 0 failed, 3 skipped" --timeout 90
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/run-all.png"

hex1b keys "$terminal_id" --text "c"
hex1b assert "$terminal_id" --text-present "Coverage:" --timeout 120
hex1b capture screenshot "$terminal_id" --format png --output "$artifact_root/coverage.png"

echo "Hex1b acceptance passed. Screenshots are in $artifact_root"
