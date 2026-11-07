-- =============================================================================
-- V29__real_trade_valuation.sql
-- 실제 매매의 마지막 운용 평가액 — 더하기만(2026-11-08 사용자 결정 "휴장일에도 운용 평가액이 보이게", ADR 0028 결정 7의 real_trade_* 저장 범위).
-- JDBC는 백엔드 store.RealTradeStore 한 곳에만 있습니다(ADR 0008).
--
-- - real_trade_valuation(새 표): 시장마다 한 행 — 정기 작업이 토스에서 마지막으로 새로 읽은 운용 평가액(안전 상한 적용 E)·상한 없는 총액(손실 판정의
--   '지금 값')·원화 매수 가능 금액과 그 읽은 시각. 백엔드를 다시 띄워도, 휴장일·토스 점검(maintenance) 동안에도 화면의 '운용 평가액'·'기준 대비 손익'이
--   이 값을 읽은 시각과 함께 보입니다. 주문·손실 판정은 이 표를 읽지 않습니다(그때마다 토스에서 새로 읽음).
-- - 보유 종목·수량·계좌번호·accountSeq는 두지 않습니다(금액 셋과 시각만). 매일 S3 백업·서버 배포 전 덤프에 들어가고(real_trade_config의 기준 평가액과
--   같은 범위), QA 복원(RESTORE_REAL_TRADE=clear)은 이 표를 비웁니다.
-- - 다른 증권사 실제 계좌 자료라 저장소·문서·커밋·QA 기록에 값을 넣지 않습니다(시드 없음). 수집기는 이 표를 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 표는 IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS real_trade_valuation (
    market            TEXT          PRIMARY KEY CHECK (market IN ('KR', 'US')),
    fetched_at        TIMESTAMPTZ   NOT NULL,              -- 토스에서 읽은 시각(수집기 사전 조회의 fetchedAt)
    equity            NUMERIC(20,2) NOT NULL,              -- 운용 평가액 E(원화 매수 가능 금액 + 국내 보유, 서버 안전 상한 적용)
    total             NUMERIC(20,2),                       -- 상한 없는 총액(이 기능의 미체결 매수가 잡은 금액을 되돌린 값 — 모르면 NULL)
    cash_buying_power NUMERIC(20,2),                       -- 원화 매수 가능 금액
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
