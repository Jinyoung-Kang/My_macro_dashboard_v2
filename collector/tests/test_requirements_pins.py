"""고정판 파일 둘(constraints.txt · sidecar/pinned.txt)에 함께 있는 패키지는 같은 판이어야 한다(QA-1005).

CI의 pip-audit는 두 파일을 한 번에 받는다. 같은 패키지가 서로 다른 판으로 적혀 있으면 감사가 오류로 끝나
아무것도 검사하지 않는데, 그 단계는 실패해도 빌드를 막지 않아 눈에 띄지 않는다.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIN = re.compile(r"^([A-Za-z0-9_.\-]+)==(\S+)$")


def pins(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        match = PIN.match(line)
        if match:
            found[re.sub(r"[-_.]+", "-", match.group(1)).lower()] = match.group(2)
    return found


def mismatches(left: str, right: str) -> dict[str, tuple[str, str]]:
    a, b = pins(left), pins(right)
    return {name: (a[name], b[name]) for name in sorted(a.keys() & b.keys()) if a[name] != b[name]}


def test_두_고정판_파일에_함께_있는_패키지는_같은_판이다():
    constraints = (ROOT / "constraints.txt").read_text(encoding="utf-8")
    pinned = (ROOT / "sidecar" / "pinned.txt").read_text(encoding="utf-8")
    assert pins(constraints) and pins(pinned)
    assert pins(constraints).keys() & pins(pinned).keys(), "겹치는 패키지가 없으면 이 대조는 아무것도 보지 않는다"
    assert mismatches(constraints, pinned) == {}


def test_한쪽_판만_다르면_어긋남으로_잡는다():
    assert mismatches("Some_Pkg==1.0.0\nother==2.0\n", "some-pkg==1.0.1  # 주석\nthird==3\n") == {
        "some-pkg": ("1.0.0", "1.0.1")
    }
