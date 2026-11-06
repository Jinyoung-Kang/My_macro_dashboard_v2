-- =============================================================================
-- V28__manual_stop_instructions.sql
-- ISA 계좌의 장중 스탑 매도 지시 — 더하기만(ADR 0033 초안, ADR 0029 개정 — 사용자 결정 2026-11-06 "ISA에도 장중 스탑, 감지 즉시 알림과 자동 기록").
-- JDBC는 백엔드 store.ManualAccountStore 한 곳에만 있습니다(ADR 0008).
--
-- - manual_stop_instructions(새 표): 따라 하는 모의 책(kr_rules)의 STOP 주문 하나에 지시 하나(UNIQUE(account, paper_order_id) — 같은 스탑을 두 번
--   알리거나 적지 않게). 매도 거래일 session, 그 모의 주문 번호 paper_order_id(외래키 없음 — 모의 초기화가 막히지 않게), 종목·수량(매도만),
--   그 모의 주문의 체결 시점 timing과 기준 시각 target_at(장중 시장가·지정 시각은 그 분, 종가는 마감 — 알림 글이 '지금 시장가'와 '종가 단일가'를
--   가름), 근거 reason, 상태 status(PLANNED → RECORDED·SKIPPED·SUPERSEDED), 즉시 알림을 보낸 시각 notified_at.
-- - manual_ledger.stop_instruction_id(새 칸, NULL 허용): 그 스탑 지시대로 적은 장부 행. 한 행은 다음 시가 지시(instruction_id)와 스탑 지시 가운데
--   하나에만 묶입니다(CHECK manual_ledger_one_instruction).
-- - 다음 시가 지시 표(manual_instructions)와 그 UNIQUE(account, session, symbol)는 바꾸지 않습니다 — 옛 코드의
--   'ON CONFLICT (account, session, symbol)'이 그대로 맞는 제약을 찾고, 옛 장부 문장은 새 칸을 몰라도 NULL로 넣습니다(코드를 되돌려도 깨지지 않음).
-- - 계좌를 지우면(QA 복원 RESTORE_REAL_TRADE=clear) 스탑 지시도 함께 지워집니다(ON DELETE CASCADE — 이 표를 모르는 옛 복원 스크립트도 막히지 않게).
-- - 다른 증권사 실제 계좌 자료라 저장소·문서·커밋·QA 기록에 값을 넣지 않습니다(마이그레이션 시드 없음). 수집기는 이 표를 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 표·칸·색인은 IF NOT EXISTS, CHECK는 지운 뒤 같은 모양으로 다시.
-- =============================================================================

CREATE TABLE IF NOT EXISTS manual_stop_instructions (
    id             BIGSERIAL     PRIMARY KEY,
    account        TEXT          NOT NULL REFERENCES manual_accounts (code) ON DELETE CASCADE,
    session        DATE          NOT NULL,             -- 매도할 거래일(그 모의 STOP 주문의 목표 세션)
    paper_order_id BIGINT        NOT NULL,             -- 따라 하는 모의 책의 STOP 주문 번호(참고용 — 외래키 없음)
    symbol         TEXT          NOT NULL CHECK (symbol ~ '^[0-9][0-9A-Z]{5}$'),
    side           TEXT          NOT NULL DEFAULT 'SELL' CHECK (side = 'SELL'),
    quantity       INTEGER       NOT NULL CHECK (quantity > 0),
    timing         TEXT          NOT NULL CHECK (timing IN ('MARKET', 'AT_MINUTE', 'NEXT_CLOSE', 'NEXT_OPEN')),
    target_at      TIMESTAMPTZ   NOT NULL,             -- 그 모의 주문의 기준 시각
    reason         JSONB         NOT NULL DEFAULT '{}', -- 근거(모의 주문 번호·감지)·자동 기록 메모
    status         TEXT          NOT NULL DEFAULT 'PLANNED'
                                 CHECK (status IN ('PLANNED', 'RECORDED', 'SKIPPED', 'SUPERSEDED')),
    notified_at    TIMESTAMPTZ,                         -- 즉시 알림을 보낸 시각(보내기 전 NULL)
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (account, paper_order_id)
);
CREATE INDEX IF NOT EXISTS manual_stop_instructions_planned ON manual_stop_instructions (account, session, id) WHERE status = 'PLANNED';
CREATE INDEX IF NOT EXISTS manual_stop_instructions_recent ON manual_stop_instructions (account, id DESC);

ALTER TABLE manual_ledger ADD COLUMN IF NOT EXISTS stop_instruction_id BIGINT REFERENCES manual_stop_instructions (id);
ALTER TABLE manual_ledger DROP CONSTRAINT IF EXISTS manual_ledger_one_instruction;
ALTER TABLE manual_ledger ADD CONSTRAINT manual_ledger_one_instruction CHECK (instruction_id IS NULL OR stop_instruction_id IS NULL);
CREATE INDEX IF NOT EXISTS manual_ledger_stop_instruction ON manual_ledger (stop_instruction_id) WHERE stop_instruction_id IS NOT NULL;
