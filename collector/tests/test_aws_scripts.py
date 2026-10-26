"""
tests/test_aws_scripts.py
AWS 개인용 서버(ADR 0019)의 스크립트 시험 — scripts/aws/{bootstrap,deploy,backup-s3,tunnel,instance}.sh.

서버·AWS·DB 없이 돕니다. 임시 폴더에 스크립트를 복사하고, docker·aws·make·logger·sleep·date는 PATH 앞에 둔 가짜
실행 파일로 바꿉니다(부른 인자를 기록 파일에 남김). deploy.sh는 진짜 git으로 임시 원격(bare)과 서버 역할의 클론을
만들어 받기·멈춤을 확인합니다. 사용자 git 설정은 읽지 않습니다. 실제 AWS를 부르지 않도록 진짜 aws가 PATH에 있어도
가짜가 먼저 잡히는지까지 각 시험이 기록으로 확인합니다.
"""
from __future__ import annotations

import os
import shutil
import socket
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ["bootstrap.sh", "deploy.sh", "backup-s3.sh", "tunnel.sh", "instance.sh"]
INSTANCE = "i-0123456789abcdef0"
SECRET = "ci-secret-value-must-not-be-printed"

_GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
}

# 기록 파일에 한 줄씩: 인자 | 그때의 COMPOSE_FILE · APP_VERSION
_FAKE_DOCKER = """#!/usr/bin/env bash
echo "$* | COMPOSE_FILE=${COMPOSE_FILE:-} APP_VERSION=${APP_VERSION:-}" >> "$FAKE_LOG"
case " $* " in
    *" exec "*) exit "${FAKE_EXEC_RC:-0}" ;;
esac
if [ -n "${FAKE_DOCKER_FAIL:-}" ] && [[ "$*" == *"$FAKE_DOCKER_FAIL"* ]]; then exit 1; fi
exit 0
"""
# sts는 FAKE_STS_OK번째까지만 성공(기본: 늘 성공), FAKE_STS_FAIL에 적은 번째(공백으로 구분)는 연결 오류.
# start-session은 곧바로 실패.
_FAKE_AWS = """#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
    "sts get-caller-identity")
        n=$(($(cat "$FAKE_LOG.sts" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_LOG.sts"
        case " ${FAKE_STS_FAIL:-} " in *" $n "*) echo "Could not connect to the endpoint URL" >&2; exit 255 ;; esac
        [ -z "${FAKE_STS_OK:-}" ] || [ "$n" -le "$FAKE_STS_OK" ] ;;
    "ssm start-session") exit 255 ;;
    "s3 cp") exit "${FAKE_AWS_RC:-0}" ;;
    "ec2 describe-instances") [ -z "${FAKE_EC2_FAIL:-}" ] || exit 255; echo "${FAKE_EC2_STATE:-}" ;;
    *) exit 0 ;;
esac
"""
_FAKE_MAKE = """#!/usr/bin/env bash
echo "make $*" >> "$FAKE_LOG"
[ "${FAKE_MAKE_RC:-0}" = 0 ] || { echo "${FAKE_MAKE_MSG:-pg_dump: error: connection failed}" >&2; echo "❌ 백업 실패: pg_dump가 오류로 끝났습니다(위 메시지 참고)." >&2; echo "make: *** [Makefile:215: backup] Error 1" >&2; exit 2; }
[ -n "${FAKE_MAKE_NOFILE:-}" ] || : > "backups/macrodash-$(date +%Y%m%d-%H%M%S).sql"
[ -z "${FAKE_MAKE_TWO:-}" ] || : > "backups/macrodash-20991231-000000.sql"
"""
_FAKE_LOGGER = """#!/usr/bin/env bash
echo "logger $*" >> "$FAKE_LOG"
"""
# 바로 돌아옵니다. FAKE_SLEEP_REAL_10이 있으면 `sleep 10`(tunnel.sh의 로그인 재확인 대기)만 실제로 11초 잡니다.
_FAKE_SLEEP = '#!/usr/bin/env bash\n[ "$1" = 10 ] && [ -n "${FAKE_SLEEP_REAL_10:-}" ] && command -p sleep 11\nexit 0\n'
_FAKE_PLUGIN = "#!/usr/bin/env bash\nexit 0\n"
# instance.sh가 묻는 지금(KST 요일+시분, `date +%u%H%M`)만 FAKE_NOW로 바꾸고 나머지는 진짜 date에 넘깁니다.
_FAKE_DATE = '#!/usr/bin/env bash\nif [ -n "${FAKE_NOW:-}" ] && [ "$*" = "+%u%H%M" ]; then echo "$FAKE_NOW"; exit 0; fi\nfor d in /bin/date /usr/bin/date; do [ -x "$d" ] && exec "$d" "$@"; done\nexit 127\n'


