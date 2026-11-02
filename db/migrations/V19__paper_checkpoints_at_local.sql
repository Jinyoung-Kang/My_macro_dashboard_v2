-- =============================================================================
-- V19__paper_checkpoints_at_local.sql
-- 장중 확인 시각 칸을 시장 일반 이름으로 — 한국 Claude 계좌2 단계 2b(명세 docs/specs/2026-11-02-kr-claude2-stage2.md §10). 이름만 바꾸고 값·제약은
-- 그대로입니다.
--
-- - paper_checkpoints.at_et → at_local: 확인 시각을 그 계좌 시장의 현지 시각으로 읽습니다(미국 계좌 = America/New_York — 지금 행 그대로,
--   한국 계좌 = Asia/Seoul). 시장은 계좌(paper_books.market)가 정하므로 칸을 더하지 않습니다.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐이고(ADR 0008), 수집기는 장중 확인 감시 범위(paper_watch_us·paper_watch_kr)를 정하려고 읽기만 합니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): at_et가 있을 때만 바꿉니다. 다시 실행하는 동안 V18의
--   CREATE TABLE IF NOT EXISTS는 표가 이미 있어 at_et를 되살리지 않습니다.
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'paper_checkpoints' AND column_name = 'at_et') THEN
        ALTER TABLE paper_checkpoints RENAME COLUMN at_et TO at_local;
    END IF;
END $$;

COMMENT ON COLUMN paper_checkpoints.at_local IS '확인 시각 — 목표 세션 E의 그 계좌 시장 현지 시각(미국 America/New_York, 한국 Asia/Seoul)';
