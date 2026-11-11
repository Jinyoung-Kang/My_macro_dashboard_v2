-- =============================================================================
-- V33__info_collect.sql
-- 정보 수집(ADR 0035) — 수집기가 쓰는 표 둘, 더하기만.
--
-- - info_items: 수집한 글 한 편에 한 행(해외 블로그·waedge 시장·거장 글). id는 정규화한 원문 주소의 해시(앞 24자) — 같은 글을 waedge 해외 블로그
--   목록(한국어 제목)과 원문 블로그 피드(본문)가 함께 채웁니다. body는 글자만(상한 40,000자), body_status는 full(본문 전체)·partial(피드 요약 등)·
--   none(아직 없음). published_at은 출처가 밝힌 작성 시각(모르면 NULL — 받은 시각으로 메우지 않음). 180일 뒤 지웁니다(수집기 보관 태스크).
-- - fetch_source_state: polite 속도군 태스크마다 한 행 — 마지막 판정(status: ok·blocked·format·failed), 같은 판정이 이어진 횟수(streak),
--   사유 한 줄(주소·본문 없음), 마지막 성공·실행 시각, '오래 못 받음'으로 볼 간격(stale_after_minutes — 그 출처 간격 상한의 3배).
--   백엔드가 읽어 끊김 알림(텔레그램 + 화면 안내)을 만듭니다.
-- - 쓰는 곳은 수집기뿐입니다(ADR 0008 — 백엔드는 읽기만, ArchitectureRulesTest의 수집기 표 목록).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS info_items (
    id            TEXT        PRIMARY KEY,
    source        TEXT        NOT NULL,
    kind          TEXT        NOT NULL CHECK (kind IN ('article', 'brief', 'guru')),
    url           TEXT        NOT NULL,
    title         TEXT        NOT NULL,
    title_ko      TEXT,
    author        TEXT,
    published_at  TIMESTAMPTZ,
    summary       TEXT,
    body          TEXT,
    body_status   TEXT        NOT NULL DEFAULT 'none' CHECK (body_status IN ('full', 'partial', 'none')),
    meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    fetch_tier    TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_info_items_recent ON info_items ((COALESCE(published_at, first_seen_at)) DESC);
CREATE INDEX IF NOT EXISTS idx_info_items_source ON info_items (source, (COALESCE(published_at, first_seen_at)) DESC);

CREATE TABLE IF NOT EXISTS fetch_source_state (
    task                TEXT        PRIMARY KEY,
    status              TEXT        NOT NULL CHECK (status IN ('ok', 'blocked', 'format', 'failed')),
    streak              INTEGER     NOT NULL DEFAULT 1 CHECK (streak >= 1),
    reason              TEXT,
    last_ok_at          TIMESTAMPTZ,
    last_run_at         TIMESTAMPTZ NOT NULL,
    stale_after_minutes INTEGER     NOT NULL CHECK (stale_after_minutes > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
