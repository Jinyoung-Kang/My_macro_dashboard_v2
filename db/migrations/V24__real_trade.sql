-- =============================================================================
-- V24__real_trade.sql
-- 토스증권 실제 계좌가 모의 책을 따라 하는 실제 매매(한국 원화) — 백엔드가 쓰는 표 넷(ADR 0028 결정 7, 명세
-- docs/specs/2026-11-06-real-trade-mirror.md §6). JDBC는 백엔드 store.RealTradeStore 한 곳에만 있습니다(ADR 0008).
--
-- - real_trade_config: 시장마다 한 행 — 상태(OFF·LIVE·HALTED·STOPPING), 따라 하는 책과 그 세대, 손실 한도·기준 평가액·기준 총액, 매수 멈춤, 다음 시가
--   맞추기의 회전율 예외(sync_pending), 이상 멈춤 사유, 버전(낙관적 잠금 — 백엔드는 이 행을 SELECT … FOR UPDATE로 잡고 'LIVE·버전 확인 +
--   SENDING 행 삽입'을 한 트랜잭션에서 합니다). 행이 없으면 꺼짐(OFF)으로 봅니다 — 백엔드가 처음 잠글 때 OFF 행을 만듭니다.
--   LIVE 행은 따라 하는 책과 그 세대가 있어야 합니다(real_trade_config_live_book).
-- - real_trade_events: 켜기·끄기·바꾸기·멈춤·쉼·창 요약·비밀번호 실패 기록과 알림 대기(notify, notified_at). 놓침·건너뜀은 주문 행이 아니라
--   이 표의 WINDOW_SUMMARY detail로 남깁니다. 종류는 대문자·밑줄 이름(목록은 열어 둠 — 명세 §6).
-- - real_trade_batches: 하루 한 번의 시가 맞추기 묶음(market, session, kind 유일) — 목표 비중·흡수한 모의 주문 번호·운용 평가액.
-- - real_trade_orders: 실제 주문 시도마다 한 행 — 보내기 전에 SENDING으로 먼저 쓰고(client_order_id 유일, 요청 본문 바이트 그대로) 결과·추적을
--   덧씁니다. 같은 모의 주문 뿌리·용도·시도는 한 행(부분 유일 색인), 같은 묶음의 종목·용도·시도도 한 행. 장중 따라 하기(MIRROR)는 모의 주문
--   번호와 뿌리가, 시가 맞추기·마무리(SYNC·SYNC_FOLLOWUP)는 묶음 번호가 있어야 합니다(그래야 위 유일 색인이 이중 주문을 막음 —
--   real_trade_orders_key). 시도는 1·2뿐(명세 §4 '새 키는 최대 2회'). 한 토스 주문 번호는 한 행에만 묶입니다(대조가 같은 주문을 둘에 묶지 않게).
-- - 모의 표(paper_*)에는 외래키를 두지 않습니다 — 모의 초기화·책 삭제가 막히지 않게(명세 §6). 실제 주문 행은 모의 주문이 지워져도 남습니다.
-- - 계좌번호·accountSeq는 어느 칸에도 두지 않습니다. 토스 주문 번호(toss_order_id)는 이 표에만 두고 응답·로그에 싣지 않습니다(ADR 0028 결정 7).
-- - 수집기는 이 표들을 읽지도 쓰지도 않습니다. 복원 직후에는 scripts/db-restore.sh가 꺼져 있지 않은 config를 HALTED('restored')로 바꾸고,
--   QA 복원은 주문·묶음·이벤트를 비우고 config를 OFF로 둡니다(명세 §9).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 표·색인은 IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS real_trade_config (
    market          TEXT          PRIMARY KEY CHECK (market IN ('KR', 'US')),
    state           TEXT          NOT NULL DEFAULT 'OFF' CHECK (state IN ('OFF', 'LIVE', 'HALTED', 'STOPPING')),
    source_book     TEXT,                                   -- 따라 하는 책(kr_rules·kr_claude·kr_claude2)
    book_generation TEXT,                                   -- 그 책의 세대(출발일·만든 시각) — 리셋·재출발을 알아챔
    loss_limit_pct  NUMERIC(5,2)  NOT NULL DEFAULT 15 CHECK (loss_limit_pct BETWEEN 1 AND 50),
    baseline_equity NUMERIC(20,2),                          -- 켤 때(또는 기준 다시 잡기)의 운용 평가액(안전 상한 적용 — 손실 한도 금액의 분모)
    baseline_total  NUMERIC(20,2),                          -- 같은 때의 상한 없는 총액(손실 판정의 기준 — 총액이 상한보다 커도 손실을 잡게)
    buys_paused     BOOLEAN       NOT NULL DEFAULT false,   -- 손실 한도에 걸려 새 매수만 멈춤
    sync_pending    BOOLEAN       NOT NULL DEFAULT false,   -- 켜기·방식 바꾸기·멈춤 해제 뒤 첫 시가 맞추기(회전율 한도 예외)
    halt_reason     TEXT,
    halt_detail     JSONB,
    version         INTEGER       NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_by      BIGINT,                                 -- 바꾼 운영자(users.id — 외래키 없음, 정기 작업이 바꾸면 NULL)
    CONSTRAINT real_trade_config_live_book CHECK (state <> 'LIVE' OR (source_book IS NOT NULL AND book_generation IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS real_trade_events (
    id          BIGSERIAL   PRIMARY KEY,
    market      TEXT        NOT NULL CHECK (market IN ('KR', 'US')),
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind        TEXT        NOT NULL CHECK (kind ~ '^[A-Z][A-Z_]{1,39}$'),
    user_id     BIGINT,                                     -- 사람이 한 일이면 그 운영자(users.id — 외래키 없음)
    detail      JSONB       NOT NULL DEFAULT '{}',          -- 사유 코드·건수(종목·금액은 넣어도 되지만 알림 글에는 쓰지 않음)
    notify      BOOLEAN     NOT NULL DEFAULT false,
    notified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS real_trade_events_recent ON real_trade_events (market, id DESC);
CREATE INDEX IF NOT EXISTS real_trade_events_kind ON real_trade_events (kind, at DESC);
CREATE INDEX IF NOT EXISTS real_trade_events_unnotified ON real_trade_events (id) WHERE notify AND notified_at IS NULL;

CREATE TABLE IF NOT EXISTS real_trade_batches (
    id                 BIGSERIAL   PRIMARY KEY,
    market             TEXT        NOT NULL CHECK (market IN ('KR', 'US')),
    session            DATE        NOT NULL,                -- 그 시장 거래일
    kind               TEXT        NOT NULL CHECK (kind IN ('SYNC')),
    source_book        TEXT        NOT NULL,
    targets            JSONB       NOT NULL DEFAULT '{}',   -- 종목 → 비중(%)
    absorbed_order_ids BIGINT[]    NOT NULL DEFAULT '{}',   -- 시가 맞추기가 흡수한 모의 주문 번호(장중 따라 하기로 따로 하지 않음)
    equity             NUMERIC,                             -- 그 묶음의 운용 평가액 E
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (market, session, kind)
);

CREATE TABLE IF NOT EXISTS real_trade_orders (
    id                   BIGSERIAL   PRIMARY KEY,
    market               TEXT        NOT NULL CHECK (market IN ('KR', 'US')),
    session              DATE        NOT NULL,
    purpose              TEXT        NOT NULL CHECK (purpose IN ('SYNC', 'SYNC_FOLLOWUP', 'MIRROR')),
    batch_id             BIGINT      REFERENCES real_trade_batches (id),
    source_book          TEXT        NOT NULL,
    book_generation      TEXT        NOT NULL,
    paper_order_id       BIGINT,                            -- 모의 주문 번호(외래키 없음 — 모의 리셋이 막히지 않게)
    paper_root_order_id  BIGINT,                            -- reason.reissuedFrom 사슬의 첫 주문(외래키 없음)
    symbol               TEXT        NOT NULL,
    side                 TEXT        NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity             INTEGER     NOT NULL CHECK (quantity > 0),
    time_in_force        TEXT        NOT NULL CHECK (time_in_force IN ('DAY', 'OPG')),
    ref_price            NUMERIC,                           -- 수량을 정할 때 쓴 기준가
    attempt              SMALLINT    NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 2),
    client_order_id      TEXT        NOT NULL UNIQUE CHECK (client_order_id ~ '^[A-Za-z0-9_-]{1,36}$'),
    request_body         TEXT        NOT NULL,              -- 수집기에 보낸 본문 바이트 그대로(재전송은 이 바이트만)
    send_outcome         TEXT        NOT NULL CHECK (send_outcome IN ('SENDING', 'ACCEPTED', 'REJECTED', 'UNKNOWN', 'NOT_SENT')),
    outcome_code         TEXT,
    toss_order_id        TEXT,                              -- 이 표에만(응답·로그에 싣지 않음)
    broker_status        TEXT,
    terminal             BOOLEAN     NOT NULL DEFAULT false, -- 종료가 확인됨(체결·취소·거부·정정, 또는 주문이 생기지 않음이 확실)
    filled_quantity      NUMERIC,
    average_filled_price NUMERIC,
    filled_amount        NUMERIC,
    commission           NUMERIC,
    tax                  NUMERIC,
    filled_at            TIMESTAMPTZ,
    first_sent_at        TIMESTAMPTZ NOT NULL,              -- 요청 본문의 firstSentAt과 같은 값(재전송 7분 창의 시작)
    last_sent_at         TIMESTAMPTZ,
    send_count           SMALLINT    NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    cancel_requested_at  TIMESTAMPTZ,                       -- 처음 취소를 보낸 시각
    cancel_outcome       TEXT,                              -- 마지막 취소 결과(수집기 outcome:사유 코드)
    cancel_count         SMALLINT    NOT NULL DEFAULT 0 CHECK (cancel_count >= 0), -- 취소를 보낸 횟수(재시작해도 이어 셈)
    cancel_last_at       TIMESTAMPTZ,                       -- 마지막으로 취소를 보낸 시각(다시 보내는 간격의 기준)
    cancel_gave_up_at    TIMESTAMPTZ,                       -- 취소를 상한까지 보내도 원 주문이 살아 있어 알린 시각(한 번만 알림)
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT real_trade_orders_kr_symbol CHECK (market <> 'KR' OR symbol ~ '^[0-9][0-9A-Z]{5}$'),
    CONSTRAINT real_trade_orders_key CHECK (
        (purpose = 'MIRROR' AND paper_order_id IS NOT NULL AND paper_root_order_id IS NOT NULL)
        OR (purpose IN ('SYNC', 'SYNC_FOLLOWUP') AND batch_id IS NOT NULL))
);
-- 배포 전 초안의 V24를 이미 적용한 DB(개발·테스트)에도 같은 칸이 생기게(make db-test는 파일을 매번 다시 실행 — 새 DB에서는 아무 일도 안 함).
ALTER TABLE real_trade_config ADD COLUMN IF NOT EXISTS baseline_total NUMERIC(20,2);
ALTER TABLE real_trade_orders ADD COLUMN IF NOT EXISTS cancel_count SMALLINT NOT NULL DEFAULT 0 CHECK (cancel_count >= 0);
ALTER TABLE real_trade_orders ADD COLUMN IF NOT EXISTS cancel_last_at TIMESTAMPTZ;
ALTER TABLE real_trade_orders ADD COLUMN IF NOT EXISTS cancel_gave_up_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS real_trade_orders_root_attempt
    ON real_trade_orders (market, paper_root_order_id, purpose, attempt) WHERE paper_root_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS real_trade_orders_batch_attempt
    ON real_trade_orders (batch_id, symbol, purpose, attempt) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS real_trade_orders_toss_order
    ON real_trade_orders (toss_order_id) WHERE toss_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS real_trade_orders_unfinished ON real_trade_orders (market, id) WHERE NOT terminal;
CREATE INDEX IF NOT EXISTS real_trade_orders_recent ON real_trade_orders (market, id DESC);
CREATE INDEX IF NOT EXISTS real_trade_orders_session ON real_trade_orders (market, session);
