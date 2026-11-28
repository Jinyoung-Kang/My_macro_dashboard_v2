-- =============================================================================
-- V47__security_acks.sql
-- 보안 공지의 '확인함' 표시(ADR 0046 덧붙임 2026-11-28) — 백엔드 표 하나, 더하기만.
--
-- - security_acks(백엔드 store.SecurityAckStore가 씀): 운영자가 '확인 필요' 공지를 손으로 확인했다고 적은 기록. 공지 하나에 한 행.
--   판정은 읽을 때 계산하는 값이라 이 표가 판정을 바꾸지 않습니다 — 확인할 때의 판정·사유(verdict·reasons)를 함께 적어 두고, 지금 판정·사유가
--   그때와 다르면 백엔드가 그 확인을 무효로 봅니다(행은 그대로 — 예전 메모를 보여 줌). 확인을 취소하면 행을 지웁니다.
-- - note: 선택 메모(근거 한 줄, 500자까지). 서버의 실제 버전을 적을 수 있으므로 DB에만 둡니다(로그·텔레그램에 싣지 않음).
-- - reasons: 확인할 때의 사유 코드를 글자순으로 쉼표로 이은 글(없으면 빈 글).
-- - 수집기는 이 표를 읽지도 쓰지도 않습니다(ADR 0008). 공지 표(security_notices)는 수집기 표라 외래 키를 걸지 않습니다(security_alerts와 같음).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행).
-- =============================================================================

CREATE TABLE IF NOT EXISTS security_acks (
    ntt_id   BIGINT      PRIMARY KEY,
    acked_at TIMESTAMPTZ NOT NULL,
    note     TEXT        CONSTRAINT security_acks_note_length CHECK (char_length(note) <= 500),
    verdict  TEXT        NOT NULL,
    reasons  TEXT        NOT NULL DEFAULT ''
);
