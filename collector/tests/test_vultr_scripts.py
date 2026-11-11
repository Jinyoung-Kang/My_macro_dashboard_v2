"""
tests/test_vultr_scripts.py
Vultr 서버(ADR 0023)의 스크립트 시험 — scripts/vultr/{bootstrap,tailscale-up,deploy,backup-s3,backup-age,instance,firewall-pc-ip}.sh
와 make status의 마지막 S3 백업 나이(QA-199).

deploy.sh·backup-s3.sh는 scripts/aws의 같은 이름에서 갈라냈으므로, 같은 가짜 실행 파일(tests/fake_server_tools.py — docker·aws·make·
logger·sleep)과 임시 git 원격으로 Vultr에서 달라진 점을 봅니다: 덧붙임 파일(compose.vultr.yml), gate·CloudFront 대역 단계가 없음,
서버 .env에 적지 않는 이름(AWS 공개 주소용 값·PC 전용 값 더함), 운영본의 PAPER_ENABLED 알림(QA-194), 백업 접두어 db/vultr/.
PC용 instance.sh·firewall-pc-ip.sh(api-common.sh)는 Vultr API를 흉내 내는 가짜 curl(상태 JSON 파일에 규칙을 들고 있음)로
규칙 교체 순서·건드리지 않는 규칙·API 키가 curl 인자에 남지 않는지·거절(401·403) 안내를 봅니다.
서버·Vultr·AWS·DB 없이 돕니다.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pytest
import yaml

from tests import fake_server_tools as tools

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ["bootstrap.sh", "tailscale-up.sh", "deploy.sh", "backup-s3.sh", "backup-age.sh", "instance.sh", "firewall-pc-ip.sh"]
SECRET = tools.SECRET


@pytest.fixture()
def fakes(tmp_path):
    """가짜 실행 파일 폴더와 기록 파일(tests/fake_server_tools.py). 진짜 git·bash·coreutils는 그 뒤의 PATH에서 찾습니다."""
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    for name, text in {"docker": tools._FAKE_DOCKER, "aws": tools._FAKE_AWS, "make": tools._FAKE_MAKE,
                       "logger": tools._FAKE_LOGGER, "sleep": tools._FAKE_SLEEP, "curl": tools._FAKE_CURL}.items():
        tools._write_exec(bin_dir / name, text)
    log.touch()
    return bin_dir, log


def _docker_calls(fakes) -> list[str]:
    return [line.split(" | ")[0] for line in tools._calls(fakes)]


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
    """원격 origin(bare)과 서버 역할의 클론 ~/My_macro_dashboard_v2(폴더 이름 규칙), 서버 .env(운영본 — PAPER_ENABLED 줄 없음 = 켜짐)."""
    if shutil.which("git") is None:
        pytest.skip("git이 없어 건너뜁니다.")
    origin, here = tmp_path / "origin.git", tmp_path / "home" / "My_macro_dashboard_v2"
    seed = tmp_path / "seed"
    tools._git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    tools._git(tmp_path, "clone", "-q", str(origin), str(seed))
    tools._git(seed, "symbolic-ref", "HEAD", "refs/heads/main")
    (seed / "scripts/vultr").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/vultr/deploy.sh", seed / "scripts/vultr/deploy.sh")
    shutil.copy(ROOT / "scripts/vultr/backup-age.sh", seed / "scripts/vultr/backup-age.sh")   # 끝 요약의 S3 백업 나이(QA-199)
    for name in ("db-backup.sh", "db-common.sh"):   # 배포 전 덤프(QA-200)가 부르는 것
        shutil.copy(ROOT / "scripts" / name, seed / "scripts" / name)
    (seed / "deploy/vultr").mkdir(parents=True)
    shutil.copy(ROOT / "deploy/vultr/Caddyfile", seed / "deploy/vultr/Caddyfile")
    (seed / "README.md").write_text("readme\n", encoding="utf-8")
    tools._git(seed, "add", ".")
    tools._git(seed, "commit", "-q", "-m", "seed")
    tools._git(seed, "push", "-q", "origin", "main")
    here.parent.mkdir(parents=True)
    tools._git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(here))
    (here / ".env").write_text(f"OWNER_EMAIL=owner@example.invalid\nAPP_PASSWORD={SECRET}\n"
                               "COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nAWS_BACKUP_BUCKET=b\n"
                               "PUBLIC_ORIGIN=https://my-macro-app.example.ts.net\n", encoding="utf-8")
    return here, seed


def _deploy(server, fakes, **extra: str) -> subprocess.CompletedProcess:
    here, _ = server
    return tools._run(here / "scripts/vultr/deploy.sh", here, tools._env(fakes, **extra))


def test_deploy는_gate_없이_하나씩_빌드하고_Vultr_덧붙임으로_기동한_뒤_스키마를_적용한다(server, fakes):
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    calls = _docker_calls(fakes)
    builds = [c for c in calls if c.startswith("compose build")]
    assert builds == ["compose build --pull backend", "compose build --pull frontend", "compose build --pull collector",
                      "compose build --pull browser"], \
        "4 GB — 서비스를 하나씩, gate는 Vultr에 없음(ADR 0023), browser는 차단 통과 수집 계층의 브라우저 컨테이너(ADR 0026)"
    assert not any(c.startswith("curl ") for c in tools._calls(fakes)), "CloudFront 대역을 받지 않습니다(공개 주소 없음)"
    assert not (server[0] / "deploy/vultr/trusted_proxies.caddy").exists()
    up = calls.index("compose up -d --no-build --wait --wait-timeout 300")
    assert up > calls.index("compose build --pull browser")
    schema = [i for i, c in enumerate(calls) if " exec -T collector " in f" {c} " and "init_schema" in c]
    assert len(schema) == 1 and schema[0] > up, "up -d 뒤 스키마 적용(QA-016)"
    assert calls.index("compose up -d --no-deps --force-recreate --wait --wait-timeout 60 caddy") > schema[0]
    head = tools._git(server[0], "rev-parse", "--short", "HEAD")
    for line in tools._calls(fakes):
        assert f"COMPOSE_FILE=docker-compose.yml:compose.vultr.yml APP_VERSION=main@{head}" in line, line
    assert "정기 작업 켜짐" in result.stdout and "주의" not in result.stdout
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
def test_deploy는_PAPER_ENABLED_false가_없으면_막지_않고_정기_작업_켜짐만_알린다(server, fakes, line):
    here, _ = server
    if line is not None:
        with (here / ".env").open("a", encoding="utf-8") as env_file:
            env_file.write(line + "\n")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "정기 작업 켜짐" in result.stdout and "주의" not in result.stdout, "운영본(ADR 0023)에서는 켜짐이 정상(QA-194)"


def test_QA194_deploy는_PAPER_ENABLED_false면_운영본의_정기_작업이_꺼진_채_뜬다고_주의를_알린다(server, fakes):
    here, _ = server
    env = (here / ".env").read_text(encoding="utf-8").replace("PAPER_ENABLED=false\n", "") + "PAPER_ENABLED=false\n"
    (here / ".env").write_text(env, encoding="utf-8")
    result = _deploy(server, fakes)
    assert result.returncode == 0, "막지는 않음 — 정비 때 일부러 끌 수 있음"
    lines = result.stdout.splitlines()
    warned = [i for i, line in enumerate(lines) if line.startswith("주의") and "꺼진 채" in line]
    assert warned, "운영본(ADR 0023)에서는 정기 작업(리스크 점검·결정·체결)이 멈춘 상태 — '참고'가 아니라 '주의'"
    done = next(i for i, line in enumerate(lines) if "배포했습니다" in line)
    assert warned[-1] > done, "빌드 출력에 묻히지 않게 끝 요약에도 다시"


def test_QA194_deploy는_PAPER_ENABLED_false가_없으면_주의_없이_켜짐만_알리고_AWS를_말하지_않는다(server, fakes):
    here, _ = server
    env = (here / ".env").read_text(encoding="utf-8").replace("PAPER_ENABLED=false\n", "")
    (here / ".env").write_text(env, encoding="utf-8")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "주의" not in result.stdout, "컷오버(2026-11-03) 뒤에는 이것이 정상 — 배포마다 주의가 나오면 무시하는 습관이 듦"
    assert "AWS" not in result.stdout and "컷오버" not in result.stdout, "AWS 서버는 2026-11-03에 지웠음"
    assert any(line.startswith("참고") and "정기 작업 켜짐" in line for line in result.stdout.splitlines())


def test_deploy는_폴더_이름이_다르면_멈춘다(server, fakes):
    here, _ = server
    moved = here.with_name("My_macro_dashboard_v2-copy")
    here.rename(moved)
    result = tools._run(moved / "scripts/vultr/deploy.sh", moved, tools._env(fakes))
    assert result.returncode != 0
    assert "My_macro_dashboard_v2" in result.stderr
    assert _docker_calls(fakes) == []


def test_deploy는_받은_main에_Caddyfile이_없으면_기동하지_않는다(server, fakes):
    _, seed = server
    tools._git(seed, "mv", "deploy/vultr/Caddyfile", "deploy/vultr/Caddyfile.new")
    tools._git(seed, "commit", "-q", "-m", "rename caddyfile")
    tools._git(seed, "push", "-q", "origin", "main")
    result = _deploy(server, fakes)
    assert result.returncode != 0
    assert "deploy/vultr/Caddyfile" in result.stderr
    assert _docker_calls(fakes) == []


def test_QA145_deploy는_받은_main의_deploy_sh가_바뀌었으면_새_판으로_다시_돈다(server, fakes):
    _, seed = server
    script = seed / "scripts/vultr/deploy.sh"
    script.write_text(script.read_text(encoding="utf-8").replace(
        'echo "코드를 받습니다(main)…"', 'echo "새 판 deploy.sh"\necho "코드를 받습니다(main)…"', 1), encoding="utf-8")
    tools._git(seed, "commit", "-qam", "new deploy.sh")
    tools._git(seed, "push", "-q", "origin", "main")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "새 판 deploy.sh" in result.stdout
    assert result.stdout.count("코드를 받습니다") == 2, "옛 판이 받은 뒤 새 판으로 한 번만 다시 돈다(되풀이 없음)"
    assert len([c for c in _docker_calls(fakes) if c.startswith("compose build")]) == 4, "빌드는 새 판에서 한 번만"


def test_QA118_deploy의_스키마_적용이_10번_모두_실패하면_알리고_0이_아닌_값으로_끝난다(server, fakes):
    result = _deploy(server, fakes, FAKE_EXEC_RC="1")
    assert result.returncode != 0
    assert len([c for c in _docker_calls(fakes) if "init_schema" in c]) == 10
    assert "스키마" in result.stderr
    assert not any("prune" in c for c in _docker_calls(fakes)), "실패한 배포는 거기서 멈춤"


UP = "compose up -d --no-build --wait --wait-timeout 300"
CADDY = "compose up -d --no-deps --force-recreate --wait --wait-timeout 60 caddy"


@pytest.mark.xfail(strict=True, reason="QA-369: 기동 확인(up --wait)이 실패하면 set -e로 그 줄에서 끝나 스키마 적용과 앞단 재생성을 건너뜁니다")
def test_QA369_deploy는_기동_확인이_실패해도_스키마_적용과_앞단_재생성을_마친_뒤_실패로_끝난다(server, fakes):
    """
    여섯 서비스 중 하나라도 5분 안에 건강해지지 못하면 `up --wait`가 0이 아닌 값으로 끝납니다. 백엔드와 스키마만 바뀐 배포였다면 새 백엔드는
    떠 있는데 새 표가 없어 모의 매매 정기 작업이 '준비 중'으로 쉬고, 다시 돌려도 같은 줄에서 멈췄습니다.
    """
    result = _deploy(server, fakes, FAKE_DOCKER_FAIL="--wait-timeout 300")      # 그 줄만 실패(postgres 120·caddy 60은 그대로)

    calls = _docker_calls(fakes)
    schema = [i for i, c in enumerate(calls) if " exec -T collector " in f" {c} " and "init_schema" in c]
    assert schema and schema[0] > calls.index(UP), "기동 확인이 실패해도 스키마는 적용합니다"
    assert CADDY in calls and calls.index(CADDY) > schema[0], "앞단 재생성도 마칩니다"
    assert result.returncode != 0, "기동 확인의 실패는 끝까지 실패로 남습니다"
    assert "기동 확인" in result.stderr and "스키마" in result.stderr, result.stderr
    assert any(c.startswith("compose ps") for c in calls), "어느 서비스가 건강하지 않은지 보입니다"
    assert not any("prune" in c for c in calls), "실패한 배포는 이미지 정리를 하지 않습니다(QA-118)"
    assert "배포했습니다" not in result.stdout, "성공 문구는 성공 때만(QA-194)"


@pytest.mark.xfail(strict=True, reason="QA-369: 앞단 재생성 줄도 set -e 아래라 실패하면 정리·요약 없이 끝납니다")
def test_QA369_deploy는_앞단_재생성이_실패하면_알리고_실패로_끝난다(server, fakes):
    result = _deploy(server, fakes, FAKE_DOCKER_FAIL="--wait-timeout 60 caddy")

    calls = _docker_calls(fakes)
    assert result.returncode != 0
    assert "앞단" in result.stderr, result.stderr
    assert not any("prune" in c for c in calls) and "배포했습니다" not in result.stdout


def _dump_calls(calls: list[str]) -> list[int]:
    return [i for i, c in enumerate(calls) if c.startswith("compose exec -T postgres pg_dump")]


def test_QA200_deploy는_빌드_뒤_기동_전에_배포_전_덤프를_따로_이름_붙여_남긴다(server, fakes):
    here, _ = server
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    calls = _docker_calls(fakes)
    dumps = _dump_calls(calls)
    assert len(dumps) == 1, "배포마다 한 번"
    assert calls.index("compose build --pull collector") < dumps[0] < calls.index(UP), \
        "빌드가 성공한 뒤, 수집기가 기동하며 마이그레이션을 적용하기(up) 전"
    saved = sorted(p.name for p in (here / "backups").glob("*.sql"))
    assert len(saved) == 1 and saved[0].startswith("pre-deploy-"), \
        f"정기 백업(macrodash-…)·복원 전 백업과 섞이지 않는 접두어 — {saved}"


def test_QA200_deploy는_배포_전_덤프가_실패하면_기동하지_않고_0이_아닌_값으로_끝난다(server, fakes):
    here, _ = server
    result = _deploy(server, fakes, FAKE_PG_DUMP_RC="1")
    assert result.returncode != 0
    assert "배포 전" in result.stderr
    assert not any(c.startswith("compose up") for c in _docker_calls(fakes)), "되돌릴 시점 없이 기동하지 않음"
    left = sorted(p.name for p in (here / "backups").glob("*")) if (here / "backups").exists() else []
    assert left == [], f"반쯤 쓴 덤프(.partial)를 남기지 않음 — {left}"


def test_QA200_deploy는_postgres가_떠_있지_않으면_postgres만_먼저_띄워_덤프한다(server, fakes):
    result = _deploy(server, fakes, FAKE_PG_DOWN="1")
    assert result.returncode == 0, result.stderr
    calls = _docker_calls(fakes)
    start = calls.index("compose up -d --no-build --wait --wait-timeout 120 postgres")
    dumps = _dump_calls(calls)
    assert len(dumps) == 1 and start < dumps[0] < calls.index(UP), "새 서버의 첫 배포·손으로 down한 뒤에도 막히지 않음"


def test_QA200_deploy는_postgres가_떠_있으면_덤프_전에_컨테이너를_건드리지_않는다(server, fakes):
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    calls = _docker_calls(fakes)
    before = calls[:_dump_calls(calls)[0]]
    assert not any(c.startswith(("compose up", "compose stop", "compose down", "compose restart")) for c in before), \
        "평소에는 돌던 DB를 그대로 뜸 — 컨테이너를 바꾸기 전 상태"


# 실제 매매 가드(ADR 0028) — 가짜 docker는 postgres 안의 psql 질의(켜진 시장 수)에 FAKE_RT_OUT을 찍고(FAKE_RT_RC가 0이 아니면 실패),
# 가짜 date는 '+%u %H%M'(요일·KST 시각)에 FAKE_KST_NOW를 찍습니다(FAKE_KST_LATER가 있으면 두 번째부터 그 값 — 빌드 중에 창에 들어옴).
# 그 밖의 date 호출(백업 파일 이름 등)은 진짜 date로 넘깁니다.
_RT_DOCKER = tools._FAKE_DOCKER.replace(
    '    *" exec -T postgres true "*)',
    '    *" exec -T postgres sh -c psql "*) [ "${FAKE_RT_RC:-0}" = 0 ] || exit 1; printf "%s\\n" "${FAKE_RT_OUT:-}"; exit 0 ;;\n'
    '    *" exec -T postgres true "*)', 1)
_REAL_DATE = shutil.which("date") or "/usr/bin/date"
_FAKE_DATE = ('#!/usr/bin/env bash\n'
              'if [ "$1" = "+%u %H%M" ]; then\n'
              '  if [ -n "${FAKE_KST_LATER:-}" ] && [ -e "$FAKE_LOG.date" ]; then echo "$FAKE_KST_LATER"; else echo "$FAKE_KST_NOW"; fi\n'
              '  : > "$FAKE_LOG.date"\n'
              f'else exec {_REAL_DATE} "$@"; fi\n')


@pytest.fixture()
def rt_fakes(fakes):
    """실제 매매 상태와 KST 시각을 흉내 내는 가짜 docker·date를 같은 가짜 폴더에 둡니다."""
    assert _RT_DOCKER != tools._FAKE_DOCKER, "가짜 docker의 postgres 갈래 모양이 바뀜 — 이 시험의 덧붙임을 고치세요"
    bin_dir, _ = fakes
    tools._write_exec(bin_dir / "docker", _RT_DOCKER)
    tools._write_exec(bin_dir / "date", _FAKE_DATE)
    return fakes


def _builds(calls: list[str]) -> list[str]:
    return [c for c in calls if c.startswith("compose build")]


# 창은 정규장 전체(08:45~15:35 — 개장 10분 뒤 맞추기·장중 스탑 매도, ADR 0033).
@pytest.mark.parametrize("now", ["3 0850", "1 0845", "1 0935", "5 1520", "2 1515", "4 1535", "2 0936", "3 1200", "4 1400", "3 1514"])
def test_deploy는_실제_매매가_켜져_있고_한국_거래_창이면_빌드_전에_멈춘다(server, rt_fakes, now):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW=now, FAKE_RT_OUT="1")
    assert result.returncode != 0
    assert "거래 창" in result.stderr and "REALTRADE_DEPLOY_OK=1" in result.stderr
    calls = _docker_calls(rt_fakes)
    assert _builds(calls) == [] and not any(c.startswith("compose up") for c in calls), "돌던 컨테이너 그대로"
    assert _dump_calls(calls) == []


@pytest.mark.parametrize("now", ["1 0844", "2 1536", "3 0700", "5 1536", "6 0850", "7 1520", "3 2330"])
def test_deploy는_실제_매매가_켜져_있어도_한국_거래_창_밖이면_알리고_진행한다(server, rt_fakes, now):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW=now, FAKE_RT_OUT="1")
    assert result.returncode == 0, result.stderr
    assert UP in _docker_calls(rt_fakes)
    assert "참고: 실제 매매 켜짐(LIVE)" in result.stdout


@pytest.mark.parametrize("value,ok", [("1", True), ("yes", False), ("true", False), ("", False)])
def test_deploy는_거래_창_안이라도_REALTRADE_DEPLOY_OK가_정확히_1이면_경고하고_진행한다(server, rt_fakes, value, ok):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="3 0850", FAKE_RT_OUT="1", REALTRADE_DEPLOY_OK=value)
    calls = _docker_calls(rt_fakes)
    if ok:
        assert result.returncode == 0, result.stderr
        assert "REALTRADE_DEPLOY_OK=1이라 계속합니다" in result.stdout
        assert UP in calls
    else:
        assert result.returncode != 0
        assert _builds(calls) == [] and UP not in calls


@pytest.mark.parametrize("out", ["0", "none"])
def test_deploy는_실제_매매가_꺼졌거나_표가_없으면_거래_창이어도_말없이_진행한다(server, rt_fakes, out):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="3 0850", FAKE_RT_OUT=out)
    assert result.returncode == 0, result.stderr
    assert UP in _docker_calls(rt_fakes)
    assert "실제 매매" not in result.stdout + result.stderr


@pytest.mark.parametrize("extra", [{"FAKE_RT_RC": "1"}, {"FAKE_RT_OUT": ""}, {"FAKE_RT_OUT": "ERROR: x"}])
def test_deploy는_실제_매매_상태를_읽지_못하면_경고만_하고_진행한다(server, rt_fakes, extra):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="3 0850", **{"FAKE_RT_OUT": "1", **extra})
    assert result.returncode == 0, result.stderr
    assert "경고: 실제 매매 상태(real_trade_config)를 읽지 못했습니다" in result.stdout
    assert UP in _docker_calls(rt_fakes)


def test_deploy는_빌드하는_동안_거래_창에_들어오면_기동_직전에_멈춘다(server, rt_fakes):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="3 0840", FAKE_KST_LATER="3 0850", FAKE_RT_OUT="1")
    assert result.returncode != 0
    assert "빌드하는 동안" in result.stderr
    calls = _docker_calls(rt_fakes)
    assert len(_builds(calls)) == 4 and len(_dump_calls(calls)) == 1, "빌드·배포 전 덤프까지는 함"
    assert not any(c.startswith("compose up") for c in calls), "돌던 컨테이너 그대로"


# RT2-COL-1: 장 시간이 바뀐 날(2026-11-19 수능 10:00~16:30 등)에는 같은 psql 호출이 켜진 시장 수 뒤에 모의 설정
# kr.calendar.openTimeOverrides의 오늘 값을 붙여 냅니다("1 10:00 16:30"). 창은 개장 −15분 ~ 마감 +5분(09:45~16:35 — 정규장 전체, ADR 0033),
# 그 설정을 읽지 못했거나 모양이 틀리면("1 bad" 등) 보수 합집합 창(평일 08:45~16:35)입니다.
@pytest.mark.parametrize("now", ["4 0955", "4 1005", "4 1625", "4 0945", "4 1035", "4 1615", "4 1635", "4 1300", "4 1530"])
def test_RT2_COL_1_deploy는_장_시간_변경일이면_옮긴_한국_거래_창에서_빌드_전에_멈춘다(server, rt_fakes, now):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW=now, FAKE_RT_OUT="1 10:00 16:30")
    assert result.returncode != 0, result.stdout
    assert "거래 창" in result.stderr and "REALTRADE_DEPLOY_OK=1" in result.stderr
    assert "09:45~16:35" in result.stderr, "옮긴 창을 알림"
    calls = _docker_calls(rt_fakes)
    assert _builds(calls) == [] and not any(c.startswith("compose up") for c in calls), "돌던 컨테이너 그대로"
    assert _dump_calls(calls) == []


@pytest.mark.parametrize("now", ["4 0850", "4 0920", "4 0944", "4 1636", "4 1700", "6 1005"])
def test_RT2_COL_1_deploy는_장_시간_변경일이면_고정_창_시각이어도_옮긴_창_밖이면_진행한다(server, rt_fakes, now):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW=now, FAKE_RT_OUT="1 10:00 16:30")
    assert result.returncode == 0, result.stderr
    assert UP in _docker_calls(rt_fakes)
    assert "참고: 실제 매매 켜짐(LIVE)" in result.stdout
    assert "읽지 못했습니다" not in result.stdout + result.stderr


@pytest.mark.parametrize("out", ["1 bad", "1 10:00", "1 25:00 16:30", "1 16:30 10:00", "1 10:00 16:30 x", "1 10:0 16:30", "1 ?"])
@pytest.mark.parametrize("now", ["4 0850", "4 1005", "4 1035", "4 1520", "4 1625"])
def test_RT2_COL_1_deploy는_장_시간_변경을_읽지_못했거나_모양이_틀리면_보수_창으로_멈춘다(server, rt_fakes, out, now):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW=now, FAKE_RT_OUT=out)
    assert result.returncode != 0, result.stdout
    assert "거래 창" in result.stderr and "보수 창" in result.stderr and "08:45~16:35" in result.stderr
    assert _builds(_docker_calls(rt_fakes)) == []


@pytest.mark.parametrize("now", ["4 0844", "4 0700", "4 1636", "7 1005"])
def test_RT2_COL_1_deploy는_보수_창_밖이면_보수_창임을_알리고_진행한다(server, rt_fakes, now):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW=now, FAKE_RT_OUT="1 bad")
    assert result.returncode == 0, result.stderr
    assert UP in _docker_calls(rt_fakes)
    assert "참고: 실제 매매 켜짐(LIVE)" in result.stdout and "보수 창" in result.stdout


@pytest.mark.parametrize("out", ["0 10:00 16:30", "0 bad"])
def test_RT2_COL_1_deploy는_실제_매매가_꺼졌으면_장_시간_변경과_관계없이_말없이_진행한다(server, rt_fakes, out):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="4 1005", FAKE_RT_OUT=out)
    assert result.returncode == 0, result.stderr
    assert UP in _docker_calls(rt_fakes)
    assert "실제 매매" not in result.stdout + result.stderr


def test_RT2_COL_1_deploy는_장_시간_변경일에_빌드하는_동안_옮긴_창에_들어오면_기동_직전에_멈춘다(server, rt_fakes):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="4 0930", FAKE_KST_LATER="4 0950", FAKE_RT_OUT="1 10:00 16:30")
    assert result.returncode != 0
    assert "빌드하는 동안" in result.stderr and "09:45~16:35" in result.stderr
    calls = _docker_calls(rt_fakes)
    assert len(_builds(calls)) == 4 and len(_dump_calls(calls)) == 1, "빌드·배포 전 덤프까지는 함"
    assert not any(c.startswith("compose up") for c in calls), "돌던 컨테이너 그대로"


def test_RT2_COL_1_deploy는_켜진_시장_수와_오늘의_장_시간_변경을_같은_psql_호출로_읽는다(server, rt_fakes):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="4 0850", FAKE_RT_OUT="1 10:00 16:30")
    assert result.returncode == 0, result.stderr
    psql = [c for c in _docker_calls(rt_fakes) if c.startswith("compose exec -T postgres sh -c psql")]
    assert len(psql) == 2, "빌드 전·기동 직전 가드마다 psql 한 번(수집기 토큰·.env 없이)"
    text = (ROOT / "scripts/vultr/deploy.sh").read_text(encoding="utf-8")
    sql = text[text.index("<<'SQL'"):text.index("\nSQL\n")]
    # 백엔드가 쓰는 설정 행(paper_settings id = 1)의 중첩 경로 — valueAt이 점 경로 kr.calendar.openTimeOverrides를 중첩 객체로 풂.
    assert "FROM public.paper_settings WHERE id = 1" in sql
    assert "body -> 'kr' -> 'calendar' -> 'openTimeOverrides'" in sql
    assert "to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')" in sql, "오늘은 KST 날짜(서버 TZ는 UTC)"
    # 장 시간 변경 질의가 실패해도 켜진 시장 수는 내고(그때 bad — 보수 창), 실패를 '꺼짐'으로 읽지 않음.
    assert "\\set rt_hours bad" in sql and "\\set ON_ERROR_STOP 0" in sql and "\\set ON_ERROR_STOP 1" in sql
    assert sql.index("\\set rt_hours bad") < sql.index("\\set ON_ERROR_STOP 0") < sql.index("public.paper_settings") \
        < sql.index("\\set ON_ERROR_STOP 1") < sql.index("FROM public.real_trade_config WHERE state <> 'OFF'")   # OPS-5 — 끄는 중·이상 멈춤도 셈


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
    return tools._run(root / "scripts/vultr/backup-s3.sh", root, tools._env(fakes, **extra))


def test_backup_s3는_이번에_만든_백업_하나만_db_vultr_아래에_올리고_syslog에_남긴다(backup_root, fakes):
    result = _backup(backup_root, fakes)
    assert result.returncode == 0, result.stderr
    calls = tools._calls(fakes)
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
    assert any(c.startswith("logger -t my-macro-backup -p user.err") for c in tools._calls(fakes))


TG_TOKEN = "123456789:telegram-token-must-not-be-in-argv"
TG_CHAT = "-100777000111"


def _with_telegram(root: Path) -> None:
    with (root / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write(f"TELEGRAM_BOT_TOKEN={TG_TOKEN}\nTELEGRAM_CHAT_ID={TG_CHAT}\n")


def _curl_config(fakes) -> str:
    path = fakes[1].with_suffix(".curl-config")
    return path.read_text(encoding="utf-8") if path.exists() else ""


def test_QA199_backup_s3는_실패하면_서버_env의_텔레그램_봇으로_한_줄_알리고_비밀값은_인자에_남기지_않는다(backup_root, fakes):
    _with_telegram(backup_root)
    result = _backup(backup_root, fakes, FAKE_AWS_RC="1")
    assert result.returncode == 1, "알림을 보내도 백업 실패의 종료 코드는 그대로"
    curls = [c for c in tools._calls(fakes) if c.startswith("curl ")]
    assert len(curls) == 1, "실패 한 번에 한 줄"
    assert "--max-time" in curls[0] and "-K -" in curls[0]
    assert "text=" in curls[0] and "백업 실패" in curls[0] and "S3 올리기" in curls[0], "무엇이 실패했는지 한 줄로"
    log = fakes[1].read_text(encoding="utf-8")
    assert TG_TOKEN not in log and TG_CHAT not in log, "토큰·채팅 ID가 curl 인자(서버 ps)에 남았습니다"
    assert TG_TOKEN not in result.stdout + result.stderr and SECRET not in result.stdout + result.stderr
    config = _curl_config(fakes)
    assert f'url = "https://api.telegram.org/bot{TG_TOKEN}/sendMessage"' in config and f"chat_id={TG_CHAT}" in config


def test_QA199_backup_s3는_올리기에_성공하면_마지막_성공_시각을_남긴다(backup_root, fakes):
    started = int(time.time())
    result = _backup(backup_root, fakes)
    assert result.returncode == 0, result.stderr
    new = sorted(p.name for p in (backup_root / "backups").glob("macrodash-*.sql"))[-1]
    fields = (backup_root / "backups/.last-s3-ok").read_text(encoding="utf-8").split()
    assert started <= int(fields[0]) <= int(time.time()), "유닉스 초(deploy.sh가 나이를 셈)"
    assert fields[-1] == f"db/vultr/{new}", "올린 키(버킷 이름은 적지 않음)"


@pytest.mark.parametrize("age_hours", [None, 37])
def test_QA199_deploy는_마지막_S3_백업이_없거나_36시간을_넘었으면_경고한다(server, fakes, age_hours):
    here, _ = server
    if age_hours is not None:
        (here / "backups").mkdir(exist_ok=True)
        (here / "backups/.last-s3-ok").write_text(f"{int(time.time()) - age_hours * 3600} x db/vultr/x.sql\n", encoding="utf-8")
    result = _deploy(server, fakes)
    assert result.returncode == 0, "경고만 — 배포는 막지 않음"
    assert any(line.startswith("경고") and "S3 백업" in line for line in result.stdout.splitlines()), \
        "매일 08:00 KST 한 번이라 36시간이면 한 번 이상 놓친 것(cron이 빠지면 텔레그램 알림도 없음)"


def test_QA199_deploy는_마지막_S3_백업이_36시간_안이면_경고_없이_나이만_찍는다(server, fakes):
    here, _ = server
    (here / "backups").mkdir(exist_ok=True)
    (here / "backups/.last-s3-ok").write_text(f"{int(time.time()) - 3600} x db/vultr/x.sql\n", encoding="utf-8")
    result = _deploy(server, fakes)
    assert result.returncode == 0, result.stderr
    assert "마지막 S3 백업: 1시간 전" in result.stdout
    assert not any(line.startswith("경고") and "S3" in line for line in result.stdout.splitlines())


@pytest.mark.parametrize("env_lines", ["", "TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=1\n", f"TELEGRAM_BOT_TOKEN={TG_TOKEN}\n"])
def test_QA199_backup_s3는_텔레그램_값이_하나라도_없으면_조용히_건너뛰고_실패_코드는_그대로(backup_root, fakes, env_lines):
    with (backup_root / ".env").open("a", encoding="utf-8") as env_file:
        env_file.write(env_lines)
    result = _backup(backup_root, fakes, FAKE_AWS_RC="1")
    assert result.returncode == 1
    assert not any(c.startswith("curl ") for c in tools._calls(fakes))
    assert any(c.startswith("logger -t my-macro-backup -p user.err") for c in tools._calls(fakes)), "syslog err는 그대로"


def test_QA199_backup_s3는_텔레그램_알림이_실패해도_종료_코드를_바꾸지_않고_syslog에_남긴다(backup_root, fakes):
    _with_telegram(backup_root)
    result = _backup(backup_root, fakes, FAKE_AWS_RC="1", FAKE_CURL_RC="7")
    assert result.returncode == 1
    assert any(c.startswith("logger -t my-macro-backup -p user.warning") and "텔레그램" in c for c in tools._calls(fakes))
    assert TG_TOKEN not in result.stdout + result.stderr + fakes[1].read_text(encoding="utf-8")


def test_QA199_backup_s3는_make_backup이_실패해도_알리고_마지막_성공_시각은_그대로_둔다(backup_root, fakes):
    _with_telegram(backup_root)
    (backup_root / "backups/.last-s3-ok").write_text("1 x db/vultr/old.sql\n", encoding="utf-8")
    result = _backup(backup_root, fakes, FAKE_MAKE_RC="1")
    assert result.returncode == 1
    curls = [c for c in tools._calls(fakes) if c.startswith("curl ")]
    assert len(curls) == 1 and "make backup" in curls[0]
    assert (backup_root / "backups/.last-s3-ok").read_text(encoding="utf-8") == "1 x db/vultr/old.sql\n"


def test_backup_s3는_버킷_이름이_없으면_백업하지_않는다(backup_root, fakes):
    (backup_root / ".env").write_text("DATABASE_NAME=macrodash\n", encoding="utf-8")
    result = _backup(backup_root, fakes)
    assert result.returncode != 0
    assert "AWS_BACKUP_BUCKET" in result.stderr
    assert not any(c.startswith(("make", "aws")) for c in tools._calls(fakes))


# --------------------------------------------------------------------------- make status (QA-199 보완 — 서버의 마지막 S3 백업)
# 계획(사용자 결정 4)은 'make status가 36시간 넘으면 경고'였는데 deploy.sh 끝 요약에만 들어가, crontab이 빠지고(텔레그램 알림도 없음)
# 배포도 없으면 날마다 보는 make status에는 아무 신호가 없었습니다. 저장소의 Makefile을 임시 저장소 최상위에서 진짜 make로 돌리고,
# 수집기는 늘 연결되지 않는 가짜 curl(fakes, FAKE_CURL_RC=7)로 바꿉니다 — 수집기가 꺼져 있어도 나이는 찍어야 합니다.
REAL_MAKE = shutil.which("make")
needs_make = pytest.mark.skipif(REAL_MAKE is None, reason="make가 없어 건너뜁니다.")


@pytest.fixture()
def status_root(tmp_path):
    """make status를 돌릴 저장소 최상위 — 레시피가 최상위 기준 상대 경로로 부르는 scripts/만 복사합니다(.env 없음 — 기본 포트)."""
    root = tmp_path / "status-root"
    shutil.copytree(ROOT / "scripts", root / "scripts")
    return root


def _write_last_s3(root: Path, age_hours: int) -> None:
    (root / "backups").mkdir(exist_ok=True)
    # 시간의 한가운데(+30분)로 적어, 두 번 돌리는 사이에 시간 경계를 넘지 않게 합니다.
    then = int(time.time()) - age_hours * 3600 - 1800
    (root / "backups/.last-s3-ok").write_text(f"{then} x db/vultr/x.sql\n", encoding="utf-8")


def _make_status(root: Path, fakes) -> subprocess.CompletedProcess:
    # fakes의 가짜 make가 PATH 앞에 있어 진짜 make를 절대 경로로 부릅니다.
    assert REAL_MAKE is not None
    return subprocess.run([REAL_MAKE, "--no-print-directory", "-C", str(root), "-f", str(ROOT / "Makefile"), "status"],
                          env=tools._env(fakes, FAKE_CURL_RC="7"), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)


def _s3_lines(stdout: str) -> list[str]:
    return [line.strip() for line in stdout.splitlines() if "S3 백업" in line]


@needs_make
def test_QA199_make_status는_서버의_마지막_S3_백업이_36시간을_넘었으면_수집기가_꺼져_있어도_경고한다(status_root, fakes):
    _write_last_s3(status_root, 37)
    result = _make_status(status_root, fakes)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "수집기에 연결하지 못했습니다." in result.stdout
    assert any(line.startswith("경고:") and "S3 백업이 37시간 전" in line for line in result.stdout.splitlines()), \
        "cron이 빠지면(crontab 유실·서버 재구성) 텔레그램 알림도 없어, 날마다 보는 make status가 잡아야 합니다"


@needs_make
def test_QA199_make_status는_마지막_S3_백업이_36시간_안이면_경고_없이_나이만_찍는다(status_root, fakes):
    _write_last_s3(status_root, 1)
    result = _make_status(status_root, fakes)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _s3_lines(result.stdout) == ["마지막 S3 백업: 1시간 전"]
    assert not any(line.startswith("경고") for line in result.stdout.splitlines())


@needs_make
def test_QA199_make_status는_마지막_S3_백업_기록이_없으면_그_줄을_찍지_않는다(status_root, fakes):
    # PC에는 S3 cron이 없어 기록 파일이 늘 없습니다. '없음' 경고는 서버를 다시 만든 직후를 잡는 deploy.sh만 냅니다.
    result = _make_status(status_root, fakes)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "S3" not in result.stdout + result.stderr
    assert not any(line.startswith("경고") for line in result.stdout.splitlines())


@needs_make
@pytest.mark.parametrize("age_hours", [1, 37])
def test_QA199_make_status와_deploy는_마지막_S3_백업을_같은_줄로_판정한다(server, fakes, age_hours):
    here, _ = server
    _write_last_s3(here, age_hours)
    deployed = _deploy(server, fakes)
    assert deployed.returncode == 0, deployed.stderr
    status = _make_status(here, fakes)
    assert status.returncode == 0, status.stdout + status.stderr
    assert len(_s3_lines(deployed.stdout)) == 1
    assert _s3_lines(status.stdout) == _s3_lines(deployed.stdout), "36시간 판정·문구가 두 곳에서 갈라지면 안 됩니다"


def test_api_common은_source로만_읽고_키를_curl_인자에_넣지_않는다():
    text = (ROOT / "scripts/vultr/api-common.sh").read_text(encoding="utf-8")
    assert text.startswith("# shellcheck shell=bash\n"), "db-common.sh처럼 source로 읽는 파일"
    assert subprocess.run(["bash", "-n", str(ROOT / "scripts/vultr/api-common.sh")], capture_output=True).returncode == 0
    assert "-H @<(printf 'Authorization: Bearer %s\\n' \"$VULTR_API_KEY\")" in text


# --------------------------------------------------------------------------- instance.sh · firewall-pc-ip.sh (PC, Vultr API)
INSTANCE_ID = "0d0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b"
GROUP_ID = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b"
API_KEY = "vultr-test-api-key-must-not-be-in-argv"
OLD_IP, NEW_IP = "198.51.100.7", "203.0.113.45"

# Vultr API 흉내 — 상태 파일(FAKE_STATE)의 instance·rules를 읽고 고칩니다. 부른 인자는 FAKE_LOG에 "curl …", API 요청은
# "api 메서드 경로 auth=ok|bad 본문"으로 남깁니다. FAKE_HTTP가 있으면 Vultr 요청은 모두 그 상태로 거절.
# checkip.amazonaws.com은 FAKE_PC_IP(FAKE_IP_FAIL이면 연결 실패 7).
_FAKE_VULTR_CURL = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
log = open(os.environ["FAKE_LOG"], "a", encoding="utf-8")
log.write("curl " + " ".join(args) + "\\n")
out = wfmt = data = None
method, headers, url, i = "GET", [], args[-1], 0
while i < len(args):
    a = args[i]
    if a in ("-o", "-w", "-X", "-H", "--data", "--max-time"):
        v = args[i + 1]
        if a == "-o": out = v
        elif a == "-w": wfmt = v
        elif a == "-X": method = v
        elif a == "-H": headers.append(v)
        elif a == "--data": data = v
        i += 2
        continue
    i += 1
if "checkip.amazonaws.com" in url:
    if os.environ.get("FAKE_IP_FAIL"):
        sys.exit(7)
    print(os.environ["FAKE_PC_IP"])
    sys.exit(0)
auth = "".join(open(h[1:], encoding="utf-8").read() if h.startswith("@") else h + "\\n" for h in headers if h.startswith("@") or h.lower().startswith("authorization"))
ok = auth.strip() == "Authorization: Bearer " + os.environ["FAKE_KEY"]
path = url.split("https://api.vultr.com", 1)[1].split("?", 1)[0]
log.write(f"api {method} {path} auth={'ok' if ok else 'bad'} {data or ''}\\n")
state = json.load(open(os.environ["FAKE_STATE"], encoding="utf-8"))
status, body = 404, {"error": "not found"}
if os.environ.get("FAKE_HTTP"):
    status, body = int(os.environ["FAKE_HTTP"]), {"error": "Unauthorized IP address"}
elif not ok:
    status, body = 401, {"error": "Invalid API token"}
elif method == "GET" and path == "/v2/instances/" + state["instance"]["id"]:
    status, body = 200, {"instance": state["instance"]}
elif path == "/v2/firewalls/" + state["group"] + "/rules" and method == "GET":
    status, body = 200, {"firewall_rules": state["rules"], "meta": {"total": len(state["rules"])}}
elif path == "/v2/firewalls/" + state["group"] + "/rules" and method == "POST":
    req = json.loads(data)
    rule = dict(req, id=max([r["id"] for r in state["rules"]] + [0]) + 1, action="accept", source="")
    state["rules"].append(rule)
    status, body = 201, {"firewall_rule": rule}
elif path.startswith("/v2/firewalls/" + state["group"] + "/rules/") and method == "DELETE":
    rid = int(path.rsplit("/", 1)[1])
    state["rules"] = [r for r in state["rules"] if r["id"] != rid]
    status, body = 204, None
json.dump(state, open(os.environ["FAKE_STATE"], "w", encoding="utf-8"))
if out:
    open(out, "w", encoding="utf-8").write("" if body is None else json.dumps(body))
if wfmt:
    sys.stdout.write(wfmt.replace("%{http_code}", str(status)))
"""


