-- =============================================================================
-- scripts/qa/security-seed.sql — 보안 공지(ADR 0046) QA 씨앗: 가짜 공지 다섯과 표 행, 가짜 배포판 추적기 결과
--
-- QA 스택 전용 시험 자료입니다. 운영 DB(로컬 3002 스택·Vultr 서버)에서 돌리지 않습니다.
--   security_notices·security_notice_rows는 수집기 태스크 kisa_security_notices가 쓰는 표(ADR 0008)지만, QA 스택은 외부가 차단 프록시라
--   보호나라를 받을 수 없어 이 파일이 그 자리를 채웁니다. 값은 모두 가짜입니다(글 번호 900001~900004, CVE-2099-*, 버전은 실제로 없는 큰 숫자,
--   주소는 example.invalid) — 저장소가 공개라 실제 공지 원문·서버 버전을 넣지 않습니다.
--
-- 쓰는 법(저장소 최상위에서, QA 스택이 떠 있을 때):
--   bash scripts/qa/qa-stack.sh exec postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/qa/security-seed.sql
-- 그다음 짝이 되는 가짜 버전 목록을 실제 받기 길로 넣으면 네 판정이 나옵니다(형식은 collector/app/inventory.py):
--   bash scripts/qa/qa-stack.sh exec collector python -m app.inventory < scripts/qa/security-inventory.tsv
--     구역 일곱 모두 ok, 구성 요소 postgres 90.2(runtime)·node 80.7(runtime)·python 70.1.9(runtime), 배포판 패키지 brotli
--     (host dpkg 90.0-1ubuntu0.1 — os ubuntu noble · collector dpkg 90.0-1 — os debian trixie · backend apk 90.0-r0 — os alpine v3.24)
--
-- 기대 판정(위 버전 목록일 때):
--   900001 PostgreSQL 90.2 — '90.0 이상 90.5 미만' 안           → affected(해당). ※ 문장은 관용 문장뿐이라 조건 아님. 89.x 행은 다른 계열.
--   900002 Node.js 80.7    — 해결 '80.3' 이상                   → patched(패치됨)
--   900003 Python 70.1.9   — 해결 '70.1.5' 이상이지만 ※ 조건 문장 → check(확인 필요, CONDITION_NOTE)
--   900004 가짜 웹 서버     — 이 스택의 별칭에 없는 제품          → unrelated(무관)
--   900005 Brotli(배포판 패키지, 2026-11-21 덧붙임 '배포판 보안 추적기') → affected(해당, 근거 TRACKER): 아래 가짜 추적기 결과로
--          host는 Ubuntu 고친 판 = 설치 판(덮임) · collector는 Debian 고친 판 > 설치 판(뒤처짐 → 해당) · backend는 Alpine 결과 없음(모름).
--          둘째 CVE(90011)는 Ubuntu open(배포판 미수정). 상세 페이지 ④ 추적기 근거와 요약 칸의 '이 환경에 걸린 것'을 보는 자리입니다.
--   버전 목록이 없으면(env 표 셋이 빔) 900001~900003은 check(NO_INVENTORY), 900004는 unrelated.
--
-- 여러 번 돌려도 됩니다(같은 번호를 지우고 다시 넣음 — 표 행은 ON DELETE CASCADE). 백엔드의 알림 기록(security_alerts)은 건드리지 않으니
-- 알림을 다시 시험하려면 QA DB에서 따로 지웁니다: DELETE FROM security_alerts WHERE ntt_id BETWEEN 900001 AND 900004;
-- =============================================================================

BEGIN;

DELETE FROM security_notices WHERE ntt_id BETWEEN 900001 AND 900005;
DELETE FROM distro_cve_status WHERE cve LIKE 'CVE-2099-%';

INSERT INTO security_notices (ntt_id, list_no, title, posted_on, url, pinned, detail_status, detail_attempts, detail_error,
                              layout, products, notes, body_text, detail_fetched_at)