def _write_exec(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


@pytest.fixture()
def fakes(tmp_path):
    """가짜 실행 파일 폴더와 기록 파일. 진짜 git·bash·coreutils는 그 뒤의 PATH에서 찾습니다."""
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    for name, text in {"docker": _FAKE_DOCKER, "aws": _FAKE_AWS, "make": _FAKE_MAKE, "logger": _FAKE_LOGGER,
                       "sleep": _FAKE_SLEEP, "session-manager-plugin": _FAKE_PLUGIN, "date": _FAKE_DATE}.items():
        _write_exec(bin_dir / name, text)
    log.touch()
    return bin_dir, log


def _env(fakes, **extra: str) -> dict[str, str]:
    bin_dir, log = fakes
    # 개발자 셸의 AWS·DB·compose 값이 끼어들지 않게 최소한의 환경만 넘깁니다.
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", "HOME": str(bin_dir.parent),
           "LANG": "C.UTF-8", "FAKE_LOG": str(log)}
    env.update(_GIT_ENV)
    env.update(extra)
    return env


def _calls(fakes) -> list[str]:
    return fakes[1].read_text(encoding="utf-8").splitlines()


def _run(script: Path, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(script)], cwd=cwd, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)


# --------------------------------------------------------------------------- 공통
@pytest.mark.parametrize("name", SCRIPTS)
def test_네_스크립트는_bash_문법이_맞고_실패하면_멈춘다(name):
    path = ROOT / "scripts/aws" / name
    text = path.read_text(encoding="utf-8")
    assert text.startswith("#!/usr/bin/env bash\n")
    assert "\nset -euo pipefail\n" in text, f"{name}: bash -eu(+pipefail)로 돌아야 실패가 성공으로 보이지 않습니다"
    assert subprocess.run(["bash", "-n", str(path)], capture_output=True).returncode == 0
    assert os.access(path, os.X_OK), f"{name}: 실행 권한(cron·user-data가 직접 부름)"


def test_bootstrap은_Docker_공식_저장소와_스왑_journald_상한을_두고_원격_접속_데몬을_깔지_않는다():
    text = (ROOT / "scripts/aws/bootstrap.sh").read_text(encoding="utf-8")
    assert "https://download.docker.com/linux/ubuntu" in text and "Signed-By: /etc/apt/keyrings/docker.asc" in text
    for package in ("docker-ce", "docker-compose-plugin", "docker-buildx-plugin", "git", "make"):
        assert f" {package}" in text
    assert "docker.io" not in text, "Ubuntu 기본 저장소의 docker.io가 아니라 Docker 공식 패키지"
    assert "awscli-exe-linux-" in text
    assert "fallocate -l 2G /swapfile" in text and "/swapfile none swap" in text
    assert "SystemMaxUse=" in text
    assert "usermod -aG docker ubuntu" in text
    assert "tailscale" not in text.lower(), "접속은 SSM 하나(ADR 0019)"


