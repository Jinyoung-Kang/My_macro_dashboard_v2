#!/usr/bin/env bash
# scripts/qa/hang-test.sh — QA 차단 프록시를 '먹통(hang — 요청을 받고 응답하지 않음)'으로 바꾸고, 화면이 부르는 GET 경로를 하나씩 불러
# 외부가 응답하지 않을 때 어느 경로가 얼마나 붙잡히는지 잽니다(성능 개선 2차 작업 C·3차 작업 A — 화면 조회의 외부 대기 상한).
# 사용: [FRESH=once|each] [TARGET=collector] bash scripts/qa/hang-test.sh <GET 목록> [출력 파일=/dev/null] [모드=hang]
#   GET 목록: 한 줄에 '/api/…' 하나('#' 뒤 주석), 또는 page-apis.js의 결과 JSON(.json — 그 안의 GET /api/ 주소를 겹침 없이 씀).
#   모드: qa-stack.sh proxy의 값(hang·block 등). 끝나면(중단해도) 프록시를 block으로 되돌립니다.
#   FRESH: 기억과 잠금을 비운 상태로 잽니다 — QA 수집기·백엔드를 다시 띄우고(restart) 준비될 때까지 기다린 뒤 잼.
#     once = 재기 전에 한 번, each = 경로마다(앞 경로가 잠근 호스트가 뒤 경로를 바로 끝내지 않게 — 경로 하나에 약 20~40초 더 듦).
#     화면 기록(page-apis.js)이나 다른 측정 직후에 FRESH 없이 재면, 앞선 호출의 기억(시세·뉴스 캐시)과 호스트 잠금(Yahoo 무응답 잠금 —
#     http.active_rejection) 때문에 외부성 경로가 바로 끝나 '붙잡히지 않음'으로 보입니다(2026-11-24에 /api/macro/ticker의 60초를 놓친 까닭).
#     외부 대기 상한을 볼 때는 FRESH=each로, 외부성 경로만 추린 목록에 쓰세요.
#   TARGET=collector: 백엔드가 아니라 QA 수집기를 바로 부릅니다(목록은 '/live/…' 경로 — 서비스 토큰은 .env.qa에서 읽어 머리글로만 보냄).
#     백엔드의 읽기 상한·기억에 가려지지 않은 수집기 쪽 대기 시간을 볼 때.
# 출력: 표준출력에 0.5초 이상 걸린 경로(긴 순서)와 나머지 수, 출력 파일에 경로마다 '초 상태\t경로'.
# 안전: GET만 한 번씩, 경로마다 120초 상한. QA 스택에만 쓰세요 — 로컬 스택·운영 서버에는 쓰지 않습니다(CLAUDE.md).
#   FRESH는 QA 컨테이너를 restart로만 다시 띄웁니다(docker kill은 쓰지 않음 — 수동 정지로 간주돼 다시 뜨지 않음).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
LIST="${1:?GET 목록 파일이 필요합니다(머리 설명)}"; OUT="${2:-/dev/null}"; MODE="${3:-hang}"
env_value() { grep -s "^$1=" .env.qa | head -1 | cut -d= -f2-; }
BASE="http://127.0.0.1:$(env_value BACKEND_PORT)"
COLLECTOR="http://127.0.0.1:$(env_value COLLECTOR_PORT)"
FRESH="${FRESH:-}"
TARGET="${TARGET:-backend}"
HEADER=()
case "$TARGET" in
  backend) ;;
  collector) BASE_CALL="$COLLECTOR"; HEADER=(-H "X-Service-Token: $(env_value COLLECTOR_API_TOKEN)") ;;
  *) echo "TARGET은 backend 또는 collector입니다: $TARGET" >&2; exit 2 ;;
esac
BASE_CALL="${BASE_CALL:-$BASE}"
case "$FRESH" in ''|once|each) ;; *) echo "FRESH는 once 또는 each입니다: $FRESH" >&2; exit 2 ;; esac
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
# 기억과 잠금 비우기 — 프록시를 block으로 둔 채(기동 중의 바깥 호출이 붙잡히지 않게) 수집기·백엔드를 다시 띄우고 둘 다 답할 때까지(최대 180초) 기다립니다.
fresh_restart() {
  bash scripts/qa/qa-stack.sh proxy block >/dev/null
  bash scripts/qa/qa-stack.sh compose restart collector backend >/dev/null 2>&1
  for _ in $(seq 1 90); do
    c=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$COLLECTOR/health")
    b=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/api/health")
    [ "$c" = 200 ] && [ "$b" = 200 ] && return 0
    sleep 2
  done
  echo "경고: 수집기·백엔드가 180초 안에 준비되지 않았습니다(수집기 $c · 백엔드 $b)" >&2
  return 1
}
[ "$FRESH" = once ] && { fresh_restart || exit 1; }
bash scripts/qa/qa-stack.sh proxy "$MODE" >/dev/null
sleep 1
RESULT="$(mktemp "${TMPDIR:-/tmp}/hang-result.XXXXXX")"
echo "# $(TZ=Asia/Seoul date '+%F %T') KST hang-test 모드=$MODE 비움=${FRESH:-없음} 대상=$TARGET $(git rev-parse --short HEAD 2>/dev/null) 경로 $(wc -l < "$URLS")개"
while read -r u; do
  if [ "$FRESH" = each ]; then
    fresh_restart || exit 1
    bash scripts/qa/qa-stack.sh proxy "$MODE" >/dev/null
    sleep 1
  fi
  t=$(curl -s -m 120 -o /dev/null -w '%{time_total} %{http_code}' "${HEADER[@]}" "$BASE_CALL$u")
  printf '%s\t%s\n' "$t" "$u" >> "$RESULT"
done < "$URLS"
cp "$RESULT" "$OUT" 2>/dev/null || true
sort -rn "$RESULT" | awk -F'\t' '$1+0 >= 0.5 {printf "%7.2f초  %s\n", $1, substr($2,1,110)}'
echo "0.5초 미만: $(awk -F'\t' '$1+0 < 0.5' "$RESULT" | wc -l)개 / 전체 $(wc -l < "$RESULT")개"
rm -f "$RESULT"
