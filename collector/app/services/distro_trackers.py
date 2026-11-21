"""
app/services/distro_trackers.py
보안 공지(ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기') — 배포판 보안 추적기의 응답 읽기. 네트워크와 DB를 모릅니다(받기·저장은
tasks/security.py, 물을 것은 백엔드가 표 ``security_tracker_wants``에 둠).

배포판 패키지는 옛 버전 번호에 보안 패치만 넣으므로(공지의 상류 버전 표로는 판정할 수 없음) '그 배포판·스위트·원본 패키지에서 이 CVE를 고친 판'을
배포판 자신의 추적기에서 읽습니다. 결과는 넷 — ``fixed``(고친 판이 있음, 판 필수)·``not_affected``(영향 없음·그 스위트에 패키지 없음)·
``open``(아직 고치지 않음)·``unknown``(추적기에 그 패키지·스위트의 기록이 없음). ``detail``은 추적기의 원래 상태 글(표시용, 100자까지).

[Ubuntu] ``https://ubuntu.com/security/cves/<CVE>.json`` — ``packages[].name``이 원본 패키지인 항목의 ``statuses[]``에서 ``release_codename``이 스위트인 것.
  released → fixed(판 = description) · not-affected·DNE → not_affected · needed·pending·deferred·needs-triage·ignored → open ·
  그 패키지·스위트가 없음 → unknown. (HTTP 404 → unknown은 태스크가 정함.)
[Debian] ``https://security-tracker.debian.org/tracker/<CVE>`` HTML — 고친 판 표(Package·Type·Release·Fixed Version·…)에서 Package·Release가 맞는 줄:
  판 → fixed · ``(not affected)`` → not_affected · ``(unfixed)`` → open. 그 릴리스 전용 줄이 없으면 Debian 추적기의 규칙대로 같은 패키지의
  ``(unstable)`` 줄이 그 릴리스에도 적용됩니다 — 판 V면 원본 패키지 표(Source Package·Release·Version·Status — 원본 칸이 여러 줄을 묶고, Release 칸은
  ``trixie (security), trixie``처럼 쉼표로 여럿)의 그 원본 ``스위트``·``스위트 (security)`` 줄 가운데 fixed가 하나라도 있으면 fixed(판 = V),
  모두 vulnerable이면 open, 그 밖(undetermined·줄 없음)은 unknown · ``(not affected)`` → not_affected · ``(unfixed)`` → open.
  고친 판 표에 그 패키지 줄이 하나도 없으면 원본 패키지 표만으로 판을 정하지 않습니다(그 표의 판은 '그 스위트에 지금 있는 판'이라 고친 판의
  하한이 아님 — 옛 이미지를 '뒤처짐'으로 잘못 알리지 않게): fixed여도 unknown, 모두 vulnerable이면 open, ``not affected``면 not_affected.
  원본이 표에 없음(또는 CVE에 패키지 기록이 아예 없음) → unknown. 표 틀이 다르면 ShapeError.
[Alpine] ``https://secdb.alpinelinux.org/<스위트>/main.json``·``community.json`` — ``packages[].pkg.name``이 원본 패키지(apk ``o:``)인 항목의
  ``secfixes``(판 → CVE 목록)에서 CVE를 찾음(항목은 ``CVE-… 다른 번호`` 꼴일 수 있어 첫 낱말로 봄). 키가 ``0``이면 not_affected, 그 밖의 키는
  fixed(판 = 키, 여럿이면 문서 순서의 처음). 패키지가 없거나 패키지에 그 CVE가 없으면 unknown(main·community 둘 다 본 뒤 — 태스크).

틀이 다르면 ``info_text.ShapeError``(메시지에 버전 값을 싣지 않음) — 태스크가 행을 쓰지 않고 실행 메시지에 건수만 남깁니다. 판 칸은
배포판 판 글자(영숫자·``.+~:_-``, 200자 이하)만 받습니다 — 아니면 그 조회만 ShapeError.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from bs4 import BeautifulSoup

from .info_text import ShapeError

DISTROS = ("ubuntu", "debian", "alpine")
STATUSES = ("fixed", "not_affected", "open", "unknown")
ALPINE_REPOS = ("main", "community")
MAX_DETAIL_CHARS = 100

_CVE = re.compile(r"^CVE-\d{4}-\d{4,7}$")
_VERSION = re.compile(r"^[A-Za-z0-9.+~:_-]{1,200}$")
_SPACES = re.compile(r"\s+")

# Ubuntu CVE 추적기의 상태 글 → 결과(그 밖의 글은 그 조회만 ShapeError).
UBUNTU_STATUS = {
    "released": "fixed",
    "not-affected": "not_affected", "DNE": "not_affected",
    "needed": "open", "pending": "open", "deferred": "open", "needs-triage": "open", "ignored": "open",
}
# Debian 원본 패키지 표의 상태 글(tracker_service.py가 쓰는 셋 + 'not affected').
_DEBIAN_SOURCE_STATUS = ("fixed", "vulnerable", "undetermined", "not affected")
_DEBIAN_SOURCE_HEADER = ["Source Package", "Release", "Version", "Status"]
_DEBIAN_FIXED_HEADER = ["Package", "Type", "Release", "Fixed Version"]
_DEBIAN_SECTION = "Vulnerable and fixed packages"


@dataclass(frozen=True)
class Status:
    """조회 결과 한 건 — distro_cve_status 한 행의 status·fixed_version·detail."""

    status: str
    fixed_version: str | None
    detail: str


def ubuntu_url(cve: str) -> str:
    return f"https://ubuntu.com/security/cves/{_checked_cve(cve)}.json"


def debian_url(cve: str) -> str:
    return f"https://security-tracker.debian.org/tracker/{_checked_cve(cve)}"


def alpine_url(suite: str, repo: str) -> str:
    if repo not in ALPINE_REPOS or not re.match(r"^v\d+\.\d+$", suite):
        raise ValueError("Alpine secdb 주소의 스위트·저장소 모양이 다름")
    return f"https://secdb.alpinelinux.org/{suite}/{repo}.json"


def _checked_cve(cve: str) -> str:
    if not _CVE.match(cve):
        raise ValueError("CVE 번호 모양이 다름")
    return cve


def _detail(text: str) -> str:
    return _SPACES.sub(" ", text).strip()[:MAX_DETAIL_CHARS]


def _fixed(version: str, detail: str, where: str) -> Status:
    version = (version or "").strip()
    if not _VERSION.match(version):
        raise ShapeError(f"{where}의 고친 판 칸 모양이 다름")
    return Status("fixed", version, _detail(detail))


# ==============================================================================
# Ubuntu
# ==============================================================================
def parse_ubuntu(body: bytes | str, cve: str) -> dict[tuple[str, str], tuple[str, str]]:
    """
    Ubuntu CVE JSON → {(원본 패키지, 스위트): (상태 글, description)}.

    :raises ShapeError: JSON이 아니거나 ``id``가 다르거나 ``packages``·``statuses`` 틀이 다름
    """
    try:
        doc = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise ShapeError("Ubuntu 응답이 JSON이 아님") from None
    if not isinstance(doc, dict) or str(doc.get("id", "")).upper() != cve.upper():
        raise ShapeError("Ubuntu 응답의 id가 묻는 CVE가 아님")
    packages = doc.get("packages")
    if not isinstance(packages, list):
        raise ShapeError("Ubuntu 응답에 packages 목록이 없음")
    index: dict[tuple[str, str], tuple[str, str]] = {}
    for package in packages:
        if not isinstance(package, dict) or not isinstance(package.get("name"), str) or not isinstance(package.get("statuses"), list):
            raise ShapeError("Ubuntu 응답의 packages 항목 틀이 다름")
        for entry in package["statuses"]:
            if (not isinstance(entry, dict) or not isinstance(entry.get("release_codename"), str)
                    or not isinstance(entry.get("status"), str) or not isinstance(entry.get("description") or "", str)):
                raise ShapeError("Ubuntu 응답의 statuses 항목 틀이 다름")
            index.setdefault((package["name"], entry["release_codename"]), (entry["status"], entry.get("description") or ""))
    return index


def ubuntu_status(index: dict[tuple[str, str], tuple[str, str]], package: str, suite: str) -> Status:
    """
    한 원본 패키지·스위트의 결과(모듈 설명 [Ubuntu]).

    :raises ShapeError: 모르는 상태 글이거나 released인데 판 칸 모양이 다름(그 조회만)
    """
    found = index.get((package, suite))
    if found is None:
        return Status("unknown", None, "no entry")
    word, description = found
    kind = UBUNTU_STATUS.get(word)
    if kind is None:
        raise ShapeError("Ubuntu 응답에 모르는 상태 글이 있음")
    detail = word if not description or kind == "fixed" else f"{word} ({description})"
    if kind == "fixed":
        return _fixed(description, word, "Ubuntu 응답")
    return Status(kind, None, _detail(detail))


# ==============================================================================
# Debian
# ==============================================================================
@dataclass(frozen=True)
class DebianRecord:
    # 원본 패키지 → [(Release 하나, Version, Status)]  (Release 칸의 쉼표 목록을 줄마다 폄)
    sources: dict[str, list[tuple[str, str, str]]]
    # [(Package, Release, Fixed Version)]
    fixed: list[tuple[str, str, str]]


def _cells(row) -> list[str]:
    return [_SPACES.sub(" ", cell.get_text(" ", strip=True)).strip() for cell in row.find_all(["td", "th"], recursive=False)]


def parse_debian(body: bytes | str, cve: str) -> DebianRecord:
    """
    Debian 보안 추적기의 CVE 쪽 HTML → 원본 패키지 표와 고친 판 표.

    :raises ShapeError: 머리(CVE 이름)가 다르거나, '취약·고친 패키지' 절이 있는데 두 표의 틀이 다름
    """
    soup = BeautifulSoup(body, "lxml")
    heading = soup.find("h1")
    if heading is None or heading.get_text(strip=True).upper() != cve.upper():
        raise ShapeError("Debian 쪽의 머리가 묻는 CVE가 아님")
    source_table = fixed_table = None
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if not rows:
            continue
        header = _cells(rows[0])
        if header == _DEBIAN_SOURCE_HEADER:
            source_table = table
        elif header[:4] == _DEBIAN_FIXED_HEADER:
            fixed_table = table
    has_section = any(h2.get_text(strip=True) == _DEBIAN_SECTION for h2 in soup.find_all("h2"))
    if source_table is None and fixed_table is None:
        if has_section:
            raise ShapeError("Debian 쪽에 '취약·고친 패키지' 절은 있는데 표가 없음")
        return DebianRecord({}, [])          # 패키지 기록이 아직 없는 CVE(예약·다른 배포판 전용 등)
    if source_table is None or fixed_table is None:
        raise ShapeError("Debian 쪽의 두 표 가운데 하나가 없음")

    sources: dict[str, list[tuple[str, str, str]]] = {}
    current: str | None = None
    for row in source_table.find_all("tr")[1:]:
        cells = _cells(row)
        if len(cells) != 4:
            raise ShapeError(f"Debian 원본 패키지 표의 줄 칸 수가 {len(cells)}(4가 아님)")
        if cells[0]:
            link = row.find("a")
            current = link.get_text(strip=True) if link is not None else cells[0].split(" ")[0]
        if current is None:
            raise ShapeError("Debian 원본 패키지 표의 첫 줄에 원본 이름이 없음")
        for release in cells[1].split(","):
            release = release.strip()
            if release:
                sources.setdefault(current, []).append((release, cells[2], cells[3]))
    fixed: list[tuple[str, str, str]] = []
    for row in fixed_table.find_all("tr")[1:]:
        cells = _cells(row)
        if len(cells) < 4:
            raise ShapeError(f"Debian 고친 판 표의 줄 칸 수가 {len(cells)}(4보다 적음)")
        fixed.append((cells[0], cells[2], cells[3]))
    return DebianRecord(sources, fixed)


def debian_status(record: DebianRecord, package: str, suite: str) -> Status:
    """
    한 원본 패키지·스위트의 결과(모듈 설명 [Debian]).

    :raises ShapeError: 모르는 상태 글이거나 판 칸 모양이 다름(그 조회만)
    """
    rows = [(release, version) for name, release, version in record.fixed if name == package]
    exact = [version for release, version in rows if release == suite]
    if exact:
        version = exact[0]
        if version == "(not affected)":
            return Status("not_affected", None, version)
        if version == "(unfixed)":
            return Status("open", None, version)
        return _fixed(version, "fixed", "Debian 고친 판 표")
    unstable = [version for release, version in rows if release == "(unstable)"]
    if unstable and unstable[0] in ("(not affected)", "(unfixed)"):
        return Status("not_affected" if unstable[0] == "(not affected)" else "open", None, f"{unstable[0]} (unstable)")

    lines = [(release, state) for release, _, state in record.sources.get(package, []) if release in (suite, f"{suite} (security)")]
    if not lines:
        return Status("unknown", None, "no entry")
    if any(state not in _DEBIAN_SOURCE_STATUS for _, state in lines):
        raise ShapeError("Debian 원본 패키지 표에 모르는 상태 글이 있음")
    detail = _detail("; ".join(f"{release}: {state}" for release, state in lines))
    states = {state for _, state in lines}
    if "fixed" in states:
        if unstable:
            # 릴리스 전용 줄이 없으면 (unstable)의 고친 판이 그 릴리스에도 적용 — 원본 표의 판(지금 있는 판)은 고친 판의 하한이 아님.
            return _fixed(unstable[0], "fixed (unstable)", "Debian 고친 판 표")
        return Status("unknown", None, "fixed; no fixed-version row")
    if states == {"vulnerable"}:
        return Status("open", None, detail)
    if states == {"not affected"}:
        return Status("not_affected", None, detail)
    return Status("unknown", None, detail)


# ==============================================================================
# Alpine
# ==============================================================================
def parse_alpine(body: bytes | str, suite: str, repo: str) -> dict[str, dict[str, list[str]]]:
    """
    Alpine secdb JSON → {원본 패키지: {CVE: [고친 판 키, …(문서 순서)]}}.

    :raises ShapeError: JSON이 아니거나 스위트·저장소가 묻는 것과 다르거나 ``packages`` 틀이 다름
    """
    try:
        doc = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise ShapeError("Alpine secdb 응답이 JSON이 아님") from None
    if not isinstance(doc, dict) or doc.get("distroversion") != suite or doc.get("reponame") != repo:
        raise ShapeError("Alpine secdb 응답의 스위트·저장소가 묻는 것과 다름")
    packages = doc.get("packages")
    if not isinstance(packages, list):
        raise ShapeError("Alpine secdb 응답에 packages 목록이 없음")
    index: dict[str, dict[str, list[str]]] = {}
    for item in packages:
        pkg = item.get("pkg") if isinstance(item, dict) else None
        if not isinstance(pkg, dict) or not isinstance(pkg.get("name"), str) or not isinstance(pkg.get("secfixes") or {}, dict):
            raise ShapeError("Alpine secdb 응답의 packages 항목 틀이 다름")
        cves = index.setdefault(pkg["name"], {})
        for key, names in (pkg.get("secfixes") or {}).items():
            if not isinstance(names, list):
                raise ShapeError("Alpine secdb 응답의 secfixes 틀이 다름")
            for name in names:
                first = name.split()[0] if isinstance(name, str) and name.strip() else ""
                if _CVE.match(first):
                    cves.setdefault(first, []).append(str(key))
    return index


def alpine_status(indexes: list[dict[str, dict[str, list[str]]]], package: str, cve: str, repos: tuple[str, ...]) -> Status:
    """
    한 원본 패키지·CVE의 결과 — ``indexes``는 저장소(main·community 순)마다 :func:`parse_alpine`의 결과(모듈 설명 [Alpine]).

    :raises ShapeError: 고친 판 키 모양이 다름(그 조회만)
    """
    for index, repo in zip(indexes, repos):
        keys = index.get(package, {}).get(cve)
        if not keys:
            continue
        versions = [key for key in keys if key != "0"]
        if versions:
            return _fixed(versions[0], f"secfixes ({repo})", "Alpine secdb")
        return Status("not_affected", None, f"secfixes 0 ({repo})")
    known = any(package in index for index in indexes)
    return Status("unknown", None, "no cve entry" if known else "no package entry")
