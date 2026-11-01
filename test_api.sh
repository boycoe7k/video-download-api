#!/bin/bash
# Keyless API smoke tests. Does not start downloads or send paid messages.
set -u
BASE="${BASE_URL:-http://localhost:3000}"
PASS=0; FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "PASS: $name"
    PASS=$((PASS+1))
  else
    echo "FAIL: $name — expected '$expected' got: $actual"
    FAIL=$((FAIL+1))
  fi
}

http_code() { curl -sS -o /tmp/netfy-api-test-response -w "%{http_code}" "$@"; }

echo "=== Public API (no API key) ==="
R=$(curl -sS "$BASE/api/health")
check "health is operational" '"success":true' "$R"

R=$(curl -sS "$BASE/api/platform/catalog")
check "catalog has API modules" '"total":26' "$R"

CODE=$(http_code "$BASE/api/github/invalid%20owner/repo")
check "invalid GitHub owner is rejected" "400" "$CODE"

CODE=$(http_code "$BASE/api/ip/not-an-ip")
check "invalid IP is rejected" "400" "$CODE"

R=$(curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/not-supported"}' "$BASE/api/media/info")
check "unsupported media URL is rejected without auth" 'supported URL' "$R"

R=$(curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1"}' "$BASE/api/screenshot")
check "unsafe screenshot URL is rejected without auth" 'public HTTPS URL is required' "$R"

CODE=$(http_code "$BASE/api/status/nonexistent123")
check "unknown job returns 404 without auth" "404" "$CODE"

echo
echo "RESULTS: PASS=$PASS FAIL=$FAIL"
exit "$FAIL"