VALUES
    (900001, 99001, '[QA 가짜] PostgreSQL 제품 보안 업데이트 권고', CURRENT_DATE - 1,
     'https://example.invalid/qa/security/900001', false, 'ok', 1, NULL,
     'product_table', '["PostgreSQL"]'::jsonb,
     '["※ 하단의 참고사이트를 확인하여 업데이트 수행 [1]"]'::jsonb,
     'QA 가짜 공지입니다. PostgreSQL 제품의 가짜 취약점을 해결한 가짜 버전이 나왔습니다.', now()),
    (900002, 99002, '[QA 가짜] Node.js 제품 보안 업데이트 권고', CURRENT_DATE - 2,
     'https://example.invalid/qa/security/900002', false, 'ok', 1, NULL,
     'product_table', '["Node.js"]'::jsonb,
     '["※ 하단의 참고사이트를 확인하여 업데이트 수행 [1]"]'::jsonb,
     'QA 가짜 공지입니다. Node.js 제품의 가짜 취약점을 해결한 가짜 버전이 나왔습니다.', now()),
    (900003, 99003, '[QA 가짜] Python 제품 보안 업데이트 권고', CURRENT_DATE - 3,
     'https://example.invalid/qa/security/900003', false, 'ok', 1, NULL,
     'product_table', '["Python"]'::jsonb,
     '["※ 가짜 확장 모듈을 켠 설치에서만 영향이 있으며, 해결 버전에서도 그 모듈의 설정을 따로 바꿔야 함(QA 가짜 조건 문장)", "※ 하단의 참고사이트를 확인하여 업데이트 수행 [1]"]'::jsonb,
     'QA 가짜 공지입니다. Python 제품의 가짜 취약점을 해결한 가짜 버전이 나왔습니다.', now()),
    (900004, 99004, '[QA 가짜] 가짜웹서버 제품 보안 업데이트 권고', CURRENT_DATE - 4,
     'https://example.invalid/qa/security/900004', false, 'ok', 1, NULL,
     'product_table', '["QAFake Web Server"]'::jsonb,
     '["※ 하단의 참고사이트를 확인하여 업데이트 수행 [1]"]'::jsonb,
     'QA 가짜 공지입니다. 이 스택이 쓰지 않는 가짜 웹 서버 제품의 가짜 취약점입니다.', now()),
    (900005, 99005, '[QA 가짜] Brotli 제품 보안 업데이트 권고', CURRENT_DATE - 5,
     'https://example.invalid/qa/security/900005', false, 'ok', 1, NULL,
     'product_table', '["Brotli"]'::jsonb,
     '["※ 하단의 참고사이트를 확인하여 업데이트 수행 [1]"]'::jsonb,
     'QA 가짜 공지입니다. 배포판 패키지로 깔리는 가짜 압축 라이브러리의 가짜 취약점입니다.', now());

INSERT INTO security_notice_rows (ntt_id, row_no, cve, product, affected, fixed)
VALUES
    (900001, 0, 'CVE-2099-90001', 'PostgreSQL', '90.0 이상 90.5 미만', '90.5'),
    (900001, 1, 'CVE-2099-90002', 'PostgreSQL', '89.0 이상 89.9 미만', '89.9'),
    (900002, 0, 'CVE-2099-90003', 'Node.js', '80.0 이상 80.3 미만', '80.3'),
    (900003, 0, 'CVE-2099-90004', 'Python', '70.1 이상 70.1.5 미만', '70.1.5'),
    (900004, 0, 'CVE-2099-90005', 'QAFake Web Server', '60.0 이상 60.2 미만', '60.2'),
    (900005, 0, 'CVE-2099-90010', 'Brotli', '1.0 이상 90.1 미만', '90.1'),
    (900005, 1, 'CVE-2099-90011', 'Brotli', '1.0 이상 90.1 미만', '90.1');

-- 가짜 배포판 추적기 결과(수집기 표 distro_cve_status — QA 스택은 외부가 차단이라 이 파일이 그 자리를 채움, 값은 모두 가짜).
INSERT INTO distro_cve_status (distro, suite, package, cve, status, fixed_version, detail, checked_at)
VALUES
    ('ubuntu', 'noble', 'brotli', 'CVE-2099-90010', 'fixed', '90.0-1ubuntu0.1', 'released', now()),
    ('ubuntu', 'noble', 'brotli', 'CVE-2099-90011', 'open', NULL, 'needed', now()),
    ('debian', 'trixie', 'brotli', 'CVE-2099-90010', 'fixed', '90.0-1+deb13u1', 'fixed', now()),
    ('debian', 'trixie', 'brotli', 'CVE-2099-90011', 'not_affected', NULL, '(not affected)', now());

COMMIT;
