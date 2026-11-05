"""
tests/test_container_images.py
QA-263: 운영 이미지에 수정판이 이미 나온 HIGH 취약점이 남던 결함(trivy 0.76.0, 2026-11-04).

- 백엔드 실행 이미지(eclipse-temurin:21-jre-alpine): 베이스 이미지가 만들어진 뒤 alpine 저장소에 나온 수정판(libexpat 2.9.0 → 2.10.0)을
  받지 않았습니다. 실행 단계에서 `apk upgrade`로 그 판까지 올립니다.
- 화면 실행 이미지(node:24-alpine): 실행에 쓰지 않는 npm CLI가 들어 있고, 그 안의 undici·brace-expansion에 HIGH가 있었습니다(앱은
  `node …/next start`로 직접 뜨고 헬스체크는 wget — npm을 부르는 곳이 없음). 실행 단계에서 npm·npx를 지웁니다.

이미지를 여기서 빌드하지는 않으므로, 실행 단계(마지막 FROM 뒤)의 비루트 USER 앞에 그 처리가 있는지 봅니다.
수정판이 실제로 들어갔는지는 수정 커밋 때 빌드한 이미지를 trivy로 다시 검사해 결함 기록에 남깁니다.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _runtime_runs(dockerfile: Path) -> str:
    """마지막 FROM(실행 단계)부터 첫 USER 앞까지의 RUN 명령(줄 이음 포함)을 한 덩어리로."""
    text = dockerfile.read_text(encoding="utf-8")
    starts = [m.start() for m in re.finditer(r"(?m)^FROM\s", text)]
    assert starts, f"{dockerfile}: FROM이 없습니다"
    stage = text[starts[-1]:]
    user = re.search(r"(?m)^USER\s", stage)
    assert user, f"{dockerfile}: 실행 단계에 USER가 없습니다(root로 돎)"
    before_user = stage[:user.start()]
    return "\n".join(m.group(0) for m in re.finditer(r"(?ms)^RUN\s.*?(?<!\\)$", before_user))


def test_QA263_백엔드_실행_이미지는_alpine_수정판까지_올린다():
    runs = _runtime_runs(ROOT / "backend" / "Dockerfile")
    assert re.search(r"\bapk\s+upgrade\b", runs), runs


def test_QA263_화면_실행_이미지에는_npm_CLI가_없다():
    runs = _runtime_runs(ROOT / "frontend" / "Dockerfile")
    for path in ("/usr/local/lib/node_modules/npm", "/usr/local/bin/npm", "/usr/local/bin/npx"):
        assert re.search(r"\brm\s+-rf\b[^\n]*" + re.escape(path) + r"(\s|$)", runs.replace("\\\n", " ")), path


def test_화면_실행_이미지는_npm을_부르지_않는다():
    # npm을 지워도 되는 근거 — 실행 명령과 헬스체크가 npm을 거치지 않습니다.
    dockerfile = (ROOT / "frontend" / "Dockerfile").read_text(encoding="utf-8")
    cmd = re.findall(r"(?m)^(?:CMD|ENTRYPOINT)\s.*$", dockerfile)
    assert cmd and not any("npm" in line or "npx" in line for line in cmd), cmd
    for compose in ("docker-compose.yml", "compose.vultr.yml"):
        text = (ROOT / compose).read_text(encoding="utf-8")
        for test in re.findall(r"(?m)^\s*test:\s*(\[.*\])\s*$", text):
            assert "npm" not in test and "npx" not in test, f"{compose}: {test}"
