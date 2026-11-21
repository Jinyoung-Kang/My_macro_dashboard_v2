#!/usr/bin/env bash
#
# scripts/bench-api.sh — 화면 API 응답 시간을 잰다 (성능 변경 전후 비교용).
#
# 사용: bash scripts/bench-api.sh [반복 횟수=7] [> 결과파일]
#       ENV_FILE=.env.qa bash scripts/bench-api.sh   # QA 스택(18082)에서 — 성능 시험은 운영 스택이 아니라 여기서(CLAUDE.md)
#
# ENV_FILE(기본 .env)의 OWNER_EMAIL·APP_PASSWORD(운영자 계정)로 로그인해 쿠키를 받은 뒤, 아래 목록의 엔드포인트를 반복 호출하고
# 첫 호출·중앙값·최대(ms)와 응답 크기를 표로 찍는다. 첫 호출은 JIT·커넥션 준비 때문에 느리므로 중앙값·최대에서 뺀다.
# 백엔드가 로그인 없는 모드(GET /api/auth/session의 noLogin — ADR 0016, QA_NO_LOGIN=1)면 로그인을 건너뛰고 쿠키 없이 부른다.
# 비밀번호는 출력하지 않는다. 쿠키 파일은 임시 폴더에 만들고 끝나면 지운다.
#
# 숫자는 같은 맥·같은 저장본·수집기가 쉬는 시간에 재야 비교할 수 있다. 수집 직후에는
# 저장본이 바뀌어 응답 크기가 달라질 수 있다.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=${ENV_FILE:-.env}
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE 이 없습니다" >&2; exit 1; }
get_env() { grep -s "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
BACKEND_PORT=$(get_env BACKEND_PORT); BACKEND_PORT=${BACKEND_PORT:-8080}
FRONTEND_PORT=$(get_env FRONTEND_PORT); FRONTEND_PORT=${FRONTEND_PORT:-3000}
BASE="http://localhost:${BACKEND_PORT}"
N=${1:-7}

JAR=$(mktemp "${TMPDIR:-/tmp}/bench-cookie.XXXXXX"); trap 'rm -f "$JAR"' EXIT
NO_LOGIN=$(curl -s "$BASE/api/auth/session" | python3 -c 'import json,sys
try: print("1" if json.load(sys.stdin).get("noLogin") is True else "")
except Exception: print("")')
if [ -n "$NO_LOGIN" ]; then
  echo "# 로그인 없는 모드 — 쿠키 없이 부릅니다" >&2
else
  PASSWORD=$(get_env APP_PASSWORD)
  EMAIL=$(get_env OWNER_EMAIL)
  if [ -z "$PASSWORD" ] || [ -z "$EMAIL" ]; then echo "OWNER_EMAIL·APP_PASSWORD가 $ENV_FILE에 없습니다(운영자 계정)" >&2; exit 1; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' \
    -H "Origin: http://localhost:${FRONTEND_PORT}" \
    --data-binary "$(EMAIL="$EMAIL" PASSWORD="$PASSWORD" python3 -c 'import json,os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"]}))')" \
    "$BASE/api/auth/login")
  unset PASSWORD
  if [ "$code" != "200" ]; then echo "로그인 실패: HTTP $code" >&2; exit 1; fi
fi

# 화면이 실제로 부르는 조합 (docs/API.md). 계산이 많거나 응답이 큰 것 위주.
ENDPOINTS=(
  "/api/macro/overview"
  "/api/macro/risk"
  "/api/macro/advanced"
  "/api/macro/fx?ids=usdkrw,dxy,eurusd,usdjpy&period=5y&mode=index"
  "/api/macro/spread?longId=DGS10&shortId=DGS2"
  "/api/liquidity?years=3"
  "/api/sector/rotation?period=1M"
  "/api/sector/momentum"
  "/api/sec13f/institutions"
  "/api/guru/profiles"
  "/api/guru/similarity"
  "/api/guru/risk?cik=0001067983&benchmark=SPY&years=1"
  "/api/stock/scorecard?symbol=AAPL&benchmark=SPY&years=1"
  "/api/cot/extremes?name=Gold&percentile=95&lookbackWeeks=52"
  "/api/krx/futures?days=60"
  "/api/krx/investor-trend"
  "/api/radar/ranking"
  "/api/radar/consensus"
  "/api/kr/investor-flows"
  "/api/kr/stock-flows?codes=005930,000660"
  "/api/analytics/regime?years=5"
  "/api/analytics/correlation?x=fred:DGS10&y=fred:DGS2&window=60&years=3&mode=change"
  "/api/status"
  "/api/status/issues"
  "/api/snapshot/text"
  "/api/alerts/unread-count"
  "/api/paper/overview?market=US"
  "/api/paper/overview?market=KR"
  "/api/paper/status?market=US"
  "/api/paper/status?market=KR"
  "/api/detail/quote?market=us&code=AAPL"
)

printf '# %s KST N=%s\n' "$(TZ=Asia/Seoul date '+%F %T')" "$N"
printf '%-78s %6s %6s %6s %8s %5s\n' "endpoint" "첫(ms)" "중앙" "최대" "bytes" "code"
for ep in "${ENDPOINTS[@]}"; do
  times=(); size=0; code=0; first=0
  for i in $(seq 0 "$N"); do
    out=$(curl -s -o /dev/null -b "$JAR" -H 'Accept-Encoding: gzip' \
      -w '%{time_total} %{size_download} %{http_code}' "$BASE$ep")
    t=$(echo "$out" | awk '{printf "%d", $1*1000}'); size=$(echo "$out" | awk '{print $2}'); code=$(echo "$out" | awk '{print $3}')
    if [ "$i" -eq 0 ]; then first=$t; else times+=("$t"); fi   # 첫 호출은 중앙값·최대에서 뺌
  done
  median=$(printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}')
  max=$(printf '%s\n' "${times[@]}" | sort -n | tail -1)
  printf '%-78s %6s %6s %6s %8s %5s\n' "$ep" "$first" "$median" "$max" "$size" "$code"
done
