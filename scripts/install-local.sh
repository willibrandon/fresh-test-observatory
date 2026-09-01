#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_root=${XDG_CONFIG_HOME:-"$HOME/.config"}
install_root="$config_root/fresh/plugins/packages/fresh-test-observatory"

mkdir -p "$install_root"
rsync -a \
  --delete \
  --delete-excluded \
  --exclude '.git/' \
  --exclude '.testagent/' \
  --exclude 'REVIEW.md' \
  --exclude 'node_modules/' \
  --exclude '.artifacts/' \
  --exclude '.fresh-test-observatory/' \
  --exclude 'target/' \
  --exclude 'bin/' \
  --exclude 'obj/' \
  "$repo_root/" "$install_root/"

echo "Installed Test Observatory from $repo_root"
