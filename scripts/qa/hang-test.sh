#!/usr/bin/env bash
# 임시(저장소 밖): QA 차단 프록시를 '먹통(hang)'으로 바꾸고 화면이 부르는 GET 경로를 하나씩 불러, 외부가 응답하지 않을 때 어느 경로가 얼마나 붙잡히는지 잰다.
# QA 스택에만 쓴다. 끝나면 프록시를 block으로 되돌린다.
# 사용: hang-test.sh <저장소> <GET 목록 파일> <출력 파일> [mode=hang]
set -uo pipefail
REPO="$1"; URLS="$2"; OUT="$3"; MODE="${4:-hang}"
BASE=http://127.0.0.1:18082
cd "$REPO"
restore() { bash scripts/qa/qa-stack.sh proxy block >/dev/null; }
trap restore EXIT
bash scripts/qa/qa-stack.sh proxy "$MODE" >/dev/null
sleep 1
: > "$OUT"
while read -r u; do
  [ -n "$u" ] || continue
  t=$(curl -s -m 120 -o /dev/null -w '%{time_total} %{http_code}' "$BASE$u")
  printf '%s\t%s\n' "$t" "$u" >> "$OUT"
done < "$URLS"
bash scripts/qa/qa-stack.sh proxy
sort -rn "$OUT" | awk -F'\t' '$1+0 >= 0.5 {printf "%7.2f초  %s\n", $1, substr($2,1,110)}'
echo "0.5초 미만: $(awk -F'\t' '$1+0 < 0.5' "$OUT" | wc -l)개 / 전체 $(wc -l < "$OUT")개"
