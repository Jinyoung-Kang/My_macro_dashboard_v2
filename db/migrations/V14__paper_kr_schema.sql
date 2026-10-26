-- =============================================================================
-- V14__paper_kr_schema.sql
-- 모의 매매(한국) 책의 장부 스키마(2단계 명세 docs/specs/2026-10-26-v2-kr-paper-spec.md §4-14, 결정 K23). 미국 행은 값이
-- 그대로이고(새 열은 기본값), 한국 책(kr_*)이 C 묶음부터 씁니다.
--
-- - paper_orders.timing에 NEXT_OPEN(다음 거래일 시가 — 한국 기본 체결 시점, K13)을 더합니다. CHECK는 지운 뒤 같은 이름으로 다시.
-- - paper_fills에 비용 칸 fee(수수료)·tax(거래세 + 농어촌특별세)·slippage_cost(슬리피지 금액)를 더합니다(NUMERIC(18,4), 기본 0,
--   음수 불가). 미국 행은 0입니다 — 미국 수수료·세금은 모형에 없고 슬리피지는 체결가(price)에 들어 있습니다. 한국 행은
--   price = raw_price(관측가 그대로)이고 슬리피지는 금액 칸으로 현금에서 뺍니다(K31). 체결 행은 쓴 뒤 고치지 않습니다.
--   price_source는 CHECK 없는 글자 그대로입니다(미국 값은 관측치 데이터셋 이름 — 한국 값 TOSS_1M_OPEN·TOSS_1M_CLOSE·
--   TOSS_INTEGRATED·TOSS_DAILY·FSC는 코드 상수, C2).
-- - paper_fill_confirmations(새 표, K29): 금융위 확정가가 들어오면 체결마다 '확정 조정' 한 행(추가만 — 체결 행은 그대로).
--   확정가, 그 값으로 다시 계산한 비용 칸, cash_delta = 확정 기준 현금 흐름 − 잠정 기준 현금 흐름(매수 잠정 71,300 → 확정
--   71,200 × 10주면 +1,000). 체결 행을 지우면(초기화·책 삭제) 함께 지워집니다(ON DELETE CASCADE). 비용 칸에 기본값을 두지
--   않습니다 — 쓰는 쪽이 늘 다시 계산한 값을 넣습니다.
-- - paper_positions.corp_action_hold: '미처리 기업행위' 사유(K32). NULL이면 정상, 값이 있으면 평가를 마지막 확정가로 묶고
--   스탑·주문을 보류합니다.
-- - paper_reviews.market·paper_notes.market(US·KR, 기본 US): 복기는 시장마다 한 주 한 행이라 기본키를 (market, week_ending)으로
--   바꿉니다(week_ending = 그 시장 달력의 ISO 주 마지막 거래일). 같은 커밋에서 store.PaperStore의 복기 SQL이
--   ON CONFLICT (market, week_ending)·WHERE market으로 바뀝니다 — 기본키만 바꾸면 ON CONFLICT (week_ending)에 맞는 유일
--   제약이 없어집니다. 메모는 그 시장 목록·패킷에만 실립니다. 지금 행은 모두 미국입니다(기본값).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 열이 이미 있으면 ADD COLUMN IF NOT EXISTS가 CHECK까지
--   통째로 건너뛰고, CHECK·기본키는 지운 뒤 같은 모양으로 다시 만듭니다(V9와 같은 방식).
-- - 그대로인 표: paper_selection_log·paper_gate_log·paper_track_record(미국·13F 전용), paper_start_prices(한국은 쓰지 않음 —
--   K28), paper_api_usage(두 책이 한 줄을 나눠 씀 — K18). 금액 NUMERIC(18,4)는 1억 원을 담습니다.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 백엔드는
--   paper_reviews.market·paper_notes.market 열로 "스키마 준비됨"을 봅니다(PaperStore.ready).
-- =============================================================================

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_timing_check;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_timing_check
    CHECK (timing IN ('NEXT_OBSERVATION', 'NEXT_OPEN', 'NEXT_CLOSE', 'IMMEDIATE', 'BACKFILL'));

ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS fee NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (fee >= 0);
ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS tax NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (tax >= 0);
ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS slippage_cost NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (slippage_cost >= 0);

CREATE TABLE IF NOT EXISTS paper_fill_confirmations (
    fill_id         BIGINT        PRIMARY KEY REFERENCES paper_fills (id) ON DELETE CASCADE,
    book_code       TEXT          NOT NULL REFERENCES paper_books (code) ON DELETE CASCADE,
    confirmed_price NUMERIC(18,6) NOT NULL,
    fee             NUMERIC(18,4) NOT NULL CHECK (fee >= 0),
    tax             NUMERIC(18,4) NOT NULL CHECK (tax >= 0),
    slippage_cost   NUMERIC(18,4) NOT NULL CHECK (slippage_cost >= 0),
    cash_delta      NUMERIC(18,4) NOT NULL,      -- 확정 기준 현금 흐름 − 잠정 기준 현금 흐름(음수 가능)
    source          TEXT          NOT NULL CHECK (source IN ('FSC', 'FSC_ETF')),
    reconciled_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_fill_confirmations_recent ON paper_fill_confirmations (book_code, reconciled_at DESC);

ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS corp_action_hold TEXT;

ALTER TABLE paper_reviews ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'KR'));
ALTER TABLE paper_reviews DROP CONSTRAINT IF EXISTS paper_reviews_pkey;
ALTER TABLE paper_reviews ADD PRIMARY KEY (market, week_ending);

ALTER TABLE paper_notes ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'KR'));
