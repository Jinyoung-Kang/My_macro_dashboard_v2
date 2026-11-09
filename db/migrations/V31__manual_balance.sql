-- =============================================================================
-- V31__manual_balance.sql
-- ISA 계좌를 '장부(거래 누적)'에서 '잔고(현재 상태가 정답)'로 — 더하기만(ADR 0034, 사용자 결정 2026-11-09). JDBC는 백엔드 store.ManualAccountStore 한 곳에만 있습니다(ADR 0008).
--
-- - manual_balance(새 표): 계좌 하나에 한 행 — 이 행이 있으면 시작한 것입니다. 시작 시각·현금·수수료율(bp, 기본 1.5 = 0.015%). 현금은 음수일 수 있습니다(막지 않고 화면에 경고).
-- - manual_positions(새 표): 종목별 보유 — 수량·매입 금액(평균 매입가 = 매입 금액 ÷ 수량), 사용자가 고친 표시 이름(name, 없으면 NULL).
-- - manual_trades(새 표): 지시를 '확인'해 잔고에 반영한 내역 — 되돌리기와 수수료·세금 누적의 근거. cost_basis는 매수면 더한 매입 금액, 매도면 줄어든 매입 금액이고
--   realized_pnl은 매도의 실현 손익입니다. tax_assumed는 시장 구분을 몰라 코스피 세율로 어림한 매도입니다. 지시·스탑 지시 가운데 하나에만 묶입니다.
-- - manual_instructions.notified_preclose_at·manual_stop_instructions.notified_midday_at·notified_preclose_at: 그날 미확인 지시의 장 중반·마감 30분 전 알림 시각(종류마다 한 번).
-- - 옛 표 manual_ledger와 옛 칸(confirmed_at 등)은 지우지 않습니다 — 코드만 더 쓰지 않습니다(옛 코드로 되돌려도 깨지지 않게, ADR 0034). 기존 장부 값을 옮기지 않고
--   배포 뒤 사용자가 시작 창에 오늘 잔고를 넣어 새로 시작합니다.
-- - 다른 증권사 실제 계좌 자료라 저장소·문서·커밋·QA 기록에 값을 넣지 않습니다(시드 없음). 매일 S3 백업에 들어가고, QA 복원(scripts/db-restore.sh RESTORE_REAL_TRADE=clear)은
--   이 표들을 비웁니다. 수집기는 이 표들을 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 표·칸·색인은 IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS manual_balance (
    account       TEXT          PRIMARY KEY REFERENCES manual_accounts (code) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ   NOT NULL,
    cash          NUMERIC(20,2) NOT NULL,
    commission_bp NUMERIC(8,4)  NOT NULL DEFAULT 1.5,
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_positions (
    account         TEXT          NOT NULL REFERENCES manual_accounts (code) ON DELETE CASCADE,
    symbol          TEXT          NOT NULL CHECK (symbol ~ '^[0-9][0-9A-Z]{5}$'),
    name            TEXT,                                   -- 사용자가 고친 표시 이름(없으면 시세 이름표)
    quantity        NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
    purchase_amount NUMERIC(20,2) NOT NULL CHECK (purchase_amount >= 0),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (account, symbol)
);

CREATE TABLE IF NOT EXISTS manual_trades (
    id                  BIGSERIAL     PRIMARY KEY,
    account             TEXT          NOT NULL REFERENCES manual_accounts (code) ON DELETE CASCADE,
    at                  TIMESTAMPTZ   NOT NULL,             -- '확인'을 누른 순간
    side                TEXT          NOT NULL CHECK (side IN ('BUY', 'SELL')),
    symbol              TEXT          NOT NULL CHECK (symbol ~ '^[0-9][0-9A-Z]{5}$'),
    quantity            NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
    price               NUMERIC(20,4) NOT NULL CHECK (price > 0),
    fee                 NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    tax                 NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    cost_basis          NUMERIC(20,2) NOT NULL CHECK (cost_basis >= 0), -- 매수는 더한 매입 금액, 매도는 줄어든 매입 금액
    realized_pnl        NUMERIC(20,2),                      -- 매도의 실현 손익(매수는 NULL)
    tax_assumed         BOOLEAN       NOT NULL DEFAULT false, -- 시장 구분을 몰라 코스피 세율로 어림한 매도
    instruction_id      BIGINT        REFERENCES manual_instructions (id),
    stop_instruction_id BIGINT        REFERENCES manual_stop_instructions (id),
    price_source        TEXT          NOT NULL,             -- live(화면이 보던 실시간 가격)·close(서버 직전 종가)
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT manual_trades_one_instruction CHECK (instruction_id IS NULL OR stop_instruction_id IS NULL)
);
CREATE INDEX IF NOT EXISTS manual_trades_recent ON manual_trades (account, at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS manual_trades_instruction ON manual_trades (instruction_id) WHERE instruction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS manual_trades_stop_instruction ON manual_trades (stop_instruction_id) WHERE stop_instruction_id IS NOT NULL;

ALTER TABLE manual_instructions ADD COLUMN IF NOT EXISTS notified_preclose_at TIMESTAMPTZ;
ALTER TABLE manual_stop_instructions ADD COLUMN IF NOT EXISTS notified_midday_at TIMESTAMPTZ;
ALTER TABLE manual_stop_instructions ADD COLUMN IF NOT EXISTS notified_preclose_at TIMESTAMPTZ;
