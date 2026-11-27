#!/usr/bin/env bash
# =============================================================================
# 시험을 일회용 PostgreSQL에 붙여 돌립니다 (make test-isolated).
#
#   bash scripts/test-isolated.sh                  # make test
#   bash scripts/test-isolated.sh test-collector   # make 대상을 골라서(여러 개도 됨)
#
# 왜 있나: 떠 있는 로컬 스택의 postgres(mem_limit 512m)에 전체 시험 여러 벌을 붙였다가 그 postgres가 메모리 부족으로 죽은 적이
# 있습니다. 여러 작업 폴더(worktree)에서 시험을 함께 돌릴 때는 이 명령을 씁니다 — 벌마다 postgres를 따로 띄우고, 끝나거나
# 중단되면 볼륨까지 지웁니다. `make test`의 뜻(떠 있는 스택의 postgres에 붙음)은 그대로입니다.
#
# 하는 일
#   1. 폴더 잠금 — 같은 작업 폴더에서 두 벌이 돌면 frontend/.next·backend/target이 서로를 덮으므로 바로 거절합니다.
#   2. 칸 잠금(flock) — 동시에 최대 두 칸. 세 벌 이상이면 화면의 5초 제한 시험이 흔들렸고 두 벌은 괜찮았습니다(2026-11-26·27 실측).
#      칸이 다 차 있으면 빌 때까지 기다립니다.
#   3. 칸마다 다른 compose 프로젝트(my_macrodash_v2_test_<칸>)와 루프백 포트로 scripts/test/docker-compose.testdb.yml을 띄웁니다.
#      --env-file /dev/null · -p · -f 를 모두 적어 이 폴더의 .env와 떠 있는 로컬·QA 스택을 건드리지 않습니다.
#   4. 셸의 TEST_DATABASE_URL을 지우고(있으면 포트 설정을 조용히 이김) 계정을 macro/macro(공개 기본값)로 맞춘 뒤
#      `make <대상> DATABASE_PORT=<포트> COMPOSE=<위 compose 명령>`을 부릅니다. make의 종료 코드를 그대로 돌려줍니다.
#   5. 끝나거나 INT·TERM으로 중단되면 `down -v`와 임시 폴더 정리.
#      한계: 이 스크립트를 INT가 무시된 채로 띄우면(비대화형 셸의 `&`, nohup 꼴 등) bash가 INT에 trap을 걸 수 없어
#      INT로는 멈추지 않습니다 — 그때는 TERM으로 끝냅니다(정리는 똑같이 돕니다).
#
# 포트: 25441(칸 1)·25442(칸 2). 이 PC에서 쓰이는 DB 포트는 로컬 스택 5432~5434(v3·v1·v2)와 QA 스택 1543x(v2 QA 15434)이고,
# 리눅스가 나가는 연결에 임의로 주는 범위는 32768부터라 그 사이의 254xx를 골랐습니다(끝자리는 로컬 5434·QA 15434와 같은 계열).
#
# 환경변수(평소에는 줄 필요 없음)
#   TEST_ISOLATED_SLOTS      동시 칸 수(기본 2 — 늘리면 화면 시험이 흔들릴 수 있음)
#   TEST_ISOLATED_PORT_BASE  칸 N의 포트 = 이 값 + N(기본 25440)
#   TEST_ISOLATED_WAIT       빈 칸을 기다리는 최대 초(기본 7200, 0이면 기다리지 않고 끝냄)
#   TEST_ISOLATED_LOCK_DIR   잠금 파일 폴더(기본 /tmp/my_macrodash_v2_test_locks — 모든 작업 폴더가 같은 자리를 봐야 칸을 나눠 씁니다)
#   VITEST_MAX_WORKERS       화면 시험 일꾼 수(기본 = CPU 수 / 칸 수)
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

SLOTS="${TEST_ISOLATED_SLOTS:-2}"
PORT_BASE="${TEST_ISOLATED_PORT_BASE:-25440}"
WAIT_MAX="${TEST_ISOLATED_WAIT:-7200}"
LOCK_DIR="${TEST_ISOLATED_LOCK_DIR:-/tmp/my_macrodash_v2_test_locks}"
COMPOSE_FILE_PATH="$ROOT/scripts/test/docker-compose.testdb.yml"
PROJECT_PREFIX="my_macrodash_v2_test_"

