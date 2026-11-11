-- =============================================================================
-- V35__info_wire_translations.sql
-- 정보 수집 3(ADR 0037) — 속보 한 줄 종류와 한국어 번역 저장 표, 더하기만.
--
-- - info_items.kind에 'headline'을 더합니다 — 본문이 없는 속보 한 줄(Financial Juice). 수집기가 씁니다(표 소유는 V33과 같음).
--   CHECK 제약은 고칠 수 없어 지우고 다시 답니다(이름은 V33의 열 제약에 Postgres가 붙인 info_items_kind_check).
-- - info_translations: 한국어 번역 한 건에 한 행. id는 md5(kind || ':' || 원문) — 같은 글자는 한 번만 번역하고, SQL에서도 같은 값을 계산해
--   글 목록과 묶습니다. kind는 title(목록 제목 — 백엔드가 미리 번역)·body(본문·요약 — 화면에서 번역 단추를 누를 때). source_chars는 원문 글자 수
--   (하루 번역량 상한을 세는 데 씀), model은 번역한 모델 ID. 원문은 저장하지 않습니다(글 표·관측치에 이미 있음).
-- - 쓰는 곳은 백엔드뿐입니다(store.TranslationStore — ADR 0008). 수집기는 읽지도 쓰지도 않습니다.
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): DROP … IF EXISTS 뒤 ADD, IF NOT EXISTS.
-- =============================================================================

ALTER TABLE info_items DROP CONSTRAINT IF EXISTS info_items_kind_check;
ALTER TABLE info_items ADD CONSTRAINT info_items_kind_check CHECK (kind IN ('article', 'brief', 'guru', 'headline'));

CREATE TABLE IF NOT EXISTS info_translations (
    id           TEXT        PRIMARY KEY,
    kind         TEXT        NOT NULL CHECK (kind IN ('title', 'body')),
    source_chars INTEGER     NOT NULL CHECK (source_chars > 0),
    text_ko      TEXT        NOT NULL,
    model        TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_info_translations_created ON info_translations (created_at);
