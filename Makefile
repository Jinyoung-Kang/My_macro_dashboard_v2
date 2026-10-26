# =============================================================================
# Makefile — 자주 쓰는 명령 모음
#
#   make setup    최초 1회 준비 (.env 생성 · 키 확인 · 포트 확인)
#   make update   최신 코드 받기 (git pull 대신 이걸 쓰세요)
#   make up       전체 스택 기동
#   make collect  지금 데이터 수집 (첫 실행 후 반드시 한 번)
#   make status   수집 현황 확인
#   make down     정지
#
# Docker 없이 쓰는 개발 명령은 make dev-* 를 보세요.
# =============================================================================

SHELL := /bin/bash
COMPOSE := docker compose

# .env가 있으면 포트 설정을 읽어 안내 문구에 씁니다(없으면 기본값).
FRONTEND_PORT ?= $(shell grep -s '^FRONTEND_PORT=' .env | cut -d= -f2)
FRONTEND_PORT := $(if $(FRONTEND_PORT),$(FRONTEND_PORT),3000)
BACKEND_PORT ?= $(shell grep -s '^BACKEND_PORT=' .env | cut -d= -f2)
BACKEND_PORT := $(if $(BACKEND_PORT),$(BACKEND_PORT),8080)
COLLECTOR_PORT ?= $(shell grep -s '^COLLECTOR_PORT=' .env | cut -d= -f2)
COLLECTOR_PORT := $(if $(COLLECTOR_PORT),$(COLLECTOR_PORT),8000)
DATABASE_PORT ?= $(shell grep -s '^DATABASE_PORT=' .env | cut -d= -f2)
DATABASE_PORT := $(if $(DATABASE_PORT),$(DATABASE_PORT),5432)

# 수집기 API 토큰(.env). 설정돼 있으면 curl에 헤더로 실어 보냅니다.
# 예전에는 make collect·status·verify가 토큰을 보내지 않아, 토큰을 켜는 순간
# 이 명령들이 401로 죽었습니다.
COLLECTOR_API_TOKEN ?= $(shell grep -s '^COLLECTOR_API_TOKEN=' .env | cut -d= -f2-)
TOKEN_HEADER := $(if $(COLLECTOR_API_TOKEN),-H "X-Service-Token: $(COLLECTOR_API_TOKEN)",)
# 토큰 없이 띄우겠다는 명시(로컬 개발용, .env.example 참고). make dev-collector가 수집기에 넘깁니다.
COLLECTOR_ALLOW_NO_TOKEN ?= $(shell grep -s '^COLLECTOR_ALLOW_NO_TOKEN=' .env | cut -d= -f2-)

.DEFAULT_GOAL := help
.PHONY: help setup update version up migrate down restart logs ps collect collect-all status verify \
        doctor test db-test test-collector test-backend test-frontend \
        dev-collector dev-backend dev-frontend db infra backup restore reset constraints

# 네이티브 개발용 파이썬. collector/.venv가 있으면 그것을 씁니다.
# (conda base 같은 다른 파이썬이 PATH 앞에 있으면 pytest·uvicorn을
#  "모듈 없음"으로 실패시킵니다. 실제로 겪은 오류입니다.)
VENV_PY := collector/.venv/bin/python
PY := $(shell test -x $(VENV_PY) && echo $(VENV_PY) || echo python3)

# 지금 체크아웃된 코드의 브랜치와 커밋. 빌드할 때 화면 왼쪽 아래에 새겨 두므로,
# "받은 줄 알았는데 예전 코드였다"를 화면만 보고 알 수 있습니다.
GIT_BRANCH := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null)
export APP_VERSION := $(if $(GIT_BRANCH),$(GIT_BRANCH)@$(GIT_COMMIT),)
# 그 커밋의 날짜(KST) — 화면 왼쪽 아래에 '최종 수정'으로 함께 새깁니다.
export APP_UPDATED := $(shell TZ=Asia/Seoul git log -1 --format=%cd --date=format-local:%Y-%m-%d 2>/dev/null)

help: ## 사용 가능한 명령 목록
	@echo ""
	@echo "My Macro Dashboard v2"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ------------------------------------------------------------------ 준비·기동
