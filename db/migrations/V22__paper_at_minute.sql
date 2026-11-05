-- =============================================================================
-- V22__paper_at_minute.sql
-- 체결 시점 자유화의 분 단위 지정 시각 — 더하기만(ADR 0027 결정 1·4, 명세 docs/specs/2026-11-05-free-fill-timing.md §2·§3).
-- 기존 행·계좌는 그대로이고, 새 값·칸을 쓰는 주문은 자유 시점 판을 켠 계좌의 결정부터 생깁니다(스위치는 기본 꺼짐).
--
-- - paper_orders.timing에 AT_MINUTE(목표 세션 E의 분 단위 시각)를 더합니다. V18의 열두 값을 모두 담는 상위 집합이라 지금 행은 그대로
--   통과합니다(V14·V17·V18과 같은 방식 — 지운 뒤 같은 이름으로 다시). 매시 값 AT_1000~AT_1500과 그 행은 바꾸지 않습니다.
-- - paper_orders.target_local(새 칸): AT_MINUTE 주문의 시각 — 그 시장의 현지 시각(미국 America/New_York, 한국 Asia/Seoul), 분 단위.
--   기준 시각 T는 백엔드가 목표 세션 날짜와 합쳐 계산합니다(서머타임·조기 폐장을 달력이 맡음 — 고정 UTC 시각을 저장하지 않음).
-- - target_local은 AT_MINUTE에만, 초는 0(paper_orders_target_local_timing).
-- - 시장에 나가는 AT_MINUTE 주문은 시각이 있어야 합니다(paper_orders_at_minute_target). 거절 행(status REJECTED)은 받은 값 그대로
--   남기므로 뺍니다 — 시각이 빠진 AT_MINUTE 응답도 거절 행이 되고, 그 행이 CHECK에 걸리면 결정 기록을 쓰는 트랜잭션 전체가 되돌려집니다.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008). 수집기는 1분봉 수집 창을 정하려고 읽기만 합니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 칸은 IF NOT EXISTS, CHECK는 지운 뒤 같은 모양으로 다시.
--   다만 다시 실행하는 동안 V14·V17·V18이 timing CHECK를 옛 값으로 되돌렸다가 이 파일이 다시 넓히므로, 테스트 DB에 AT_MINUTE 주문 행이
--   남아 있으면 그 파일들에서 실패합니다 — 그런 행을 쓰는 시험은 시작·끝에 지웁니다(MARKET 선례). 운영 DB(수집기 기동)는 대기 중인
--   파일만 적용하므로 해당하지 않습니다.
-- =============================================================================

ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS target_local TIME;

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_timing_check;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_timing_check
    CHECK (timing IN ('NEXT_OBSERVATION', 'NEXT_OPEN', 'NEXT_CLOSE', 'IMMEDIATE', 'BACKFILL',
                      'AT_1000', 'AT_1100', 'AT_1200', 'AT_1300', 'AT_1400', 'AT_1500', 'MARKET', 'AT_MINUTE'));

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_target_local_timing;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_target_local_timing
    CHECK (target_local IS NULL OR (timing = 'AT_MINUTE' AND EXTRACT(SECOND FROM target_local) = 0));

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_at_minute_target;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_at_minute_target
    CHECK (status = 'REJECTED' OR timing <> 'AT_MINUTE' OR target_local IS NOT NULL);
