"""
tests/test_vultr_scripts.py
Vultr 서버(ADR 0023)의 스크립트 시험 — scripts/vultr/{bootstrap,tailscale-up,deploy,backup-s3,instance,firewall-pc-ip}.sh.

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
import shutil
import subprocess
from pathlib import Path

import pytest

from tests import fake_server_tools as tools

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ["bootstrap.sh", "tailscale-up.sh", "deploy.sh", "backup-s3.sh", "instance.sh", "firewall-pc-ip.sh"]
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
    assert builds == ["compose build --pull backend", "compose build --pull frontend", "compose build --pull collector"], \
        "4 GB — 서비스를 하나씩, gate는 Vultr에 없음(ADR 0023)"
    assert not any(c.startswith("curl ") for c in tools._calls(fakes)), "CloudFront 대역을 받지 않습니다(공개 주소 없음)"
    assert not (server[0] / "deploy/vultr/trusted_proxies.caddy").exists()
    up = calls.index("compose up -d --no-build --wait --wait-timeout 300")
    assert up > calls.index("compose build --pull collector")
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


def test_backup_s3는_버킷_이름이_없으면_백업하지_않는다(backup_root, fakes):
    (backup_root / ".env").write_text("DATABASE_NAME=macrodash\n", encoding="utf-8")
    result = _backup(backup_root, fakes)
    assert result.returncode != 0
    assert "AWS_BACKUP_BUCKET" in result.stderr
    assert not any(c.startswith(("make", "aws")) for c in tools._calls(fakes))


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
