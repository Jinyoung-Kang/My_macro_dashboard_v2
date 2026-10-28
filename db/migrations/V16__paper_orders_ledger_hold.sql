-- =============================================================================
-- V16__paper_orders_ledger_hold.sql
-- 한국 장부가 그 관측치를 처리하며 그날 보류한 대기 주문의 표시(2단계 명세 docs/specs/2026-10-26-v2-kr-paper-spec.md §4-9
-- 'E0 구현에서 정한 것', 사용자 결정 v3 — 2026-10-28).
--
-- - paper_orders.ledger_hold_reason·ledger_hold_collected_at: 시가 체결 장부(한국)가 수집 시각 ledger_hold_collected_at의 관측치로
--   그 책을 처리하면서 그 종목 주문을 그날 보류했으면(기업행위 판정 대기·분할·병합을 반영한 밤·보유 없는 주문 종목의 신호·미처리
--   기업행위 보유) 그 사유와 그 관측치의 수집 시각. 결정 게이트 ①은 그 실행 관측치의 수집 시각과 같은 표시가 있는 대기 주문을
--   기다리지 않습니다. 예전에는 장부의 메모리(PaperLedgerService.orderHolds)라 그 밤 백엔드를 재기동하면 잊혀(그 관측치는 이미
--   처리해 다시 처리하지 않음) ①이 그 주문을 기다렸습니다.
-- - 장부가 그 책을 새 관측치로 처리할 때마다 그 책의 표시를 모두 지우고 이번 보류만 다시 씁니다(보류가 풀렸거나 주문이 대기를
--   벗어나면 지워짐). 처리와 같은 트랜잭션이라 처리를 되돌리면 표시도 앞 그대로입니다(앞 관측치의 수집 시각이라 ①은 면제하지
--   않음). 미국 주문은 늘 NULL입니다.
-- - 둘 다 NULL이거나 둘 다 값(CHECK). 주문 레코드(store.PaperStore.Order)에는 이 칸이 없습니다 — PaperStore가 따로 읽고 씁니다
--   (insertOrder는 쓰지 않음 — 미국 주문 경로·고정본 그대로, corp_action_hold·fill_ref_volume과 같은 방식).
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 백엔드는 ledger_hold_reason
--   열로 "스키마 준비됨"을 봅니다(PaperStore.ready).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): ADD COLUMN IF NOT EXISTS, CHECK는 지운 뒤 같은 이름으로
--   다시 만듭니다(V9·V14와 같은 방식).
-- =============================================================================

ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS ledger_hold_reason TEXT;
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS ledger_hold_collected_at TIMESTAMPTZ;
ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_ledger_hold_check;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_ledger_hold_check
    CHECK ((ledger_hold_reason IS NULL) = (ledger_hold_collected_at IS NULL));