setup: ## 최초 1회 준비 (.env 생성 · 키/포트 확인)
	@bash scripts/setup.sh

update: ## 최신 코드 받기 (git pull 대신 — 다른 브랜치의 새 작업까지 알려 줍니다)
	@bash scripts/update.sh

version: ## 지금 체크아웃된 코드의 브랜치·커밋과 원격 대비 상태
	@bash scripts/version.sh

up: ## 전체 스택 기동 (최초 빌드는 5~10분)
	@test -f .env || (echo "⚠️  .env가 없습니다. 먼저 'make setup'을 실행하세요." && exit 1)
	@# 포트가 겹치면 compose는 나머지를 다 띄운 뒤 백엔드만 실패시켜, 화면이 백엔드
	@# 없이 멈춥니다. 누가 포트를 잡았는지 먼저 확인하고 겹치면 시작하지 않습니다.
	@bash scripts/ports.sh check
	@# 베이스 이미지(JRE·Node·Python·Alpine)의 보안 패치를 받으려면 빌드할 때 새로 받아야 합니다 — 받아 둔 이미지를
	@# 계속 쓰면 패치가 들어가지 않습니다. 오프라인이면 받아 둔 이미지로 빌드합니다.
	@$(COMPOSE) build --pull || { echo "ℹ️  베이스 이미지를 새로 받지 못해(오프라인?) 받아 둔 이미지로 빌드합니다."; $(COMPOSE) build; }
	$(COMPOSE) up -d
	@$(MAKE) --no-print-directory migrate
	@echo ""
	@bash scripts/ports.sh wait
	@echo ""
	@echo "  화면    : http://localhost:$(FRONTEND_PORT)"
	@echo "  API     : http://localhost:$(BACKEND_PORT)/api/health"
	@echo "  수집기  : http://localhost:$(COLLECTOR_PORT)/status"
	@echo ""
	@echo "  빌드한 코드 : $(if $(APP_VERSION),$(APP_VERSION)$(if $(APP_UPDATED), (최종 수정 $(APP_UPDATED)),),알 수 없음 (git 저장소가 아님))"
	@echo "                (화면 왼쪽 아래에도 같은 값이 표시됩니다)"
	@echo ""
	@bash scripts/version.sh --brief
	@echo "  첫 실행이라면 'make collect'로 데이터를 한 번 받아 오세요."
	@echo ""

migrate: ## 대기 중인 스키마 파일(db/migrations)을 지금 적용 (make up이 부름)
	@# 수집기는 기동할 때만 스키마를 적용합니다. 백엔드만 바뀐 배포에서는 수집기가 다시 만들어지지 않아
	@# 새 테이블이 생기지 않았습니다(QA-016). 이미 적용한 파일은 건너뛰므로 몇 번 불러도 안전합니다.
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		$(COMPOSE) exec -T collector python -c "from app import store; store.init_schema()" >/dev/null 2>&1 && \
		{ echo "  스키마: 최신 (db/migrations)"; exit 0; }; sleep 3; done; \
		echo "⚠️  스키마를 적용하지 못했습니다. 'make logs S=collector'를 보세요." ; exit 1

down: ## 정지 (데이터는 보존)
	$(COMPOSE) down

restart: ## 재기동
	$(COMPOSE) restart

ps: ## 컨테이너 상태
	$(COMPOSE) ps

logs: ## 로그 따라 보기 (make logs S=backend 로 특정 서비스만)
	$(COMPOSE) logs -f --tail=100 $(S)

infra: ## PostgreSQL만 기동 (네이티브 개발용)
	$(COMPOSE) up -d postgres

# ------------------------------------------------------------------ 데이터
collect: ## 시세·수급 수집 (fast — 약 1분)
	@curl -fsS $(TOKEN_HEADER) -X POST "http://localhost:$(COLLECTOR_PORT)/collect?group=fast" \
		| python3 -m json.tool --no-ensure-ascii 2>/dev/null || echo "수집기에 연결하지 못했습니다."