# --------------------------------------------------------------------------- deploy.sh
def _git(cwd: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(_GIT_ENV)
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture()
def server(tmp_path):
    """원격 origin(bare)과 서버 역할의 클론 ~/My_macro_dashboard_v2(폴더 이름 규칙), 서버 .env."""
    if shutil.which("git") is None:
        pytest.skip("git이 없어 건너뜁니다.")
    origin, here = tmp_path / "origin.git", tmp_path / "home" / "My_macro_dashboard_v2"
    seed = tmp_path / "seed"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(seed))
    _git(seed, "symbolic-ref", "HEAD", "refs/heads/main")
    (seed / "scripts/aws").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/aws/deploy.sh", seed / "scripts/aws/deploy.sh")
    (seed / "deploy/aws").mkdir(parents=True)
    shutil.copy(ROOT / "deploy/aws/Caddyfile", seed / "deploy/aws/Caddyfile")
    (seed / "README.md").write_text("readme\n", encoding="utf-8")
    _git(seed, "add", ".")
    _git(seed, "commit", "-q", "-m", "seed")
    _git(seed, "push", "-q", "origin", "main")
    here.parent.mkdir(parents=True)
    _git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(here))
    (here / ".env").write_text(f"OWNER_EMAIL=owner@example.invalid\nAPP_PASSWORD={SECRET}\n"
                               "COMPOSE_FILE=docker-compose.yml:compose.aws.yml\nAWS_BACKUP_BUCKET=b\n", encoding="utf-8")
    return here, seed


def _deploy(server, fakes, **extra: str) -> subprocess.CompletedProcess:
    here, _ = server
    return _run(here / "scripts/aws/deploy.sh", here, _env(fakes, **extra))


def _docker_calls(fakes) -> list[str]:
    return [line.split(" | ")[0] for line in _calls(fakes)]


def test_deploy는_하나씩_빌드하고_기동한_뒤_스키마를_적용한다(server, fakes):
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    calls = _docker_calls(fakes)
    builds = [c for c in calls if c.startswith("compose build")]
    assert builds == ["compose build --pull backend", "compose build --pull frontend", "compose build --pull collector"], \
        "4 GiB — 서비스를 하나씩, backend → frontend → collector(서비스를 빼면 한꺼번에 빌드)"
    up = next(i for i, c in enumerate(calls) if c.startswith("compose up"))
    assert calls[up] == "compose up -d --no-build --wait --wait-timeout 300"
    assert up > calls.index("compose build --pull collector")
    schema = [i for i, c in enumerate(calls) if " exec -T collector " in f" {c} " and "init_schema" in c]
    assert len(schema) == 1 and schema[0] > up, "up -d 뒤 스키마 적용(QA-016)"
    recreate = calls.index("compose up -d --no-deps --force-recreate --wait --wait-timeout 60 caddy")
    assert recreate > schema[0], "Caddyfile은 파일 하나 bind mount라 다시 만들어야 바뀐 내용이 들어감"
    assert "image prune -f" in calls
    # 모든 compose 호출이 덧붙임까지 읽고, 화면 빌드에는 받은 커밋의 버전이 들어갑니다.
    head = _git(server[0], "rev-parse", "--short", "HEAD")
    for line in _calls(fakes):
        assert f"COMPOSE_FILE=docker-compose.yml:compose.aws.yml APP_VERSION=main@{head}" in line, line
    assert SECRET not in result.stdout + result.stderr, "서버 .env의 값을 찍지 않습니다"


def test_deploy는_origin_main을_fast_forward로_받는다(server, fakes):
    here, seed = server
    (seed / "NEW.md").write_text("new\n", encoding="utf-8")
    _git(seed, "add", "NEW.md")
    _git(seed, "commit", "-q", "-m", "new")
    _git(seed, "push", "-q", "origin", "main")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert _git(here, "rev-parse", "HEAD") == _git(seed, "rev-parse", "HEAD")


