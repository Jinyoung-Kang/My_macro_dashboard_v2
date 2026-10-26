#!/usr/bin/env bash
#
# scripts/doctor.sh
# "화면에 데이터가 안 보인다"를 한 번에 진단합니다.
#
# 확인 순서는 데이터가 흐르는 순서와 같습니다.
#   컨테이너 → 수집기 → 저장소(PostgreSQL) → 백엔드 → 화면
# 앞 단계가 막혀 있으면 뒤 단계는 반드시 비어 있으므로, 가장 앞의 ✗ 하나만
# 고치면 됩니다. (여러 곳을 동시에 건드리면 무엇이 고쳤는지 알 수 없습니다.)
#
set -uo pipefail          # -e는 쓰지 않습니다. 실패한 검사도 끝까지 보여줘야 합니다.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
note()  { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
title() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }

get_env() { grep -s "^$1=" .env | head -1 | cut -d= -f2-; }
COLLECTOR_PORT=$(get_env COLLECTOR_PORT); COLLECTOR_PORT=${COLLECTOR_PORT:-8000}
BACKEND_PORT=$(get_env BACKEND_PORT);     BACKEND_PORT=${BACKEND_PORT:-8080}
FRONTEND_PORT=$(get_env FRONTEND_PORT);   FRONTEND_PORT=${FRONTEND_PORT:-3000}

PY=python3
[ -x collector/.venv/bin/python ] && PY=collector/.venv/bin/python

printf '%s\n' "${BOLD}My Macro Dashboard v2 — 진단${RESET}"

# 어느 코드로 돌고 있는지 먼저 밝힙니다. "고쳤다는 기능이 없다"의 절반은
# 그 코드가 아예 안 받아진 경우였습니다(다른 브랜치에 있는데 git pull만 함).
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '%s\n' "${DIM}코드: $(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD) — 자세히 보려면 make version${RESET}"
fi

FIRST_PROBLEM=""
problem() { [ -z "$FIRST_PROBLEM" ] && FIRST_PROBLEM="$1"; }

# ==============================================================================
title "1. 컨테이너"
# ==============================================================================
if ! docker info >/dev/null 2>&1; then
  fail "Docker 데몬에 연결하지 못했습니다"
  note "Docker Desktop을 실행한 뒤 다시 시도하세요"
  problem "Docker Desktop을 켜고 'make up'"
else
  RUNNING=$(docker compose ps --services --filter status=running 2>/dev/null | sort)
  for svc in postgres collector backend frontend; do
    if printf '%s\n' "$RUNNING" | grep -qx "$svc"; then
      ok "$svc 실행 중"
    else
      fail "$svc 꺼져 있음"
      note "make up  (또는 make logs S=$svc 로 기동 실패 원인 확인)"
      problem "make up"
    fi
  done
  # 백엔드·화면이 꺼져 있다면 가장 흔한 원인은 포트 충돌입니다(compose는 한 줄만 남김).
  if ! printf '%s\n' "$RUNNING" | grep -qx backend || ! printf '%s\n' "$RUNNING" | grep -qx frontend; then
    bash scripts/ports.sh check 2>&1 | sed '1d; s/^/  /' || true
  fi
fi

# ==============================================================================
title "2. 수집기 (Python) — 외부에서 데이터를 받아오는 쪽"
# ==============================================================================
STATUS_JSON=$(curl -fsS --max-time 10 "http://localhost:$COLLECTOR_PORT/status" 2>/dev/null)
if [ -z "$STATUS_JSON" ]; then
  fail "수집기에 연결하지 못했습니다 (http://localhost:$COLLECTOR_PORT/status)"
  note "make logs S=collector 로 기동 오류를 확인하세요"
  if docker compose logs --tail=100 collector 2>/dev/null | grep -q 'COLLECTOR_API_TOKEN이 비어 있습니다'; then
    note ".env의 COLLECTOR_API_TOKEN이 비어 있어 수집기가 뜨지 않습니다 — 'make setup'이 채워 줍니다 (임시로 띄우려면 COLLECTOR_ALLOW_NO_TOKEN=1)"
  fi
  problem "수집기 기동 실패 — make logs S=collector"
else
  ok "수집기 응답함"
  printf '%s' "$STATUS_JSON" | "$PY" -c '
import json, sys
d = json.load(sys.stdin)
tasks = d.get("taskSummary") or []
bad = [t for t in tasks if t.get("status") != "ok"]
print("    마지막 실행:", d.get("lastRunStatus"))
print(f"    작업 {len(tasks) - len(bad)}/{len(tasks)} 정상")
for t in bad:
    detail = (t.get("detail") or "").strip()
    print("    x %s: %s" % (t.get("task"), detail[:160]))
missing = d.get("missingDatasets") or []
if missing:
    print("    비어 있는 데이터셋:", ", ".join(missing[:8]),
          ("…" if len(missing) > 8 else ""))
' 2>/dev/null || note "(상태 JSON을 해석하지 못했습니다)"

  # 실패 작업이 있으면 원인을 로그에서 한 번 더 긁어 옵니다.
  if printf '%s' "$STATUS_JSON" | grep -q '"status": *"fail"'; then
    warn "실패한 수집 작업이 있습니다 — 최근 오류 로그:"
    docker compose logs --tail=400 collector 2>/dev/null \
      | grep -E 'ERROR|WARNING' | tail -8 | sed 's/^/      /'
    problem "수집 실패 — 위 사유를 보고 키/네트워크를 확인"
  fi
fi

