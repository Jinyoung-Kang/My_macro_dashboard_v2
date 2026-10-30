-- =============================================================================
-- V18__paper_checkpoints.sql
-- 🧪 미국 Claude 계좌2(체결 시점 실험)의 장중 확인 — 단계 2, 더하기만(명세 docs/specs/2026-10-30-claude-book2-timing-design.md
-- §5-2·§9-5·§11, ADR 0022). 기존 행·계좌는 그대로이고, 새 값·표를 쓰는 코드는 장중 확인 계획(B1-2)·작업(B1-4)·시장가(B2-2)부터입니다.
--
-- - paper_decisions.kind에 CHECKPOINT(장중 확인 응답 — 기준 거래일은 아침 결정과 같은 d라 UNIQUE(book, d, kind)가 "세션당 한 번"을
--   그대로 강제)를 더합니다. V8이 표와 함께 만든 CHECK(자동 이름 paper_decisions_kind_check)를 지운 뒤 같은 이름으로 다시 만듭니다.
--   V8을 다시 실행해도 CREATE TABLE IF NOT EXISTS라 이 CHECK를 되돌리지 않습니다.
-- - paper_orders.timing에 MARKET(장중 확인 응답의 장중 시장가 — 기준 시각은 생성 + 60초 뒤 첫 분)을 더합니다. V17의 열한 값을 모두
--   담는 상위 집합이라 지금 행은 그대로 통과합니다(V14·V17과 같은 방식 — 지운 뒤 같은 이름으로 다시).
-- - paper_checkpoints(새 표): 계좌·세션마다 한 행 — 아침 결정이 고른 확인 시각 at_et(목표 세션 E의 뉴욕 시간), 볼 자료 feed(MINUTE =
--   감시 종목 1분봉, HOURLY = 전 종목 시간별 관측치), 감시 목록 watch, 질문 question, 그 요청을 낸 결정 source_decision_id, 확인 응답
--   결정 checkpoint_decision_id(부르기 전·놓침은 NULL), 상태 status(PLANNED → DONE·EXPIRED·SKIPPED, 사유는 reason), 그 확인이 읽은
--   감시 저장본의 지연 lag_seconds(정규장 밖·모름·HOURLY는 NULL — 0으로 채우지 않음), 부른 시각 called_at. 요청을 낸 결정을 지우면
--   (초기화·책 삭제) 함께 지워지고, 확인 응답 결정만 지워지면 칸이 NULL이 됩니다.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 수집기는 장중 확인 감시 범위
--   (paper_watch_us)를 정하려고 이 표를 읽기만 합니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): CHECK는 지운 뒤 같은 모양으로 다시, 표·색인은 IF NOT EXISTS입니다.
--   다만 다시 실행하는 동안 V14(다섯 값)·V17(열한 값)이 timing CHECK를 옛 값으로 되돌렸다가 이 파일이 다시 넓히므로, 테스트 DB에 MARKET
--   주문 행이 남아 있으면 V14·V17에서 실패합니다 — 그런 행(과 CHECKPOINT 결정 행)을 쓰는 시험은 시작·끝에 지웁니다. 운영 DB(수집기
--   기동)는 대기 중인 파일만 적용하므로 해당하지 않습니다.
-- =============================================================================

ALTER TABLE paper_decisions DROP CONSTRAINT IF EXISTS paper_decisions_kind_check;
ALTER TABLE paper_decisions ADD CONSTRAINT paper_decisions_kind_check
    CHECK (kind IN ('SCHEDULED', 'MANUAL', 'INITIAL', 'REBALANCE', 'CHECKPOINT'));

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_timing_check;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_timing_check
    CHECK (timing IN ('NEXT_OBSERVATION', 'NEXT_OPEN', 'NEXT_CLOSE', 'IMMEDIATE', 'BACKFILL',
                      'AT_1000', 'AT_1100', 'AT_1200', 'AT_1300', 'AT_1400', 'AT_1500', 'MARKET'));

CREATE TABLE IF NOT EXISTS paper_checkpoints (
    book_code              TEXT        NOT NULL REFERENCES paper_books (code) ON DELETE CASCADE,
    session_date           DATE        NOT NULL,                  -- 목표 세션 E(뉴욕 거래일)
    at_et                  TIME        NOT NULL,                  -- 확인 시각(E의 America/New_York 시각)
    feed                   TEXT        NOT NULL CHECK (feed IN ('MINUTE', 'HOURLY')),
    watch                  TEXT[]      NOT NULL DEFAULT '{}',
    question               TEXT,
    source_decision_id     BIGINT      NOT NULL REFERENCES paper_decisions (id) ON DELETE CASCADE,
    checkpoint_decision_id BIGINT      REFERENCES paper_decisions (id) ON DELETE SET NULL,
    status                 TEXT        NOT NULL CHECK (status IN ('PLANNED', 'DONE', 'EXPIRED', 'SKIPPED')),
    reason                 TEXT,
    lag_seconds            INTEGER,                               -- 정규장 밖·모름·HOURLY는 NULL(0으로 채우지 않음)
    called_at              TIMESTAMPTZ,                           -- 부르기 전·놓침은 NULL
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (book_code, session_date)
);
CREATE INDEX IF NOT EXISTS paper_checkpoints_status ON paper_checkpoints (status);
