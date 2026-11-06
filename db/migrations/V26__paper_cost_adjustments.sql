-- =============================================================================
-- V26__paper_cost_adjustments.sql
-- 미국 모의 계좌 체결 비용의 과거 소급 조정(ADR 0030, 명세 docs/specs/2026-11-06-us-costs-backfill.md §2). 백엔드가 쓰는 표 하나.
--
-- - paper_cost_adjustments: 소급 비용 조정 — 체결 하나에 한 행(기본키 fill_id — 같은 체결을 두 번 조정할 수 없음). 체결 행
--   (paper_fills)은 고치지 않습니다(paper_fill_confirmations 선례 — 당시 수량·체결가·결정은 그대로, 비용만 더함).
--   fee = 수수료(센트 반올림), tax = 매도 제비용(SEC fee + FINRA TAF, 센트 올림), cash_delta = −(fee + tax)(늘 0 이하 — 계좌 현금에 더한 값),
--   fill_date = 그 체결이 장부에 반영된 거래일(paper_fills.observation_date — 일별 순자산 줄 d에 fill_date ≤ d인 조정을 더함),
--   settings_version = 계산에 쓴 설정 판(설정 행이 없었으면 NULL), rates = 쓴 비율(commissionBp·secPerMillion·tafPerShare·tafMaxPerTrade),
--   reason = 'us-cost-backfill'. 체결을 지우면(계좌 초기화) 함께 지워집니다(ON DELETE CASCADE).
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 수집기는 읽지도 쓰지도 않습니다.
--   백엔드는 이 표가 있는지로 "스키마 준비됨"을 봅니다(PaperStore.ready — 백엔드만 새로 띄워 마이그레이션이 빠졌을 때, QA-016).
-- - 모의 자료라 금액을 담아도 됩니다(실제 계좌 자료 아님 — ADR 0025). 백업·QA 복원으로 함께 옮겨지고, 조정 행이 있는 체결은 소급을
--   다시 돌려도 건너뜁니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 표·색인은 IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS paper_cost_adjustments (
    fill_id          BIGINT        PRIMARY KEY REFERENCES paper_fills (id) ON DELETE CASCADE,
    book_code        TEXT          NOT NULL REFERENCES paper_books (code) ON DELETE CASCADE,
    market           TEXT          NOT NULL CHECK (market IN ('US', 'KR')),
    fee              NUMERIC(18,4) NOT NULL CHECK (fee >= 0),
    tax              NUMERIC(18,4) NOT NULL CHECK (tax >= 0),
    cash_delta       NUMERIC(18,4) NOT NULL CHECK (cash_delta <= 0),
    fill_date        DATE          NOT NULL,
    settings_version INTEGER,
    rates            JSONB         NOT NULL DEFAULT '{}'::jsonb,
    reason           TEXT          NOT NULL,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_cost_adjustments_book ON paper_cost_adjustments (book_code, fill_date);
