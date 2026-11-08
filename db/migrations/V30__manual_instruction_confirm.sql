-- =============================================================================
-- V30__manual_instruction_confirm.sql
-- ISA 계좌 지시의 '매매함' 표시와 장 중반 확인 알림 시각 — 더하기만(2026-11-08 사용자 요청 "해당 영업일 중반까지 지시대로 매매하지 않았다면 텔레그램을
-- 한 번 더", ADR 0029 개정). JDBC는 백엔드 store.ManualAccountStore 한 곳에만 있습니다(ADR 0008).
--
-- - manual_instructions.confirmed_at: 사용자가 화면에서 '매매함'을 누른 시각(NULL = 표시 없음). ISA는 증권사와 연결되지 않아 실제 매매 여부를 시스템이
--   볼 수 없고, 장부 자동 기록은 그날 밤에야 적히므로 이 표시와 직접 적은 체결만이 '매매했다'는 신호입니다. 장부·다음 지시 계산은 이 칸을 읽지 않습니다.
-- - manual_instructions.notified_midday_at: 장 중반 확인 알림을 보낸 시각(세션마다 한 번 — 밤·아침 알림 칸과 같은 모양).
-- - 옛 코드의 INSERT·ON CONFLICT는 두 칸을 몰라도 NULL로 넣습니다(코드를 되돌려도 깨지지 않음). 수집기는 이 표를 읽지도 쓰지도 않습니다.
-- - 다른 증권사 실제 계좌 자료라 저장소·문서·커밋·QA 기록에 값을 넣지 않습니다(시드 없음).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 칸은 IF NOT EXISTS.
-- =============================================================================

ALTER TABLE manual_instructions ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE manual_instructions ADD COLUMN IF NOT EXISTS notified_midday_at TIMESTAMPTZ;
