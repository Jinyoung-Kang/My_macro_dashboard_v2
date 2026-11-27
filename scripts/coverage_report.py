#!/usr/bin/env python3
"""세 묶음(수집기·백엔드·화면)의 커버리지 보고서를 합쳐 '시험 없는 자리' 목록을 냅니다(make coverage).

[왜 필요한가]
시험 수는 많지만 어느 파일의 어느 줄을 시험이 한 번도 지나지 않는지는 알 길이 없었습니다. 이 목록은
문턱값으로 막는 용도가 아니라, 다음에 시험을 어디에 쓸지 고르는 자료입니다(품질 개선 계획 P6-다).

[읽는 것 — scripts/coverage.sh가 만든 파일]
  - 수집기: coverage.py의 JSON 보고서(`coverage json`)
  - 백엔드: JaCoCo의 XML 보고서(backend/target/site/jacoco/jacoco.xml)
  - 화면:   vitest v8 커버리지의 istanbul JSON(coverage-final.json)
없는 보고서는 건너뛰고 '재지 않음'으로 적습니다(없는 숫자를 만들지 않음).

[내는 것]
  - 파일마다 '안 지난 줄 범위'를 안 지난 줄이 많은 순서로. 범위는 사이에 '지난 줄'이 없으면 하나로 묶습니다
    (빈 줄·주석·여러 줄에 걸친 문장 때문에 잘게 쪼개지지 않게).
  - 줄 커버리지가 못 보는 자리(정적 목록): 모듈을 통째로 목으로 바꾼 화면 시험, 자기 시험 파일이 없는 훅.

표준 라이브러리만 씁니다(어느 파이썬 3으로도 돕니다).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class FileCoverage:
    """한 파일의 줄 커버리지. covered·missed는 실행 대상 줄만 담습니다(빈 줄·주석은 어느 쪽에도 없음)."""

    part: str
    path: str
    covered: frozenset[int]
    missed: frozenset[int]

    @property
    def total(self) -> int:
        return len(self.covered) + len(self.missed)


def missed_ranges(covered: frozenset[int] | set[int], missed: frozenset[int] | set[int]) -> list[tuple[int, int]]:
    """안 지난 줄을 범위로 묶습니다. 두 줄 사이에 지난 줄이 하나도 없으면 같은 범위입니다."""
    ranges: list[tuple[int, int]] = []
    hits = sorted(covered)
    index = 0
    for line in sorted(missed):
        while index < len(hits) and hits[index] < line:
            index += 1
        # 직전 범위의 끝과 이 줄 사이에 지난 줄이 있는가 — hits[index - 1]이 그 사이에 있으면 끊습니다.
        if ranges and not (index > 0 and hits[index - 1] > ranges[-1][1]):
            ranges[-1] = (ranges[-1][0], line)
        else:
            ranges.append((line, line))
    return ranges


def _relative(path: str, base: Path) -> str:
    """보고서의 경로를 저장소 최상위 기준으로 바꿉니다(절대 경로·묶음 폴더 기준 상대 경로 모두)."""
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        return candidate.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return candidate.as_posix()


def read_coverage_py(report: Path, base: Path, part: str = "수집기") -> list[FileCoverage]:
    """coverage.py JSON — files[경로].executed_lines / missing_lines."""
    data = json.loads(report.read_text(encoding="utf-8"))
    return [
        FileCoverage(part, _relative(path, base), frozenset(entry.get("executed_lines", [])),
                     frozenset(entry.get("missing_lines", [])))
        for path, entry in data.get("files", {}).items()
    ]


def read_jacoco(report: Path, source_root: str = "backend/src/main/java", part: str = "백엔드") -> list[FileCoverage]:
    """JaCoCo XML — package/sourcefile/line의 mi(안 지난 명령 수)·ci(지난 명령 수). 일부만 지난 줄은 지난 줄로 봅니다."""
    files: list[FileCoverage] = []
    for package in ET.parse(report).getroot().iter("package"):
        for source in package.findall("sourcefile"):
            covered: set[int] = set()
            missed: set[int] = set()
            for line in source.findall("line"):
                number = int(line.get("nr", "0"))
                if int(line.get("ci", "0")) > 0:
                    covered.add(number)
                elif int(line.get("mi", "0")) > 0:
                    missed.add(number)
            files.append(FileCoverage(part, f"{source_root}/{package.get('name')}/{source.get('name')}",
                                      frozenset(covered), frozenset(missed)))
    return files


def read_istanbul(report: Path, base: Path, part: str = "화면") -> list[FileCoverage]:
    """istanbul JSON(coverage-final.json) — 문장마다 시작 줄과 실행 횟수. 한 줄에 문장이 여럿이면 하나라도 지났을 때 지난 줄입니다."""
    data = json.loads(report.read_text(encoding="utf-8"))
    files: list[FileCoverage] = []
    for path, entry in data.items():
        hits: dict[int, int] = {}
        for key, location in entry.get("statementMap", {}).items():
            line = location.get("start", {}).get("line")
            if line is None:
                continue
            hits[line] = max(hits.get(line, 0), entry.get("s", {}).get(key, 0))
        files.append(FileCoverage(part, _relative(entry.get("path", path), base),
                                  frozenset(n for n, count in hits.items() if count > 0),
                                  frozenset(n for n, count in hits.items() if count == 0)))
    return files


# ------------------------------------------------------------------ 정적 목록(줄 커버리지가 못 보는 자리)

_TEST_FILE = re.compile(r"\.test\.tsx?$")
_VI_MOCK = re.compile(r"""vi\.mock\(\s*["']([^"']+)["']""")
_IMPORT_FROM = re.compile(r"""(?:from|import)\s*\(?\s*["']([^"']+)["']""")


def _test_files(src: Path) -> list[Path]:
    return sorted(p for p in src.rglob("*") if p.is_file() and "__tests__" in p.parts and _TEST_FILE.search(p.name))


def whole_module_mocks(src: Path) -> dict[str, list[str]]:
    """프로젝트 모듈(@/… · 상대 경로)을 통째로 목으로 바꾼 시험 파일 — 모듈 이름 → 시험 파일 목록.

    원본을 불러 일부만 바꾸는 목(importOriginal·importActual)은 원본 코드가 실제로 돌므로 뺍니다. 통째로 바꾼
    시험에서는 그 모듈의 줄이 '안 지남'으로 잡히거나(다른 시험도 없을 때) 다른 시험 덕에 '지남'으로 보일 뿐,
    그 화면과 모듈이 맞물리는 자리는 어느 쪽으로도 확인되지 않습니다.
    """
    found: dict[str, list[str]] = {}
    for path in _test_files(src):
        text = path.read_text(encoding="utf-8")
        matches = list(_VI_MOCK.finditer(text))
        for index, match in enumerate(matches):
            module = match.group(1)
            if not module.startswith(("@/", ".")):
                continue
            end = matches[index + 1].start() if index + 1 < len(matches) else min(len(text), match.end() + 600)
            factory = text[match.end():end]
            if "importOriginal" in factory or "importActual" in factory:
                continue
            found.setdefault(module, []).append(path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix())
    return found


def hooks_without_tests(src: Path) -> list[str]:
    """src/hooks의 훅 가운데, src/hooks/__tests__에 제 이름의 시험 파일도 없고 어느 시험 파일도 불러오지 않는 것(파일 이름)."""
    hooks_dir = src / "hooks"
    if not hooks_dir.is_dir():
        return []
    imported: set[str] = set()
    for path in _test_files(hooks_dir):
        imported.add(path.name.split(".", 1)[0])  # useX.test.tsx · useX.retry.test.ts — 그 훅을 쓰는 화면으로 시험하는 파일
        text = path.read_text(encoding="utf-8")
        mocked = {m.group(1) for m in _VI_MOCK.finditer(text)}
        for match in _IMPORT_FROM.finditer(text):
            module = match.group(1)
            if module not in mocked:
                imported.add(module.rsplit("/", 1)[-1])
    return sorted(p.name for p in hooks_dir.iterdir()
                  if p.is_file() and re.fullmatch(r"use\w+\.tsx?", p.name) and p.stem not in imported)


# ------------------------------------------------------------------ 글로 내기

def _format_ranges(ranges: list[tuple[int, int]], limit: int) -> str:
    biggest = sorted(ranges, key=lambda r: (-(r[1] - r[0]), r[0]))
    shown = ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in (biggest if limit <= 0 else biggest[:limit]))
    rest = len(biggest) - limit
    return shown + (f" 외 {rest}곳" if limit > 0 and rest > 0 else "")


def render(files: list[FileCoverage], skipped: list[str], mocks: dict[str, list[str]], orphan_hooks: list[str],
           *, top: int, ranges_per_file: int, header: str = "") -> str:
    """목록 글. top·ranges_per_file이 0 이하면 줄이지 않습니다(파일로 남기는 전체 목록)."""
    out: list[str] = ["# 시험 없는 자리 목록 (make coverage)", ""]
    if header:
        out += [header, ""]
    out += ["문턱값이 아니라 자료입니다. '안 지난 줄'은 시험을 돌리는 동안 한 번도 실행되지 않은 줄이고,",
            "범위는 사이에 지난 줄이 없으면 하나로 묶었습니다(범위 안의 빈 줄·주석 포함).", ""]

    out += ["## 묶음 요약", "", "| 묶음 | 파일 | 실행 대상 줄 | 안 지난 줄 | 지난 비율 |", "|---|---:|---:|---:|---:|"]
    parts: dict[str, list[FileCoverage]] = {}
    for entry in files:
        parts.setdefault(entry.part, []).append(entry)
    for part, entries in parts.items():
        total = sum(e.total for e in entries)
        missed = sum(len(e.missed) for e in entries)
        ratio = f"{(total - missed) / total * 100:.1f}%" if total else "—"
        out.append(f"| {part} | {len(entries)} | {total} | {missed} | {ratio} |")
    for part in skipped:
        out.append(f"| {part} | — | — | — | 재지 않음(보고서 없음) |")
    out.append("")

    ranked = sorted((e for e in files if e.missed), key=lambda e: (-len(e.missed), e.path))
    shown = ranked if top <= 0 else ranked[:top]
    title = "## 안 지난 줄이 많은 파일" + (f" (위 {len(shown)}개 / 전체 {len(ranked)}개)" if len(shown) < len(ranked) else f" ({len(ranked)}개)")
    out += [title, "", "| 묶음 | 파일 | 안 지난 줄 / 실행 대상 줄 | 안 지난 줄 범위(큰 순서) |", "|---|---|---:|---|"]
    for entry in shown:
        ranges = _format_ranges(missed_ranges(entry.covered, entry.missed), ranges_per_file)
        whole = " (한 줄도 안 지남)" if not entry.covered else ""
        out.append(f"| {entry.part} | `{entry.path}`{whole} | {len(entry.missed)} / {entry.total} | {ranges} |")
    out.append("")

    out += ["## 줄 커버리지가 못 보는 자리 (정적 목록)", "",
            "### 모듈을 통째로 목으로 바꾼 화면 시험", "",
            "이 시험들에서는 그 모듈의 진짜 코드가 돌지 않습니다 — 화면과 모듈이 맞물리는 자리는 위 표의 숫자로 확인되지 않습니다.",
            "(원본을 불러 일부만 바꾸는 목은 뺐습니다.)", ""]
    if mocks:
        out += ["| 모듈 | 통째로 목으로 둔 시험 파일 수 |", "|---|---:|"]
        ordered = sorted(mocks.items(), key=lambda item: (-len(item[1]), item[0]))
        out += [f"| `{module}` | {len(paths)} |" for module, paths in ordered]
        if top <= 0:
            for module, paths in ordered:
                out += ["", f"`{module}`을 목으로 둔 시험 파일({len(paths)}개):", ""] + [f"- `{p}`" for p in paths]
    else:
        out.append("없음.")
    out += ["", "### 자기 시험 파일이 없는 훅", "",
            "`frontend/src/hooks`의 훅 가운데 `hooks/__tests__`에 제 이름의 시험 파일이 없고 어느 시험도 불러오지 않는 것입니다(화면 시험이 간접으로 지날 수는 있음 — 위 표 참고).", ""]
    out += [f"- `frontend/src/hooks/{name}`" for name in orphan_hooks] or ["없음."]
    out.append("")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="커버리지 보고서 셋을 합쳐 시험 없는 자리 목록을 냅니다.")
    parser.add_argument("--collector", type=Path, help="coverage.py JSON 보고서")
    parser.add_argument("--backend", type=Path, help="JaCoCo XML 보고서")
    parser.add_argument("--frontend", type=Path, help="istanbul JSON 보고서(coverage-final.json)")
    parser.add_argument("--out", type=Path, help="전체 목록을 적을 파일(줄이지 않음)")
    parser.add_argument("--top", type=int, default=40, help="화면에 보일 파일 수(0이면 전부)")
    parser.add_argument("--ranges", type=int, default=5, help="화면에 보일 파일마다의 범위 수(0이면 전부)")
    parser.add_argument("--header", default="", help="목록 머리에 적을 한 줄(잰 시각·커밋 등)")
    args = parser.parse_args(argv)

    files: list[FileCoverage] = []
    skipped: list[str] = []
    readers = (
        ("수집기", args.collector, lambda p: read_coverage_py(p, ROOT / "collector")),
        ("백엔드", args.backend, read_jacoco),
        ("화면", args.frontend, lambda p: read_istanbul(p, ROOT / "frontend")),
    )
    for part, report, reader in readers:
        if report is None or not report.is_file():
            skipped.append(part)
            continue
        files += reader(report)

    src = ROOT / "frontend" / "src"
    mocks, orphan_hooks = whole_module_mocks(src), hooks_without_tests(src)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(render(files, skipped, mocks, orphan_hooks, top=0, ranges_per_file=0, header=args.header),
                            encoding="utf-8")
    print(render(files, skipped, mocks, orphan_hooks, top=args.top, ranges_per_file=args.ranges, header=args.header))
    if args.out:
        print(f"전체 목록: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
