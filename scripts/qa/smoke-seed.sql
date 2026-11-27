-- =============================================================================
-- scripts/qa/smoke-seed.sql — 브라우저 연기 시험(scripts/qa/ui-smoke.js)의 씨앗: 가짜 CIK 13F 즐겨찾기로 상한(20곳)을 채웁니다
--
-- QA 스택 전용 시험 자료입니다. 운영 DB(로컬 3002 스택·Vultr 서버)와 시험 DB(macrodash_test)에서 돌리지 않습니다.
--   sec13f_favorites는 백엔드 표(ADR 0008)지만, QA 씨앗의 관례(perf-seed.py)대로 여기서 채웁니다 — 더하기 API는 SEC 확인이 필요한데
--   QA 스택은 외부가 차단 프록시라 부를 수 없습니다. 값은 모두 가짜입니다(CIK 0009910001~, 이름 'QA SMOKE FILER n').
--   13F 저장본·가격·순자산은 만들지 않습니다 — 이 기관을 고르면 '저장본 없음' 안내가 보이는 것이 맞습니다.
--
-- 넣는 수: 지금 있는 즐겨찾기(다른 씨앗 포함)와 합쳐 20곳이 되게(InstitutionCatalog.FAVORITE_LIMIT — 바뀌면 아래 20도 고칩니다).
--   연기 시험의 흐름은 표시 이름이 '[QA 연기]'로 시작하는 줄만 고치고 지우며, 그런 줄이 둘 이상이고 목록이 상한에 차 있어야 돕니다.
-- 여러 번 돌려도 됩니다(이 씨앗의 줄을 지우고 다시 넣음 — 흐름이 고친 이름·지운 줄이 처음 상태로 돌아옴). make smoke가 매번 넣습니다.
--
-- 쓰는 법(저장소 최상위에서, QA 스택이 떠 있을 때):
--   bash scripts/qa/qa-stack.sh exec postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/qa/smoke-seed.sql
-- 지우기(QA): DELETE FROM sec13f_favorites WHERE description = '[QA 연기 씨앗]';
-- =============================================================================

BEGIN;

DELETE FROM sec13f_favorites WHERE description = '[QA 연기 씨앗]';

INSERT INTO sec13f_favorites (cik, sec_name, display_name, description)
SELECT lpad((9910000 + k)::text, 10, '0'), 'QA SMOKE FILER ' || k, '[QA 연기] 가짜 제출자 ' || (9910000 + k), '[QA 연기 씨앗]'
FROM generate_series(1, GREATEST(0, 20 - (SELECT count(*) FROM sec13f_favorites)::int)) AS k
ON CONFLICT (cik) DO NOTHING;

COMMIT;
