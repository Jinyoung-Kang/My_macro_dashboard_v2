-- =============================================================================
-- V34__source_alerts.sql
-- 수집 출처 끊김 알림의 기록(ADR 0035 결정 7) — 백엔드가 쓰는 표 하나, 더하기만.
--
-- - source_alerts: 끊김 사건 하나에 한 행. alert_key는 '태스크|종류'(종류: blocked·format·failed·stale). 처음 본 시각(opened_at), 텔레그램을
--   보낸 시각(notified_at — 보내지 못했으면 NULL이라 다음 주기에 다시 보냄), 풀린 시각(recovered_at — 풀린 뒤 다시 끊기면 같은 키로 새 사건이
--   열림: recovered_at이 있는 행은 다시 열 때 지우고 새로 넣음), 사유 한 줄(주소·본문 없음).
-- - 메모리가 아니라 표에 두는 이유: 배포로 백엔드가 다시 뜰 때마다 '이미 알린 것'이 사라지면, 그 사이 생긴 끊김을 알리지 못하거나 같은 끊김을
--   다시 알립니다.
-- - 쓰는 곳은 백엔드뿐입니다(store.SourceAlertStore — ADR 0008). 수집기는 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS source_alerts (
    alert_key    TEXT        PRIMARY KEY,
    task         TEXT        NOT NULL,
    kind         TEXT        NOT NULL CHECK (kind IN ('blocked', 'format', 'failed', 'stale')),
    reason       TEXT,
    opened_at    TIMESTAMPTZ NOT NULL,
    notified_at  TIMESTAMPTZ,
    recovered_at TIMESTAMPTZ
);