fail() { echo "✗ $*" >&2; exit 1; }

for n in "$SLOTS" "$PORT_BASE" "$WAIT_MAX"; do
    [[ "$n" =~ ^[0-9]+$ ]] || fail "TEST_ISOLATED_SLOTS·PORT_BASE·WAIT는 숫자여야 합니다: '$n'"
done
[ "$SLOTS" -ge 1 ] || fail "TEST_ISOLATED_SLOTS는 1 이상이어야 합니다."
for tool in docker make flock; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool 명령이 없습니다(이 스크립트는 리눅스·WSL2용입니다)."
done

if [ "$#" -eq 0 ]; then set -- test; fi
for target in "$@"; do
    # make 변수(이름=값)나 선택지(-C 등)를 받지 않습니다 — DATABASE_PORT·COMPOSE를 덮으면 떠 있는 스택에 붙습니다.
    [[ "$target" =~ ^[A-Za-z][A-Za-z0-9_-]*$ ]] || fail "make 대상 이름만 받습니다: '$target'"
done

# COMPOSE는 make에 한 줄 글로 넘어가므로 경로에 공백이 있으면 쪼개집니다.
[[ "$ROOT" != *[[:space:]]* ]] || fail "저장소 경로에 공백이 있으면 쓸 수 없습니다: $ROOT"

mkdir -p "$LOCK_DIR" || fail "잠금 폴더를 만들지 못했습니다: $LOCK_DIR"

# ---- 1. 폴더 잠금 (fd 9)
dir_key="$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
exec 9>"$LOCK_DIR/dir-$dir_key.lock" || fail "잠금 파일을 열지 못했습니다: $LOCK_DIR"
flock -n 9 || fail "이 작업 폴더에서 이미 격리 시험이 돌고 있습니다($ROOT) — frontend/.next·backend/target이 겹치므로 다른 작업 폴더(worktree)에서 돌리세요."

# ---- 2. 칸 잠금 (fd 8)
slot=""
waited=0
while :; do
    for i in $(seq 1 "$SLOTS"); do
        exec 8>"$LOCK_DIR/slot-$i.lock" || fail "잠금 파일을 열지 못했습니다: $LOCK_DIR"
        if flock -n 8; then slot="$i"; break; fi
        exec 8>&-
    done
    [ -z "$slot" ] || break
    [ "$waited" -lt "$WAIT_MAX" ] || fail "빈 칸이 없습니다(동시에 ${SLOTS}벌까지, ${waited}초 기다림). 돌고 있는 시험이 끝난 뒤 다시 부르세요."
    [ $((waited % 60)) -ne 0 ] || echo "참고: ${SLOTS}칸이 모두 쓰이고 있어 빌 때까지 기다립니다(동시에 ${SLOTS}벌까지)."
    sleep 5
    waited=$((waited + 5))
done

PORT=$((PORT_BASE + slot))
PROJECT="${PROJECT_PREFIX}${slot}"
export TESTDB_PORT="$PORT"          # compose 파일이 읽는 유일한 값 — make가 부르는 exec에도 필요합니다
COMPOSE_CMD=(docker compose --env-file /dev/null -p "$PROJECT" -f "$COMPOSE_FILE_PATH")

TMP=""
STARTED=0
CHILD=""

cleanup() {
    local rc=$?
    trap '' INT TERM
    if [ "$STARTED" = 1 ]; then
        if "${COMPOSE_CMD[@]}" down -v --remove-orphans >/dev/null 2>&1; then
            echo "✓ 일회용 postgres 정리: $PROJECT (컨테이너·볼륨 삭제)"
        else
            echo "경고: 일회용 postgres를 지우지 못했습니다 — 손으로: ${COMPOSE_CMD[*]} down -v" >&2
        fi
    fi
    [ -z "$TMP" ] || rm -rf "$TMP"
    exit "$rc"
}

