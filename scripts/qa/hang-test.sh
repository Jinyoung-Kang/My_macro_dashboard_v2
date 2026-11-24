#!/usr/bin/env bash
# scripts/qa/hang-test.sh — QA 차단 프록시를 '먹통(hang — 요청을 받고 응답하지 않음)'으로 바꾸고, 화면이 부르는 GET 경로를 하나씩 불러
# 외부가 응답하지 않을 때 어느 경로가 얼마나 붙잡히는지 잽니다(성능 개선 2차 작업 C — 화면 조회의 외부 대기 상한).
# 사용: bash scripts/qa/hang-test.sh <GET 목록> [출력 파일=/dev/null] [모드=hang]
#   GET 목록: 한 줄에 '/api/…' 하나('#' 뒤 주석), 또는 page-apis.js의 결과 JSON(.json — 그 안의 GET /api/ 주소를 겹침 없이 씀).
#   모드: qa-stack.sh proxy의 값(hang·block 등). 끝나면(중단해도) 프록시를 block으로 되돌립니다.
# 출력: 표준출력에 0.5초 이상 걸린 경로(긴 순서)와 나머지 수, 출력 파일에 경로마다 '초 상태\t경로'.
# 안전: GET만 한 번씩, 경로마다 120초 상한. QA 스택에만 쓰세요 — 로컬 스택·운영 서버에는 쓰지 않습니다(CLAUDE.md).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
LIST="${1:?GET 목록 파일이 필요합니다(머리 설명)}"; OUT="${2:-/dev/null}"; MODE="${3:-hang}"
env_value() { grep -s "^$1=" .env.qa | head -1 | cut -d= -f2-; }
BASE="http://127.0.0.1:$(env_value BACKEND_PORT)"
URLS="$(mktemp "${TMPDIR:-/tmp}/hang-test.XXXXXX")"
restore() { bash scripts/qa/qa-stack.sh proxy block >/dev/null; rm -f "$URLS"; }
trap restore EXIT
case "$LIST" in
  *.json) python3 -c 'import json,sys
seen = []
for page in json.load(open(sys.argv[1])):
    for a in page.get("apis", []):
        if a.get("method") == "GET" and not a.get("sse") and a["url"].startswith("/api/") and a["url"] not in seen:
            seen.append(a["url"])
print("\n".join(seen))' "$LIST" > "$URLS" ;;
  *) sed -e 's/#.*$//' -e 's/[[:space:]]*$//' "$LIST" | grep -v '^$' > "$URLS" ;;
esac
bash scripts/qa/qa-stack.sh proxy "$MODE" >/dev/null
sleep 1
RESULT="$(mktemp "${TMPDIR:-/tmp}/hang-result.XXXXXX")"
echo "# $(TZ=Asia/Seoul date '+%F %T') KST hang-test 모드=$MODE $(git rev-parse --short HEAD 2>/dev/null) 경로 $(wc -l < "$URLS")개"
while read -r u; do
  t=$(curl -s -m 120 -o /dev/null -w '%{time_total} %{http_code}' "$BASE$u")
  printf '%s\t%s\n' "$t" "$u" >> "$RESULT"
done < "$URLS"
cp "$RESULT" "$OUT" 2>/dev/null || true
sort -rn "$RESULT" | awk -F'\t' '$1+0 >= 0.5 {printf "%7.2f초  %s\n", $1, substr($2,1,110)}'
echo "0.5초 미만: $(awk -F'\t' '$1+0 < 0.5' "$RESULT" | wc -l)개 / 전체 $(wc -l < "$RESULT")개"
rm -f "$RESULT"
