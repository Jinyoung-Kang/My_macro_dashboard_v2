-- =============================================================================
-- V42__security_trackers.sql
-- 보안 공지(ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기') — 변경 기록으로 가리지 못한 배포판 패키지의 CVE를 배포판의 보안 추적기
-- (Ubuntu CVE 추적기·Debian 보안 추적기·Alpine secdb)에 물어 본 결과. 표 둘, 더하기만.
-- - security_tracker_wants(백엔드가 씀 — SecurityAlertJob 주기마다 판정에서 모은 '물어볼 것'을 통째로 맞춤): 배포판·스위트·원본 패키지·CVE 한 벌에 한 행.
--   distro는 버전 목록의 그 구역 os-release ID(ubuntu·debian·alpine), suite는 Ubuntu·Debian이면 VERSION_CODENAME(noble·trixie), Alpine이면
--   'v' + VERSION_ID 앞 두 마디(v3.24). package는 배포판의 원본 패키지 이름(dpkg ${source:Package}, apk o: — 실행 중인 커널은 linux).
--   wanted_at은 처음 넣은 시각(다시 맞출 때 그대로 둠).
-- - distro_cve_status(수집기 태스크 kisa_security_notices가 씀 — 같은 실행 안에서 보호나라 상세 다음에, 하루 최대 4번): 물어본 결과 한 행.
--   status: fixed(그 스위트에서 고친 판이 있음 — fixed_version 필수)·not_affected(영향 없음·그 스위트에 패키지 없음)·open(아직 고치지 않음)·
--   unknown(추적기에 그 패키지·스위트의 기록이 없음). detail은 추적기의 원래 상태 글(released·needed·DNE·vulnerable·(unfixed) 등, 표시용).
--   받지 못한 요청(연결 오류·틀이 다름)은 행을 쓰지 않습니다(직전 결과 그대로). wants에서 빠진 행도 지우지 않습니다(다시 원하면 그대로 씀).
-- - 판정(백엔드 feature/security)은 설치 판 ≥ fixed_version이면 패치됨, 설치 판 < fixed_version이면 해당(고친 판이 나왔는데 깔리지 않음),
--   not_affected면 영향 없음, open이면 확인 필요(배포판이 아직 고치지 않음). 판 비교는 배포판 규칙(dpkg·apk)입니다.
-- - 쓰는 곳은 표마다 하나입니다(ADR 0008): wants는 백엔드 store.SecurityTrackerStore, status는 수집기 store.py(ArchitectureRulesTest의
--   수집기 표 목록, collector tests/test_table_ownership.py).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS security_tracker_wants (
    distro    TEXT        NOT NULL CHECK (distro IN ('ubuntu', 'debian', 'alpine')),
    suite     TEXT        NOT NULL CHECK (suite ~ '^[a-z0-9][a-z0-9.+-]{0,31}$'),
    package   TEXT        NOT NULL CHECK (package ~ '^[a-z0-9][a-z0-9.+-]{0,99}$'),
    cve       TEXT        NOT NULL CHECK (cve ~ '^CVE-[0-9]{4}-[0-9]{4,7}$'),
    wanted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (distro, suite, package, cve)
);

CREATE TABLE IF NOT EXISTS distro_cve_status (
    distro        TEXT        NOT NULL CHECK (distro IN ('ubuntu', 'debian', 'alpine')),
    suite         TEXT        NOT NULL CHECK (suite ~ '^[a-z0-9][a-z0-9.+-]{0,31}$'),
    package       TEXT        NOT NULL CHECK (package ~ '^[a-z0-9][a-z0-9.+-]{0,99}$'),
    cve           TEXT        NOT NULL CHECK (cve ~ '^CVE-[0-9]{4}-[0-9]{4,7}$'),
    status        TEXT        NOT NULL CHECK (status IN ('fixed', 'not_affected', 'open', 'unknown')),
    fixed_version TEXT        CHECK (char_length(fixed_version) <= 200),
    detail        TEXT        CHECK (char_length(detail) <= 100),
    checked_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (distro, suite, package, cve),
    CHECK ((status = 'fixed') = (fixed_version IS NOT NULL))
);
