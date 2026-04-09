#!/usr/bin/env bash
# When `git push` fails with "pack-objects died of signal 10" — that is often a Bus error
# while packing objects. Do NOT run `git fsck --full` or `git repack` here; they can crash the same way.
#
# This script only:
#   1) Sets macOS + Git pack tunables that sometimes help
#   2) Tries a normal push once
#
# If push still fails, run:
#   bash scripts/export-push-patches.sh
# and apply patches in a fresh clone (see that script's instructions).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export MallocNanoZone=0

git config pack.threads 1
git config pack.windowMemory 100m

echo "==> Attempting: git push origin main"
if git push origin main; then
  echo "==> Push succeeded."
  exit 0
fi

echo ""
echo "Push failed. Export patches and use a fresh clone:"
echo "  bash scripts/export-push-patches.sh"
exit 1
