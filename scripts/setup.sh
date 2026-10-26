#!/usr/bin/env bash
#
# scripts/setup.sh
# 최초 1회 준비 스크립트 (macOS · Linux 공통).
#
#   1) .env 생성 (.env.example 복사)
#   2) 운영자 계정 이메일(OWNER_EMAIL) 확인 · 수집기 내부 토큰(COLLECTOR_API_TOKEN) 자동 생성
#      — 기본 placeholder나 빈 값을 쓰면 안 됩니다. 둘 다 외부 API 키가 아닙니다
#   3) 필수 도구 확인 (Docker / 네이티브 실행용 Java·Node·Python)
#   4) 포트 충돌 확인 (3000 · 8080 · 8000 · 5432 · 6379)
#
# 이미 .env가 있으면 덮어쓰지 않습니다. 여러 번 실행해도 안전합니다.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# macOS 기본 터미널에서도 색이 깨지지 않는 범위만 씁니다.
BOLD=$(printf '\033[1m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
RED=$(printf '\033[31m')
DIM=$(printf '\033[2m')
RESET=$(printf '\033[0m')

ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
note()  { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
title() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }

printf '%s\n' "${BOLD}My Macro Dashboard v2 — 준비${RESET}"
printf '%s\n' "${DIM}경로: $REPO_ROOT${RESET}"

# ==============================================================================
# 1. .env
# ==============================================================================
title "1. 환경 파일"

if [ -f .env ]; then
  ok ".env가 이미 있습니다 (덮어쓰지 않습니다)"
else
  # 머리말까지 그대로 복사하면 .env 첫 줄이 "# .env.example — …"로 남습니다.
  # 파일을 열어 본 사람이 "내가 잘못 저장했나?" 하고 헷갈립니다. 바꿔 둡니다.
  sed '1,6s|^# \.env\.example — docker compose가 읽는 값들\.$|# .env — 이 파일이 실제로 쓰입니다 (scripts/setup.sh가 .env.example에서 생성).|' \
      .env.example > .env
  ok ".env를 만들었습니다 (.env.example 복사)"
fi

# --- .env 형식 점검 -------------------------------------------------------
# docker compose는 KEY=VALUE 한 줄 형식만 읽습니다. 값에 따옴표를 두르거나
# `export KEY=...`로 적으면 따옴표·export가 값의 일부가 되어 조용히 틀립니다.
bad_lines=$(grep -nE '^[[:space:]]*export[[:space:]]|^[[:space:]]+[A-Z_]+=' .env 2>/dev/null || true)
if [ -n "$bad_lines" ]; then
  warn ".env에 docker compose가 못 읽는 줄이 있습니다"
  printf '%s\n' "$bad_lines" | head -5 | sed 's/^/      /'
  note "KEY=VALUE 형식으로, 줄 맨 앞에서 시작해야 합니다 (export·들여쓰기 금지)"
fi

# --- 더 쓰지 않는 값 --------------------------------------------------------
# 화면·API는 이제 늘 127.0.0.1에만 열립니다(로컬은 로그인 없이 운영자로 열려 밖에 열지 않음, ADR 0016).
# 예전 .env의 WEB_BIND_HOST=0.0.0.0은 조용히 무시되므로, 휴대폰 접속이 되리라 기대하지 않게 알려 줍니다.
if grep -Eq '^WEB_BIND_HOST=' .env 2>/dev/null && ! grep -Eq '^WEB_BIND_HOST=127\.0\.0\.1[[:space:]]*$' .env; then
  warn "WEB_BIND_HOST는 더 쓰지 않습니다 — 화면·API는 이 맥(127.0.0.1)에서만 열립니다"
  note "휴대폰 등 다른 기기에서는 접속할 수 없습니다. .env에서 이 줄을 지워도 됩니다"
fi

# --- 운영자 계정 이메일 -----------------------------------------------------
# 처음 기동할 때 계정이 없으면 OWNER_EMAIL·APP_PASSWORD로 운영자 계정을 만듭니다(ADR 0010).
# 로컬 화면은 로그인 없이 이 계정으로 열리므로(ADR 0016) 계정이 없으면 화면을 쓸 수 없습니다.
# 로그인 아이디라 자리표시 값을 대신 넣지 않습니다 — 비어 있으면 알려만 줍니다.
if ! grep -q '^OWNER_EMAIL=.\+' .env 2>/dev/null; then
  grep -q '^OWNER_EMAIL=' .env 2>/dev/null || printf '\nOWNER_EMAIL=\n' >> .env
  warn "OWNER_EMAIL이 비어 있습니다. .env에 운영자 계정 이메일(로그인 아이디)을 넣으세요 (예: OWNER_EMAIL=본인이메일)"
  note "넣은 뒤 make up — 그 전에는 운영자 계정이 없어 화면을 열 수 없습니다"
else
  ok "OWNER_EMAIL이 설정돼 있습니다"
fi

# --- 수집기 내부 토큰 -----------------------------------------------------
# 비어 있으면 수집기가 기동하지 않습니다(COLLECTOR_ALLOW_NO_TOKEN=1일 때만 인증 없이 뜸). 외부 API 키가 아니라 이 컴퓨터 안에서
# 백엔드·make가 수집기를 부를 때 쓰는 값이라, 무작위로 만들어 두면 됩니다
# (docker compose가 백엔드·수집기에 같은 값을 넘기고, Makefile도 이 값을 읽습니다).
if ! grep -q '^COLLECTOR_API_TOKEN=.' .env 2>/dev/null; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN=$(openssl rand -hex 32)
    if grep -q '^COLLECTOR_API_TOKEN=' .env 2>/dev/null; then
      tmp=$(mktemp)
      awk -v token="$TOKEN" \
        '/^COLLECTOR_API_TOKEN=/ { print "COLLECTOR_API_TOKEN=" token; next } { print }' .env > "$tmp"
      mv "$tmp" .env
    else
      printf 'COLLECTOR_API_TOKEN=%s\n' "$TOKEN" >> .env
    fi
    ok "COLLECTOR_API_TOKEN(수집기 내부 토큰)을 무작위 값으로 생성했습니다 — 'make up'으로 반영하세요"
  else
    warn "openssl이 없어 COLLECTOR_API_TOKEN을 생성하지 못했습니다. .env에 무작위 문자열을 직접 넣으세요"
  fi
else
  ok "COLLECTOR_API_TOKEN이 설정돼 있습니다"
fi

# --- 운영자 계정 비밀번호 -------------------------------------------------
# 비었거나 옛 공개 기본값(admin1234@)이면 무작위로 만듭니다. 백엔드는 이 두 경우에 운영자 계정을 만들지 않아,
# 로그인 없는 로컬 화면도 열리지 않습니다. 비밀번호 자체는 로그인 화면(LOCAL_NO_LOGIN=false)에서 씁니다.
if ! grep -q '^APP_PASSWORD=.' .env 2>/dev/null || grep -Eq '^APP_PASSWORD=admin1234@[[:space:]]*(#.*)?$' .env; then
  if command -v openssl >/dev/null 2>&1; then
    # 헷갈리는 문자(0 O 1 l I)와 기호를 빼 손으로 옮겨 적기 쉽게 합니다.
    PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-HJ-NP-Za-km-z2-9' | cut -c1-16)
    if grep -q '^APP_PASSWORD=' .env 2>/dev/null; then
      tmp=$(mktemp)
      awk -v value="$PASSWORD" \
        '/^APP_PASSWORD=/ { print "APP_PASSWORD=" value; next } { print }' .env > "$tmp"
      mv "$tmp" .env
    else
      printf 'APP_PASSWORD=%s\n' "$PASSWORD" >> .env
    fi
    ok "APP_PASSWORD(운영자 계정 비밀번호)를 무작위 값으로 만들었습니다: $PASSWORD"
    note "처음 기동할 때 운영자 계정을 만드는 데 씁니다. 로컬 화면은 로그인 없이 그 계정으로 열리고,"
    note "로그인 화면을 켜면(LOCAL_NO_LOGIN=false) 이 비밀번호로 들어갑니다. 원하는 값으로 바꾸려면 .env의 APP_PASSWORD를 고치고 'make up' 하세요."
  else
    warn "openssl이 없어 APP_PASSWORD를 만들지 못했습니다. .env의 APP_PASSWORD에 직접 넣으세요"
    note "비었거나 admin1234@면 운영자 계정이 만들어지지 않아 화면을 열 수 없습니다."
  fi
else
  ok "APP_PASSWORD가 설정돼 있습니다 (기본값 아님)"
fi

# --- API 키 현황 ----------------------------------------------------------
title "2. 외부 API 키 (없어도 실행됩니다)"

check_key() {
  local var="$1" label="$2" effect="$3"
  local value
  value=$(grep "^${var}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  if [ -n "$value" ]; then
    ok "$label"
  else
    warn "$label 없음 → $effect"
  fi
}

check_key FRED_API_KEY "FRED"        "웹 CSV로 폴백 (대부분 정상 동작)"
check_key KRX_API_KEY  "KRX"         "선물이 KODEX 200 기반 추정치로 표시"
check_key KIS_APP_KEY  "한국투자증권" "장중 수급 가집계·교차 검증 비활성화"
check_key LS_APP_KEY   "LS증권"       "수급 레이더에서 LS 단계만 건너뜀"
check_key NVIDIA_API_KEY "AI(NVIDIA)" "AI 메뉴 비활성화 (Cerebras/Cloudflare로 대체 가능)"
check_key SEC_USER_AGENT "SEC 연락처" "13F 수집 중단 — .env에 본인 이메일을 넣으세요 (키 아님)"

# SEC 연락처는 "있다/없다"만으로 부족합니다. 한글이 섞이면 HTTP 헤더를
# latin-1로 인코딩할 수 없어 UnicodeEncodeError가 나는데, 그 메시지만 보고
# .env를 고쳐야 한다는 걸 알아채기 어렵습니다.
sec_ua=$(grep "^SEC_USER_AGENT=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)
if [ -n "$sec_ua" ]; then
  if printf '%s' "$sec_ua" | LC_ALL=C grep -q '[^ -~]'; then
    fail "SEC_USER_AGENT에 영문/숫자가 아닌 문자가 있습니다: $sec_ua"
    note "HTTP 헤더는 한글을 담을 수 없습니다. 실제 이메일을 영문 그대로 적으세요"
  elif printf '%s' "$sec_ua" | grep -qi 'example\.com\|your-name\|your-email'; then
    warn "SEC_USER_AGENT가 예시 값 그대로입니다: $sec_ua"
    note "SEC는 연락이 닿지 않는 요청을 차단합니다. 실제 이메일로 바꾸세요"
  elif ! printf '%s' "$sec_ua" | grep -q '@'; then
    warn "SEC_USER_AGENT에 이메일 주소가 없습니다: $sec_ua"
  fi
fi

# ==============================================================================
# 3. 실행 도구
# ==============================================================================
title "3. 실행 방법 확인"

DOCKER_READY=0
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    DOCKER_READY=1
    ok "Docker 실행 중 → 'make up' 한 줄로 전체 스택을 띄울 수 있습니다"
  else
    warn "Docker는 설치돼 있지만 데몬이 꺼져 있습니다"
    note "Docker Desktop을 실행한 뒤 다시 시도하세요 (또는 아래 네이티브 실행)"
  fi
else
  warn "Docker가 없습니다 → 네이티브 실행 경로를 쓰세요 (docs/LOCAL_SETUP.md)"
fi

NATIVE_READY=1
check_tool() {
  local cmd="$1" label="$2" hint="$3" version
  if command -v "$cmd" >/dev/null 2>&1; then
    # JAVA_TOOL_OPTIONS 같은 환경 안내가 섞여 나오는 경우가 있어 걸러 냅니다.
    version=$("$cmd" --version 2>&1 | grep -v '^Picked up' | head -1 | cut -c1-60)
    ok "$label: $version"
  else
    NATIVE_READY=0
    warn "$label 없음 — $hint"
  fi
}

if [ "$DOCKER_READY" -eq 1 ]; then
  # Docker로 돌리면 Java·Maven·Node·psql이 **로컬에 없어도 됩니다**.
  # 전부 컨테이너 안에 있습니다. 여기서 경고를 띄우면 없어도 되는 도구를
  # 설치하러 가게 만듭니다.
  note "Docker를 쓰면 Java·Maven·Node·psql을 따로 설치하지 않아도 됩니다"
else
  check_tool java   "Java 21"    "brew install --cask temurin@21 (17은 빌드되지 않습니다)"
  check_tool mvn    "Maven"      "brew install maven"
  check_tool node   "Node.js"    "brew install node@22"
  check_tool python3 "Python"    "brew install python@3.11"

  # 백엔드는 Java 21 문법(record pattern 등)을 씁니다. 17이면 컴파일 실패합니다.
  if command -v java >/dev/null 2>&1; then
    JAVA_MAJOR=$(java -version 2>&1 | head -1 \
      | sed -E 's/.*version "([0-9]+).*/\1/')
    if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt 21 ] 2>/dev/null; then
      fail "Java $JAVA_MAJOR입니다 — 백엔드는 Java 21 이상이 필요합니다"
      note "brew install --cask temurin@21 후 JAVA_HOME을 21로 맞추세요"
      NATIVE_READY=0
    fi
  fi
fi

if [ "$DOCKER_READY" -eq 0 ] && [ "$NATIVE_READY" -eq 0 ]; then
  fail "Docker도, 네이티브 도구도 준비되지 않았습니다. 둘 중 하나를 갖추세요."
fi

# ==============================================================================
# 4. 포트 충돌
# ==============================================================================
title "4. 포트 확인"

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

# 이 프로젝트의 컨테이너가 이미 그 포트를 잡고 있는 경우가 흔합니다
# (make up → make setup 재실행). 그건 충돌이 아니라 정상 동작이므로
# "포트를 바꾸세요"라고 안내하면 안 됩니다. 먼저 우리 컨테이너 목록을
# 한 번만 조회해 둡니다.
# compose 버전마다 --format 지원이 달라 두 경로를 모두 시도합니다.
OWN_PORTS=""
if [ "$DOCKER_READY" -eq 1 ]; then
  OWN_PORTS=$(docker compose ps --format json 2>/dev/null \
    | grep -oE '"PublishedPort":[[:space:]]*[0-9]+' \
    | grep -oE '[0-9]+$' | sort -u || true)
  if [ -z "$OWN_PORTS" ]; then
    OWN_PORTS=$(docker compose ps 2>/dev/null \
      | grep -oE '(0\.0\.0\.0|\[::\]|127\.0\.0\.1):[0-9]+->' \
      | grep -oE ':[0-9]+->' | grep -oE '[0-9]+' | sort -u || true)
  fi
fi

owned_by_us() {
  [ -n "$OWN_PORTS" ] && printf '%s\n' "$OWN_PORTS" | grep -qx "$1"
}

CONFLICT=0
check_port() {
  local port="$1" label="$2" envvar="$3"
  if owned_by_us "$port"; then
    ok "$port ($label) — 이 프로젝트의 컨테이너가 사용 중 (정상)"
  elif port_in_use "$port"; then
    CONFLICT=1
    warn "$port ($label) 다른 프로그램이 사용 중"
    note ".env의 ${envvar}를 다른 값으로 바꾸거나, 그 프로그램을 끄세요"
    note "무엇이 쓰는지 확인: lsof -nP -iTCP:$port -sTCP:LISTEN"
  else
    ok "$port ($label) 비어 있음"
  fi
}

check_port 3000 "화면"       "FRONTEND_PORT"
check_port 8080 "백엔드 API" "BACKEND_PORT"
check_port 8000 "수집기"     "COLLECTOR_PORT"
check_port 5432 "PostgreSQL" "DATABASE_PORT"

if [ "$CONFLICT" -eq 1 ]; then
  note "FRONTEND_ORIGIN·NEXT_PUBLIC_API_BASE를 .env에 직접 적어 두셨다면 새 포트로 함께 고치세요"
  note "(두 줄을 지우면 포트를 자동으로 따라갑니다)."
fi

# ==============================================================================
# 5. 다음 단계
# ==============================================================================
title "다음 단계"

if [ "$DOCKER_READY" -eq 1 ]; then
  front_port="$(grep -s '^FRONTEND_PORT=' .env | cut -d= -f2)"
  cat <<NEXT
    make up        # 전체 스택 기동 (최초 빌드 5~10분)
    make collect   # 첫 데이터 수집 (없으면 화면이 비어 있습니다)
    open http://localhost:${front_port:-3002}
NEXT
else
  cat <<'NEXT'
    Docker 없이 실행하려면: docs/LOCAL_SETUP.md 의 "네이티브 실행" 절을 따르세요.
NEXT
fi

printf '\n'
