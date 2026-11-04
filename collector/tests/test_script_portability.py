"""
tests/test_script_portability.py
QA-250: 저장소 스크립트의 `mktemp -t 이름`이 GNU mktemp(Linux — 지금 작업 PC WSL2·CI·Vultr 서버)에서 실패하던 결함.

`mktemp -t 이름`은 BSD(맥) 문법이라 GNU에서는 'too few X's in template'로 끝나, QA 스택 도우미(`qa-stack.sh api`)·Lighthouse·
의존성 공시·API 측정 스크립트가 시작하자마자 멈췄습니다. 스크립트 안의 `mktemp` 호출을 그대로 이 OS에서 실행해 봅니다.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# `$(mktemp …)`의 인자 — 따옴표 안의 변수까지 그대로 셸에 넘깁니다.
_CALL = re.compile(r"\$\(\s*mktemp((?:\s+[^)]*)?)\)")


def _calls() -> list[tuple[str, str]]:
    out = []
    for path in sorted([*ROOT.glob("scripts/**/*.sh"), ROOT / "Makefile"]):
        for line in path.read_text(encoding="utf-8").splitlines():
            for m in _CALL.finditer(line):
                out.append((str(path.relative_to(ROOT)), m.group(1).strip()))
    return out


def test_mktemp_호출을_찾는다():
    # 아래 검사가 빈 목록으로 통과해 버리지 않게 합니다.
    assert any(path == "scripts/qa/qa-stack.sh" for path, _ in _calls())


@pytest.mark.xfail(strict=True, reason="QA-250 재현 — 수정 전: mktemp -t 이름(BSD 문법)이 GNU mktemp에서 실패")
def test_QA250_스크립트의_mktemp는_이_OS에서_임시_파일을_만든다(tmp_path):
    failed = []
    for path, args in _calls():
        r = subprocess.run(["bash", "-c", f"mktemp {args}"], capture_output=True, text=True,
                           env={"TMPDIR": str(tmp_path), "PATH": "/usr/bin:/bin"})
        if r.returncode != 0:
            failed.append(f"{path}: mktemp {args} — {r.stderr.strip()}")
    assert failed == []
