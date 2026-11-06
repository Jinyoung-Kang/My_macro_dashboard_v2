-- =============================================================================
-- V25__manual_accounts.sql
-- 연결되지 않은 다른 증권사 계좌(ISA 계좌)를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매' — 백엔드가 쓰는 표 넷(ADR 0029, 명세
-- docs/specs/2026-11-06-isa-manual-account.md §6). JDBC는 백엔드 store.ManualAccountStore 한 곳에만 있습니다(ADR 0008).
--
-- - manual_accounts: 계좌 하나에 한 행(코드 isa) — 이름·시장(KR)·따라 하는 책(kr_rules)·상태(ACTIVE·PAUSED)·시작 시각·시작 현금·버전.
--   시작 전에는 행이 없습니다(시작은 POST /api/manual/isa/start 한 번 — 시작 현금 DEPOSIT 행과 시작 매수 BUY 행을 한 트랜잭션으로).
-- - manual_ledger: 장부 행이 정본입니다 — 입금(DEPOSIT)·출금(WITHDRAW)·매수(BUY)·매도(SELL)·수량 조정(ADJUST). 현금·보유는 이 행들로만 셉니다
--   (현금·보유가 음수가 되는 행은 백엔드가 받지 않음). 지시대로 자동 기록한 행은 source AUTO(수수료·세금 0), 사용자가 입력·고친 행은 USER.
-- - manual_instructions: 다음 시가 매매 지시 — (계좌, 세션, 종목)마다 한 행, 상태 PLANNED → RECORDED(장부에 적힘)·SKIPPED(건너뜀).
--   알림 시각(밤·아침)은 한 번씩만 보내려고 둡니다.
-- - manual_sessions: 세션마다 한 행 — 지시를 만들었는가(PLANNED)·지시 없음(NONE)·못 만듦(UNAVAILABLE)을 남겨 같은 세션을 되풀이하지 않게.
--   detail에는 사유 코드·건너뛴 종목 등 계산 기록을 둡니다. 다음 세션 지시를 만든 뒤 그 세션 08:00 전에 장부를 고치면 백엔드가 그 세션의
--   PLANNED 지시(묶인 장부 행 없음)와 세션 행을 지워 고친 장부로 다시 만들게 하고, 08:00 뒤면 지우지 않고 ledger_changed_at만 남깁니다.
-- - 다른 증권사 실제 계좌 자료라 저장소·문서·커밋·QA 기록에 값을 넣지 않습니다(마이그레이션 시드 없음). 매일 S3 백업에 들어가고,
--   QA 복원(scripts/db-restore.sh RESTORE_REAL_TRADE=clear)은 이 표들을 비웁니다.
-- - 모의 표(paper_*)에는 외래키를 두지 않습니다(decision_id는 참고용 번호) — 모의 초기화가 막히지 않게.
-- - 수집기는 이 표들을 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 표·색인은 IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS manual_accounts (
    code        TEXT          PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{1,20}$'),
    label       TEXT          NOT NULL,
    market      TEXT          NOT NULL CHECK (market IN ('KR')),
    source_book TEXT          NOT NULL,                     -- 따라 하는 모의 책(kr_rules)
    state       TEXT          NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'PAUSED')),
    started_at  TIMESTAMPTZ   NOT NULL,
    start_cash  NUMERIC(20,2) NOT NULL CHECK (start_cash >= 0),
    version     INTEGER       NOT NULL DEFAULT 0,           -- 장부·지시가 바뀔 때마다 1씩
    recalc_session DATE,                                    -- 장부 고침이 이미 알린 다음 세션 지시를 지운 세션(다시 만들 때 알림 머리에 '다시 계산') — 다시 만들면 비움
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_instructions (
    id                  BIGSERIAL     PRIMARY KEY,
    account             TEXT          NOT NULL REFERENCES manual_accounts (code),
    session             DATE          NOT NULL,             -- 매매할 거래일(그 시가)
    symbol              TEXT          NOT NULL CHECK (symbol ~ '^[0-9][0-9A-Z]{5}$'),
    side                TEXT          NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity            INTEGER       NOT NULL CHECK (quantity > 0),
    ref_price           NUMERIC(20,4),                      -- 수량을 정한 기준가
    weight_pct          NUMERIC(9,4),                       -- 규칙 계좌의 목표 비중(%) — 책에 없는 보유는 0
    reason              JSONB         NOT NULL DEFAULT '{}', -- 근거(규칙 계좌 결정 번호·목표 비중·평가액)·자동 기록 메모
    status              TEXT          NOT NULL DEFAULT 'PLANNED'
                                      CHECK (status IN ('PLANNED', 'RECORDED', 'SKIPPED', 'SUPERSEDED')),
    notified_night_at   TIMESTAMPTZ,
    notified_morning_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (account, session, symbol)
);
CREATE INDEX IF NOT EXISTS manual_instructions_planned ON manual_instructions (account, session, id) WHERE status = 'PLANNED';
CREATE INDEX IF NOT EXISTS manual_instructions_recent ON manual_instructions (account, id DESC);

CREATE TABLE IF NOT EXISTS manual_ledger (
    id             BIGSERIAL     PRIMARY KEY,
    account        TEXT          NOT NULL REFERENCES manual_accounts (code),
    at             TIMESTAMPTZ   NOT NULL,
    kind           TEXT          NOT NULL CHECK (kind IN ('DEPOSIT', 'WITHDRAW', 'BUY', 'SELL', 'ADJUST')),
    symbol         TEXT,
    quantity       NUMERIC(20,6),
    price          NUMERIC(20,4),
    amount         NUMERIC(20,2),                           -- 입출금 금액
    fee            NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    tax            NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    instruction_id BIGINT        REFERENCES manual_instructions (id),
    source         TEXT          NOT NULL CHECK (source IN ('AUTO', 'USER')),
    note           TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT manual_ledger_symbol CHECK (kind NOT IN ('BUY', 'SELL', 'ADJUST')
        OR (symbol ~ '^[0-9][0-9A-Z]{5}$' AND quantity IS NOT NULL)),
    CONSTRAINT manual_ledger_trade CHECK (kind NOT IN ('BUY', 'SELL') OR (quantity > 0 AND price > 0)),
    CONSTRAINT manual_ledger_adjust CHECK (kind <> 'ADJUST' OR quantity <> 0),
    CONSTRAINT manual_ledger_cash CHECK (kind NOT IN ('DEPOSIT', 'WITHDRAW') OR (amount > 0 AND symbol IS NULL))
);
CREATE INDEX IF NOT EXISTS manual_ledger_account_at ON manual_ledger (account, at, id);
CREATE INDEX IF NOT EXISTS manual_ledger_instruction ON manual_ledger (instruction_id) WHERE instruction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_sessions (
    account     TEXT        NOT NULL REFERENCES manual_accounts (code),
    session     DATE        NOT NULL,
    state       TEXT        NOT NULL CHECK (state IN ('NONE', 'PLANNED', 'UNAVAILABLE')),
    decision_id BIGINT,                                     -- 근거가 된 규칙 계좌 결정 번호(외래키 없음)
    detail      JSONB       NOT NULL DEFAULT '{}',          -- 사유 코드·건너뛴 종목(계산 기록)
    ledger_changed_at TIMESTAMPTZ,                          -- 지시를 만든 뒤(그 세션 08:00 뒤) 장부가 바뀌었는데 다시 계산하지 않은 시각
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account, session)
);
