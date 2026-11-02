"""
tests/test_vultr_scripts.py
Vultr 서버(ADR 0023)의 스크립트 시험 — scripts/vultr/{bootstrap,tailscale-up,deploy,backup-s3}.sh.

deploy.sh·backup-s3.sh는 scripts/aws의 같은 이름에서 갈라냈으므로, 같은 가짜 실행 파일(tests/test_aws_scripts.py — docker·aws·make·
logger·sleep)과 임시 git 원격으로 Vultr에서 달라진 점을 봅니다: 덧붙임 파일(compose.vultr.yml), gate·CloudFront 대역 단계가 없음,
서버 .env에 적지 않는 이름(AWS 공개 주소용 값·PC 전용 값 더함), 병행 기간의 PAPER_ENABLED 알림, 백업 접두어 db/vultr/.
서버·Vultr·AWS·DB 없이 돕니다.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests import test_aws_scripts as aws

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ["bootstrap.sh", "tailscale-up.sh", "deploy.sh", "backup-s3.sh"]
SECRET = aws.SECRET


@pytest.fixture()
def fakes(tmp_path):
    """가짜 실행 파일 폴더와 기록 파일(AWS 시험과 같은 가짜). 진짜 git·bash·coreutils는 그 뒤의 PATH에서 찾습니다."""
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    for name, text in {"docker": aws._FAKE_DOCKER, "aws": aws._FAKE_AWS, "make": aws._FAKE_MAKE,
                       "logger": aws._FAKE_LOGGER, "sleep": aws._FAKE_SLEEP, "curl": aws._FAKE_CURL}.items():
        aws._write_exec(bin_dir / name, text)
    log.touch()
    return bin_dir, log


def _docker_calls(fakes) -> list[str]:
    return [line.split(" | ")[0] for line in aws._calls(fakes)]


# --------------------------------------------------------------------------- 공통
@pytest.mark.parametrize("name", SCRIPTS)
def test_스크립트는_bash_문법이_맞고_실패하면_멈춘다(name):
    path = ROOT / "scripts/vultr" / name
    text = path.read_text(encoding="utf-8")
    assert text.startswith("#!/usr/bin/env bash\n")
    assert "\nset -euo pipefail\n" in text, f"{name}: bash -eu(+pipefail)로 돌아야 실패가 성공으로 보이지 않습니다"
    assert subprocess.run(["bash", "-n", str(path)], capture_output=True).returncode == 0
    assert os.access(path, os.X_OK), f"{name}: 실행 권한(cron·user-data가 직접 부름)"


def test_tailscale_up은_auth_key를_stdin으로만_받고_tailnet_안에서만_연다():
    text = (ROOT / "scripts/vultr/tailscale-up.sh").read_text(encoding="utf-8")
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    assert 'key="$(cat)"' in code, "키는 stdin — 인자로 받으면 프로세스 목록·셸 기록에 남습니다"
    assert "$1" not in code and "${1" not in code
    assert "tailscale up --ssh --hostname" in code
    assert "tailscale serve --bg --https=443 http://127.0.0.1:8201" in code
    assert "funnel" not in code, "공개 노출(funnel)은 쓰지 않습니다(ADR 0023)"


def test_bootstrap은_비밀번호_로그인을_막는_sshd_드롭인이_cloud_init보다_먼저_읽힌다():
    text = (ROOT / "scripts/vultr/bootstrap.sh").read_text(encoding="utf-8")
    assert "/etc/ssh/sshd_config.d/00-my-macro.conf" in text, "50-cloud-init.conf의 PasswordAuthentication yes보다 먼저"
    assert "PasswordAuthentication no" in text
    assert "https://download.docker.com/linux/ubuntu" in text and "docker.io" not in text
    assert "usermod -aG docker ubuntu" in text


# --------------------------------------------------------------------------- deploy.sh
@pytest.fixture()
def server(tmp_path):
    """원격 origin(bare)과 서버 역할의 클론 ~/My_macro_dashboard_v2(폴더 이름 규칙), 서버 .env(병행 기간 — PAPER_ENABLED=false)."""
    if shutil.which("git") is None:
        pytest.skip("git이 없어 건너뜁니다.")
    origin, here = tmp_path / "origin.git", tmp_path / "home" / "My_macro_dashboard_v2"
    seed = tmp_path / "seed"
    aws._git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    aws._git(tmp_path, "clone", "-q", str(origin), str(seed))
    aws._git(seed, "symbolic-ref", "HEAD", "refs/heads/main")
    (seed / "scripts/vultr").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/vultr/deploy.sh", seed / "scripts/vultr/deploy.sh")
    (seed / "deploy/vultr").mkdir(parents=True)
    shutil.copy(ROOT / "deploy/vultr/Caddyfile", seed / "deploy/vultr/Caddyfile")
    (seed / "README.md").write_text("readme\n", encoding="utf-8")
    aws._git(seed, "add", ".")
    aws._git(seed, "commit", "-q", "-m", "seed")
    aws._git(seed, "push", "-q", "origin", "main")
    here.parent.mkdir(parents=True)
    aws._git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(here))
    (here / ".env").write_text(f"OWNER_EMAIL=owner@example.invalid\nAPP_PASSWORD={SECRET}\n"
                               "COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nAWS_BACKUP_BUCKET=b\n"
                               "PUBLIC_ORIGIN=https://my-macro-app.example.ts.net\nPAPER_ENABLED=false\n", encoding="utf-8")
    return here, seed


def _deploy(server, fakes, **extra: str) -> subprocess.CompletedProcess:
    here, _ = server
    return aws._run(here / "scripts/vultr/deploy.sh", here, aws._env(fakes, **extra))


def test_deploy는_gate_없이_하나씩_빌드하고_Vultr_덧붙임으로_기동한_뒤_스키마를_적용한다(server, fakes):
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    calls = _docker_calls(fakes)
    builds = [c for c in calls if c.startswith("compose build")]
    assert builds == ["compose build --pull backend", "compose build --pull frontend", "compose build --pull collector"], \
        "4 GB — 서비스를 하나씩, gate는 Vultr에 없음(ADR 0023)"
    assert not any(c.startswith("curl ") for c in aws._calls(fakes)), "CloudFront 대역을 받지 않습니다(공개 주소 없음)"
    assert not (server[0] / "deploy/vultr/trusted_proxies.caddy").exists()
    up = calls.index("compose up -d --no-build --wait --wait-timeout 300")
    assert up > calls.index("compose build --pull collector")
    schema = [i for i, c in enumerate(calls) if " exec -T collector " in f" {c} " and "init_schema" in c]
    assert len(schema) == 1 and schema[0] > up, "up -d 뒤 스키마 적용(QA-016)"
    assert calls.index("compose up -d --no-deps --force-recreate --wait --wait-timeout 60 caddy") > schema[0]
    head = aws._git(server[0], "rev-parse", "--short", "HEAD")
    for line in aws._calls(fakes):
        assert f"COMPOSE_FILE=docker-compose.yml:compose.vultr.yml APP_VERSION=main@{head}" in line, line
    assert "PAPER_ENABLED=false" in result.stdout and "주의" not in result.stdout
    assert SECRET not in result.stdout + result.stderr, "서버 .env의 값을 찍지 않습니다"


@pytest.mark.parametrize("line", ["FRONTEND_PORT=3002", "LOCAL_NO_LOGIN=true", "PUBLIC_URL=http://x",
                                  "AWS_INSTANCE_ID=i-0123456789abcdef0", "ORIGIN_SECRET=origin-secret-value",
                                  "GATE_CODES=me:scrypt-hash-value", "GATE_SECRET=gate-secret-value",
                                  "VULTR_API_KEY=vultr-api-key-value", "VULTR_SERVER_IP=192.0.2.10",
                                  "TAILSCALE_AUTH_KEY=tskey-auth-value", "TAILNET_DOMAIN=tailnet-value.ts.net",
                                  "export VULTR_INSTANCE_ID=instance-id-value"])
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


def test_deploy는_적지_않는_이름이_여럿이면_모두_한_번에_알린다(server, fakes):
    here, _ = server
    with (here / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write("VULTR_API_KEY=a\nVULTR_SERVER_IP=b\nTAILSCALE_AUTH_KEY=c\nDATABASE_PORT=5434\n")
    result = _deploy(server, fakes)
    assert result.returncode != 0
    for name in ("VULTR_API_KEY", "VULTR_SERVER_IP", "TAILSCALE_AUTH_KEY", "DATABASE_PORT"):
        assert name in result.stderr


@pytest.mark.parametrize("line", ["PAPER_ENABLED=true", "PAPER_ENABLED=", None])
def test_deploy는_병행_기간의_PAPER_ENABLED_false가_없으면_막지_않고_주의를_알린다(server, fakes, line):
    here, _ = server
    env = (here / ".env").read_text(encoding="utf-8").replace("PAPER_ENABLED=false\n", "" if line is None else line + "\n")
    (here / ".env").write_text(env, encoding="utf-8")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "주의" in result.stdout and "PAPER_ENABLED" in result.stdout, "컷오버 전이면 정기 작업이 두 곳에서 돕니다"


def test_deploy는_폴더_이름이_다르면_멈춘다(server, fakes):
    here, _ = server
    moved = here.with_name("My_macro_dashboard_v2-copy")
    here.rename(moved)
    result = aws._run(moved / "scripts/vultr/deploy.sh", moved, aws._env(fakes))
    assert result.returncode != 0
    assert "My_macro_dashboard_v2" in result.stderr
    assert _docker_calls(fakes) == []


def test_deploy는_받은_main에_Caddyfile이_없으면_기동하지_않는다(server, fakes):
    _, seed = server
    aws._git(seed, "mv", "deploy/vultr/Caddyfile", "deploy/vultr/Caddyfile.new")
    aws._git(seed, "commit", "-q", "-m", "rename caddyfile")
    aws._git(seed, "push", "-q", "origin", "main")
    result = _deploy(server, fakes)
    assert result.returncode != 0
    assert "deploy/vultr/Caddyfile" in result.stderr
    assert _docker_calls(fakes) == []


def test_QA145_deploy는_받은_main의_deploy_sh가_바뀌었으면_새_판으로_다시_돈다(server, fakes):
    _, seed = server
    script = seed / "scripts/vultr/deploy.sh"
    script.write_text(script.read_text(encoding="utf-8").replace(
        'echo "코드를 받습니다(main)…"', 'echo "새 판 deploy.sh"\necho "코드를 받습니다(main)…"', 1), encoding="utf-8")
    aws._git(seed, "commit", "-qam", "new deploy.sh")
    aws._git(seed, "push", "-q", "origin", "main")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "새 판 deploy.sh" in result.stdout
    assert result.stdout.count("코드를 받습니다") == 2, "옛 판이 받은 뒤 새 판으로 한 번만 다시 돈다(되풀이 없음)"
    assert len([c for c in _docker_calls(fakes) if c.startswith("compose build")]) == 3, "빌드는 새 판에서 한 번만"


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
    (root / "scripts/vultr").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/vultr/backup-s3.sh", root / "scripts/vultr/backup-s3.sh")
    shutil.copy(ROOT / "scripts/db-common.sh", root / "scripts/db-common.sh")
    (root / "backups").mkdir()
    (root / "backups/macrodash-20200101-000000.sql").write_text("old\n", encoding="utf-8")   # 지난 백업 — 다시 올리지 않음
    (root / ".env").write_text(f"AWS_BACKUP_BUCKET=test-bucket\nDATABASE_PASSWORD={SECRET}\n", encoding="utf-8")
    return root


def _backup(root: Path, fakes, **extra: str) -> subprocess.CompletedProcess:
    return aws._run(root / "scripts/vultr/backup-s3.sh", root, aws._env(fakes, **extra))


def test_backup_s3는_이번에_만든_백업_하나만_db_vultr_아래에_올리고_syslog에_남긴다(backup_root, fakes):
    result = _backup(backup_root, fakes)
    assert result.returncode == 0, result.stderr
    calls = aws._calls(fakes)
    assert calls[0] == "make --no-print-directory backup"
    new = sorted(p.name for p in (backup_root / "backups").glob("macrodash-*.sql"))[-1]
    assert new != "macrodash-20200101-000000.sql"
    uploads = [c for c in calls if c.startswith("aws s3 cp")]
    assert uploads == [f"aws s3 cp --only-show-errors {backup_root}/backups/{new} s3://test-bucket/db/vultr/{new}"], \
        "AWS 서버의 db/와 섞이지 않게 접두어 db/vultr/(그 IAM 사용자는 db/vultr/에만 쓸 수 있음)"
    assert any(c.startswith("logger -t my-macro-backup") and "user.err" not in c for c in calls)
    assert SECRET not in result.stdout + result.stderr


def test_backup_s3는_Vultr_덧붙임으로_백업한다():
    text = (ROOT / "scripts/vultr/backup-s3.sh").read_text(encoding="utf-8")
    assert "\nexport COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\n" in text
    assert "compose.aws.yml" not in text


def test_backup_s3는_S3_올리기가_실패하면_0이_아닌_값과_syslog_err(backup_root, fakes):
    result = _backup(backup_root, fakes, FAKE_AWS_RC="1")
    assert result.returncode != 0
    assert any(c.startswith("logger -t my-macro-backup -p user.err") for c in aws._calls(fakes))


def test_backup_s3는_버킷_이름이_없으면_백업하지_않는다(backup_root, fakes):
    (backup_root / ".env").write_text("DATABASE_NAME=macrodash\n", encoding="utf-8")
    result = _backup(backup_root, fakes)
    assert result.returncode != 0
    assert "AWS_BACKUP_BUCKET" in result.stderr
    assert not any(c.startswith(("make", "aws")) for c in aws._calls(fakes))
