-- =============================================================================
-- V36__paper_briefings.sql
-- 모의 매매 마감 브리핑의 기록(ADR 0039) — 백엔드가 쓰는 표 하나, 더하기만.
--
-- - paper_briefings: 시장·세션마다 한 행. 그날 정규장 마감 뒤 텔레그램으로 보내는 브리핑의 사실(코드가 만든 JSON — facts), Claude의 응답
--   (해석·의견 — response, 부르지 못했으면 NULL), 보낸 글(message), 상태(OK = 의견 포함, FACTS_ONLY = 사실만), 보낸 시각(sent_at — 보내지
--   못했으면 NULL이라 다음 주기에 같은 글을 다시 보냄).
-- - 표에 두는 이유: 한 세션에 한 번만 부르고(행이 있으면 다시 부르지 않음), 보내기가 실패해도 글이 남고, 나중에 "마감 시점 의견이 개장 전
--   결정보다 나았는가"를 견줄 수 있습니다. 모의 매매의 입력으로는 읽지 않습니다(결정·장중 판단 패킷에 넣지 않음).
-- - 쓰는 곳은 백엔드뿐입니다(store.BriefingStore — ADR 0008). 수집기는 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS paper_briefings (
    market       TEXT        NOT NULL CHECK (market IN ('US', 'KR')),
    session_date DATE        NOT NULL,
    status       TEXT        NOT NULL CHECK (status IN ('OK', 'FACTS_ONLY')),
    facts        JSONB       NOT NULL,
    response     JSONB,
    message      TEXT        NOT NULL,
    model        TEXT,
    usage        JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at      TIMESTAMPTZ,
    PRIMARY KEY (market, session_date)
);
