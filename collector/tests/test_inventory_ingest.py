"""
tests/test_inventory_ingest.py
보안 공지(ADR 0046 결정 1·2) — 버전 목록 받기 ``python -m app.inventory``(표준입력 → 표 셋).

고정하는 규칙
  1. 입력은 탭으로 나눈 줄(머리 inventory·section·component·pending). 통과하면 표 셋을 한 트랜잭션으로 통째로 바꾸고 건수 한 줄만 찍는다(버전 없음).
  2. 하나라도 틀리면 아무것도 쓰지 않는다(앞의 목록 그대로) — 종료 코드 2, 메시지는 줄 번호와 사유만(칸 값 없음).
  3. 보안 여부는 저장소 이름이 '-security'로 끝나는지(ESM의 '-infra-security'·'-apps-security'도). 쉼표로 여럿이면 하나라도.
  4. component는 상태가 ok인 구역에만, pending은 ok인 host 구역이 있을 때만. 호스트 구역 포함이 0이면 host는 ok일 수 없음.
     생태계는 runtime·dpkg·apk·maven·npm·pypi 여섯이고 dpkg·apk는 원본(source 패키지) 칸을 반드시 채운다(판정 갈래와의 이름 약속).
  5. 모듈은 app.store만 가져온다(쓰는 곳 하나 — ADR 0008).
  6. changelog(배포판 패키지 변경 기록의 CVE — ADR 0046 덧붙임 2026-11-21)는 ok인 host 구역이 있을 때만, 번호는 'CVE-연도-숫자 4~7자리'.
     같은 줄은 한 번으로, 넷째 표 env_changelog_cves도 같은 트랜잭션으로 통째로 바꾸고 건수만 찍는다(번호 없음).
  7. os(구역의 /etc/os-release — ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기')는 ok인 구역에만 구역당 한 줄, 세 칸은 소문자·숫자·.·_·-의
     32자 이하(ID는 반드시, 나머지는 '-'이면 null). 표를 바꾸지 않고 env_inventory.sections의 그 구역 객체에 "os"로 두고, 건수만 찍는다(값 없음).

값은 모두 가짜입니다(공개 저장소 — 서버의 실제 버전은 운영 DB에만).
"""
from __future__ import annotations

import ast
import io
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app import inventory

COLLECTOR = Path(__file__).resolve().parents[1]

GOOD = "\n".join([
    "inventory\t1\t2026-11-21T07:20:00Z\t1\t2026-11-20T03:26:44+00:00",
    "section\thost\tok\t-",
    "section\tpostgres\tok\t-",
    "section\tbackend\tfailed\tcontainer not running",
    "section\tbrowser\tskipped\t-",
    "component\thost\tdpkg\tfake-ssl-lib\t9.9.9-0fake1\tfake-ssl",
    "component\thost\tdpkg\tfake-ssl-lib\t9.9.9-0fake1\tfake-ssl",                    # 같은 줄(다중 아키텍처) — 한 번으로
    "component\thost\truntime\tkernel\t0.0.1-1-fake\t-",
    "component\thost\truntime\tdocker\t1.2.3\t-",
    "component\tpostgres\truntime\tpostgres\t99.1\t-",
    "component\tpostgres\tapk\tfake-musl\t1.0.0-r0\tfake-musl",
    "pending\tfake-ssl-lib\tamd64\t9.9.9-0fake1\t9.9.9-0fake2\tfakecode-updates,fakecode-security",
    "pending\tfake-engine-cli\tamd64\t1.2.3\t1.2.4\tfakecode",
    "pending\tfake-esm-lib\t-\t1.0\t1.0+esm1\tfakecode-infra-security",
    "",
])


