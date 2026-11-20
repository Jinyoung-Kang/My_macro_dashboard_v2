-- =============================================================================
-- V40__security_notices.sql
-- 보안 공지(ADR 0046) — 보호나라 보안공지와 운영 환경의 버전 목록. 표 여섯, 더하기만.
--
-- - security_notices(수집기 태스크 kisa_security_notices가 씀): 공지 글 한 건에 한 행. ntt_id는 보호나라 글 번호(nttId), list_no는 목록의
--   번호 칸(고정 공지로만 본 글은 NULL — 같은 글이 번호 칸으로도 보이면 채움), posted_on은 게시일(KST 날짜), pinned는 목록 1쪽의 고정 공지인가.
--   detail_status: pending(상세를 아직 받지 않음)·ok(받아 읽음)·failed(받지 못했거나 틀이 깨짐 — detail_attempts가 상한에 닿을 때까지 다시
--   받음)·skipped(90일보다 오래된 글 — 상세를 받지 않음). layout은 상세의 틀: product_table(취약점·제품명·영향받는 버전·해결 버전 4열 표)·
--   other_table(다른 표)·no_table. products는 표의 제품명 고유 값(원문 그대로, 처음 나온 순서), notes는 표 밖 '※' 문장, body_text는 표를 뺀
--   본문 글자. 버전 칸 해석과 판정은 여기 두지 않습니다(백엔드가 읽을 때 계산 — ADR 0046 결정 5).
-- - security_notice_rows(같은 태스크가 씀): product_table 공지의 표 한 행 — 취약점·제품명·영향받는 버전·해결 버전 칸을 원문 그대로.
--   row_no는 표 안의 순서(0부터). 상세를 다시 받으면 그 공지의 행을 통째로 바꿉니다.
-- - env_inventory·env_components·env_pending_updates(수집기 CLI ``python -m app.inventory``가 씀 — 호스트 스크립트 scripts/vultr/inventory.sh가
--   표준입력으로 넘김): 늘 '마지막으로 모은 한 벌'. 받을 때마다 셋을 한 트랜잭션으로 통째로 바꿉니다.
--   env_inventory는 늘 한 행(id = 1): 모은 시각(collected_at — 스크립트가 적은 시각), 받은 시각, 호스트 구역 포함 여부, apt 목록을 마지막으로
--   새로 받은 시각(apt_lists_at — 모르면 NULL), 구역별 상태(sections — {구역: {status: ok|failed|skipped, count, reason?}}).
--   env_components는 구성 요소 한 개에 한 행: source(어디서 읽었나 — host·postgres·backend 등), ecosystem(deb·apk·maven·npm·pypi·runtime 등),
--   이름·버전(원문 그대로)·원본 패키지(배포판 패키지의 source 이름 — 없으면 NULL).
--   env_pending_updates는 서버 apt 보류 업데이트: 패키지·아키텍처·설치 버전·후보 버전·저장소(원문)·보안 여부(저장소 이름이 -security로 끝남).
--   서버의 실제 버전은 이 표(운영 DB)에만 둡니다 — 저장소가 공개라 시험·문서·로그에는 가짜 값만.
-- - security_alerts(백엔드 SecurityAlertStore가 씀): 공지당 한 번의 알림 기록 — 처음 알린 시각, 알림함 사건(alert_events.id), 텔레그램을 보낸
--   시각(보내지 못했으면 NULL이라 다음 주기에 다시 보냄 — source_alerts와 같은 모양). 수집기는 읽지도 쓰지도 않습니다.
-- - 쓰는 곳은 표마다 하나입니다(ADR 0008 — ArchitectureRulesTest의 수집기 표 목록, collector tests/test_table_ownership.py).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS security_notices (
    ntt_id            BIGINT      PRIMARY KEY,
    list_no           INTEGER,
    title             TEXT        NOT NULL,
    posted_on         DATE        NOT NULL,
    url               TEXT        NOT NULL,
    pinned            BOOLEAN     NOT NULL DEFAULT false,
    detail_status     TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (detail_status IN ('pending', 'ok', 'failed', 'skipped')),
    detail_attempts   INTEGER     NOT NULL DEFAULT 0 CHECK (detail_attempts >= 0),
    detail_error      TEXT,
    layout            TEXT        CHECK (layout IN ('product_table', 'other_table', 'no_table')),
    products          JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(products) = 'array'),
    notes             JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notes) = 'array'),
    body_text         TEXT,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    detail_fetched_at TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_notices_posted ON security_notices (posted_on DESC, ntt_id DESC);

CREATE TABLE IF NOT EXISTS security_notice_rows (
    ntt_id   BIGINT  NOT NULL REFERENCES security_notices (ntt_id) ON DELETE CASCADE,
    row_no   INTEGER NOT NULL CHECK (row_no >= 0),
    cve      TEXT    NOT NULL,
    product  TEXT    NOT NULL,
    affected TEXT    NOT NULL,
    fixed    TEXT    NOT NULL,
    PRIMARY KEY (ntt_id, row_no)
);

CREATE TABLE IF NOT EXISTS env_inventory (
    id            SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    collected_at  TIMESTAMPTZ NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    host_included BOOLEAN     NOT NULL,
    apt_lists_at  TIMESTAMPTZ,
    sections      JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sections) = 'object')
);

CREATE TABLE IF NOT EXISTS env_components (
    source         TEXT NOT NULL,
    ecosystem      TEXT NOT NULL,
    name           TEXT NOT NULL,
    version        TEXT NOT NULL,
    source_package TEXT,
    PRIMARY KEY (source, ecosystem, name, version)
);
CREATE INDEX IF NOT EXISTS env_components_name ON env_components (lower(name));

CREATE TABLE IF NOT EXISTS env_pending_updates (
    package   TEXT    NOT NULL,
    arch      TEXT    NOT NULL DEFAULT '',
    installed TEXT    NOT NULL,
    candidate TEXT    NOT NULL,
    repos     TEXT    NOT NULL,
    security  BOOLEAN NOT NULL,
    PRIMARY KEY (package, arch)
);

CREATE TABLE IF NOT EXISTS security_alerts (
    ntt_id           BIGINT      PRIMARY KEY,
    alerted_at       TIMESTAMPTZ NOT NULL,
    alert_event_id   BIGINT,
    telegram_sent_at TIMESTAMPTZ
);
