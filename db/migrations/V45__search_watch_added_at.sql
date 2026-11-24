-- =============================================================================
-- V45__search_watch_added_at.sql
-- 정보 검색 관심 대상이 모은 글(search_watch_items — 수집기가 씀)에 '표에 넣은 시각' 칸 하나, 더하기만(QA-1012, ADR 0041 덧붙임 2026-11-25).
--
-- - added_at: 그 줄을 이 표에 넣은 순간(주지 않으면 clock_timestamp() — 문장이 아니라 줄마다의 실제 시각). 백엔드의 새 글 수·알림(계약
--   docs/specs/2026-11-14-info-search-contract.md §6-4·§9-5)이 '마지막으로 본 뒤·지난 알림 뒤에 들어온 글'을 이 칸으로 가립니다.
--   first_seen_at(화면의 '받은 시각' — 작성 시각 없는 저장본 글은 그 글을 원래 받은 시각, 그 밖은 깨기 시작 시각)은 그대로이고 뜻도 그대로입니다.
--   그 칸을 '들어온 시각'으로 쓰면 늦게 들어온 저장본 글과 커밋이 늦은 줄이 새 글에서 빠졌습니다.
-- - 있던 줄은 added_at = first_seen_at으로 채웁니다(판정이 지금까지와 같음). 있던 칸의 값은 바꾸지 않습니다.
-- - 새 글 조건(added_at > last_seen_at)은 대상 키로 좁힌 뒤 거르므로 색인을 더하지 않습니다(first_seen_at에도 따로 없었음).
-- - 모의 매매의 입력이 아닙니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS, 빈 칸만 채움, 기본값·NOT NULL은 다시 걸어도 같음.
-- =============================================================================

ALTER TABLE search_watch_items ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ;
UPDATE search_watch_items SET added_at = first_seen_at WHERE added_at IS NULL;
ALTER TABLE search_watch_items ALTER COLUMN added_at SET DEFAULT clock_timestamp();
ALTER TABLE search_watch_items ALTER COLUMN added_at SET NOT NULL;
