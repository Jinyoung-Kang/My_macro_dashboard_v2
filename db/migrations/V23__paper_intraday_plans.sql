-- =============================================================================
-- V23__paper_intraday_plans.sql
-- 체결 시점 자유화의 장중 판단 — 더하기만(ADR 0027 결정 3·4, 명세 docs/specs/2026-11-05-free-fill-timing.md §3·§7).
-- 기존 행·제약은 그대로이고, 새 값·표를 쓰는 것은 자유 시점 판을 켠 계좌의 결정부터입니다(스위치는 기본 꺼짐).
--
-- - paper_decisions.kind에 INTRADAY_1·INTRADAY_2(자유 시점 판의 장중 판단 응답 — 세션마다 계좌별 최대 두 번)를 더합니다. V18의 다섯 값을 모두
--   담는 상위 집합입니다(지운 뒤 같은 이름으로 다시 — V18과 같은 방식). 기준 거래일은 그 세션의 아침(한국은 밤) 결정과 같은 d라, 기존
--   UNIQUE(book_code, as_of_trading_date, kind)가 "순번마다 한 번"을 그대로 강제합니다 — UNIQUE와 그것에 기대는 ON CONFLICT 문장은 바꾸지
--   않습니다(스위치가 꺼진 동안 옛 판 백엔드로 되돌릴 수 있게). 끈 판의 장중 확인(CHECKPOINT)은 그대로입니다.
-- - paper_intraday_plans(새 표): 계좌·세션·순번마다 한 행 — 확인 시각 at_local(목표 세션 E의 그 시장 현지 시각, 분 단위), 볼 자료 feed,
--   감시 목록 watch, 질문 question, 그 세션의 결정이 쓴 판 variant(장중 판단은 이 판으로 부름), 운영자가 당기거나 넣은 행인가 manual,
--   그 세션의 아침(밤) 결정 source_decision_id(장중 판단 패킷이 하드 규칙·가격·선정 기준일을 읽는 결정 — 다음 판단을 예약한 장중 판단이
--   있어도 바뀌지 않음), 다음 판단을 예약한 장중 판단 requested_by_decision_id, 응답 결정 intraday_decision_id(부르기 전·놓침은 NULL),
--   상태 status(PLANNED → DONE·EXPIRED·SKIPPED·SUPERSEDED, 사유는 reason), 감시 저장본의 지연 lag_seconds(모르면 NULL — 0으로 채우지 않음),
--   부른 시각 called_at. 아침 결정을 지우면(초기화·책 삭제) 함께 지워지고, 다른 두 결정만 지워지면 그 칸이 NULL이 됩니다.
--   paper_checkpoints(PK 계좌·세션 — 끈 판의 세션당 한 번)와 따로 둡니다: 그 표의 PK를 바꾸면 지금 코드의 ON CONFLICT (book_code,
--   session_date)가 맞는 제약을 찾지 못합니다.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 수집기는 장중 감시 범위를 정하려고 읽기만 합니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): CHECK는 지운 뒤 같은 모양으로 다시, 표·색인은 IF NOT EXISTS.
--   다만 다시 실행하는 동안 V18이 kind CHECK를 옛 다섯 값으로 되돌렸다가 이 파일이 다시 넓히므로, 테스트 DB에 INTRADAY_* 결정 행이 남아
--   있으면 V18에서 실패합니다 — 그런 행을 쓰는 시험은 시작·끝에 지웁니다(CHECKPOINT·MARKET 선례). 운영 DB(수집기 기동)는 대기 중인 파일만
--   적용하므로 해당하지 않습니다.
-- =============================================================================

ALTER TABLE paper_decisions DROP CONSTRAINT IF EXISTS paper_decisions_kind_check;
ALTER TABLE paper_decisions ADD CONSTRAINT paper_decisions_kind_check
    CHECK (kind IN ('SCHEDULED', 'MANUAL', 'INITIAL', 'REBALANCE', 'CHECKPOINT', 'INTRADAY_1', 'INTRADAY_2'));

CREATE TABLE IF NOT EXISTS paper_intraday_plans (
    book_code                TEXT        NOT NULL REFERENCES paper_books (code) ON DELETE CASCADE,
    session_date             DATE        NOT NULL,                  -- 목표 세션 E(그 시장 거래일)
    slot                     SMALLINT    NOT NULL CHECK (slot BETWEEN 1 AND 2),   -- 그 세션의 몇 번째 판단인가(결정 종류 INTRADAY_<slot>)
    at_local                 TIME        NOT NULL CHECK (EXTRACT(SECOND FROM at_local) = 0),   -- 확인 시각(그 시장 현지 시각, 분 단위)
    feed                     TEXT        NOT NULL CHECK (feed IN ('MINUTE', 'HOURLY')),
    watch                    TEXT[]      NOT NULL DEFAULT '{}',
    question                 TEXT,
    variant                  TEXT        NOT NULL,                  -- 그 세션의 결정이 쓴 판 이름(1_basis.fixedRules — ft-1·kr-ft-1)
    manual                   BOOLEAN     NOT NULL DEFAULT FALSE,    -- 운영자가 당기거나 넣은 행(수동 문턱으로 부름)
    source_decision_id       BIGINT      NOT NULL REFERENCES paper_decisions (id) ON DELETE CASCADE,
    requested_by_decision_id BIGINT      REFERENCES paper_decisions (id) ON DELETE SET NULL,
    intraday_decision_id     BIGINT      REFERENCES paper_decisions (id) ON DELETE SET NULL,
    status                   TEXT        NOT NULL CHECK (status IN ('PLANNED', 'DONE', 'EXPIRED', 'SKIPPED', 'SUPERSEDED')),
    reason                   TEXT,
    lag_seconds              INTEGER,                               -- 모르면 NULL(0으로 채우지 않음)
    called_at                TIMESTAMPTZ,                           -- 부르기 전·놓침은 NULL
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (book_code, session_date, slot)
);
CREATE INDEX IF NOT EXISTS paper_intraday_plans_status ON paper_intraday_plans (status);
-- 결정 행을 지울 때(초기화·책 삭제)의 외래키 확인이 표 전체를 훑지 않게(V20과 같은 까닭).
CREATE INDEX IF NOT EXISTS paper_intraday_plans_source_decision ON paper_intraday_plans (source_decision_id);
CREATE INDEX IF NOT EXISTS paper_intraday_plans_requested_by_decision ON paper_intraday_plans (requested_by_decision_id);
CREATE INDEX IF NOT EXISTS paper_intraday_plans_intraday_decision ON paper_intraday_plans (intraday_decision_id);
