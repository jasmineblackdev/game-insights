#!/usr/bin/env bash
# GameLens backend smoke test (Edge Functions + optional REST).
# Usage: from repo root, with .env.local containing VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env.local ]]; then
  echo "Missing .env.local — copy .env.example and add your anon key."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

URL="${VITE_SUPABASE_URL%/}"
KEY="$VITE_SUPABASE_ANON_KEY"

if [[ -z "$URL" || -z "$KEY" ]]; then
  echo "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env.local"
  exit 1
fi

if [[ ${#KEY} -lt 80 ]]; then
  echo "Warning: VITE_SUPABASE_ANON_KEY looks too short — Supabase anon keys are long JWTs (usually 200+ chars)."
fi

CURL=(curl -sS -H "Authorization: Bearer ${KEY}" -H "apikey: ${KEY}")

check() {
  local name="$1"
  local path="$2"
  local code
  code="$("${CURL[@]}" -o /tmp/gamelens_verify.json -w "%{http_code}" "${URL}/functions/v1/${path}")"
  if [[ "$code" != "200" ]]; then
    echo "FAIL $name HTTP $code"
    head -c 400 /tmp/gamelens_verify.json 2>/dev/null || true
    echo
    return 1
  fi
  echo "OK   $name HTTP $code"
  return 0
}

echo "Probing ${URL} …"
check "draft-edge (NFL 2026)" "draft-edge?year=2026&league=nfl"
check "draft-edge (NBA 2026)" "draft-edge?year=2026&league=nba"
check "player-edge (NBA)" "player-edge?sport=nba"
check "nba-stats-proxy" "nba-stats-proxy"

echo "All Edge Function checks passed."
