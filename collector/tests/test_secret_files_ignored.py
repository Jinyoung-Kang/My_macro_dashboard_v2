"""
tests/test_secret_files_ignored.py
비밀값 파일(.env와 그 복사본)이 git 추적 대상이 되지 않는지 — 저장소 최상위 .gitignore.

예전 .gitignore는 `.env`·`.env.qa`만 이름으로 적어, AWS 배포용으로 만든 `.env.aws` 같은 복사본은 `git add .`
한 번에 커밋될 수 있었습니다(저장소는 공개될 수 있다고 봅니다). 지금은 `.env*`를 막고 키 이름만 담은
예시(`*.example`)만 추적합니다 — 각 서비스의 .dockerignore와 같은 방식입니다.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _in_git_checkout() -> bool:
    if shutil.which("git") is None:
        return False
    probe = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=ROOT, capture_output=True, text=True)
    return probe.returncode == 0 and probe.stdout.strip() == "true"


pytestmark = pytest.mark.skipif(not _in_git_checkout(), reason="git 저장소가 아니라 건너뜁니다.")


def _ignored(name: str) -> bool:
    # --no-index: 이미 추적 중인지와 상관없이 무시 규칙만 봅니다.
    return subprocess.run(["git", "check-ignore", "-q", "--no-index", name], cwd=ROOT).returncode == 0


@pytest.mark.parametrize("name", [".env", ".env.qa", ".env.aws", ".env.vultr", ".env.prod", "collector/.env", "frontend/.env.local"])
def test_env_파일과_복사본은_추적하지_않는다(name):
    assert _ignored(name)


@pytest.mark.parametrize("name", [".env.example", ".env.vultr.example"])
def test_키_이름만_담은_예시는_추적한다(name):
    assert not _ignored(name)


def test_추적_중인_파일이_무시_규칙에_걸리지_않는다():
    listed = subprocess.run(["git", "ls-files", "-ci", "--exclude-standard"], cwd=ROOT,
                            capture_output=True, text=True, check=True)
    assert listed.stdout.split() == []


# Tailscale은 기기에 CGNAT 대역(100.64.0.0/10)의 주소를 줍니다. 운영 서버의 tailnet 주소는 .env·메모리에만 둡니다(CLAUDE.md —
# 이 저장소는 공개). 시험·문서에서 이 대역의 예시가 필요하면 아래 문서용 값만 씁니다(QA-340). 100.100.100.100은 기기 주소가 아니라
# 모든 tailnet에서 같은 Tailscale 고정 DNS 리졸버 주소라 비밀이 아닙니다(QA-415 — 서버가 그 리졸버를 쓰지 않게 한 기록·시험).
_CGNAT_EXAMPLES = {"100.64.0.0", "100.64.0.1", "100.100.100.100"}


def test_QA340_추적_파일의_CGNAT_주소는_문서용_예시뿐이다():
    import ipaddress
    import re

    network = ipaddress.ip_network("100.64.0.0/10")
    pattern = re.compile(r"(?<![\d.])100\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])")
    tracked = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.split(b"\0")
    found = []
    for raw in tracked:
        path = ROOT / raw.decode()
        if not path.is_file() or path.is_symlink():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue                       # 이진 파일
        for number, line in enumerate(text.splitlines(), 1):
            for match in pattern.finditer(line):
                try:
                    address = ipaddress.ip_address(match.group())
                except ValueError:
                    continue
                if address in network and match.group() not in _CGNAT_EXAMPLES:
                    found.append(f"{raw.decode()}:{number}")     # 값은 찍지 않습니다 — 위치만

    assert found == [], "CGNAT(100.64.0.0/10) 주소는 문서용 예시(100.64.0.1)만 씁니다 — 위치: " + ", ".join(found)
