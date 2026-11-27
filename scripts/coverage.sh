#!/usr/bin/env bash
# 세 묶음(수집기·백엔드·화면)의 시험을 커버리지를 재며 돌리고 '시험 없는 자리' 목록을 냅니다(make coverage).
#
# 문턱값으로 막지 않습니다 — 목록만 냅니다(품질 개선 계획 P6-다). 평소 `make test`·CI는 이 스크립트를 부르지 않습니다.
# 커버리지를 재면 시험이 느려지므로(특히 수집기) 시간에 기대는 시험이 평소보다 흔들릴 수 있습니다. 시험이 실패한
# 묶음이 있어도 만들어진 보고서로 목록은 내고, 마지막에 그 사실을 알린 뒤 0이 아닌 코드로 끝납니다.
#
# 쓰는 법(make가 환경을 채워 부릅니다 — 직접 부를 때는 아래 환경변수를 넘깁니다):
#   bash scripts/coverage.sh [collector] [backend] [frontend]      # 묶음을 고르지 않으면 셋 다
#   bash scripts/coverage.sh report                                 # 시험은 돌리지 않고 남아 있는 보고서로 목록만
# 환경변수:
#   COLLECTOR_TEST_DATABASE_URL · BACKEND_TEST_DATABASE_URL  시험 DB(macrodash_test) 주소 — 운영 DB로 돌리지 않습니다
#   COLLECTOR_PY     수집기 파이썬(기본 collector/.venv/bin/python, 없으면 python3)
#   PYTEST_ARGS      pytest 인자(기본 tests) · VITEST_ARGS vitest에 더할 인자 · MVN_ARGS mvn에 더할 인자(예: -Dtest=…)
#   COVERAGE_OUT     산출물 폴더(기본 coverage-out — 커밋하지 않음) · TOP 화면에 보일 파일 수(기본 40)
#   JACOCO_VERSION   JaCoCo 판(pom은 고치지 않고 명령줄 좌표로 부릅니다)
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

OUT=${COVERAGE_OUT:-coverage-out}
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
JACOCO_VERSION=${JACOCO_VERSION:-0.8.16}
JACOCO="org.jacoco:jacoco-maven-plugin:$JACOCO_VERSION"
JACOCO_XML="$ROOT/backend/target/site/jacoco/jacoco.xml"

parts=("$@")
[ ${#parts[@]} -gt 0 ] || parts=(collector backend frontend)
for part in "${parts[@]}"; do
  case "$part" in
    collector|backend|frontend|report) ;;
    *) echo "경고: 모르는 묶음 '$part' — collector · backend · frontend · report 가운데서 고릅니다." >&2; exit 2 ;;
  esac
done

# 운영 DB로 시험하지 않습니다 — 주소의 DB 이름이 _test로 끝나지 않으면 시작하지 않습니다(주소는 비밀번호가 들어 있어 찍지 않음).
require_test_db() { # $1 = 변수 이름
  local value=${!1:-}
  if [ -z "$value" ]; then
    echo "경고: $1이 비어 있습니다 — make coverage로 부르거나 시험 DB(macrodash_test) 주소를 넘깁니다." >&2
    exit 2
  fi
  local name=${value%%\?*}
  name=${name##*/}
  case "$name" in
    *_test) ;;
    *) echo "경고: $1의 DB 이름이 _test로 끝나지 않습니다 — 운영 DB로는 시험하지 않습니다." >&2; exit 2 ;;
  esac
}

# 고른 묶음의 주소를 먼저 다 확인합니다 — 하나라도 틀리면 아무것도 돌리지 않습니다.
for part in "${parts[@]}"; do
  case "$part" in
    collector) require_test_db COLLECTOR_TEST_DATABASE_URL ;;
    backend) require_test_db BACKEND_TEST_DATABASE_URL ;;
  esac
done

failed=()
mkdir -p "$OUT"

