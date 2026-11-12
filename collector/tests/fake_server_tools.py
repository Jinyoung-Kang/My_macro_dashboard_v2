"""
tests/fake_server_tools.py
서버 스크립트 시험(tests/test_*_scripts.py)이 같이 쓰는 가짜 실행 파일과 도우미 — test_aws_scripts.py에서 옮겼습니다.

docker·aws·make·logger·sleep·curl은 PATH 앞에 둔 가짜 실행 파일로 바꿉니다(부른 인자를 기록 파일에 남김). git은 진짜를
쓰되 사용자 git 설정은 읽지 않습니다.
"""
from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

SECRET = "ci-secret-value-must-not-be-printed"

_GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
}

# 기록 파일에 한 줄씩: 인자(여러 줄 인자 — 배포 전 덤프의 psql 질의 등 — 는 한 줄로 폄) | 그때의 COMPOSE_FILE · APP_VERSION
# postgres 안의 pg_dump는 끝 표시가 있는 덤프를 내고(FAKE_PG_DUMP_RC가 0이 아니면 실패), `exec -T postgres true`(떠 있는지 보기)는
# FAKE_PG_DOWN이 있으면 실패합니다. 그 밖의 exec(스키마 적용 등)는 FAKE_EXEC_RC로 끝나고, 실패하는 스키마 적용(init_schema)은
# 원인 한 줄(FAKE_EXEC_ERROR)을 stderr에 씁니다(QA-373 — 스크립트가 그 원인을 버리지 않는지 봄).
_FAKE_DOCKER = """#!/usr/bin/env bash
args="$*"
echo "${args//$'\\n'/ } | COMPOSE_FILE=${COMPOSE_FILE:-} APP_VERSION=${APP_VERSION:-}" >> "$FAKE_LOG"
case " $* " in
    *" exec -T postgres pg_dump "*)
        [ "${FAKE_PG_DUMP_RC:-0}" = 0 ] || { echo "pg_dump: error: connection to server failed" >&2; exit 1; }
        printf '%s\\n' 'COPY public.t (a) FROM stdin;' '\\.' '-- PostgreSQL database dump complete'
        exit 0 ;;
    *" exec -T postgres true "*) [ -z "${FAKE_PG_DOWN:-}" ]; exit $? ;;
    *" exec "*)
        if [ "${FAKE_EXEC_RC:-0}" != 0 ]; then
            case "$*" in *init_schema*) echo "${FAKE_EXEC_ERROR:-psycopg.errors.DuplicateTable: relation \"fake_table\" already exists}" >&2 ;; esac
        fi
        exit "${FAKE_EXEC_RC:-0}" ;;
esac
if [ -n "${FAKE_DOCKER_FAIL:-}" ] && [[ "$*" == *"$FAKE_DOCKER_FAIL"* ]]; then exit 1; fi
exit 0
"""
# s3 cp는 FAKE_AWS_RC로 끝납니다(기본 0).
_FAKE_AWS = """#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
    "s3 cp") exit "${FAKE_AWS_RC:-0}" ;;
    *) exit 0 ;;
esac
"""
_FAKE_MAKE = """#!/usr/bin/env bash
echo "make $*" >> "$FAKE_LOG"
[ "${FAKE_MAKE_RC:-0}" = 0 ] || { echo "${FAKE_MAKE_MSG:-pg_dump: error: connection failed}" >&2; echo "✗ 백업 실패: pg_dump가 오류로 끝났습니다(위 메시지 참고)." >&2; echo "make: *** [Makefile:215: backup] Error 1" >&2; exit 2; }
[ -n "${FAKE_MAKE_NOFILE:-}" ] || : > "backups/macrodash-$(date +%Y%m%d-%H%M%S).sql"
[ -z "${FAKE_MAKE_TWO:-}" ] || : > "backups/macrodash-20991231-000000.sql"
"""
_FAKE_LOGGER = """#!/usr/bin/env bash
echo "logger $*" >> "$FAKE_LOG"
"""
# 바로 돌아옵니다.
_FAKE_SLEEP = "#!/usr/bin/env bash\nexit 0\n"
# 부른 인자를 남깁니다 — 서버 배포(deploy.sh)가 바깥 주소를 받지 않는지 기록으로 봅니다. 설정을 stdin으로 받으면(-K -) 그 내용은
# 기록 파일 옆 <기록>.curl-config에 따로 남깁니다(비밀값이 인자가 아니라 stdin으로만 가는지 봄). FAKE_CURL_RC로 끝납니다(기본 0).
_FAKE_CURL = """#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
case " $* " in *" -K - "*) cat >> "${FAKE_LOG%.log}.curl-config" ;; esac
exit "${FAKE_CURL_RC:-0}"
"""


# Livepatch 상태(scripts/vultr/reboot-check.sh) — 기본은 정상(지원됨·점검함·적용할 것 없음·먼 기한·방금 점검). FAKE_LP_JSON이면 그 글을,
# FAKE_LP_RC가 0이 아니면 그 값으로 끝납니다. 부른 기록은 남기지 않습니다(배포 시험의 호출 목록을 바꾸지 않게).
_FAKE_LIVEPATCH = """#!/usr/bin/env bash
[ "${FAKE_LP_RC:-0}" = 0 ] || exit "$FAKE_LP_RC"
if [ -n "${FAKE_LP_JSON:-}" ]; then printf '%s\\n' "$FAKE_LP_JSON"; exit 0; fi
printf '{"Last-Check": "%s", "Status": [{"Kernel": "6.8.0-149.149-generic", "Running": true, "Livepatch": {"CheckState": "checked", "State": "nothing-to-apply"}, "Supported": "supported", "UpgradeRequiredDate": "2099-01-01"}]}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"""


def _write_exec(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _env(fakes, **extra: str) -> dict[str, str]:
    bin_dir, log = fakes
    # 개발자 셸의 AWS·DB·compose 값이 끼어들지 않게 최소한의 환경만 넘깁니다.
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", "HOME": str(bin_dir.parent),
           "LANG": "C.UTF-8", "FAKE_LOG": str(log),
           # 시험을 돌리는 기계의 /var/run/reboot-required가 끼어들지 않게 — 없는 경로(reboot-check.sh).
           "REBOOT_REQUIRED_FILE": str(bin_dir.parent / "no-reboot-required")}
    env.update(_GIT_ENV)
    env.update(extra)
    return env


def _calls(fakes) -> list[str]:
    return fakes[1].read_text(encoding="utf-8").splitlines()


def _run(script: Path, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(script)], cwd=cwd, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)


def _git(cwd: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(_GIT_ENV)
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()
