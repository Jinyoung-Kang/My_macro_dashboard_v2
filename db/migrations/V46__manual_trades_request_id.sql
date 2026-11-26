-- =============================================================================
-- V46__manual_trades_request_id.sql
-- ISA 계좌 매매 내역(manual_trades — 백엔드 store.ManualAccountStore가 씀)에 '요청 열쇠' 칸 하나와 색인 하나, 더하기만(QA-1035, ADR 0034 덧붙임 2026-11-27).
--
-- - request_id: 지시 없는 매매 적기(POST /api/manual/isa/trades)의 화면이 적기 창마다 만들어 보내는 열쇠(글자·숫자·'-'·'_' 8~64자 — 모양은 백엔드가 보고,
--   여기서는 글자 수만 막음). 같은 요청이 두 번 와도(응답이 안 와 다시 누름) 내역 한 줄·현금과 보유 한 번만 반영하게, 백엔드가 계좌 행을 잠근 뒤
--   이 칸으로 먼저 찾습니다. 열쇠 없이 온 요청과 있던 줄, 지시를 확인해 적은 줄은 NULL입니다(지금까지와 같음).
-- - manual_trades_request: (account, request_id) 부분 유일 색인(NULL이 아닌 줄만) — 찾기와, 잠금을 지나친 겹침의 마지막 막이.
-- - 되돌리기는 그 줄을 지우므로 열쇠도 함께 사라집니다(되돌린 뒤 같은 열쇠가 오면 다시 적힘 — ADR 0034의 남는 한계).
-- - 백엔드는 이 칸을 ISA 전체의 '준비됨' 판정에 넣지 않습니다 — 칸이 아직 없으면(새 백엔드 + 옛 스키마) 열쇠를 무시하고 지금처럼 적습니다.
-- - 다른 증권사 실제 계좌 자료의 표라 값을 넣지 않습니다(시드 없음). 수집기는 이 표를 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 칸·색인은 IF NOT EXISTS, CHECK는 칸을 처음 더할 때만 함께 걸림.
-- =============================================================================

ALTER TABLE manual_trades ADD COLUMN IF NOT EXISTS request_id TEXT
    CONSTRAINT manual_trades_request_id_length CHECK (char_length(request_id) BETWEEN 8 AND 64);
CREATE UNIQUE INDEX IF NOT EXISTS manual_trades_request ON manual_trades (account, request_id) WHERE request_id IS NOT NULL;
