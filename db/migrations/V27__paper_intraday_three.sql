-- =============================================================================
-- V27__paper_intraday_three.sql
-- 장중 판단 세션당 최대 3회와 코드가 만든 판단의 출처 — 더하기만(ADR 0031 초안 결정 4, ADR 0027 결정 3 개정 — 사용자 결정 2026-11-06 "최소 1~최대 3회").
-- 기존 행·값은 그대로 받습니다(상위 집합). 새 값(순번 3·결정 종류 INTRADAY_3·출처 GUARANTEE·EVENT)을 쓰는 것은 설정 intradayMaxPerSession·
-- intradayMinPerSession·intradayEvents를 바꾼 뒤부터입니다(배포만으로는 2회 그대로).
--
-- - paper_decisions.kind에 INTRADAY_3을 더합니다. V23의 일곱 값을 모두 담는 상위 집합입니다(지운 뒤 같은 이름으로 다시 — V18·V23과 같은 방식).
--   UNIQUE(book_code, as_of_trading_date, kind)와 그것에 기대는 ON CONFLICT 문장은 바꾸지 않습니다.
-- - paper_intraday_plans.slot CHECK를 1~2에서 1~3으로 넓힙니다(V23의 인라인 CHECK가 받은 이름 paper_intraday_plans_slot_check — 지운 뒤 다시).
-- - paper_intraday_plans.origin(새 칸, 기본 RESERVED): 그 행을 누가 만들었나 — RESERVED(그 세션 결정의 예약), NEXT(장중 판단의 nextCheckpoint),
--   MANUAL(운영자 당김·넣기), GUARANTEE(세션 중간까지 예약이 없어 코드가 만든 보장 1회), EVENT(사건이 당기거나 더한 판단). 기존 행은 한 번
--   채웁니다 — manual이면 MANUAL, 예약한 장중 판단(requested_by_decision_id)이 있으면 NEXT, 그 밖은 기본 RESERVED.
-- - paper_intraday_plans.trigger(새 칸, JSONB, 없으면 NULL): 사건이 당기거나 더한 판단의 사건 목록·원래 시각(코드 규칙이 부른 이유 — 패킷·화면이 읽음).
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). 수집기는 장중 감시 범위를 정하려고 이 표를
--   읽기만 하고 순번을 거르지 않습니다(collector/app/store.py intraday_watch_plans).
-- - 옛 코드(이 파일 전 백엔드)와 함께 돌아도 됩니다 — 옛 upsert는 새 칸을 모르니 넣는 행은 기본 RESERVED, 바꾸는 행은 출처를 그대로 둡니다. 다만
--   옛 코드는 순번 3 행을 부르지 못하므로(INTRADAY_3을 모름) 코드를 되돌리기 전에 설정을 2회로 낮추고 순번 3인 PLANNED 행을 닫습니다(ADR 0031
--   초안 '되돌리기').
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): CHECK는 지운 뒤 같은 모양으로 다시, 칸은 IF NOT EXISTS, 채우기는 기본값
--   행만 바꿉니다. 다만 다시 실행하는 동안 V18·V23이 kind CHECK를 옛 값으로 되돌렸다가 이 파일이 다시 넓히므로, 테스트 DB에 INTRADAY_3 결정 행이
--   남아 있으면 V18·V23에서 실패합니다 — 그런 행을 쓰는 시험은 시작·끝에 지웁니다(V23의 INTRADAY_* 선례). 순번 3 계획 행은 V23이 표를 다시
--   만들지 않으므로(CREATE TABLE IF NOT EXISTS) 막히지 않습니다. 운영 DB(수집기 기동)는 대기 중인 파일만 적용하므로 해당하지 않습니다.
-- =============================================================================

ALTER TABLE paper_decisions DROP CONSTRAINT IF EXISTS paper_decisions_kind_check;
ALTER TABLE paper_decisions ADD CONSTRAINT paper_decisions_kind_check
    CHECK (kind IN ('SCHEDULED', 'MANUAL', 'INITIAL', 'REBALANCE', 'CHECKPOINT', 'INTRADAY_1', 'INTRADAY_2', 'INTRADAY_3'));

ALTER TABLE paper_intraday_plans DROP CONSTRAINT IF EXISTS paper_intraday_plans_slot_check;
ALTER TABLE paper_intraday_plans ADD CONSTRAINT paper_intraday_plans_slot_check CHECK (slot BETWEEN 1 AND 3);

ALTER TABLE paper_intraday_plans ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'RESERVED';
ALTER TABLE paper_intraday_plans DROP CONSTRAINT IF EXISTS paper_intraday_plans_origin_check;
ALTER TABLE paper_intraday_plans ADD CONSTRAINT paper_intraday_plans_origin_check
    CHECK (origin IN ('RESERVED', 'NEXT', 'MANUAL', 'GUARANTEE', 'EVENT'));
ALTER TABLE paper_intraday_plans ADD COLUMN IF NOT EXISTS trigger JSONB;

-- 기존 행의 출처 — 기본값(RESERVED)인 행만 바꿉니다(다시 실행해도 같은 결과, 코드가 적은 출처는 건드리지 않음).
UPDATE paper_intraday_plans SET origin = 'MANUAL' WHERE origin = 'RESERVED' AND manual;
UPDATE paper_intraday_plans SET origin = 'NEXT'
 WHERE origin = 'RESERVED' AND NOT manual AND requested_by_decision_id IS NOT NULL;