# 중단되면 make와 그 자식들(mvn·node·pytest)을 먼저 멈춘 뒤 정리합니다. make는 자기 세션(프로세스 그룹)으로 띄웁니다.
on_signal() {
    local rc=$1
    trap '' INT TERM
    echo "" >&2
    echo "참고: 중단 신호를 받아 시험을 멈추고 정리합니다." >&2
    if [ -n "$CHILD" ]; then
        kill -TERM -- "-$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null
        for _ in $(seq 1 20); do
            kill -0 -- "-$CHILD" 2>/dev/null || kill -0 "$CHILD" 2>/dev/null || break
            sleep 0.5
        done
        kill -KILL -- "-$CHILD" 2>/dev/null
        wait "$CHILD" 2>/dev/null
    fi
    exit "$rc"
}
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# ---- 3. 일회용 postgres
# 칸 잠금을 쥐고 있으므로 이 프로젝트 이름으로 남은 것은 죽은 실행(kill -9·재부팅)의 찌꺼기입니다 — 먼저 지웁니다.
"${COMPOSE_CMD[@]}" down -v --remove-orphans >/dev/null 2>&1

# 그래도 포트가 쓰이고 있으면 다른 프로그램입니다(compose가 내는 긴 오류 대신 여기서 알림).
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    fail "포트 127.0.0.1:$PORT 가 이미 쓰이고 있습니다(칸 $slot). 그 포트를 쓰는 프로그램을 끝내거나 TEST_ISOLATED_PORT_BASE로 다른 자리를 주세요."
fi

echo "일회용 postgres 기동: 칸 $slot · 프로젝트 $PROJECT · 127.0.0.1:$PORT"
STARTED=1
"${COMPOSE_CMD[@]}" up -d --wait || fail "일회용 postgres를 띄우지 못했습니다(위 메시지 참고)."

# ---- 4. 시험 환경
unset TEST_DATABASE_URL                       # 있으면 make의 DATABASE_PORT를 조용히 이겨 떠 있는 스택의 DB에 붙습니다
export DATABASE_USER=macro DATABASE_PASSWORD=macro
unset MAKEFLAGS MFLAGS MAKELEVEL              # make test-isolated로 불렸을 때 바깥 make의 선택지·변수가 안쪽으로 새지 않게

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-isolated.XXXXXX")" || fail "임시 폴더를 만들지 못했습니다."
mkdir -p "$TMP/cache" "$TMP/py-yfinance"
# yfinance의 sqlite 캐시는 여러 벌이 같은 파일을 쓰면 잠깁니다(실제로 겪음) — 벌마다 따로 둡니다.
export XDG_CACHE_HOME="$TMP/cache" YFINANCE_CACHE_DIR="$TMP/py-yfinance"

if [ -z "${VITEST_MAX_WORKERS:-}" ]; then
    cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
    workers=$((cpus / SLOTS))
    [ "$workers" -ge 1 ] || workers=1
    export VITEST_MAX_WORKERS="$workers"      # vitest가 읽는 환경변수 — 두 벌이 CPU를 나눠 쓰게
fi

echo "시험 실행: make $* (DATABASE_PORT=$PORT · 화면 일꾼 $VITEST_MAX_WORKERS)"
make_cmd=(make "$@" "DATABASE_PORT=$PORT" "COMPOSE=${COMPOSE_CMD[*]}")
# 잠금 fd(8·9)는 자식에게 넘기지 않습니다 — 고아가 된 자식이 칸을 쥐고 있지 않게.
# 비대화형 셸이 `&`로 띄운 명령은 INT·QUIT을 무시한 채 시작하고 그 상태가 make → pytest·mvn·node → 시험이 띄우는 프로세스까지
# 물려 내려갑니다(INT를 보내 보는 시험이 멈춤 — 실제로 겪음). 그래서 두 신호를 기본값으로 되돌려 띄웁니다(coreutils env 8.32부터).
launch=()
if command -v setsid >/dev/null 2>&1; then launch+=(setsid); fi
if env --default-signal=INT,QUIT true 2>/dev/null; then
    launch+=(env --default-signal=INT,QUIT)
else
    echo "경고: 이 env는 --default-signal을 모릅니다 — 시험 프로세스가 INT를 무시한 채 돕니다(INT를 보내는 시험이 실패할 수 있음)." >&2
fi
"${launch[@]}" "${make_cmd[@]}" 8>&- 9>&- &
CHILD=$!
wait "$CHILD"
rc=$?
CHILD=""

if [ "$rc" -eq 0 ]; then
    echo "✓ 격리 시험 통과: make $*"
else
    echo "✗ 격리 시험 실패: make $* (종료 코드 $rc)" >&2
fi
exit "$rc"
