-- =============================================================================
-- V38__search_watch_notify.sql
-- 정보 검색 관심 대상의 알림함 연결(ADR 0041 단계 6, 계약 docs/specs/2026-11-14-info-search-contract.md §9-5) — search_watches에 칸 둘, 더하기만.
--
-- - notify(기본 꺼짐): 그 대상의 새 글을 알림함으로 받을지. 사용자가 대상마다 켭니다(PATCH /api/search/watch/{id}). 있던 줄도 꺼짐으로 시작합니다.
-- - notified_at(처음엔 NULL): 그 줄로 마지막 알림을 만든 시각. 백엔드 정기 작업(15분)이 새 글(§6-4 규칙) 가운데 이 시각 뒤에 처음 받은 글만 셉니다.
-- - 네 칸 모두 백엔드가 씁니다(search_watches는 백엔드 표 — ADR 0008). 수집기는 notify·notified_at을 읽지도 쓰지도 않고, 정기 수집은 대표 키·이름·
--   name_ko·name_en·별칭·식별자만 읽습니다.
-- - 알림은 알림함(alert_events·alert_deliveries)에만 — 텔레그램으로 보내지 않습니다. 모의 매매의 입력이 아닙니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

ALTER TABLE search_watches ADD COLUMN IF NOT EXISTS notify      BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE search_watches ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
-- 등록 때 대상 풀기가 준 한국어·영문 이름(없으면 NULL) — 백엔드가 등록할 때 씁니다. 수집기 정기 수집은 이 두 칸으로 검색어의 이름을 정하고,
-- 별칭 편집(계약 §9-4)으로 바뀐 별칭 앞자리에서 이름을 짐작하지 않습니다(짧은 사용자 별칭이 이름이 되어 규칙 5를 건너뛰지 않게).
ALTER TABLE search_watches ADD COLUMN IF NOT EXISTS name_ko     TEXT;
ALTER TABLE search_watches ADD COLUMN IF NOT EXISTS name_en     TEXT;
