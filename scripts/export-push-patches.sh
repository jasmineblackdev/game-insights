#!/usr/bin/env bash
# When `git push` dies with "pack-objects died of signal 10" (Bus error), your local
# .git pack is often broken. This exports commits as mailbox patches — no pack-objects.
#
# If you have NO unpushed commits but DO have uncommitted edits, this writes a single
# unified diff you can apply in a fresh clone (git apply + commit + push).
#
# Usage (from repo root):
#   bash scripts/export-push-patches.sh
#   PATCH_DIR=~/Desktop/my-patches bash scripts/export-push-patches.sh
#
# If SSH fetch fails, this script can switch origin to HTTPS automatically (unless
# GIT_EXPORT_NO_HTTPS_FALLBACK=1).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export MallocNanoZone=0

# git@github.com:user/repo.git -> https://github.com/user/repo.git
ssh_url_to_https() {
  local u="$1"
  case "$u" in
    git@github.com:*)
      local p="${u#git@github.com:}"
      p="${p%.git}"
      echo "https://github.com/${p}.git"
      ;;
    *)
      echo "$u"
      ;;
  esac
}

echo "==> Remote: $(git remote get-url origin 2>/dev/null || echo '(none)')"
echo "==> Fetching origin…"

FETCH_OK=0
if git fetch origin 2>/dev/null; then
  FETCH_OK=1
else
  if [ "${GIT_EXPORT_NO_HTTPS_FALLBACK:-0}" != "1" ]; then
    OLD_URL=$(git remote get-url origin 2>/dev/null || true)
    NEW_URL=$(ssh_url_to_https "$OLD_URL")
    if [ "$NEW_URL" != "$OLD_URL" ]; then
      echo ""
      echo "!!! SSH fetch failed — switching origin to HTTPS (easier on Mac without ssh-agent):"
      echo "    $OLD_URL"
      echo " -> $NEW_URL"
      git remote set-url origin "$NEW_URL"
      if git fetch origin; then
        FETCH_OK=1
        echo "==> Fetch OK. Origin is now HTTPS (git push will use HTTPS + your GitHub login or PAT)."
      else
        echo "!!! HTTPS fetch also failed — check network or repo URL."
      fi
    else
      echo "!!! fetch failed — not a github.com SSH URL; fix remote and run: git fetch origin"
    fi
  else
    echo "!!! fetch failed (GIT_EXPORT_NO_HTTPS_FALLBACK=1 — no auto HTTPS). Fix SSH or set-url manually."
  fi
fi

if [ "$FETCH_OK" -ne 1 ]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    echo ""
    echo "!!! Using existing origin/main (fetch failed — ref may be stale). For accuracy, fix fetch later."
  else
    echo ""
    echo "ERROR: fetch failed and origin/main is missing. Fix remote, then:"
    echo "  git remote set-url origin https://github.com/jasmineblackdev/game-insights.git"
    echo "  git fetch origin"
    exit 1
  fi
fi

if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
  echo "ERROR: origin/main missing."
  exit 1
fi

OUT="${PATCH_DIR:-$ROOT/../game-insights-push-patches-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd)"
PATCH_FILE="$OUT_ABS/working-tree-uncommitted.patch"

COUNT=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)

if [ "${COUNT:-0}" -gt 0 ]; then
  git format-patch origin/main..HEAD -o "$OUT_ABS"
  echo ""
  echo "==> Wrote $COUNT commit patch(es) to:"
  echo "    $OUT_ABS"
  echo ""
  echo "==> In a fresh clone:"
  echo "    cd .. && git clone https://github.com/jasmineblackdev/game-insights.git game-insights-clean"
  echo "    cd game-insights-clean && git am $OUT_ABS/*.patch && git push origin main"
  exit 0
fi

echo "No commits ahead of origin/main."

DIRTY=0
git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null || DIRTY=1

if [ "$DIRTY" -eq 0 ]; then
  echo "Working tree matches HEAD — nothing to export."
  echo "(After git add: if you have not committed, staged changes still show in git diff HEAD — if you see this, try: git status)"
  rmdir "$OUT_ABS" 2>/dev/null || true
  exit 0
fi

git diff HEAD > "$PATCH_FILE"

BYTES=$(wc -c < "$PATCH_FILE" | tr -d ' ')
if [ "${BYTES:-0}" -lt 3 ]; then
  echo "Diff was empty. Tip: new files need 'git add' before they appear in git diff HEAD."
  echo "Run: git add -A && npm run git:export-patches"
  exit 1
fi

echo ""
echo "==> Exported uncommitted work (vs last commit) to:"
echo "    $PATCH_FILE"
echo ""
echo "==> Next: fresh clone, apply, commit, push (HTTPS clone avoids SSH):"
echo "    cd .."
echo "    git clone https://github.com/jasmineblackdev/game-insights.git game-insights-clean"
echo "    cd game-insights-clean"
echo "    git apply --check \"$PATCH_FILE\""
echo "    git apply \"$PATCH_FILE\""
echo "    git add -A && git status"
echo "    git commit -m \"Describe your changes\""
echo "    git push origin main"
echo ""
echo "If apply fails on paths/whitespace:"
echo "    git apply --reject --whitespace=fix \"$PATCH_FILE\""