def _run(text: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = inventory.main(io.StringIO(text), out, err)
    return code, out.getvalue(), err.getvalue()


def test_받으면_표_셋을_바꾸고_건수_한_줄만_찍는다(store):
    code, out, err = _run(GOOD)

    assert code == 0 and err == ""
    assert out.strip() == ("버전 목록 받음 — 구역 4(ok 2·failed 1·skipped 1) · 구성 요소 5 · 보류 3(보안 2) · 실패 구역 backend")
    assert "9.9.9" not in out and "99.1" not in out, "버전은 찍지 않음"
    saved = store.env_inventory()
    head = saved["inventory"]
    assert head["collected_at"] == datetime(2026, 11, 21, 7, 20, tzinfo=timezone.utc) and head["host_included"] is True
    assert head["apt_lists_at"] == datetime(2026, 11, 20, 3, 26, 44, tzinfo=timezone.utc)
    assert head["sections"] == {"host": {"status": "ok", "count": 3, "pending": 3}, "postgres": {"status": "ok", "count": 2},
                                "backend": {"status": "failed", "reason": "container not running"}, "browser": {"status": "skipped"}}
    assert saved["components"] == [
        {"source": "host", "ecosystem": "dpkg", "name": "fake-ssl-lib", "version": "9.9.9-0fake1", "source_package": "fake-ssl"},
        {"source": "host", "ecosystem": "runtime", "name": "docker", "version": "1.2.3", "source_package": None},
        {"source": "host", "ecosystem": "runtime", "name": "kernel", "version": "0.0.1-1-fake", "source_package": None},
        {"source": "postgres", "ecosystem": "apk", "name": "fake-musl", "version": "1.0.0-r0", "source_package": "fake-musl"},
        {"source": "postgres", "ecosystem": "runtime", "name": "postgres", "version": "99.1", "source_package": None},
    ]
    assert saved["pending"] == [
        {"package": "fake-engine-cli", "arch": "amd64", "installed": "1.2.3", "candidate": "1.2.4", "repos": "fakecode", "security": False},
        {"package": "fake-esm-lib", "arch": "", "installed": "1.0", "candidate": "1.0+esm1", "repos": "fakecode-infra-security",
         "security": True},
        {"package": "fake-ssl-lib", "arch": "amd64", "installed": "9.9.9-0fake1", "candidate": "9.9.9-0fake2",
         "repos": "fakecode-updates,fakecode-security", "security": True},
    ]


def test_변경_기록_CVE를_받아_넷째_표에_두고_건수만_찍는다(store):
    text = GOOD + "\n".join([
        "changelog\tfake-ssl\t9.9.9-0fake1\tCVE-2099-0001",
        "changelog\tfake-ssl\t9.9.9-0fake1\tCVE-2099-0001",                         # 같은 줄 — 한 번으로
        "changelog\tfake-ssl\t9.9.9-0fake1\tCVE-2099-1234567",
        "changelog\tkernel\t0.0.1-1-fake\tCVE-2099-7777",
        "",
    ])

    code, out, err = _run(text)

    assert code == 0 and err == ""
    assert out.strip().endswith(" · 변경 기록 CVE 3 · 실패 구역 backend")
    assert "CVE-2099" not in out, "번호는 찍지 않음"
    saved = store.env_inventory()
    assert saved["changelog"] == [
        {"package": "fake-ssl", "version": "9.9.9-0fake1", "cve": "CVE-2099-0001"},
        {"package": "fake-ssl", "version": "9.9.9-0fake1", "cve": "CVE-2099-1234567"},
        {"package": "kernel", "version": "0.0.1-1-fake", "cve": "CVE-2099-7777"},
    ]
    assert saved["inventory"]["sections"]["host"] == {"status": "ok", "count": 3, "pending": 3, "changelog": 3}

    assert _run(GOOD)[0] == 0
    assert store.env_inventory()["changelog"] == [], "다시 받으면 변경 기록도 통째로 바뀜(없으면 빈 표)"


def test_구역의_os_줄을_그_구역_객체에_두고_건수만_찍는다(store):
    text = GOOD + "\n".join([
        "os\thost\tubuntu\t99.04\tfakecode",
        "os\tpostgres\talpine\t9.99.9\t-",
        "",
    ])

    code, out, err = _run(text)

    assert code == 0 and err == ""
    assert out.strip().endswith(" · 보류 3(보안 2) · OS 2구역 · 실패 구역 backend")
    assert "99.04" not in out and "9.99.9" not in out and "fakecode" not in out, "값은 찍지 않음"
    sections = store.env_inventory()["inventory"]["sections"]
    assert sections["host"] == {"status": "ok", "count": 3, "pending": 3,
                                "os": {"id": "ubuntu", "versionId": "99.04", "codename": "fakecode"}}
    assert sections["postgres"] == {"status": "ok", "count": 2, "os": {"id": "alpine", "versionId": "9.99.9", "codename": None}}
    assert "os" not in sections["backend"] and "os" not in sections["browser"]
    assert len(store.env_inventory()["components"]) == 5, "os 줄은 구성 요소가 아님"

    assert _run(GOOD)[0] == 0
    assert "os" not in store.env_inventory()["inventory"]["sections"]["host"], "다시 받으면 통째로 바뀜(os 줄이 없으면 없음)"


def test_다시_받으면_앞의_목록을_통째로_바꾼다(store):
    assert _run(GOOD)[0] == 0
    smaller = "\n".join([
        "inventory\t1\t2026-11-22T07:20:00+00:00\t0\t-",
        "section\tpostgres\tok\t-",
        "component\tpostgres\truntime\tpostgres\t99.2\t-",
    ])

    assert _run(smaller)[0] == 0

    saved = store.env_inventory()
    assert saved["inventory"]["host_included"] is False and saved["inventory"]["apt_lists_at"] is None
    assert saved["inventory"]["sections"] == {"postgres": {"status": "ok", "count": 1}}
    assert [c["version"] for c in saved["components"]] == ["99.2"] and saved["pending"] == []


@pytest.mark.parametrize("text, why", [
    ("", "머리(inventory) 줄이 없음"),
    ("section\thost\tok\t-\n", "첫 줄이 머리"),
    ("inventory\t2\t2026-11-21T00:00:00Z\t1\t-\n", "모르는 형식 판"),
    ("inventory\t1\t2026-11-21T00:00:00\t1\t-\n", "시간대가 없음"),
    ("inventory\t1\t어제\t1\t-\n", "ISO 8601"),
    ("inventory\t1\t2026-11-21T00:00:00Z\t2\t-\n", "0·1"),
    ("inventory\t1\t2026-11-21T00:00:00Z\t1\n", "머리 칸이 4개"),
    (GOOD + "inventory\t1\t2026-11-21T00:00:00Z\t1\t-\n", "머리가 두 번"),
    (GOOD + "section\thost\tok\t-\n", "같은 구역이 두 번"),
    (GOOD + "section\tHost\tok\t-\n", "구역 이름 모양"),
    (GOOD + "section\tcaddy\tdone\t-\n", "구역 상태"),
    (GOOD + "component\tbackend\tmaven\tfake-lib\t1.0\t-\n", "ok인 section 줄에 없음"),
    (GOOD + "component\tnowhere\tmaven\tfake-lib\t1.0\t-\n", "ok인 section 줄에 없음"),
    (GOOD + "component\thost\tcargo\tfake-lib\t1.0\t-\n", "모르는 생태계"),
    (GOOD + "component\thost\tdpkg\t-\t1.0\tx\n", "이름 칸이 비어 있음"),
    (GOOD + "component\thost\tdpkg\tfake-lib\t1.0\t-\n", "원본 칸이 비어 있음"),
    (GOOD + "component\tpostgres\tapk\tfake-lib\t1.0-r0\t-\n", "원본 칸이 비어 있음"),
    (GOOD + "component\thost\tdeb\tfake-lib\t1.0\tx\n", "모르는 생태계"),
    (GOOD + "component\thost\tdpkg\tfake-lib\t \tx\n", "버전 칸이 비어 있음"),
    (GOOD + "component\thost\tdpkg\tfake-lib\t" + "9" * 301 + "\tx\n", "300자"),
    (GOOD + "component\thost\tdpkg\tfake-lib\t1.0\n", "component 칸이 5개"),
    (GOOD + "pending\tfake-ssl-lib\tamd64\t1\t2\tfakecode\n", "같은 보류 패키지"),
    (GOOD + "pending\tfake-x\tamd64\t1\t2\t-\n", "저장소 칸이 비어 있음"),
    (GOOD + "note\thello\n", "모르는 줄 종류"),
    (GOOD + "component\thost\tdpkg\tfake\x1b[31m\t1.0\tx\n", "제어 문자"),
    ("\n".join(line for line in GOOD.split("\n") if not line.startswith("component\thost")).replace("section\thost\tok\t-", "section\thost\tfailed\t-"),
     "ok인 host 구역이 없음"),
    (GOOD.replace("Z\t1\t", "Z\t0\t"), "호스트 구역 포함이 0인데 host"),
    (GOOD + "changelog\tfake-ssl\t9.9.9-0fake1\tCVE-2099-123\n", "CVE 번호 모양"),
    (GOOD + "changelog\tfake-ssl\t9.9.9-0fake1\tcve-2099-0001\n", "CVE 번호 모양"),
    (GOOD + "changelog\tfake-ssl\t9.9.9-0fake1\tCVE-2099-12345678\n", "CVE 번호 모양"),
    (GOOD + "changelog\t-\t9.9.9-0fake1\tCVE-2099-0001\n", "패키지 칸이 비어 있음"),
    (GOOD + "changelog\tfake-ssl\tCVE-2099-0001\n", "changelog 칸이 3개"),
    ("\n".join(line for line in GOOD.split("\n") if not line.startswith(("component\thost", "pending")))
     .replace("section\thost\tok\t-", "section\thost\tfailed\t-") + "\nchangelog\tfake-ssl\t9.9.9-0fake1\tCVE-2099-0001\n",
     "changelog 줄이 있는데 ok인 host 구역이 없음"),
    (GOOD + "os\thost\tubuntu\t99.04\n", "os 칸이 4개"),
    (GOOD + "os\thost\tUbuntu\t99.04\tfakecode\n", "os의 ID 모양"),
    (GOOD + "os\thost\t-\t99.04\tfakecode\n", "os의 ID 모양"),
    (GOOD + "os\thost\tubuntu\t99 04\tfakecode\n", "os의 VERSION_ID 모양"),
    (GOOD + "os\thost\tubuntu\t.99\tfakecode\n", "os의 VERSION_ID 모양"),
    (GOOD + "os\thost\tubuntu\t" + "9" * 33 + "\tfakecode\n", "os의 VERSION_ID 모양"),
    (GOOD + "os\thost\tubuntu\t99.04\tFake/Code\n", "os의 VERSION_CODENAME 모양"),
    (GOOD + "os\tbackend\tdebian\t99\tfakedeb\n", "os의 구역이 ok인 section 줄에 없음"),
    (GOOD + "os\tbrowser\tdebian\t99\tfakedeb\n", "os의 구역이 ok인 section 줄에 없음"),
    (GOOD + "os\tnowhere\tdebian\t99\tfakedeb\n", "os의 구역이 ok인 section 줄에 없음"),
    (GOOD + "os\thost\tubuntu\t99.04\tfakecode\nos\thost\tubuntu\t99.04\tfakecode\n", "같은 구역의 os 줄이 두 번"),
])
def test_하나라도_틀리면_아무것도_쓰지_않는다(store, text, why):
    assert _run(GOOD)[0] == 0
    before = store.env_inventory()

    code, out, err = _run(text)

    assert code == inventory.EXIT_INVALID and out == ""
    assert why in err and err.startswith("버전 목록을 받지 않음(아무것도 쓰지 않음)")
    assert "fake-lib" not in err and "9.9.9" not in err and "99.04" not in err and "fakecode" not in err, "칸 값을 싣지 않음"
    assert store.env_inventory() == before


def test_줄이_너무_많으면_받지_않는다(monkeypatch):
    monkeypatch.setattr(inventory, "MAX_LINES", 3)
    with pytest.raises(inventory.InvalidInventory, match="줄이 3개를 넘음"):
        inventory.parse(GOOD)


def test_저장에_실패하면_종료_코드_1이고_건수를_찍지_않는다(monkeypatch):
    def broken(doc):
        raise RuntimeError("db down — secret-ish detail")

    monkeypatch.setattr(inventory.store, "replace_env_inventory", broken)
    monkeypatch.setattr(inventory.store, "close_pool", lambda: None)

    code, out, err = _run(GOOD)

    assert code == inventory.EXIT_STORE and out == "" and err.strip() == "버전 목록을 저장하지 못함 — RuntimeError"


@pytest.mark.parametrize("repos, expected", [
    ("noble-security", True), ("noble-infra-security", True), ("noble-apps-security", True),
    ("noble-updates,noble-security", True), ("noble", False), ("noble-updates", False), ("security-noble", False), ("", False),
])
def test_보안_여부는_저장소_이름이_security로_끝나는지(repos, expected):
    assert inventory.is_security(repos) is expected


def test_python_m_app_inventory로_표준입력을_받는다(store):
    """배포·cron이 쓰는 길 그대로 — 새 프로세스가 같은 시험 스키마(DATABASE_URL)에 씁니다."""
    result = subprocess.run([sys.executable, "-m", "app.inventory"], input=GOOD, capture_output=True, text=True, cwd=COLLECTOR,
                            env={**os.environ}, timeout=60, check=False)

    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("버전 목록 받음 — 구역 4") and "9.9.9" not in result.stdout + result.stderr
    assert store.env_inventory()["inventory"]["host_included"] is True


def test_모듈은_app_store만_가져온다():
    tree = ast.parse((COLLECTOR / "app" / "inventory.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.update(f"{node.module}.{alias.name}" if node.module == "app" else node.module for alias in node.names)
    assert {name for name in imported if name.startswith("app")} == {"app.store"}
    assert imported - {"app.store"} <= {"__future__", "re", "sys", "dataclasses", "datetime"}
