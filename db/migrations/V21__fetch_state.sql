-- =============================================================================
-- V21__fetch_state.sql
-- 차단 통과 수집 계층의 상태(ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §3) — 수집기가 쓰는 표 둘, 더하기만.
--
-- - fetch_hosts: 호스트마다 한 행. 고정한 브라우저 프로필(profile — curl_cffi impersonate 이름, profile_lib은 그것을 뽑았을 때의 curl_cffi 판),
--   마지막으로 통과한 계층(last_good_tier), 연속 거부 횟수(fail_level), 닫힘(blocked_until·blocked_reason), 포기(given_up — 운영자가 풀 때까지
--   다시 시도하지 않음), 하루 요청 예산(budget_day는 KST 날짜, budget_used는 그 날 쓴 요청 수).
-- - fetch_schedule: polite 속도군 태스크마다 한 행. 다음 실행 시각(next_due_at — 실행이 끝날 때 구간 안에서 무작위로 정함).
-- - 메모리에 두지 않는 이유: 배포로 수집기가 다시 뜰 때마다 물러남·예산·일정이 사라지면 기동 직후 모든 출처를 한꺼번에 다시 두드립니다.
-- - 공용 세션의 5분 호스트 래치(app/http.py)와 따로입니다 — 새 계층의 거부가 같은 호스트의 기존 수집(인베스팅닷컴 RSS)을 닫지 않게.
-- - 쓰는 곳은 수집기뿐입니다(ADR 0008 — 백엔드는 읽기만, ArchitectureRulesTest의 수집기 표 목록).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS fetch_hosts (
    host           TEXT        PRIMARY KEY,
    profile        TEXT,
    profile_lib    TEXT,
    last_good_tier TEXT        CHECK (last_good_tier IN ('impersonate', 'browser')),
    fail_level     INTEGER     NOT NULL DEFAULT 0 CHECK (fail_level >= 0),
    blocked_until  TIMESTAMPTZ,
    blocked_reason TEXT,
    given_up       BOOLEAN     NOT NULL DEFAULT FALSE,
    budget_day     DATE,
    budget_used    INTEGER     NOT NULL DEFAULT 0 CHECK (budget_used >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fetch_schedule (
    task        TEXT        PRIMARY KEY,
    next_due_at TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
