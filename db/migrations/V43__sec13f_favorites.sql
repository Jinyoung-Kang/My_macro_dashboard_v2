-- =============================================================================
-- V43__sec13f_favorites.sql
-- 13F 즐겨찾기 기관(ADR 0048) — 표 하나, 더하기만.
--
-- - sec13f_favorites(백엔드가 씀): 운영자가 13F 포트폴리오 화면에서 더한 기관(기본 12곳 밖). 사용자별이 아니라 하나의 목록이고, 상한은 백엔드 상수
--   (InstitutionCatalog.FAVORITE_LIMIT). CIK(10자리)마다 한 줄 — SEC 등록 이름(더할 때 submissions로 확인), 표시 이름·설명(선택 — 비우면 SEC 이름),
--   더한 시각·사용자(사용자를 지우면 NULL). 수집기는 읽기만 합니다(ADR 0008 — search_watches 선례): sec_13f 태스크의 대상 = 기본 12곳 + 이 표
--   (기본 12곳·트랙레코드 후보 CIK는 빼고 — ADR 0048 불변식 2).
-- - 줄을 지워도 그 기관의 13F 저장본(snapshots)은 지우지 않습니다(목록에서 빼고 수집만 멈춤 — 다시 더하면 바로 보임).
-- - 모의 매매·AI 리포트 원문의 입력이 아닙니다(feature/paper·snapshot·ai는 이 표를 읽지 않음 — 시험으로 고정).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sec13f_favorites (
    cik          TEXT        PRIMARY KEY CHECK (cik ~ '^[0-9]{10}$'),
    sec_name     TEXT        NOT NULL,
    display_name TEXT,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL
);
