-- =============================================================================
-- V20__paper_decision_fk_indexes.sql
-- 결정 번호 외래 키 세 칸에 색인(QA-282, docs/qa/2026-11-04-qa-defects.md).
--
-- - paper_orders.decision_id: 결정 요약(백엔드 store.PaperStore의 결정별 주문 COUNT)이 결정마다 주문 표 전체를 훑어, 개요·결정 목록이
--   주문 누적에 비례해 느려졌습니다(QA 스택 합성 주문 12.2k에서 개요 17ms → 124ms, 이 색인으로 31.5ms).
-- - paper_checkpoints.source_decision_id·checkpoint_decision_id: 계좌 초기화가 결정 행을 지울 때의 외래 키 검사(ON DELETE CASCADE·SET NULL)가
--   장중 확인 표 전체를 훑었습니다.
-- - 표가 작아(운영 주문 수십 행) 잠금은 순간입니다. 쓰는 곳은 그대로 백엔드 store뿐이고(ADR 0008), 이 파일은 색인만 더합니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE INDEX IF NOT EXISTS paper_orders_decision ON paper_orders (decision_id);
CREATE INDEX IF NOT EXISTS paper_checkpoints_source_decision ON paper_checkpoints (source_decision_id);
CREATE INDEX IF NOT EXISTS paper_checkpoints_checkpoint_decision ON paper_checkpoints (checkpoint_decision_id);
