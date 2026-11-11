"""
tests/test_native_dev_run.py
QA-106: 문서의 네이티브 실행(make dev-collector·dev-backend, LOCAL_SETUP의 launchd)으로는 수집기가 뜨지 않던 결함.

수집기는 COLLECTOR_API_TOKEN이 비면 기동을 거부합니다(COLLECTOR_ALLOW_NO_TOKEN=1일 때만 경고 후 기동).
그런데 Makefile은 .env의 토큰을 make 변수로만 읽고 레시피 환경에는 넘기지 않아, `make dev-collector`가
'COLLECTOR_API_TOKEN이 비어 있습니다'로 멈췄습니다. dev-backend도 토큰 없이 수집기를 불러 401을 받았고,
dev-collector는 DB 포트를 5432로 박아 .env의 DATABASE_PORT를 무시했습니다.

실제 uvicorn·mvn 대신, 받은 환경을 출력만 하는 가짜 실행 파일을 임시 폴더에 두고 저장소의 Makefile을
그 폴더에서 돌립니다(가짜 .env, 가짜 값만 씀). DB·네트워크가 필요 없습니다.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FAKE_TOKEN = "fake-token-from-env-file"

pytestmark = pytest.mark.skipif(shutil.which("make") is None, reason="make가 없어 건너뜁니다.")

_PRINT_ENV = ('#!/bin/sh\nprintf "TOKEN=%s\\nURL=%s\\nPAPER=%s\\nPORT=%s\\nCOLLECTOR=%s\\n" "$COLLECTOR_API_TOKEN" "$DATABASE_URL" '
              '"${PAPER_ENABLED-(unset)}" "${SERVER_PORT-(unset)}" "${COLLECTOR_URL-(unset)}"\n')


def _fake_exe(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_PRINT_ENV, encoding="utf-8")
    path.chmod(0o755)


def _run(tmp_path: Path, target: str, extra_env: dict[str, str] | None = None, env_file: str = "") -> dict[str, str]:
    (tmp_path / ".env").write_text(f"COLLECTOR_API_TOKEN={FAKE_TOKEN}\nDATABASE_PORT=5433\n{env_file}", encoding="utf-8")
    _fake_exe(tmp_path / "collector/.venv/bin/python")   # make dev-collector가 부르는 해석기
    _fake_exe(tmp_path / "bin/mvn")                      # make dev-backend가 부르는 mvn
    (tmp_path / "backend").mkdir(exist_ok=True)
    drop = {"COLLECTOR_API_TOKEN", "COLLECTOR_ALLOW_NO_TOKEN", "DATABASE_URL", "DATABASE_PORT",
            "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_NAME", "PAPER_ENABLED", "MAKEFLAGS", "MFLAGS", "MAKELEVEL",
            "SERVER_PORT", "COLLECTOR_URL", "BACKEND_PORT", "COLLECTOR_PORT", "FRONTEND_PORT"}     # 개발자 셸의 포트 값이 새지 않게
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env["PATH"] = f"{tmp_path / 'bin'}{os.pathsep}{env.get('PATH', '')}"
    env.update(extra_env or {})
    result = subprocess.run(
        ["make", "--no-print-directory", "-C", str(tmp_path), "-f", str(ROOT / "Makefile"), target],
        env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    # 토큰 값이 make가 찍는 명령 줄에 그대로 보이면 안 됩니다(터미널·로그에 남음).
    echoed = [line for line in result.stdout.splitlines() if not line.startswith(("TOKEN=", "URL=", "PAPER=", "PORT=", "COLLECTOR="))]
    assert not any(FAKE_TOKEN in line for line in echoed), echoed
    return dict(re.findall(r"^(TOKEN|URL|PAPER|PORT|COLLECTOR)=(.*)$", result.stdout, re.M))


def test_QA106_dev_collector는_env_파일의_토큰과_DB_포트로_띄운다(tmp_path):
    seen = _run(tmp_path, "dev-collector")
    assert seen["TOKEN"] == FAKE_TOKEN
    assert "@localhost:5433/" in seen["URL"]


def test_QA106_dev_backend는_수집기와_같은_토큰을_보낸다(tmp_path):
    seen = _run(tmp_path, "dev-backend")
    assert seen["TOKEN"] == FAKE_TOKEN
    assert ":5433/" in seen["URL"]


def test_셸에서_준_값이_env_파일보다_앞선다(tmp_path):
    # LOCAL_SETUP 터미널 2처럼 DATABASE_URL을 직접 주면 그 값을 씁니다. 토큰도 셸 값이 먼저입니다.
    explicit = "jdbc:postgresql://localhost:6543/macrodash"
    seen = _run(tmp_path, "dev-backend", {"DATABASE_URL": explicit, "COLLECTOR_API_TOKEN": "from-shell"})
    assert seen["TOKEN"] == "from-shell" and seen["URL"] == explicit


def test_QA251_dev_backend는_env_파일의_PAPER_ENABLED를_넘기고_줄이_없으면_끈다(tmp_path):
    # 장부는 Vultr 서버 한 곳에만(ADR 0019·0020·0023) — 로컬 .env는 PAPER_ENABLED=false 고정인데 백엔드 기본값은 켜짐입니다.
    assert _run(tmp_path, "dev-backend", env_file="PAPER_ENABLED=false\n")["PAPER"] == "false"
    assert _run(tmp_path, "dev-backend")["PAPER"] == "false", ".env에 줄이 없어도 네이티브 백엔드는 끔"
    # 셸에서 일부러 켠 값은 그대로(다른 값들처럼 셸 값이 먼저).
    assert _run(tmp_path, "dev-backend", {"PAPER_ENABLED": "true"}, env_file="PAPER_ENABLED=false\n")["PAPER"] == "true"
    # 수집기에는 넘기지 않음(수집기는 이 값을 쓰지 않음).
    assert _run(tmp_path, "dev-collector", env_file="PAPER_ENABLED=false\n")["PAPER"] == "(unset)"


def test_QA251_dev_backend는_따옴표_주석_중복_줄에도_true_false만_넘긴다(tmp_path):
    # compose와 deploy.sh는 따옴표·줄 끝 주석을 받으므로(LOCAL_SETUP '형식 규칙'), 네이티브 백엔드도 기동이 깨지지 않게 true·false로만 넘깁니다.
    assert _run(tmp_path, "dev-backend", env_file='PAPER_ENABLED="false"\n')["PAPER"] == "false"
    assert _run(tmp_path, "dev-backend", env_file="PAPER_ENABLED=false # 로컬은 끔\n")["PAPER"] == "false"
    assert _run(tmp_path, "dev-backend", env_file="PAPER_ENABLED=true\nPAPER_ENABLED=false\n")["PAPER"] == "false", "마지막 줄"
    assert _run(tmp_path, "dev-backend", env_file="PAPER_ENABLED=yes\n")["PAPER"] == "false", "true가 아니면 끔"
    assert _run(tmp_path, "dev-backend", env_file="PAPER_ENABLED='true'\n")["PAPER"] == "true"


def test_QA371_dev_backend는_env_파일의_백엔드·수집기_포트를_따른다(tmp_path):
    # make dev-frontend는 .env의 BACKEND_PORT(이 저장소 8082)를 부르고 make dev-collector는 COLLECTOR_PORT(8002)에서 뜹니다.
    seen = _run(tmp_path, "dev-backend", env_file="BACKEND_PORT=8082\nCOLLECTOR_PORT=8002\n")
    assert seen["PORT"] == "8082"
    assert seen["COLLECTOR"] == "http://localhost:8002"


def test_QA371_dev_backend의_포트도_셸에서_준_값이_먼저이고_env_파일에_없으면_기본값(tmp_path):
    seen = _run(tmp_path, "dev-backend", {"SERVER_PORT": "9090", "COLLECTOR_URL": "http://localhost:9000"},
                env_file="BACKEND_PORT=8082\nCOLLECTOR_PORT=8002\n")
    assert (seen["PORT"], seen["COLLECTOR"]) == ("9090", "http://localhost:9000")
    seen = _run(tmp_path, "dev-backend")                      # .env에 포트 줄이 없으면 compose와 같은 기본값
    assert (seen["PORT"], seen["COLLECTOR"]) == ("8080", "http://localhost:8000")
    # 수집기에는 넘기지 않음(수집기는 --port 인자로 받음).
    assert _run(tmp_path, "dev-collector", env_file="BACKEND_PORT=8082\n")["PORT"] == "(unset)"


_FAKE_LSOF = '#!/bin/sh\necho "$*" >> "$FAKE_LSOF_LOG"\nexit 1\n'       # 어느 포트를 물었는지만 남기고 '비어 있음'
_FAKE_NO_DOCKER = "#!/bin/sh\nexit 1\n"                                   # docker info 실패 — 컨테이너 목록을 읽지 않음


def _setup_ports(tmp_path: Path, env_lines: str) -> tuple[list[str], str]:
    """scripts/setup.sh를 임시 폴더의 사본으로 돌려(가짜 .env·lsof·docker) 포트 확인이 물은 포트 목록과 출력을 돌려줍니다."""
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy(ROOT / "scripts/setup.sh", repo / "scripts/setup.sh")
    shutil.copy(ROOT / ".env.example", repo / ".env.example")
    (repo / ".env").write_text("OWNER_EMAIL=owner@example.invalid\nCOLLECTOR_API_TOKEN=fake-token\nAPP_PASSWORD=fake-password-not-default\n"
                               + env_lines, encoding="utf-8")
    log = tmp_path / "lsof.log"
    log.touch()
    for name, text in (("lsof", _FAKE_LSOF), ("docker", _FAKE_NO_DOCKER)):
        exe = tmp_path / "fakebin" / name
        exe.parent.mkdir(exist_ok=True)
        exe.write_text(text, encoding="utf-8")
        exe.chmod(0o755)
    env = {"PATH": f"{tmp_path / 'fakebin'}{os.pathsep}{os.environ.get('PATH', '')}", "HOME": str(tmp_path), "LANG": "C.UTF-8",
           "FAKE_LSOF_LOG": str(log)}
    result = subprocess.run(["bash", str(repo / "scripts/setup.sh")], cwd=repo, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    asked = re.findall(r"-iTCP:(\d+)", log.read_text(encoding="utf-8"))
    return asked, result.stdout


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash가 없어 건너뜁니다.")
def test_QA371_setup의_포트_확인은_env_파일의_포트를_본다(tmp_path):
    asked, out = _setup_ports(tmp_path, "FRONTEND_PORT=3002\nBACKEND_PORT=8082\nCOLLECTOR_PORT=8002\nDATABASE_PORT=5434\n")
    assert asked == ["3002", "8082", "8002", "5434"], "다른 스택(3000/8080/8000/5432)이 떠 있다고 이 저장소의 충돌로 알리지 않습니다"
    assert "3002 (화면) 비어 있음" in out and "5434 (PostgreSQL) 비어 있음" in out


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash가 없어 건너뜁니다.")
def test_setup의_포트_확인은_env_파일에_포트_줄이_없으면_compose_기본값을_본다(tmp_path):
    """지금 동작 고정 — compose의 기본값(3000/8080/8000/5432)."""
    asked, _ = _setup_ports(tmp_path, "")
    assert asked == ["3000", "8080", "8000", "5432"]


def test_QA106_문서가_빈_토큰을_인증_끔으로_적지_않고_launchd에_토큰을_넘긴다():
    api = (ROOT / "docs/API.md").read_text(encoding="utf-8")
    principles = (ROOT / "docs/PRINCIPLES.md").read_text(encoding="utf-8")
    local_setup = (ROOT / "docs/LOCAL_SETUP.md").read_text(encoding="utf-8")
    assert "비워 두면 토큰 검사는 하지" not in api
    assert "토큰이 선택 사항" not in principles
    assert "인증 없이 요청을 받으므로" not in principles
    plist = local_setup[local_setup.index("<key>EnvironmentVariables</key>"):]
    plist = plist[:plist.index("</dict>")]
    assert "<key>COLLECTOR_API_TOKEN</key>" in plist