def test_deploy는_물려받은_umask와_상관없이_받은_파일을_컨테이너가_읽을_수_있게_쓴다(server, fakes):
    here, seed = server
    (seed / "frontend").mkdir()
    (seed / "frontend/page.txt").write_text("new\n", encoding="utf-8")
    _git(seed, "add", "frontend/page.txt")
    _git(seed, "commit", "-q", "-m", "new page")
    _git(seed, "push", "-q", "origin", "main")
    result = subprocess.run(["bash", "-c", 'umask 077 && exec bash scripts/aws/deploy.sh'], cwd=here, env=_env(fakes),
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert result.returncode == 0, result.stderr
    assert stat.S_IMODE((here / "frontend/page.txt").stat().st_mode) == 0o644, ".env를 받은 셸의 077이 그대로면 0600 — root 아닌 컨테이너가 못 읽음"


def test_deploy는_서버에서_고친_파일이_있으면_받지도_빌드하지도_않는다(server, fakes):
    here, _ = server
    (here / "README.md").write_text("edited on server\n", encoding="utf-8")
    result = _deploy(server, fakes)
    assert result.returncode != 0
    assert "서버에서 고친 파일" in result.stderr
    assert _docker_calls(fakes) == []


@pytest.mark.parametrize("line", ["FRONTEND_PORT=3001", "DATABASE_PORT=5433", "LOCAL_NO_LOGIN=true",
                                  "FRONTEND_ORIGIN=http://localhost:3001", "PUBLIC_URL=http://x",
                                  f"AWS_INSTANCE_ID={INSTANCE}", "export BACKEND_PORT=8081"])
def test_deploy는_서버_env에_적지_않는_이름이_있으면_이름만_알리고_멈춘다(server, fakes, line):
    here, _ = server
    with (here / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write(line + "\n")
    result = _deploy(server, fakes)
    name, value = line.removeprefix("export ").split("=", 1)
    assert result.returncode != 0
    assert name in result.stderr
    assert value not in result.stdout + result.stderr and SECRET not in result.stdout + result.stderr
    assert _docker_calls(fakes) == []


def test_deploy는_COOKIE_SECURE는_막지_않고_알리기만_한다(server, fakes):
    here, _ = server
    with (here / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write("COOKIE_SECURE=false\n")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "COOKIE_SECURE" in result.stdout


@pytest.mark.parametrize(("line", "noticed"), [("PAPER_ENABLED=false", True), ('export PAPER_ENABLED="0"', True),
                                               ("PAPER_ENABLED=Off", True), ("PAPER_ENABLED=true", False), ("PAPER_ENABLED=", False)])
def test_deploy는_서버_정기_작업이_꺼져_있으면_알린다(server, fakes, line, noticed):
    here, _ = server
    with (here / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write(line + "\n")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert ("PAPER_ENABLED" in result.stdout) is noticed


def test_deploy는_폴더_이름이_다르면_멈춘다(server, fakes):
    here, _ = server
    moved = here.with_name("My_macro_dashboard_v2-copy")
    here.rename(moved)
    result = _run(moved / "scripts/aws/deploy.sh", moved, _env(fakes))
    assert result.returncode != 0
    assert "My_macro_dashboard_v2" in result.stderr
    assert _docker_calls(fakes) == []


def test_deploy는_받은_main에_Caddyfile이_없으면_기동하지_않는다(server, fakes):
    _, seed = server
    _git(seed, "mv", "deploy/aws/Caddyfile", "deploy/aws/Caddyfile.new")
    _git(seed, "commit", "-q", "-m", "rename caddyfile")
    _git(seed, "push", "-q", "origin", "main")
    result = _deploy(server, fakes)
    assert result.returncode != 0
    assert "Caddyfile" in result.stderr, "없으면 docker가 빈 폴더를 만들고 caddy가 뜨지 못함"
    assert _docker_calls(fakes) == []


def test_deploy는_빌드가_실패하면_다음_빌드도_기동도_하지_않는다(server, fakes):
    result = _deploy(server, fakes, FAKE_DOCKER_FAIL="build --pull frontend")
    assert result.returncode != 0
    calls = _docker_calls(fakes)
    assert "compose build --pull collector" not in calls
    assert not any(c.startswith("compose up") for c in calls)


def test_QA118_deploy의_스키마_적용이_10번_모두_실패하면_알리고_0이_아닌_값으로_끝난다(server, fakes):
    result = _deploy(server, fakes, FAKE_EXEC_RC="1")
    assert result.returncode != 0
    assert len([c for c in _docker_calls(fakes) if "init_schema" in c]) == 10
    assert "스키마" in result.stderr
    assert not any("prune" in c for c in _docker_calls(fakes)), "실패한 배포는 거기서 멈춤"


# --------------------------------------------------------------------------- backup-s3.sh
@pytest.fixture()
def backup_root(tmp_path):
    root = tmp_path / "My_macro_dashboard_v2"
    (root / "scripts/aws").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/aws/backup-s3.sh", root / "scripts/aws/backup-s3.sh")
    shutil.copy(ROOT / "scripts/db-common.sh", root / "scripts/db-common.sh")
    (root / "backups").mkdir()
    (root / "backups/macrodash-20200101-000000.sql").write_text("old\n", encoding="utf-8")   # 지난 백업 — 다시 올리지 않음
    (root / ".env").write_text(f"AWS_BACKUP_BUCKET=test-bucket\nDATABASE_PASSWORD={SECRET}\n", encoding="utf-8")
    return root


def _backup(root: Path, fakes, **extra: str) -> subprocess.CompletedProcess:
    return _run(root / "scripts/aws/backup-s3.sh", root, _env(fakes, **extra))


def test_backup_s3는_이번에_만든_백업_하나만_db_아래에_올리고_syslog에_남긴다(backup_root, fakes):
    result = _backup(backup_root, fakes)
    assert result.returncode == 0, result.stderr
    calls = _calls(fakes)
    assert calls[0] == "make --no-print-directory backup"
    uploads = [c for c in calls if c.startswith("aws s3 cp")]
    new = sorted(p.name for p in (backup_root / "backups").glob("macrodash-*.sql"))[-1]
    assert new != "macrodash-20200101-000000.sql"
    assert uploads == [f"aws s3 cp --only-show-errors {backup_root}/backups/{new} s3://test-bucket/db/{new}"]
    assert any(c.startswith("logger -t my-macro-backup") and "user.err" not in c for c in calls)
    assert SECRET not in result.stdout + result.stderr


def test_backup_s3는_이름이_더_늦은_옛_파일이_있어도_이번에_만든_파일을_올린다(backup_root, fakes):
    # 맥(KST)에서 옮겨 온 백업은 서버(UTC)가 같은 날 만든 것보다 이름이 늦을 수 있습니다.
    (backup_root / "backups/macrodash-29991231-235959.sql").write_text("from mac\n", encoding="utf-8")
    result = _backup(backup_root, fakes)
    assert result.returncode == 0, result.stderr
    uploads = [c for c in _calls(fakes) if c.startswith("aws s3 cp")]
    assert len(uploads) == 1 and "29991231" not in uploads[0] and "20200101" not in uploads[0]


def test_backup_s3는_make_backup이_실패하면_올리지_않고_syslog에_원인_한_줄을_err로_남긴다(backup_root, fakes):
    result = _backup(backup_root, fakes, FAKE_MAKE_RC="2")
    assert result.returncode != 0
    calls = _calls(fakes)
    assert not any(c.startswith("aws s3") for c in calls)
    errors = [c for c in calls if c.startswith("logger -t my-macro-backup -p user.err")]
    assert len(errors) == 1 and "connection failed" in errors[0], "일반 문구(❌·make: ***)가 아니라 원인 줄"
    log = backup_root / "backups/backup-s3-last-error.log"
    assert stat.S_IMODE(log.stat().st_mode) == 0o600 and "connection failed" in log.read_text(encoding="utf-8")


def test_backup_s3는_env_해석_오류의_값을_syslog에_남기지_않는다(backup_root, fakes):
    message = f'failed to read /home/ubuntu/My_macro_dashboard_v2/.env: unterminated quoted value "{SECRET}'
    result = _backup(backup_root, fakes, FAKE_MAKE_RC="2", FAKE_MAKE_MSG=message)
    assert result.returncode != 0
    errors = [c for c in _calls(fakes) if c.startswith("logger -t my-macro-backup -p user.err")]
    assert len(errors) == 1 and SECRET not in errors[0] and "값 생략" in errors[0]
    assert SECRET not in result.stdout + result.stderr


def test_backup_s3는_새_파일이_둘이면_올리지_않는다(backup_root, fakes):
    result = _backup(backup_root, fakes, FAKE_MAKE_TWO="1")
    assert result.returncode != 0
    assert not any(c.startswith("aws s3") for c in _calls(fakes))
    assert any(c.startswith("logger -t my-macro-backup -p user.err") for c in _calls(fakes))


def test_backup_s3는_compose_경고에_든_값의_조각도_syslog에_남기지_않는다(backup_root, fakes):
    message = f'time="2026-10-27T21:10:00Z" level=warning msg="The \\"{SECRET}\\" variable is not set. Defaulting to a blank string."'
    result = _backup(backup_root, fakes, FAKE_MAKE_RC="2", FAKE_MAKE_MSG=message)
    assert result.returncode != 0
    errors = [c for c in _calls(fakes) if c.startswith("logger -t my-macro-backup -p user.err")]
    assert len(errors) == 1 and SECRET not in errors[0]


def test_backup_s3는_새_파일이_없으면_지난_백업을_올리지_않는다(backup_root, fakes):
    result = _backup(backup_root, fakes, FAKE_MAKE_NOFILE="1")
    assert result.returncode != 0
    assert not any(c.startswith("aws s3") for c in _calls(fakes))


def test_backup_s3는_S3_올리기가_실패하면_0이_아닌_값과_syslog_err(backup_root, fakes):
    result = _backup(backup_root, fakes, FAKE_AWS_RC="1")
    assert result.returncode != 0
    assert any(c.startswith("logger -t my-macro-backup -p user.err") for c in _calls(fakes))


def test_backup_s3는_버킷_이름이_없으면_백업하지_않는다(backup_root, fakes):
    (backup_root / ".env").write_text("DATABASE_NAME=macrodash\n", encoding="utf-8")
    result = _backup(backup_root, fakes)
    assert result.returncode != 0
    assert "AWS_BACKUP_BUCKET" in result.stderr
    assert not any(c.startswith(("make", "aws")) for c in _calls(fakes))


# --------------------------------------------------------------------------- tunnel.sh
@pytest.fixture()
def pc_root(tmp_path):
    root = tmp_path / "My_macro_dashboard_v2"
    (root / "scripts/aws").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/aws/tunnel.sh", root / "scripts/aws/tunnel.sh")
    shutil.copy(ROOT / "scripts/db-common.sh", root / "scripts/db-common.sh")
    (root / ".env").write_text(f"AWS_INSTANCE_ID={INSTANCE}\nAPP_PASSWORD={SECRET}\n", encoding="utf-8")
    return root


def _port_8201_in_use() -> bool:
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", 8201)) == 0


def _tunnel(root: Path, fakes, **extra: str) -> subprocess.CompletedProcess:
    if _port_8201_in_use():
        pytest.skip("이 PC의 8201을 이미 쓰고 있어 건너뜁니다(열려 있는 터널).")
    return _run(root / "scripts/aws/tunnel.sh", root, _env(fakes, **extra))


_SESSION = (f"aws ssm start-session --region ap-northeast-2 --target {INSTANCE} --document-name AWS-StartPortForwardingSession "
            '--parameters {"portNumber":["8201"],"localPortNumber":["8201"]}')


def test_tunnel은_env의_인스턴스로_8201을_포워딩하고_연달아_곧바로_끊기면_멈춘다(pc_root, fakes):
    result = _tunnel(pc_root, fakes)
    assert "http://localhost:8201" in result.stdout
    sessions = [c for c in _calls(fakes) if c.startswith("aws ssm")]
    assert sessions == [_SESSION] * 5, "끊기면 다시 잇되, 서버가 꺼져 있으면 5번 연달아 곧바로 실패한 뒤 멈춤"
    assert result.returncode != 0
    assert "SSM" in result.stderr
    assert SECRET not in result.stdout + result.stderr


def test_tunnel은_로그인_재확인을_기다린_시간을_세션_시간에_넣지_않는다(pc_root, fakes):
    # 곧바로 끊긴 세션 뒤 sts가 한 번 실패해 실제로 11초를 기다려도, 그 세션은 '곧바로 끊김'으로 셉니다 — 넣으면 셈이 0으로
    # 돌아가 꺼진 서버에 끝없이 다시 붙습니다(5번이 아니라 6번 이상).
    result = _tunnel(pc_root, fakes, FAKE_STS_FAIL="2", FAKE_SLEEP_REAL_10="1")
    assert [c for c in _calls(fakes) if c.startswith("aws ssm")] == [_SESSION] * 5
    assert "연달아 곧바로 끊겼습니다" in result.stderr


def test_tunnel은_AWS_INSTANCE_ID가_없거나_모양이_다르면_aws를_부르지_않는다(pc_root, fakes):
    for content in ("APP_PASSWORD=x\n", "AWS_INSTANCE_ID=my-macro-app\n"):
        (pc_root / ".env").write_text(content, encoding="utf-8")
        result = _tunnel(pc_root, fakes)
        assert result.returncode != 0
        assert "AWS_INSTANCE_ID" in result.stderr
    assert _calls(fakes) == []


def test_tunnel은_로그인이_안_돼_있으면_세션을_열지_않고_aws_login을_안내한다(pc_root, fakes):
    result = _tunnel(pc_root, fakes, FAKE_STS_OK="0")
    assert result.returncode != 0
    assert "aws login" in result.stderr
    assert not any(c.startswith("aws ssm") for c in _calls(fakes))


def test_tunnel은_세션_중에_로그인이_만료되면_1분쯤_기다린_뒤_다시_잇지_않는다(pc_root, fakes):
    result = _tunnel(pc_root, fakes, FAKE_STS_OK="1")
    assert result.returncode != 0
    assert "aws login" in result.stderr
    assert [c for c in _calls(fakes) if c.startswith("aws ssm")] == [_SESSION]
    assert len([c for c in _calls(fakes) if c.startswith("aws sts")]) == 1 + 1 + 6, "처음 확인 + 끊긴 뒤 확인 + 다시 확인 6번"


def test_tunnel은_끊긴_뒤_잠깐_AWS에_닿지_않아도_돌아오면_다시_잇는다(pc_root, fakes):
    # 잠자기에서 깨어날 때·와이파이를 바꿀 때: 세션이 끝난 직후 sts가 연결 오류(2·3번째) → 네 번째에 회복.
    result = _tunnel(pc_root, fakes, FAKE_STS_FAIL="2 3")
    sessions = [c for c in _calls(fakes) if c.startswith("aws ssm")]
    assert len(sessions) == 5, "회복한 뒤 다시 이음(서버가 꺼져 있어 결국 연달아 곧바로 끊겨 멈춤)"
    assert "연달아 곧바로 끊겼습니다" in result.stderr, "로그인 만료로 멈추지 않음"


def test_tunnel은_8201을_이미_쓰고_있으면_세션을_열지_않는다(pc_root, fakes):
    if _port_8201_in_use():
        pytest.skip("이 PC의 8201을 이미 쓰고 있어 건너뜁니다(열려 있는 터널).")
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("127.0.0.1", 8201))
        except OSError:
            pytest.skip("8201을 열 수 없어 건너뜁니다.")
        listener.listen(1)
        result = _run(pc_root / "scripts/aws/tunnel.sh", pc_root, _env(fakes))
    assert result.returncode != 0
    assert "8201" in result.stderr
    assert not any(c.startswith("aws ssm") for c in _calls(fakes))


def test_tunnel은_서버가_꺼져_있으면_세션을_열지_않고_켜는_방법을_알린다(pc_root, fakes):
    result = _tunnel(pc_root, fakes, FAKE_EC2_STATE="stopped")
    assert result.returncode != 0
    assert "instance.sh start" in result.stderr and "21:55" in result.stderr
    assert not any(c.startswith("aws ssm") for c in _calls(fakes))


# --------------------------------------------------------------------------- instance.sh
@pytest.fixture()
def pc_instance_root(pc_root):
    shutil.copy(ROOT / "scripts/aws/instance.sh", pc_root / "scripts/aws/instance.sh")
    return pc_root


def _instance(root: Path, fakes, *args: str, **extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(root / "scripts/aws/instance.sh"), *args], cwd=root, env=_env(fakes, **extra),
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def _ec2_calls(fakes) -> list[str]:
    return [c for c in _calls(fakes) if c.startswith("aws ec2 ") and not c.startswith("aws ec2 describe-instances")]


@pytest.mark.parametrize(("state", "words"), [("running", "켜져 있습니다"), ("stopped", "instance.sh start")])
def test_instance_status는_지금_상태를_한_줄로_알린다(pc_instance_root, fakes, state, words):
    result = _instance(pc_instance_root, fakes, "status", FAKE_EC2_STATE=state)
    assert result.returncode == 0, result.stderr
    assert state in result.stdout and words in result.stdout and INSTANCE in result.stdout
    assert _ec2_calls(fakes) == []
    assert SECRET not in result.stdout + result.stderr


def test_instance_start는_켜고_running까지_기다리고_다음_정지_일정을_알린다(pc_instance_root, fakes):
    result = _instance(pc_instance_root, fakes, "start", FAKE_EC2_STATE="stopped")
    assert result.returncode == 0, result.stderr
    assert _ec2_calls(fakes) == [f"aws ec2 start-instances --region ap-northeast-2 --instance-ids {INSTANCE}",
                                 f"aws ec2 wait instance-running --region ap-northeast-2 --instance-ids {INSTANCE}"]
    assert "08:00" in result.stdout and "10:00" in result.stdout


def test_instance_start는_이미_켜져_있으면_아무것도_하지_않는다(pc_instance_root, fakes):
    result = _instance(pc_instance_root, fakes, "start", FAKE_EC2_STATE="running")
    assert result.returncode == 0
    assert _ec2_calls(fakes) == []


# 요일(1=월 … 6=토 … 7=일) + KST 시분
@pytest.mark.parametrize(("now", "in_window"), [("12300", True), ("20759", True), ("70759", True), ("62155", True),
                                                ("60930", True), ("20800", False), ("11200", False), ("61000", False),
                                                ("62154", False), ("70800", False)])
def test_instance_stop은_정기_가동_시간에는_force_없이_끄지_않는다(pc_instance_root, fakes, now, in_window):
    result = _instance(pc_instance_root, fakes, "stop", FAKE_EC2_STATE="running", FAKE_NOW=now)
    stops = [c for c in _ec2_calls(fakes) if c.startswith("aws ec2 stop-instances")]
    if in_window:
        assert result.returncode != 0 and "--force" in result.stderr and stops == []
    else:
        assert result.returncode == 0, result.stderr
        assert stops == [f"aws ec2 stop-instances --region ap-northeast-2 --instance-ids {INSTANCE}"]


def test_instance_stop은_force면_가동_시간에도_끈다(pc_instance_root, fakes):
    result = _instance(pc_instance_root, fakes, "stop", "--force", FAKE_EC2_STATE="running", FAKE_NOW="12300")
    assert result.returncode == 0, result.stderr
    assert _ec2_calls(fakes) == [f"aws ec2 stop-instances --region ap-northeast-2 --instance-ids {INSTANCE}",
                                 f"aws ec2 wait instance-stopped --region ap-northeast-2 --instance-ids {INSTANCE}"]


def test_instance는_상태를_읽지_못하거나_인스턴스_ID가_없으면_멈춘다(pc_instance_root, fakes):
    result = _instance(pc_instance_root, fakes, "start", FAKE_EC2_FAIL="1")
    assert result.returncode != 0 and "aws login" in result.stderr and _ec2_calls(fakes) == []
    (pc_instance_root / ".env").write_text("APP_PASSWORD=x\n", encoding="utf-8")
    result = _instance(pc_instance_root, fakes, "status")
    assert result.returncode != 0 and "AWS_INSTANCE_ID" in result.stderr
    assert _instance(pc_instance_root, fakes, "reboot").returncode != 0