collect-all: ## 전체 수집 (13F 포함 — 10분 이상)
	@curl -fsS $(TOKEN_HEADER) -X POST "http://localhost:$(COLLECTOR_PORT)/collect?group=all&wait=false" \
		| python3 -m json.tool --no-ensure-ascii 2>/dev/null || echo "수집기에 연결하지 못했습니다."
	@echo "백그라운드로 실행 중입니다. 'make status'로 진행 상황을 확인하세요."

status: ## 수집 현황 (구버전 collector.py --status)
	@curl -fsS $(TOKEN_HEADER) "http://localhost:$(COLLECTOR_PORT)/status" \
		| python3 -c "import json,sys; d=json.load(sys.stdin); \
print('마지막 실행:', d.get('lastRunStatus')); \
print('누락 데이터셋:', len(d.get('missingDatasets') or [])); \
[print(' ', t['status'], t['task'], (t.get('detail') or '')[:60]) for t in (d.get('taskSummary') or [])]" \
		2>/dev/null || echo "수집기에 연결하지 못했습니다."

verify: ## 교차 검증 실행 (KRX·KIS 대조)
	@curl -fsS $(TOKEN_HEADER) "http://localhost:$(COLLECTOR_PORT)/verify/readings" \
		| python3 -m json.tool --no-ensure-ascii 2>/dev/null || echo "수집기에 연결하지 못했습니다."

# ------------------------------------------------------------------ 진단
doctor: ## 어디가 막혔는지 한 번에 진단 (데이터가 안 보일 때 먼저 실행)
	@bash scripts/doctor.sh

# ------------------------------------------------------------------ 테스트
test: test-collector test-backend test-frontend ## 전체 테스트

# ⚠️ 테스트는 운영 DB(macrodash)를 쓰지 않습니다.
#
# 백엔드 통합 테스트는 매 테스트 시작 시 snapshots를 비웁니다. 접속 기본값이
# 운영 DB였을 때는 `make test-backend` 한 번으로 수집해 둔 데이터가 전부
# 사라졌습니다(되살리려면 make collect-all — 10분 이상). 그래서 테스트 전용
# DB를 따로 만들어 씁니다. 테스트 쪽에도 "이름이 _test로 끝나지 않으면 실행을
# 거부"하는 안전장치를 두었습니다(ApiIntegrationTest).
TEST_DB_NAME := macrodash_test

# 마이그레이션은 번호 순서로 적용합니다(V10은 V9 다음). 모두 여러 번 실행해도 안전합니다.
MIGRATIONS = $(shell ls db/migrations/V*__*.sql | sort -t V -k 2 -n)

db-test: ## 테스트 전용 DB 준비 (없으면 만들고 스키마 적용)
	@$(COMPOSE) exec -T postgres psql -U $${DATABASE_USER:-macro} -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname='$(TEST_DB_NAME)'" | grep -q 1 || \
		$(COMPOSE) exec -T postgres psql -U $${DATABASE_USER:-macro} -d postgres \
			-c "CREATE DATABASE $(TEST_DB_NAME) OWNER $${DATABASE_USER:-macro}" >/dev/null
	@for f in $(MIGRATIONS); do \
		$(COMPOSE) exec -T postgres psql -q -v ON_ERROR_STOP=1 -U $${DATABASE_USER:-macro} \
			-d $(TEST_DB_NAME) -f /dev/stdin < "$$f" >/dev/null || exit 1; \
	done
	@echo "✅ 테스트 DB 준비: $(TEST_DB_NAME) (운영 DB는 건드리지 않습니다)"

