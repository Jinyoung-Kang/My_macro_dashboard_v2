-- =============================================================================
-- V41__env_changelog_cves.sql
-- 보안 공지(ADR 0046 덧붙임 2026-11-21 '배포판 패키지 변경 기록') — 서버에 설치된 배포판 패키지의 변경 기록(changelog.Debian.gz)에 적힌 CVE 번호.
-- 표 하나, 더하기만.
--
-- - env_changelog_cves(수집기 CLI ``python -m app.inventory``가 씀 — 호스트 스크립트 scripts/vultr/inventory.sh가 표준입력으로 넘김):
--   버전 목록 표 셋(env_inventory·env_components·env_pending_updates)과 같은 트랜잭션으로 통째로 바꿉니다(늘 '마지막으로 모은 한 벌').
--   한 행 = (패키지, 버전, CVE). 패키지는 dpkg 원본 패키지 이름(``${source:Package}`` — env_components.source_package와 같은 값)이고
--   버전은 그 원본에서 나온 바이너리 패키지의 설치 버전(env_components.version과 같은 값)입니다. 같은 원본·버전의 바이너리 패키지들의 변경 기록을
--   합친 것입니다. 실행 중인 커널은 패키지 이름 ``kernel``·버전 ``uname -r``(env_components의 runtime kernel 줄과 같은 값)로, 그 커널 판의 패키지들
--   (이름이 ``-<uname -r>``로 끝남)의 변경 기록을 합친 것입니다.
-- - 판정(백엔드 feature/security)은 호스트 배포판 패키지가 apt 보안 보류에 없을 때 공지 표의 그 제품 행 CVE가 모두 여기 있으면 패치됨으로 봅니다.
--   변경 기록에 없다고 취약하다는 뜻은 아닙니다(배포판이 영향 없다고 본 CVE는 적히지 않음 — 그때는 확인 필요 그대로).
-- - 호스트 구역만(서버에서만 생김 — 로컬·QA는 빈 표). 서버의 실제 목록은 운영 DB에만 둡니다(저장소가 공개).
-- - 쓰는 곳은 수집기 store.py 하나입니다(ADR 0008 — ArchitectureRulesTest의 수집기 표 목록, collector tests/test_table_ownership.py).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS env_changelog_cves (
    package TEXT NOT NULL,
    version TEXT NOT NULL,
    cve     TEXT NOT NULL CHECK (cve ~ '^CVE-[0-9]{4}-[0-9]{4,7}$'),
    PRIMARY KEY (package, version, cve)
);
