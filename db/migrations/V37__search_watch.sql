-- =============================================================================
-- V37__search_watch.sql
-- 정보 검색의 관심 대상·매체 제외·모은 글·검색 예산(ADR 0041 결정 6·9, 계약 docs/specs/2026-11-14-info-search-contract.md §6-2) — 표 넷, 더하기만.
--
-- - search_watches(백엔드가 씀): 사용자마다 관심 대상 목록. 대표 키(entity_key — us:·kr:·cik:·wd:·topic:)·종류·이름·별칭(문자열 배열)·식별자,
--   등록 시각과 마지막으로 본 시각(last_seen_at — 화면이 그 대상의 타임라인 결과를 그렸을 때 고침, 새 글 수 = first_seen_at > last_seen_at이고
--   작성 시각이 last_seen_at 하루 전과 등록 시각 가운데 늦은 것보다 늦은 글).
--   사용자를 지우면 함께 지웁니다. 수집기는 읽기만 합니다(대표 키마다 한 번 모음 — paper_settings 선례).
-- - search_media_excludes(백엔드가 씀): 사용자가 더하는 제외 매체(도메인은 소문자 호스트, 이름은 그대로 — 대조는 대소문자 무시). 처음 값은 코드
--   상수(services/search_rules)이고 이 표는 그 위에 더합니다. 수집기는 읽기만 합니다.
-- - search_watch_items(수집기가 씀): 관심 대상마다 모은 글 — 제목·매체·출처·언어·요약(짧은 상한)·원문 주소·작성 시각(모르면 NULL)·처음 받은 시각.
--   본문은 두지 않습니다. 2년이 지난 글, 아무도 등록하지 않은 대상의 글(7일 유예 뒤), 제외 목록에 걸리는 글은 수집기가 지웁니다.
--   item_id는 원문 주소면 info_text.item_id(주소), 경유 주소(구글)면 그 기사 경로의 같은 해시, 주소가 없으면 전체 제목의 해시입니다.
-- - fetch_budgets(수집기가 씀): 즉석 검색·관심 대상의 호스트별 하루 요청 예산(budget_day는 KST 날짜). 정기 polite 예산(fetch_hosts)과 따로 셉니다.
-- - 모의 매매의 입력이 아닙니다(패킷·프롬프트는 이 표들을 읽지 않음).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS search_watches (
    id           BIGSERIAL   PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    entity_key   TEXT        NOT NULL,
    kind         TEXT        NOT NULL CHECK (kind IN ('company', 'institution', 'person', 'topic')),
    name         TEXT        NOT NULL,
    aliases      JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'),
    ids          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, entity_key)
);
CREATE INDEX IF NOT EXISTS search_watches_entity ON search_watches (entity_key);

CREATE TABLE IF NOT EXISTS search_media_excludes (
    id         BIGSERIAL   PRIMARY KEY,
    kind       TEXT        NOT NULL CHECK (kind IN ('domain', 'name')),
    value      TEXT        NOT NULL CHECK (length(btrim(value)) > 0),
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS search_media_excludes_kind_value ON search_media_excludes (kind, lower(value));

CREATE TABLE IF NOT EXISTS search_watch_items (
    entity_key       TEXT        NOT NULL,
    item_id          TEXT        NOT NULL,
    kind             TEXT        NOT NULL,
    title            TEXT        NOT NULL,
    url              TEXT,
    publisher        TEXT,
    publisher_domain TEXT,
    source           TEXT        NOT NULL,
    lang             TEXT,
    summary          TEXT,
    published_at     TIMESTAMPTZ,
    first_seen_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (entity_key, item_id)
);
CREATE INDEX IF NOT EXISTS search_watch_items_recent
    ON search_watch_items (entity_key, (COALESCE(published_at, first_seen_at)) DESC);
-- 2년 정리(대상과 상관없이 작성 시각 범위로 지움)가 표 전체를 훑지 않게.
CREATE INDEX IF NOT EXISTS search_watch_items_time
    ON search_watch_items ((COALESCE(published_at, first_seen_at)));

CREATE TABLE IF NOT EXISTS fetch_budgets (
    host        TEXT        NOT NULL,
    purpose     TEXT        NOT NULL CHECK (purpose IN ('watch', 'search')),
    budget_day  DATE        NOT NULL,
    budget_used INTEGER     NOT NULL DEFAULT 0 CHECK (budget_used >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host, purpose)
);
