-- =============================================================================
-- V39__fetch_budgets_article.sql
-- 정보 검색 본문 보기(ADR 0043, 계약 docs/specs/2026-11-14-info-search-contract.md §10) — fetch_budgets의 용도에 article을 더함. 새 표 없음.
--
-- - 운영자가 '본문 보기'를 누른 글 한 건을 운영 서버가 받을 때의 하루(KST) 예산을 같은 표에 셉니다: 하루 전체 받기(host '*'), 기사 호스트마다의
--   요청(그 호스트), 구글 경유 주소 풀기(news.google.com). 쓰는 쪽은 그대로 수집기 store.take_search_budget 하나입니다(ADR 0008).
-- - 본문은 이 표에도 어느 표에도 두지 않습니다(수집기 메모리 24시간 — 저장하지 않는 결정).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 제약을 지우고 같은 이름으로 다시 만듦.
-- =============================================================================

ALTER TABLE fetch_budgets DROP CONSTRAINT IF EXISTS fetch_budgets_purpose_check;
ALTER TABLE fetch_budgets ADD CONSTRAINT fetch_budgets_purpose_check CHECK (purpose IN ('watch', 'search', 'article'));