def _rule(rid: int, ip_type: str, protocol: str, port: str, subnet: str, size: int) -> dict:
    return {"id": rid, "ip_type": ip_type, "protocol": protocol, "port": port, "subnet": subnet, "subnet_size": size,
            "notes": "", "action": "accept", "source": ""}


@pytest.fixture()
def pc(tmp_path):
    """PC 역할의 저장소(스크립트·.env)와 가짜 curl·상태 파일. 규칙: 22/tcp 옛 IP, Tailscale 41641/udp v4·v6."""
    root, bin_dir, log, state = tmp_path / "My_macro_dashboard_v2", tmp_path / "bin", tmp_path / "calls.log", tmp_path / "state.json"
    (root / "scripts/vultr").mkdir(parents=True)
    for name in ("api-common.sh", "instance.sh", "firewall-pc-ip.sh"):
        shutil.copy(ROOT / "scripts/vultr" / name, root / "scripts/vultr" / name)
    shutil.copy(ROOT / "scripts/db-common.sh", root / "scripts/db-common.sh")
    (root / ".env").write_text(f"VULTR_API_KEY={API_KEY}\nVULTR_INSTANCE_ID={INSTANCE_ID}\nVULTR_FIREWALL_GROUP_ID={GROUP_ID}\n",
                               encoding="utf-8")
    tools._write_exec(bin_dir / "curl", _FAKE_VULTR_CURL)
    log.touch()
    state.write_text(json.dumps({
        "group": GROUP_ID,
        "instance": {"id": INSTANCE_ID, "label": "my-macro-app", "region": "icn", "plan": "vhf-2c-4gb", "status": "active",
                     "power_status": "running", "server_status": "ok", "main_ip": "192.0.2.20", "v6_main_ip": "2001:db8::20"},
        "rules": [_rule(1, "v4", "tcp", "22", OLD_IP, 32), _rule(2, "v4", "udp", "41641", "0.0.0.0", 0),
                  _rule(3, "v6", "udp", "41641", "::", 0)],
    }), encoding="utf-8")
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", "HOME": str(tmp_path), "LANG": "C.UTF-8",
           "FAKE_LOG": str(log), "FAKE_STATE": str(state), "FAKE_KEY": API_KEY, "FAKE_PC_IP": NEW_IP}
    return root, env, log, state


