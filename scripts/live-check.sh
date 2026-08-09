#!/usr/bin/env bash
# One real message to Grant against a deployed URL.
#   ./scripts/live-check.sh https://your-app.vercel.app
#
# Exercises the same path the panel uses: POST /api/grant, read the SSE stream.
# Prints the raw frames so `meta` (which doctrine sections were injected) and
# `done` (token usage, cache hits) are both visible.
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi

read -r -d '' BODY <<'JSON'
{
  "mode": "midday",
  "now": "2026-08-09T14:00:00+02:00",
  "energy": "cooked",
  "message": "jsem uplne cooked, mam sip na Matthew onboarding",
  "tasks": [
    {"id": "t1", "title": "Onboard Matthew on the Klaviyo SOP",
     "tag": "MOVER", "category": "CLIENT", "ageDays": 6,
     "isArrow": true, "status": "open"}
  ],
  "arrow": "t1",
  "arrowStreak": 0,
  "tracker": {"sleepHours": 4.5, "bedtime": "01:40", "wakeTime": "06:10"},
  "openLoops": [],
  "history": []
}
JSON

echo "POST ${BASE}/api/grant"
echo "---"

code=$(curl -sS -N -o /tmp/grant-live.out -w '%{http_code}' \
  -X POST "${BASE}/api/grant" \
  -H 'Content-Type: application/json' \
  --max-time 90 \
  -d "$BODY")

echo "HTTP ${code}"
echo "---"
head -c 4000 /tmp/grant-live.out
echo
echo "---"

if [ "$code" != "200" ]; then
  echo "Not a 200. If the body is an SSO/login page, the deployment has Vercel"
  echo "protection on and needs a bypass token or a public alias."
  exit 1
fi

grep -q '^event: done' /tmp/grant-live.out && echo "OK: stream completed" || echo "WARN: no done frame"