# ==============================================================================
title "3. 저장소 (PostgreSQL) — 실제로 쌓였는지"
# ==============================================================================
# psql이 로컬에 없어도 됩니다. 컨테이너 안의 psql을 씁니다.
DB_USER=$(get_env DATABASE_USER); DB_USER=${DB_USER:-macro}
DB_NAME=$(get_env DATABASE_NAME); DB_NAME=${DB_NAME:-macrodash}
ROWS=$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tA \
  -c "select rpad(name, 22) || to_char(collected_at, 'MM-DD HH24:MI') || '  ' || status
      from snapshots order by collected_at desc limit 10;" 2>/dev/null)
if [ -z "$ROWS" ]; then
  fail "snapshots 테이블이 비어 있습니다 (아직 한 번도 수집되지 않았습니다)"
  note "make collect  로 한 번 수집한 뒤 다시 실행하세요"
  problem "make collect"
else
  ok "최근 저장된 스냅샷:"
  printf '%s\n' "$ROWS" | sed 's/^/      /'
fi

# ==============================================================================
title "4. 백엔드 (Java) — 화면이 읽는 API"
# ==============================================================================
# 헬스체크는 DB에 닿지 못하면 503(본문 "database": "unreachable")을 돌려줍니다 — 기동 실패와 다릅니다.
HEALTH_RESPONSE=$(curl -s -w '\n%{http_code}' --max-time 10 "http://localhost:$BACKEND_PORT/api/health" 2>/dev/null)
HEALTH_CODE=${HEALTH_RESPONSE##*$'\n'}
HEALTH=${HEALTH_RESPONSE%$'\n'*}
case "$HEALTH_CODE" in
  200)
    ok "백엔드 응답함: $(printf '%s' "$HEALTH" | cut -c1-120)" ;;
  503)
    fail "백엔드는 떠 있지만 DB에 닿지 못합니다: $(printf '%s' "$HEALTH" | cut -c1-120)"
    note "make logs S=postgres · make logs S=backend"
    problem "백엔드가 DB에 닿지 못함 — make logs S=postgres" ;;
  *)
    fail "백엔드에 연결하지 못했습니다 (http://localhost:$BACKEND_PORT/api/health)"
    note "make logs S=backend"
    problem "백엔드 기동 실패 — make logs S=backend" ;;
esac

# 운영자 계정 — 처음 기동할 때 계정이 없으면 OWNER_EMAIL·APP_PASSWORD로 만듭니다(ADR 0010). 로컬 화면은 로그인 없이
# 이 계정으로 열리므로(ADR 0016) 계정이 없으면 화면을 쓸 수 없습니다. 백엔드가 /api/auth/session에 알려 주는
# noLogin·ownerMissing을 먼저 보고, 답이 없거나(꺼져 있음·옛 백엔드) 로그인 화면 모드면 .env를 봅니다.
LOGIN_MODE=$(curl -fsS --max-time 5 "http://localhost:$BACKEND_PORT/api/auth/session" 2>/dev/null | "$PY" -c '
import json, sys
d = json.load(sys.stdin)
print("missing" if d.get("ownerMissing") is True else {True: "on", False: "off"}.get(d.get("noLogin"), ""))
' 2>/dev/null)
case "$LOGIN_MODE" in
  missing)
    fail "운영자 계정이 없어 로그인 없이 열 수 없습니다"
    note ".env에 OWNER_EMAIL(이메일)과 APP_PASSWORD를 넣고 make up — 'make setup'이 APP_PASSWORD를 만들어 줍니다"
    problem "운영자 계정 만들기 — .env의 OWNER_EMAIL·APP_PASSWORD를 채우고 make up" ;;
  on)
    ok "로그인 없이 운영자 계정으로 열립니다 (LOCAL_NO_LOGIN)" ;;
  *)
    [ "$LOGIN_MODE" = "off" ] && note "로그인 화면을 거칩니다 (.env의 LOCAL_NO_LOGIN=false)"
    if [ -z "$(get_env OWNER_EMAIL)" ]; then
      warn "OWNER_EMAIL이 .env에 없습니다 — 계정이 아직 없다면 화면을 쓸 수 없습니다(이미 계정이 있으면 무시해도 됩니다)"
      note ".env에 OWNER_EMAIL=운영자 계정 이메일 을 넣고 make up"
    fi ;;
esac

# ==============================================================================
title "5. 화면 (Next.js)"
# ==============================================================================
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$FRONTEND_PORT/" 2>/dev/null)
if [ "$CODE" = "200" ] || [ "$CODE" = "307" ] || [ "$CODE" = "302" ]; then
  ok "화면 응답함 (HTTP $CODE) → http://localhost:$FRONTEND_PORT"
else
  fail "화면이 응답하지 않습니다 (HTTP ${CODE:-없음})"
  note "make logs S=frontend"
  problem "화면 기동 실패 — make logs S=frontend"
fi

# ==============================================================================
title "결론"
# ==============================================================================
if [ -z "$FIRST_PROBLEM" ]; then
  printf '  %s모든 단계가 정상입니다.%s\n' "$GREEN" "$RESET"
  note "그래도 화면이 비어 있으면: make status 의 '누락 데이터셋' 목록을 확인하세요."
  note "(LOCAL_NO_LOGIN=false로 로그인 화면을 켰다면 브라우저에서 로그인했는지도)"
else
  printf '  가장 먼저 할 일: %s%s%s\n' "$BOLD" "$FIRST_PROBLEM" "$RESET"
  note "앞 단계가 막히면 뒤 단계는 반드시 비어 있습니다. 하나씩 고치세요."
fi
printf '\n'