test-collector: db-test ## 수집기 린트(ruff) + 테스트 (PostgreSQL 필요)
	@test -x $(VENV_PY) || echo "ℹ️  collector/.venv가 없어 $(PY)로 실행합니다. 'No module named pytest'가 나오면 docs/LOCAL_SETUP.md의 가상환경 절을 보세요."
	cd collector && $(if $(filter $(VENV_PY),$(PY)),.venv/bin/python,python3) -m ruff check app tests
	cd collector && TEST_DATABASE_URL=$${TEST_DATABASE_URL:-postgresql://$${DATABASE_USER:-macro}:$${DATABASE_PASSWORD:-macro}@localhost:$(DATABASE_PORT)/$(TEST_DB_NAME)} \
		$(if $(filter $(VENV_PY),$(PY)),.venv/bin/python,python3) -m pytest tests -q

constraints: ## 수집기 간접 의존성 고정 파일(collector/constraints.txt)을 다시 만들기 — requirements.txt를 바꾼 뒤 함께 커밋
	bash scripts/collector-constraints.sh

test-backend: db-test ## 백엔드 테스트 (PostgreSQL 필요)
	cd backend && TEST_DATABASE_URL=$${TEST_DATABASE_URL:-jdbc:postgresql://localhost:$(DATABASE_PORT)/$(TEST_DB_NAME)} \
		mvn -B verify

test-frontend: ## 화면 자가검증 + 훅 테스트 + 린트 + 빌드(타입 검사 포함)
	cd frontend && npm run check && npm test && npm run lint && npm run build

# ------------------------------------------------------------- 네이티브 개발
# 수집기는 토큰이 비면 기동을 거부하고(COLLECTOR_ALLOW_NO_TOKEN=1일 때만 경고 후 기동), 백엔드는 같은 토큰을
# 보내야 수집기를 부를 수 있습니다. 그래서 이 두 레시피에만 .env의 값을 환경으로 넘깁니다(셸에 export한 값이
# 있으면 그것이 먼저). 전역 export는 다른 타깃 환경까지 들어가므로 쓰지 않고, 명령 줄에 값을 적지 않아 make가
# 찍는 명령에도 토큰이 보이지 않습니다. 예전에는 넘기지 않아 make dev-collector가 뜨지 않았습니다(QA-106).
dev-collector dev-backend: export COLLECTOR_API_TOKEN := $(COLLECTOR_API_TOKEN)
dev-collector: export COLLECTOR_ALLOW_NO_TOKEN := $(COLLECTOR_ALLOW_NO_TOKEN)

dev-collector: ## 수집기 개발 서버 (자동 리로드 · collector/.venv 필요)
	@test -x $(VENV_PY) || (echo "⚠️  collector/.venv가 없습니다. 먼저:" && \
		echo "    python3 -m venv collector/.venv && collector/.venv/bin/pip install -r collector/requirements-dev.txt -c collector/constraints.txt" && exit 1)
	@# DB 포트는 .env의 DATABASE_PORT(make infra가 여는 포트)를 따릅니다. 예전에는 5432로 박혀 있었습니다.
	cd collector && DATABASE_URL=postgresql://$${DATABASE_USER:-macro}:$${DATABASE_PASSWORD:-macro}@localhost:$(DATABASE_PORT)/$${DATABASE_NAME:-macrodash} \
		.venv/bin/python -m uvicorn app.main:app --reload --port $(COLLECTOR_PORT)

dev-backend: ## 백엔드 개발 서버
	@# DATABASE_URL을 직접 주지 않았으면 .env의 DATABASE_PORT로 붙습니다(수집기와 같은 DB).
	cd backend && DATABASE_URL=$${DATABASE_URL:-jdbc:postgresql://localhost:$(DATABASE_PORT)/$${DATABASE_NAME:-macrodash}} \
		mvn spring-boot:run

dev-frontend: ## 화면 개발 서버 (핫 리로드)
	cd frontend && NEXT_PUBLIC_BACKEND_PORT=$(BACKEND_PORT) npm run dev

db: ## PostgreSQL 셸
	$(COMPOSE) exec postgres psql -U $${DATABASE_USER:-macro} -d $${DATABASE_NAME:-macrodash}

# ------------------------------------------------------------------ 백업·정리
backup: ## 데이터베이스 백업 (backups/ 폴더에 저장 · 실패하면 파일을 남기지 않음)
	@bash scripts/db-backup.sh

restore: ## 백업으로 DB 전체 교체 (make restore F=backups/xxx.sql · 교체 전 자동 백업)
	@test -n "$(F)" || (echo "사용법: make restore F=backups/파일.sql" && exit 1)
	@bash scripts/db-restore.sh "$(F)"

reset: ## ⚠️ 전체 삭제 후 재기동 (수집 이력까지 사라집니다)
	@printf "정말 모든 데이터를 지울까요? 누적 수급 이력은 복구할 수 없습니다 [y/N] " && read ans && [ "$$ans" = "y" ]
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build