def _pc_run(pc, script: str, *args: str, **extra: str) -> subprocess.CompletedProcess:
    root, env, _, _ = pc
    return subprocess.run(["bash", str(root / "scripts/vultr" / script), *args], cwd=root, env={**env, **extra},
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def _api_calls(pc) -> list[str]:
    return [line for line in pc[2].read_text(encoding="utf-8").splitlines() if line.startswith("api ")]


def _rules(pc) -> list[dict]:
    return json.loads(pc[3].read_text(encoding="utf-8"))["rules"]


def test_instance_status는_상태와_주소를_한_번의_GET으로_보이고_키를_인자에_남기지_않는다(pc):
    result = _pc_run(pc, "instance.sh", "status")
    assert result.returncode == 0, result.stderr
    assert "my-macro-app" in result.stdout and "power running" in result.stdout and "192.0.2.20" in result.stdout
    assert _api_calls(pc) == [f"api GET /v2/instances/{INSTANCE_ID} auth=ok "]
    assert API_KEY not in pc[2].read_text(encoding="utf-8"), "API 키가 curl 인자(프로세스 목록)에 남았습니다"
    assert API_KEY not in result.stdout + result.stderr


@pytest.mark.parametrize(("args", "env_line"), [((), None), (("start",), None), (("status",), "VULTR_INSTANCE_ID=\n"),
                                                (("status",), "VULTR_INSTANCE_ID=my-macro-app\n")])
def test_instance는_status만_받고_ID가_없거나_모양이_다르면_API를_부르지_않는다(pc, args, env_line):
    if env_line is not None:
        env_file = pc[0] / ".env"
        env_file.write_text(env_file.read_text(encoding="utf-8").replace(f"VULTR_INSTANCE_ID={INSTANCE_ID}\n", env_line),
                            encoding="utf-8")
    result = _pc_run(pc, "instance.sh", *args)
    assert result.returncode != 0
    assert _api_calls(pc) == []


@pytest.mark.parametrize("http", ["401", "403"])
def test_API가_거절하면_허용_IP는_콘솔에서만_바꿀_수_있다고_알린다(pc, http):
    result = _pc_run(pc, "instance.sh", "status", FAKE_HTTP=http)
    assert result.returncode != 0
    assert f"HTTP {http}" in result.stderr and "Access Control" in result.stderr


def test_firewall은_새_22_규칙을_먼저_넣고_옛_22_규칙만_지운다(pc):
    result = _pc_run(pc, "firewall-pc-ip.sh")
    assert result.returncode == 0, result.stderr
    calls = _api_calls(pc)
    assert [c.split(" auth=")[0] for c in calls] == [
        f"api GET /v2/firewalls/{GROUP_ID}/rules", f"api POST /v2/firewalls/{GROUP_ID}/rules",
        f"api DELETE /v2/firewalls/{GROUP_ID}/rules/1"], "넣기 전에 지우면 그 사이 SSH가 막힘"
    assert all("auth=ok" in c for c in calls)
    posted = json.loads(calls[1].split(" auth=ok ", 1)[1])
    assert posted == {"ip_type": "v4", "protocol": "tcp", "subnet": NEW_IP, "subnet_size": 32, "port": "22", "notes": "ssh from pc"}
    rules = _rules(pc)
    assert [(r["protocol"], r["port"], r["subnet"], r["subnet_size"]) for r in rules] == [
        ("udp", "41641", "0.0.0.0", 0), ("udp", "41641", "::", 0), ("tcp", "22", NEW_IP, 32)], "Tailscale 규칙은 그대로"
    assert API_KEY not in pc[2].read_text(encoding="utf-8")


def test_firewall은_이미_지금_IP면_아무것도_바꾸지_않는다(pc):
    state = json.loads(pc[3].read_text(encoding="utf-8"))
    state["rules"][0]["subnet"] = NEW_IP
    pc[3].write_text(json.dumps(state), encoding="utf-8")
    result = _pc_run(pc, "firewall-pc-ip.sh")
    assert result.returncode == 0, result.stderr
    assert [c.split(" auth=")[0] for c in _api_calls(pc)] == [f"api GET /v2/firewalls/{GROUP_ID}/rules"]
    assert "바꿀 것이 없습니다" in result.stdout


def test_firewall은_옛_22_규칙이_여럿이면_새_규칙을_넣은_뒤_모두_지운다(pc):
    state = json.loads(pc[3].read_text(encoding="utf-8"))
    state["rules"].append(_rule(4, "v4", "tcp", "22", "192.0.2.99", 32))
    pc[3].write_text(json.dumps(state), encoding="utf-8")
    result = _pc_run(pc, "firewall-pc-ip.sh")
    assert result.returncode == 0, result.stderr
    methods = [c.split(" ")[1] for c in _api_calls(pc)]
    assert methods == ["GET", "POST", "DELETE", "DELETE"]
    assert [r["subnet"] for r in _rules(pc) if r["port"] == "22"] == [NEW_IP]


def test_firewall은_PC_IP를_모르면_API를_부르지_않는다(pc):
    result = _pc_run(pc, "firewall-pc-ip.sh", FAKE_IP_FAIL="1")
    assert result.returncode != 0
    assert _api_calls(pc) == []
    result = _pc_run(pc, "firewall-pc-ip.sh", FAKE_PC_IP="<html>")
    assert result.returncode != 0 and _api_calls(pc) == []


def test_firewall은_API가_거절하면_규칙을_바꾸지_않고_콘솔을_안내한다(pc):
    result = _pc_run(pc, "firewall-pc-ip.sh", FAKE_HTTP="401")
    assert result.returncode != 0
    assert "Access Control" in result.stderr
    assert [c.split(" ")[1] for c in _api_calls(pc)] == ["GET"]
    assert [r["subnet"] for r in _rules(pc) if r["port"] == "22"] == [OLD_IP]


# --------------------------------------------------------------------------- 실제 매매 운영(RT3 — OPS-1·2·3·5)
# OPS-5: 배포 가드는 꺼지지 않은(LIVE·STOPPING·HALTED) 시장을 셉니다 — 끄는 중·이상 멈춤도 이 기능의 미체결 취소를 보내, 거래 창 안에서
# 다시 만들면 보내던 취소가 끊깁니다. 가짜 docker 시험은 psql 응답을 흉내 내므로, 질의 자체는 진짜 PostgreSQL에서 돌려 봅니다.
def _deploy_state_sql() -> str:
    text = (ROOT / "scripts/vultr/deploy.sh").read_text(encoding="utf-8")
    start = text.index("\n", text.index("<<'SQL'")) + 1   # 여기 문서 줄(<<'SQL' || true)의 다음 줄부터
    return text[start:text.index("\nSQL\n", start)] + "\n"


@pytest.fixture()
def rt_db(database_url):
    """deploy.sh의 상태 질의를 돌릴 이 시험 전용 DB(저장소 마이그레이션 적용). psql 클라이언트가 없으면 건너뜁니다(CI에는 있음)."""
    if shutil.which("psql") is None:
        pytest.skip("psql 클라이언트가 없어 deploy.sh 상태 질의 시험을 건너뜁니다.")
    import psycopg

    from app import migrations

    name = f"deploy_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    db_url = urlparse(database_url)._replace(path=f"/{name}").geturl()
    with psycopg.connect(db_url, autocommit=True) as conn:
        migrations.apply_pending(conn, migrations.discover(ROOT / "db" / "migrations"))
        conn.execute("DELETE FROM paper_settings")
    try:
        yield name, db_url
    finally:
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def _rt_set(db_url: str, sql: str, params: tuple = ()) -> None:
    import psycopg

    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(sql, params)


def _run_state_sql(database_url: str, db_name: str) -> subprocess.CompletedProcess:
    """deploy.sh가 postgres 컨테이너 안에서 부르는 것과 같은 psql 옵션으로 질의를 돌립니다(접속만 TCP)."""
    url = urlparse(database_url)
    env = {**os.environ, "PGPASSWORD": url.password or "", "PGHOST": url.hostname or "localhost", "PGPORT": str(url.port or 5432)}
    return subprocess.run(["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", url.username or "macro", "-d", db_name],
                          input=_deploy_state_sql(), env=env, capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("kr_state,expected", [(None, "0"), ("OFF", "0"), ("LIVE", "1"), ("STOPPING", "1"), ("HALTED", "1")])
def test_OPS5_deploy의_상태_질의는_끄는_중과_이상_멈춤도_꺼지지_않은_시장으로_센다(database_url, rt_db, kr_state, expected):
    name, db_url = rt_db
    _rt_set(db_url, "INSERT INTO real_trade_config(market, state) VALUES ('US', 'OFF')")
    if kr_state is not None:
        _rt_set(db_url, "INSERT INTO real_trade_config(market, state, source_book, book_generation, halt_reason)"
                        " VALUES ('KR', %s, 'kr_rules', '2026-10-30', %s)",
                (kr_state, "restored" if kr_state == "HALTED" else None))

    result = _run_state_sql(database_url, name)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == expected, "끄는 중·이상 멈춤도 미체결 취소를 보내 거래 창 배포를 막아야 합니다(OPS-5)"


def test_OPS5_deploy의_상태_질의는_끄는_중에도_오늘의_장_시간_변경을_함께_낸다(database_url, rt_db):
    name, db_url = rt_db
    _rt_set(db_url, "INSERT INTO real_trade_config(market, state, source_book, book_generation)"
                    " VALUES ('KR', 'STOPPING', 'kr_rules', '2026-10-30')")
    _rt_set(db_url, "INSERT INTO paper_settings(id, version, body) VALUES (1, 1, jsonb_build_object('kr', jsonb_build_object("
                    "'calendar', jsonb_build_object('openTimeOverrides', jsonb_build_object("
                    "to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD'), jsonb_build_object('open', '10:00', 'close', '16:30'))))))")

    result = _run_state_sql(database_url, name)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "1 10:00 16:30"


def test_OPS5_deploy는_꺼지지_않은_시장이_있으면_끄는_중과_이상_멈춤까지_거래_창에서_멈춘다고_알린다(server, rt_fakes):
    result = _deploy(server, rt_fakes, FAKE_KST_NOW="1 0850", FAKE_RT_OUT="1")
    assert result.returncode != 0
    assert "끄는 중" in result.stderr and "이상 멈춤" in result.stderr and "미체결 취소" in result.stderr
    assert "먼저 화면의 끄기" in result.stderr, "비상 끄기는 화면 끄기가 먼저(OPS-3)"
    assert _builds(_docker_calls(rt_fakes)) == []


# OPS-2: 기본 정지 유예 10초면 배포·복원·재부팅이 백엔드의 종료 훅(진행 중인 주기를 기다림)과 수집기의 주문 POST를 SIGKILL로 자릅니다.
# 덧붙임의 값이 코드의 상수보다 긴지 대조합니다(상수를 바꾸면 이 시험이 함께 봄).
def _duration_seconds(value: str) -> float:
    match = re.fullmatch(r"(?:(\d+)m)?(?:(\d+)s)?", value.strip())
    assert match and value.strip(), f"모르는 시간 모양: {value!r}"
    return int(match.group(1) or 0) * 60 + int(match.group(2) or 0)


def test_OPS2_Vultr_덧붙임은_백엔드와_수집기가_보내던_실제_주문을_끝낼_때까지_정지를_기다린다():
    services = yaml.safe_load((ROOT / "compose.vultr.yml").read_text(encoding="utf-8"))["services"]
    job = (ROOT / "backend/src/main/java/com/macrodash/feature/realtrade/RealTradeJob.java").read_text(encoding="utf-8")
    client = (ROOT / "backend/src/main/java/com/macrodash/collector/CollectorTradeClient.java").read_text(encoding="utf-8")
    trade = (ROOT / "collector/app/services/toss_trade.py").read_text(encoding="utf-8")
    shutdown_wait = int(re.search(r"\bSHUTDOWN_WAIT_SECONDS\s*=\s*(\d+)\s*;", job).group(1))
    order_read = int(re.search(r"\bORDER_READ_SECONDS\s*=\s*(\d+)\s*;", client).group(1))
    order_budget = float(re.search(r"^ORDER_BUDGET_SECONDS\s*=\s*([\d.]+)", trade, re.M).group(1))

    backend = _duration_seconds(str(services["backend"].get("stop_grace_period", "10s")))
    collector = _duration_seconds(str(services["collector"].get("stop_grace_period", "10s")))

    assert backend > shutdown_wait + order_read, "종료 훅 대기 + 주문 읽기 상한보다 길어야 보내던 주문의 결과를 기록합니다"
    assert collector > order_budget, "수집기 주문 한 건 예산보다 길어야 토스로 나간 주문의 응답을 돌려줍니다"


# OPS-1: 서버 .env 다시 전달(docs/DEVELOPMENT.md §7 '서버 .env 전달'의 첫 명령)을 가짜 ssh로 그대로 돌립니다. 서버에만 있는 줄 — 토스 키·텔레그램·
# Tailscale 신원·토스 스위치·실제 매매 여섯 줄·브라우저 비밀 등 — 은 서버의 값 그대로 남아야 하고(로컬의 빈 줄·다른 값으로 덮지 않음), 값은 PC를
# 거치지 않으며, 지금 .env는 먼저 백업됩니다.
_FAKE_SSH = ('#!/usr/bin/env bash\n'
             '# 가짜 ssh — 호스트 이름을 남기고, 원격 명령을 서버 역할 폴더를 HOME으로 둔 이 기계의 bash로 돌립니다(stdin은 그대로).\n'
             'printf "%s\\n" "$1" >> "$FAKE_SSH_LOG"; shift\n'
             'cd "$FAKE_SERVER_HOME" && HOME="$FAKE_SERVER_HOME" exec bash -c "$*"\n')


def _env_redelivery_block() -> str:
    text = (ROOT / "docs/DEVELOPMENT.md").read_text(encoding="utf-8")
    start = text.index("### 서버 .env 전달")
    section = text[start:text.index("\n### ", start + 1)]
    begin = section.index("```bash\n") + len("```bash\n")
    return section[begin:section.index("\n```", begin)] + "\n"


def _env_names(text: str) -> list[str]:
    return [m.group(1) for m in re.finditer(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", text, re.M)]


def _env_values(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            values[m.group(1)] = m.group(2)
    return values


def _server_only_names() -> list[str]:
    """.env.vultr.example의 '서버 전용' 칸 이름 + 서버 밖에 두지 않는 토스 키(실제 매매 켜기 점검표)."""
    text = (ROOT / ".env.vultr.example").read_text(encoding="utf-8")
    names = _env_names(text[text.index("# ── 서버 전용 ──"):])
    assert {"TAILNET_OWNER_LOGIN", "TOSS_TRADING_ENABLED", "REAL_TRADE_ENABLED", "TELEGRAM_BOT_TOKEN"} <= set(names)
    return names + ["TOSS_CLIENT_ID", "TOSS_CLIENT_SECRET"]


def _redeliver(tmp_path: Path, local_env: str, server_env: str | None) -> tuple[subprocess.CompletedProcess, Path, Path]:
    pc, home = tmp_path / "pc", tmp_path / "server-home"
    repo = home / "My_macro_dashboard_v2"
    pc.mkdir()
    repo.mkdir(parents=True)
    (tmp_path / "tmp").mkdir()
    (pc / ".env").write_text(local_env, encoding="utf-8")
    if server_env is not None:
        (repo / ".env").write_text(server_env, encoding="utf-8")
        (repo / ".env").chmod(0o600)
    bin_dir, log = tmp_path / "ssh-bin", tmp_path / "ssh.log"
    tools._write_exec(bin_dir / "ssh", _FAKE_SSH)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_SERVER_HOME": str(home), "FAKE_SSH_LOG": str(log),
           "TMPDIR": str(tmp_path / "tmp")}
    result = subprocess.run(["bash", "-c", _env_redelivery_block()], cwd=pc, env=env, capture_output=True, text=True, timeout=60)
    assert log.read_text(encoding="utf-8").split() == ["ubuntu@my-macro-app"], "Tailscale SSH 한 번"
    assert list((tmp_path / "tmp").iterdir()) == [], "PC의 걸러 낸 사본은 지웁니다"
    return result, repo, pc


def _deploy_unwanted_patterns() -> list[str]:
    text = (ROOT / "scripts/vultr/deploy.sh").read_text(encoding="utf-8")
    loop = text[text.index("for name in DATABASE_PORT"):text.index("; do", text.index("for name in DATABASE_PORT"))]
    return [w.strip("'") for w in loop.replace("\\\n", " ").split()[3:]]


def test_OPS1_서버_env를_다시_전달해도_서버_전용_줄은_서버의_값_그대로_남고_먼저_백업한다(tmp_path):
    server_only = _server_only_names()
    server_values = {n: f"server-{n.lower().replace('_', '-')}-value" for n in server_only}
    server_env = ("OWNER_EMAIL=owner@example.invalid\nAPP_PASSWORD=old-app-password-value\nFRED_API_KEY=fred-old-value\n"
                  + "".join(f"{n}={v}\n" for n, v in server_values.items()))
    # 로컬 .env — 서버 전용 이름은 빈 값(.env.example 모양 — 토스 키는 로컬에 두지 않음)이거나 다른 값, 적지 않는 이름·PC 전용 값이 섞여 있고 끝 줄바꿈이 없음
    local_env = (f"OWNER_EMAIL=owner@example.invalid\nAPP_PASSWORD={SECRET}\nFRED_API_KEY=fred-new-value\n"
                 "DATABASE_PORT=5434\nBACKEND_PORT=8082\nCOLLECTOR_PORT=8002\nFRONTEND_PORT=3002\nLOCAL_NO_LOGIN=true\nFRONTEND_ORIGIN=http://x\n"
                 "PUBLIC_URL=http://x\nAWS_INSTANCE_ID=i-0123456789abcdef0\nPAPER_ENABLED=false\nCOOKIE_SECURE=false\n"
                 "TAILNET_DOMAIN=example.ts.net\nVULTR_API_KEY=pc-vultr-key-value\nTAILSCALE_AUTH_KEY=pc-tailscale-key-value\n"
                 "TOSS_CLIENT_ID=\nTOSS_CLIENT_SECRET=\nTOSS_TRADING_ENABLED=local-should-not-win\nREAL_TRADE_ENABLED=\n"
                 "TELEGRAM_BOT_TOKEN=local-telegram-should-not-win\nexport BROWSER_FETCH_TOKEN=local-browser-should-not-win")

    result, repo, _ = _redeliver(tmp_path, local_env, server_env)

    assert result.returncode == 0, result.stderr
    new_text = (repo / ".env").read_text(encoding="utf-8")
    names = _env_names(new_text)
    assert len(names) == len(set(names)), f"같은 이름이 두 번: {sorted(n for n in names if names.count(n) > 1)}"
    values = _env_values(new_text)
    for name in server_only:
        assert values.get(name) == server_values[name], f"{name}: 서버 전용 줄은 서버의 값 그대로(OPS-1)"
    assert values["FRED_API_KEY"] == "fred-new-value" and values["APP_PASSWORD"] == SECRET, "로컬에서 옮기는 줄은 로컬 값"
    assert "PAPER_ENABLED" not in values and "COOKIE_SECURE" not in values, "로컬의 false는 옮기지 않음(서버는 비우면 켜짐·Secure)"
    for pattern in _deploy_unwanted_patterns():
        assert not any(re.fullmatch(pattern, n) for n in names), f"deploy.sh가 막는 이름이 들어감: {pattern}"
    assert (repo / ".env").stat().st_mode & 0o777 == 0o600
    backups = sorted(repo.glob(".env.bak-*"))
    assert len(backups) == 1 and backups[0].read_text(encoding="utf-8") == server_env, "바꾸기 전 서버 .env를 그대로 떠 둠"
    assert backups[0].stat().st_mode & 0o777 == 0o600
    assert not (repo / ".env.new").exists()
    output = result.stdout + result.stderr
    for value in [SECRET, *server_values.values(), "pc-vultr-key-value"]:
        assert value not in output, "값은 화면에 찍지 않습니다"
    assert "경고" not in output, "빠진 이름 없음"


def test_OPS1_서버에서_일부러_적은_PAPER_ENABLED와_COOKIE_SECURE는_남고_빠지는_이름은_이름만_알린다(tmp_path):
    server_env = ("APP_PASSWORD=old\nCOMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nPAPER_ENABLED=false\nCOOKIE_SECURE=false\n"
                  "KIS_APP_KEY=server-kis-key-value\nTOSS_CLIENT_SECRET=server-toss-secret-value\n")
    local_env = f"APP_PASSWORD={SECRET}\nPAPER_ENABLED=false\nCOOKIE_SECURE=false\n"

    result, repo, _ = _redeliver(tmp_path, local_env, server_env)

    values = _env_values((repo / ".env").read_text(encoding="utf-8"))
    assert values["PAPER_ENABLED"] == "false" and values["COOKIE_SECURE"] == "false", "정비 때 서버에서 적은 값은 서버 것 그대로"
    assert values["TOSS_CLIENT_SECRET"] == "server-toss-secret-value" and values["APP_PASSWORD"] == SECRET
    assert "KIS_APP_KEY" not in values
    output = result.stdout + result.stderr
    assert "경고" in output and "KIS_APP_KEY" in output, "새 .env에서 빠진 이름을 알림"
    assert "server-kis-key-value" not in output and "server-toss-secret-value" not in output
    assert len(list(repo.glob(".env.bak-*"))) == 1, "되살릴 수 있게 백업"


def test_OPS1_서버_env가_없으면_다시_전달하지_않고_아무것도_만들지_않는다(tmp_path):
    result, repo, _ = _redeliver(tmp_path, f"APP_PASSWORD={SECRET}\n", None)
    assert "서버 .env가 없습니다" in result.stderr
    assert sorted(p.name for p in repo.iterdir()) == []


# OPS-3: 수집기 스위치(비상 끄기 3단계)를 끈 뒤 켜진(LIVE) 상태가 남으면, 스위치를 되돌리고 배포하는 것만으로 확인 글자·비밀번호 없이 주문이
# 다시 나갔습니다. 백엔드는 이제 그때 이상 멈춤(collector-disabled)으로 두고, 문서는 다시 켤 때 스위치를 되돌린 뒤 화면의 멈춤 해제를 거치게 적습니다.
def test_OPS3_비상_끄기는_화면_끄기가_먼저이고_수집기_스위치를_끈_뒤에는_멈춤_해제로_다시_켠다고_적는다():
    text = (ROOT / "docs/DEVELOPMENT.md").read_text(encoding="utf-8")
    start = text.index("**비상 끄기**")
    section = text[start:text.index("\n### ", start)]
    assert section.index("1. 화면") < section.index("2. 화면이 안 열리면") < section.index("3. 그래도 안 되면")
    assert "collector-disabled" in section, "수집기 스위치를 끄면 백엔드가 이상 멈춤으로 둠"
    assert "멈춤 해제" in section and "확인 글자" in section, "다시 켤 때는 화면의 멈춤 해제(확인 글자 + 비밀번호)"
    assert "'켜는 순서' 2부터" not in section, "스위치를 되돌리고 배포만 하면 확인 없이 매매가 이어진다는 옛 안내"
    step3 = section[section.index("3. 그래도 안 되면"):section.index("4. ", section.index("3. 그래도 안 되면"))]
    assert "/toss/trading/status" in step3, "3단계 뒤 수집기 스위치가 꺼졌는지(enabled false·reason disabled) 확인"
