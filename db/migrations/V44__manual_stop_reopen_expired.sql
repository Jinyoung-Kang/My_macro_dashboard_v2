-- V44__manual_stop_reopen_expired.sql
--
-- QA-990(ADR 0034 결정 7 개정, 2026-11-23): ISA 스탑 지시는 이제 정기 작업이 닫지 않고, 사용자가 '확인'이나 '건너뜀'을 누를 때까지 PLANNED(화면 '대기 중')입니다.
-- 예전 규칙(세션 마감에 자동 만료)으로 닫힌 스탑 지시 — 근거의 skippedBy = AUTO, autoNote = expired — 를 다시 PLANNED로 엽니다. 장중에 판 뒤 마감까지
-- 확인하지 못해 매매 내역을 적을 수 없던 지시를 적게 하고, 팔지 않았으면 화면에서 건너뜁니다(사용자 결정 2026-11-23 — 자동 만료로 닫힌 줄 모두).
-- 사용자가 건너뛴 것(USER)·보유 없음(no-holding)·알리지 못함(not-notified)·새로 시작(restart)·DB 복원(restored)으로 닫힌 줄과 확인한 줄은 그대로입니다.
-- 연 줄의 근거에서 skippedBy·autoNote를 지우고 reopenedFrom = expired를 남깁니다. 연 줄이 있는 계좌만 판(version)을 올려 화면이 다시 읽게 합니다.
-- 다시 실행해도 같은 결과입니다(이미 연 줄은 SKIPPED가 아니어서 다시 고르지 않고, 판도 올리지 않음). 스키마는 바꾸지 않습니다.

WITH reopened AS (
    UPDATE manual_stop_instructions
       SET status = 'PLANNED',
           reason = (reason - 'skippedBy' - 'autoNote') || '{"reopenedFrom": "expired"}'::jsonb,
           updated_at = now()
     WHERE status = 'SKIPPED'
       AND reason ->> 'skippedBy' = 'AUTO'
       AND reason ->> 'autoNote' = 'expired'
 RETURNING account
)
UPDATE manual_accounts
   SET version = version + 1,
       updated_at = now()
 WHERE code IN (SELECT account FROM reopened);
