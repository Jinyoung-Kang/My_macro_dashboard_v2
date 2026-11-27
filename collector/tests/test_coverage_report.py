"""
tests/test_coverage_report.py
시험 없는 자리 목록(make coverage — scripts/coverage.sh · scripts/coverage_report.py).

고정하는 것
  - 안 지난 줄은 사이에 지난 줄이 없을 때만 한 범위로 묶인다
  - 세 보고서 형식(coverage.py JSON · JaCoCo XML · istanbul JSON)을 같은 뜻으로 읽는다
  - 보고서가 없는 묶음은 0이 아니라 '재지 않음'으로 적는다
  - 정적 목록: 통째로 바꾼 목만 세고(원본을 불러 일부만 바꾸는 목 제외), 시험 파일이 없는 훅만 낸다
  - 스크립트는 운영 DB 주소로는 시작하지 않고, 주소를 화면에 찍지 않는다
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "coverage.sh"

_spec = importlib.util.spec_from_file_location("coverage_report", ROOT / "scripts" / "coverage_report.py")
report = importlib.util.module_from_spec(_spec)
import sys  # noqa: E402

sys.modules["coverage_report"] = report  # dataclass가 모듈을 이름으로 찾습니다
_spec.loader.exec_module(report)


def test_사이에_지난_줄이_없으면_한_범위로_묶는다():
    # 10·11과 14 사이(12·13)는 빈 줄·주석이라 어느 쪽에도 없다 → 한 범위. 15가 지났으므로 20은 다른 범위.
    assert report.missed_ranges({1, 15, 30}, {10, 11, 14, 20}) == [(10, 14), (20, 20)]


def test_지난_줄이_없으면_전체가_한_범위다():
    assert report.missed_ranges(set(), {3, 9, 40}) == [(3, 40)]
    assert report.missed_ranges({1, 2}, set()) == []


def test_coverage_py_보고서를_읽는다(tmp_path):
    path = tmp_path / "coverage.json"
    path.write_text(json.dumps({"files": {"app/x.py": {"executed_lines": [1, 2], "missing_lines": [5, 6]}}}), encoding="utf-8")
    [entry] = report.read_coverage_py(path, ROOT / "collector")
    assert (entry.part, entry.path, entry.covered, entry.missed) == ("수집기", "collector/app/x.py", {1, 2}, {5, 6})
    assert entry.total == 4


def test_jacoco_보고서를_읽는다_일부만_지난_줄은_지난_줄이다(tmp_path):
    path = tmp_path / "jacoco.xml"
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?><report name="b"><package name="com/x/store">'
        '<class name="com/x/store/A" sourcefilename="A.java"/>'
        '<sourcefile name="A.java"><line nr="3" mi="0" ci="4" mb="0" cb="0"/><line nr="4" mi="2" ci="1" mb="1" cb="1"/>'
        '<line nr="7" mi="5" ci="0" mb="0" cb="0"/><counter type="LINE" missed="1" covered="2"/></sourcefile>'
        "</package></report>",
        encoding="utf-8",
    )
    [entry] = report.read_jacoco(path)
    assert entry.path == "backend/src/main/java/com/x/store/A.java"
    assert (entry.covered, entry.missed) == ({3, 4}, {7})


def test_istanbul_보고서를_읽는다_한_줄의_문장_가운데_하나라도_지나면_지난_줄이다(tmp_path):
    path = tmp_path / "coverage-final.json"
    source = str(ROOT / "frontend" / "src" / "lib" / "x.ts")
    path.write_text(json.dumps({source: {
        "path": source,
        "statementMap": {"0": {"start": {"line": 2}, "end": {"line": 2}}, "1": {"start": {"line": 2}, "end": {"line": 2}},
                         "2": {"start": {"line": 8}, "end": {"line": 12}}},
        "s": {"0": 0, "1": 3, "2": 0},
    }}), encoding="utf-8")
    [entry] = report.read_istanbul(path, ROOT / "frontend")
    assert (entry.path, entry.covered, entry.missed) == ("frontend/src/lib/x.ts", {2}, {8})


def test_보고서가_없는_묶음은_재지_않음으로_적는다():
    files = [report.FileCoverage("화면", "frontend/src/a.ts", frozenset({1}), frozenset({2, 3})),
             report.FileCoverage("화면", "frontend/src/b.ts", frozenset(), frozenset({1}))]
    text = report.render(files, ["백엔드"], {}, [], top=1, ranges_per_file=5)
    assert "| 화면 | 2 | 4 | 3 | 25.0% |" in text
    assert "| 백엔드 | — | — | — | 재지 않음(보고서 없음) |" in text
    assert "(위 1개 / 전체 2개)" in text and "`frontend/src/a.ts` | 2 / 3 | 2-3 |" in text
    assert "frontend/src/b.ts" not in text  # top=1
    assert "한 줄도 안 지남" in report.render(files, [], {}, [], top=0, ranges_per_file=0)


def test_정적_목록은_통째로_바꾼_목과_시험_없는_훅만_낸다(tmp_path):
    src = tmp_path / "src"
    (src / "hooks" / "__tests__").mkdir(parents=True)
    (src / "screens" / "__tests__").mkdir(parents=True)
    for name in ("useA.ts", "useB.ts", "useC.tsx", "useD.ts", "helper.ts"):
        (src / "hooks" / name).write_text("export {};\n", encoding="utf-8")
    (src / "hooks" / "__tests__" / "useA.test.ts").write_text('import { useA } from "../useA";\n', encoding="utf-8")
    # useB는 목으로만 나온다(시험한 것이 아님), useD는 제 이름의 시험 파일이 있다(훅을 쓰는 화면으로 시험).
    (src / "hooks" / "__tests__" / "useD.test.tsx").write_text(
        'vi.mock("@/hooks/useB", () => ({ useB: vi.fn() }));\nimport { Screen } from "@/screens/Screen";\n', encoding="utf-8")
    (src / "screens" / "__tests__" / "S.test.tsx").write_text(
        'vi.mock("@/lib/api", () => api);\n'
        'vi.mock("@/lib/taskRun", async (importOriginal) => ({ ...(await importOriginal()), run: vi.fn() }));\n'
        'vi.mock("next/navigation", () => ({ useRouter: () => router }));\n',
        encoding="utf-8",
    )
    mocks = report.whole_module_mocks(src)
    assert set(mocks) == {"@/lib/api", "@/hooks/useB"}
    assert [Path(p).name for p in mocks["@/lib/api"]] == ["S.test.tsx"]
    assert report.hooks_without_tests(src) == ["useB.ts", "useC.tsx"]


def _run(*args: str, **env: str) -> subprocess.CompletedProcess:
    base = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}
    return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env={**base, **env}, timeout=60)


def test_운영_DB_주소로는_시작하지_않고_주소를_찍지_않는다():
    password = "do-not-" + "print"
    for part, name in (("collector", "COLLECTOR_TEST_DATABASE_URL"), ("backend", "BACKEND_TEST_DATABASE_URL")):
        result = _run(part, **{name: f"postgresql://macro:{password}@localhost:1/macrodash"})
        assert result.returncode == 2, result.stderr
        assert "_test로 끝나지 않습니다" in result.stderr
        assert password not in result.stdout + result.stderr
        assert _run(part).returncode == 2  # 주소가 비어도 시작하지 않는다


def test_모르는_묶음_이름은_거부한다():
    result = _run("everything")
    assert result.returncode == 2 and "모르는 묶음" in result.stderr
