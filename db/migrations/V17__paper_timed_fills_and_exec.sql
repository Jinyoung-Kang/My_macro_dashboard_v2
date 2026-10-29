-- =============================================================================
-- V17__paper_timed_fills_and_exec.sql
-- 🧪 미국 Claude 계좌2(체결 시점 실험)의 장부 스키마 — 단계 0·1, 더하기만(명세 docs/specs/2026-10-30-claude-book2-timing-design.md
-- §11, ADR 0022). 기존 행·계좌는 그대로이고, 새 칸·표를 쓰는 코드는 실행 감사 작업(단계 0-4)과 시각 지정 체결(단계 1-4)부터입니다.
--
-- - paper_orders.timing에 계좌2의 시각 지정 시점 AT_1000·AT_1100·AT_1200·AT_1300·AT_1400·AT_1500(목표 세션 E의 그 시각,
--   America/New_York — ADR 0022 결정 3)을 더합니다. 옛 다섯 값을 모두 담는 상위 집합이라 지금 행은 그대로 통과합니다.
--   CHECK는 지운 뒤 같은 이름으로 다시 만듭니다(V14와 같은 방식). 장중 확인의 MARKET은 V18(단계 2)입니다.
-- - paper_fills.bar_at(체결 봉의 시작 시각)·fill_rung(가격 사다리 칸 Y1M_AT·Y1M_NEXT·Y1M_LATE·QUOTES_FALLBACK·QUOTES_CLOSE):
--   계좌2의 시각 지정 체결만 씁니다. 계좌1·규칙·벤치마크·한국 체결은 NULL입니다(기본값 없음 — 빈 값으로 채우지 않음). observed_at은
--   지금 뜻 그대로(장부가 처리한 관측치의 수집 시각)입니다. 두 칸을 묶는 CHECK는 두지 않습니다 — 시간별 관측가로 푼 칸(QUOTES_*)에는
--   1분봉 시각이 없을 수 있습니다.
-- - paper_order_exec(새 표, 실행 감사): 주문마다 한 행 — 고른 시점 timing(주문 행 값 그대로, CHECK는 paper_orders 한 곳),
--   목표 시각 target_at(정해진 시각이 없는 NEXT_OBSERVATION은 NULL), 메뉴 시점마다의 반사실 cf(시점 → {raw, at, rung} 또는 null —
--   한 번 쓴 시점은 고치지 않음), 그 주문을 푼 1분봉 저장본의 지연 lag_seconds(정규장 밖·모름은 NULL), 늦게 풀었는가 late_resolved
--   (아직 풀리지 않았거나 모르면 NULL). 계좌1 주문 행도 가집니다(반사실 기준 분포). 주문을 지우면(초기화·책 삭제) 함께 지워집니다.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 수집기는 1분봉 수집 범위를 정하려고
--   paper_orders·paper_positions·paper_books를 읽기만 합니다(단계 0-3, 이 표는 읽지 않음). 백엔드가 이 칸·표로 "스키마 준비됨"을
--   보는 것(PaperStore.ready)은 그것을 읽고 쓰는 코드와 같은 커밋(단계 0-4)에서입니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 열이 이미 있으면 ADD COLUMN IF NOT EXISTS가 CHECK까지
--   통째로 건너뛰고, CHECK는 지운 뒤 같은 모양으로 다시, 표·색인은 IF NOT EXISTS입니다. 다만 다시 실행하는 동안 V14가 timing CHECK를
--   옛 다섯 값으로 되돌렸다가 이 파일이 다시 넓히므로, 테스트 DB에 AT_* 주문 행이 남아 있으면 V14에서 실패합니다 — 그런 행을 쓰는
--   시험은 시작·끝에 지웁니다. 운영 DB(수집기 기동)는 대기 중인 파일만 적용하므로 해당하지 않습니다.
-- =============================================================================

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_timing_check;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_timing_check
    CHECK (timing IN ('NEXT_OBSERVATION', 'NEXT_OPEN', 'NEXT_CLOSE', 'IMMEDIATE', 'BACKFILL',
                      'AT_1000', 'AT_1100', 'AT_1200', 'AT_1300', 'AT_1400', 'AT_1500'));

ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS bar_at TIMESTAMPTZ;
ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS fill_rung TEXT
    CHECK (fill_rung IN ('Y1M_AT', 'Y1M_NEXT', 'Y1M_LATE', 'QUOTES_FALLBACK', 'QUOTES_CLOSE'));

CREATE TABLE IF NOT EXISTS paper_order_exec (
    order_id      BIGINT      PRIMARY KEY REFERENCES paper_orders (id) ON DELETE CASCADE,
    book_code     TEXT        NOT NULL REFERENCES paper_books (code) ON DELETE CASCADE,
    timing        TEXT        NOT NULL,                -- 주문 행의 timing 그대로
    target_at     TIMESTAMPTZ,                         -- 목표 시각 T. NEXT_OBSERVATION은 NULL
    cf            JSONB       NOT NULL DEFAULT '{}',   -- 시점 → {raw, at, rung} 또는 null. 한 번 쓴 시점은 고치지 않음
    lag_seconds   INTEGER,                             -- 정규장 밖·모름은 NULL(0으로 채우지 않음)
    late_resolved BOOLEAN,                             -- 아직 풀리지 않았거나 모르면 NULL
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_order_exec_book ON paper_order_exec (book_code);
