#!/bin/bash
set -u
BASE="http://localhost:3000"
KEY="Nexora_7Kp9xQ4mV8zL2nR6"
KEY2="Nexora_B4xT8pLm2Qw7Yk9C"
ADMIN="supersecretadmintestkey"
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

poll_job() {
  local jobid="$1"
  local S="" ST=""
  for i in $(seq 1 30); do
    S=$(curl -s "$BASE/api/status/$jobid" -H "x-api-key: $KEY")
    ST=$(echo "$S" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "  poll $i: $ST"
    if [ "$ST" = "completed" ] || [ "$ST" = "failed" ]; then break; fi
    sleep 5
  done
  echo "$S"
}

download_ok() {
  local s="$1" desc="$2"
  local DLURL=$(echo "$s" | grep -o '"downloadUrl":"[^"]*"' | cut -d'"' -f4)
  echo "  Download URL: $DLURL"
  local R=$(curl -s -o /dev/null -w "%{http_code}" "$DLURL" -H "x-api-key: $KEY")
  check "download file accessible ($desc)" "200" "$R"
  local R2=$(curl -s -o /dev/null -w "%{http_code}" "$DLURL")
  check "download without key -> 401 ($desc)" "401" "$R2"
}

echo "=== Auth & validation ==="
R=$(curl -s "$BASE/api/health")
check "health (no key)" "success\":true" "$R"
check "health lists platforms" "platforms" "$R"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' "$BASE/api/media/info")
check "info without key -> 401" "Invalid API key" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-api-key: BadKey" \
  -H "Content-Type: application/json" -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' "$BASE/api/media/info")
check "info with invalid key format -> 401" "401" "$R"

R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/not-supported"}' "$BASE/api/media/info")
check "unsupported URL -> 400" "supported URL" "$R"

R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "type":"pdf"}' "$BASE/api/media/download")
check "invalid type -> 400" "video or audio" "$R"

echo "=== Admin endpoints ==="
R=$(curl -s "$BASE/api/admin/keys" -H "x-admin-key: $ADMIN")
check "admin list keys (2 keys)" "Nexora_7Kp…" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/admin/keys" -H "x-admin-key: wrong")
check "admin without key -> 401" "401" "$R"

R=$(curl -s -X POST "$BASE/api/admin/keys/$KEY2/disable" -H "x-admin-key: $ADMIN")
check "disable key2" "Key disabled" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-api-key: $KEY2" \
  -H "Content-Type: application/json" -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' "$BASE/api/media/info")
check "disabled key2 -> 401" "401" "$R"

R=$(curl -s -X POST "$BASE/api/admin/keys/$KEY2/enable" -H "x-admin-key: $ADMIN")
check "enable key2" "Key enabled" "$R"

echo "=== YouTube info ==="
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' "$BASE/api/media/info")
check "youtube info returns title" "success\":true" "$R"

echo "=== YouTube download (video) ==="
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "type":"video", "quality":"360p"}' "$BASE/api/media/download")
JOBID=$(echo "$R" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
echo "YT video Job ID: $JOBID"
ST=$(echo "$R" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
check "download accepted 202 (status=$ST)" 'true' "$([ "$ST" = "queued" ] || [ "$ST" = "processing" ] && echo true)"
S=$(poll_job "$JOBID")
check "youtube video job completed" '"status":"completed"' "$S"
download_ok "$S" "youtube video"

echo "=== YouTube audio ==="
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "type":"audio"}' "$BASE/api/media/download")
J2=$(echo "$R" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
S=$(poll_job "$J2")
check "youtube audio job completed" '"status":"completed"' "$S"
download_ok "$S" "youtube audio"

echo "=== TikTok ==="
TIKTOK="https://vm.tiktok.com/ZMhxRkq5c/"
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"'$TIKTOK'"}' "$BASE/api/media/info")
check "tiktok info" "success\":true" "$R"
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"'$TIKTOK'", "type":"video"}' "$BASE/api/media/download")
JT=$(echo "$R" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
S=$(poll_job "$JT")
check "tiktok download completed" '"status":"completed"' "$S"
download_ok "$S" "tiktok"

echo "=== Facebook ==="
FB="https://www.facebook.com/61593563634759/videos/1404182515145652/"
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"'$FB'", "type":"video"}' "$BASE/api/media/download")
JF=$(echo "$R" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
S=$(poll_job "$JF")
check "facebook download completed" '"status":"completed"' "$S"
download_ok "$S" "facebook"

echo "=== Instagram ==="
IG="https://www.instagram.com/reel/DTcUAT2E1qX/"
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"'$IG'", "type":"video"}' "$BASE/api/media/download")
JI=$(echo "$R" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
S=$(poll_job "$JI")
check "instagram download completed" '"status":"completed"' "$S"
download_ok "$S" "instagram"

echo "=== Legacy YouTube endpoints ==="
R=$(curl -s -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' "$BASE/api/youtube/info")
check "legacy youtube info works" "success\":true" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" -d '{"url":"https://www.tiktok.com/@x"}' "$BASE/api/youtube/download")
check "legacy download rejects non-youtube -> 400" "400" "$R"

echo "=== 404 on missing job ==="
R=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status/nonexistent123" -H "x-api-key: $KEY")
check "status 404 for unknown job" "404" "$R"

echo
echo "RESULTS: PASS=$PASS FAIL=$FAIL"
exit $FAIL