run_collector() {
  local py=${COLLECTOR_PY:-}
  if [ -z "$py" ]; then
    if [ -x "$ROOT/collector/.venv/bin/python" ]; then py="$ROOT/collector/.venv/bin/python"; else py=python3; fi
  fi
  if ! "$py" -c 'import coverage' 2>/dev/null; then
    echo "경고: 수집기 파이썬에 coverage가 없습니다 — collector/.venv/bin/pip install -r collector/requirements-dev.txt -c collector/constraints.txt" >&2
    failed+=("수집기(coverage 없음)")
    return
  fi
  mkdir -p "$OUT/collector"
  rm -f "$OUT/collector/.coverage" "$OUT/collector/coverage.json"
  echo "== 수집기: pytest를 커버리지를 재며 돌립니다 =="
  # 시험이 띄우는 다른 프로세스 안의 코드는 재지 않습니다(이 프로세스가 실행한 줄만).
  # shellcheck disable=SC2086
  (cd collector && TEST_DATABASE_URL="$COLLECTOR_TEST_DATABASE_URL" \
    "$py" -m coverage run --data-file="$OUT/collector/.coverage" --source=app,sidecar -m pytest ${PYTEST_ARGS:-tests} -q) \
    || failed+=("수집기")
  (cd collector && "$py" -m coverage json -q --data-file="$OUT/collector/.coverage" -o "$OUT/collector/coverage.json") \
    || failed+=("수집기(보고서)")
}

run_backend() {
  echo "== 백엔드: mvn verify를 JaCoCo $JACOCO_VERSION 에이전트와 함께 돌립니다 =="
  rm -f "$ROOT/backend/target/jacoco.exec" "$JACOCO_XML"
  # shellcheck disable=SC2086
  (cd backend && TEST_DATABASE_URL="$BACKEND_TEST_DATABASE_URL" mvn -B "$JACOCO:prepare-agent" verify ${MVN_ARGS:-}) \
    || failed+=("백엔드")
  # 시험이 실패해도 실행 기록(target/jacoco.exec)은 남으므로 보고서는 따로 만듭니다.
  (cd backend && mvn -B -q "$JACOCO:report") || failed+=("백엔드(보고서)")
}

run_frontend() {
  echo "== 화면: vitest를 v8 커버리지와 함께 돌립니다 =="
  # 앞 실행의 보고서는 vitest가 스스로 지웁니다(coverage.clean 기본값).
  # 순수 함수 검사(npm run check — node로 직접 도는 *.check.mts)는 vitest 밖이라 재지 않습니다.
  # shellcheck disable=SC2086
  (cd frontend && npx vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=json \
    --coverage.reportsDirectory="$OUT/frontend" --coverage.reportOnFailure \
    --coverage.include='src/**/*.{ts,tsx}' \
    --coverage.exclude='src/**/__tests__/**' --coverage.exclude='src/**/__checks__/**' --coverage.exclude='src/**/*.d.ts' \
    ${VITEST_ARGS:-}) || failed+=("화면")
}

for part in "${parts[@]}"; do
  case "$part" in
    collector) run_collector ;;
    backend) run_backend ;;
    frontend) run_frontend ;;
    report) ;;
  esac
done

header="잰 시각 $(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M KST') · 커밋 $(git rev-parse --short HEAD 2>/dev/null || echo '?') · 이번에 돌린 묶음: ${parts[*]}"
python3 scripts/coverage_report.py \
  --collector "$OUT/collector/coverage.json" --backend "$JACOCO_XML" --frontend "$OUT/frontend/coverage-final.json" \
  --out "$OUT/uncovered.md" --top "${TOP:-40}" --header "$header" || exit 1

if [ ${#failed[@]} -gt 0 ]; then
  echo "경고: 시험이 실패했거나 보고서를 만들지 못한 묶음 — ${failed[*]}. 그 묶음의 숫자는 끝까지 돈 결과가 아닙니다." >&2
  exit 1
fi
