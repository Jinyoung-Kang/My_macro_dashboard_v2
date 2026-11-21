"""
app/inventory.py
보안 공지(ADR 0046 결정 1·2, 덧붙임 2026-11-21 '배포판 패키지 변경 기록') — 운영 환경의 버전 목록 받기. ``python -m app.inventory < 목록``

호스트 스크립트(scripts/vultr/inventory.sh)가 ``docker compose exec -T collector python -m app.inventory``의 표준입력으로 넘깁니다. 검증에 하나라도
실패하면 **아무것도 쓰지 않고** 끝납니다(종료 코드 2). 통과하면 표 넷(env_inventory·env_components·env_pending_updates·env_changelog_cves)을
한 트랜잭션으로 통째로 바꿉니다(늘 '마지막으로 모은 한 벌'). 쓰는 곳은 ``app.store`` 하나이고 이 모듈은 그것만 가져옵니다(ADR 0008).

[입력] UTF-8, 줄마다 탭으로 나눈 칸. 빈 줄은 건너뜁니다. 비어 있는 칸은 ``-``.
  inventory  1  <모은 시각 ISO 8601, 시간대 포함>  <호스트 구역 포함 0|1>  <apt 목록을 마지막으로 새로 받은 시각 ISO 8601 | ->     (첫 줄, 한 번)
  section    <구역>  <ok|failed|skipped>  <사유 | ->
  component  <구역>  <생태계>  <이름>  <버전>  <원본 | ->
  pending    <패키지>  <아키텍처 | ->  <설치 버전>  <후보 버전>  <저장소(쉼표로 여럿)>
  changelog  <원본 패키지 | kernel>  <버전>  <CVE 번호>

  - 구역: 소문자·숫자·``_``·``-``. 지금 쓰는 것은 일곱 — host(서버 OS 패키지·커널·Docker·Compose·Tailscale·apt 보류)·postgres·backend·
    frontend·collector·browser·caddy(컨테이너 OS 패키지도 그 컨테이너의 구역). 구역마다 한 줄. component는 상태가 ok인 구역에만,
    pending은 ok인 ``host`` 구역이 있을 때만 받습니다. 호스트 구역 포함이 0이면 host 구역은 ok일 수 없습니다.
  - 생태계: dpkg·apk(배포판 패키지 — 원본 칸에 source 패키지 이름을 **반드시**: dpkg ``${source:Package}``, apk ``o:``), maven·npm·pypi
    (프로젝트 의존성), runtime(서버·런타임 — 이름 postgres·jdk·node·python·chrome·caddy·docker·compose·tailscale·kernel, jdk의 원본 칸은
    배포처(release 파일의 IMPLEMENTOR)). 판정(백엔드 feature/security)이 이 이름들에 기댑니다.
  - 이름·버전은 원문 그대로 두고 해석하지 않습니다(판정은 백엔드 — ADR 0046 결정 5). 같은 줄이 두 번 오면 한 번으로 셉니다.
  - 보안 여부는 저장소 이름 가운데 하나가 ``-security``로 끝나는지로 가립니다(Ubuntu ``noble-security``, Ubuntu Pro ESM ``noble-infra-security``·
    ``noble-apps-security``).
  - changelog는 서버 배포판 패키지의 변경 기록(changelog.Debian.gz)에 적힌 CVE 번호 — ok인 ``host`` 구역이 있을 때만 받습니다. 패키지는 dpkg 원본
    패키지 이름(component 줄의 원본 칸과 같은 값)·버전은 그 바이너리 패키지의 설치 버전이고, 실행 중인 커널은 이름 ``kernel``·버전 ``uname -r``
    (runtime kernel 줄과 같은 값)입니다. CVE 번호는 ``CVE-연도-숫자 4~7자리``. 같은 줄이 두 번 오면 한 번으로 셉니다.

[출력] 성공하면 건수 한 줄만(버전 없음 — 배포 출력·syslog에 그대로 남음). 실패하면 줄 번호와 사유만(칸 값을 싣지 않음).
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from datetime import datetime

from app import store

FORMAT_VERSION = "1"
STATUSES = ("ok", "failed", "skipped")
ECOSYSTEMS = ("runtime", "dpkg", "apk", "maven", "npm", "pypi")
# 원본(source 패키지) 칸을 반드시 채우는 생태계 — 배포판 공지(openssl·openssh·curl·glibc·커널) 맞추기가 여기에 기댑니다.
NEEDS_ORIGIN = ("dpkg", "apk")
HOST_SECTIONS = ("host",)
_CVE = re.compile(r"^CVE-\d{4}-\d{4,7}$")
MAX_LINES = 100_000
MAX_FIELD_CHARS = 300
MAX_REASON_CHARS = 200

_SECTION = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

EXIT_OK = 0
EXIT_INVALID = 2
EXIT_STORE = 1


class InvalidInventory(ValueError):
    """입력이 틀림 — 메시지는 줄 번호와 사유만(칸 값 없음)."""


@dataclass
class Inventory:
    collected_at: datetime
    host_included: bool
    apt_lists_at: datetime | None
    sections: dict[str, dict] = field(default_factory=dict)
    components: list[tuple[str, str, str, str, str | None]] = field(default_factory=list)
    pending: list[tuple[str, str, str, str, str, bool]] = field(default_factory=list)
    changelog: list[tuple[str, str, str]] = field(default_factory=list)


def is_security(repos: str) -> bool:
    """저장소(쉼표로 여럿) 가운데 하나가 ``-security``로 끝나면 보안 업데이트."""
    return any(repo.strip().endswith("-security") for repo in repos.split(","))


def _time(text: str, line: int, what: str) -> datetime:
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise InvalidInventory(f"줄 {line}: {what}이 ISO 8601 시각이 아님") from None
    if moment.tzinfo is None:
        raise InvalidInventory(f"줄 {line}: {what}에 시간대가 없음")
    return moment


def _field(text: str, line: int, what: str, *, optional: bool = False, limit: int = MAX_FIELD_CHARS) -> str | None:
    value = text.strip()
    if optional and value in ("", "-"):
        return None
    if not value or value == "-":
        raise InvalidInventory(f"줄 {line}: {what} 칸이 비어 있음")
    if len(value) > limit:
        raise InvalidInventory(f"줄 {line}: {what} 칸이 {limit}자를 넘음")
    return value


def parse(text: str) -> Inventory:
    """
    입력 전체 → 버전 목록.

    :raises InvalidInventory: 하나라도 틀리면(무엇도 쓰지 않게 — 부르는 쪽이 저장 전에 부름)
    """
    lines = text.split("\n")
    if len(lines) > MAX_LINES:
        raise InvalidInventory(f"줄이 {MAX_LINES}개를 넘음")
    inventory: Inventory | None = None
    raw_components: list[tuple[int, list[str]]] = []
    raw_pending: list[tuple[int, list[str]]] = []
    raw_changelog: list[tuple[int, list[str]]] = []
    for number, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        body = raw.rstrip("\r")
        if _CONTROL.search(body.replace("\t", "")):
            raise InvalidInventory(f"줄 {number}: 제어 문자가 있음")
        cells = body.split("\t")
        kind = cells[0]
        if inventory is None:
            if kind != "inventory":
                raise InvalidInventory(f"줄 {number}: 첫 줄이 머리(inventory)가 아님")
            if len(cells) != 5:
                raise InvalidInventory(f"줄 {number}: 머리 칸이 {len(cells)}개(5개여야 함)")
            if cells[1] != FORMAT_VERSION:
                raise InvalidInventory(f"줄 {number}: 모르는 형식 판")
            if cells[3] not in ("0", "1"):
                raise InvalidInventory(f"줄 {number}: 호스트 구역 포함이 0·1이 아님")
            apt = _field(cells[4], number, "apt 목록 시각", optional=True)
            inventory = Inventory(_time(cells[2], number, "모은 시각"), cells[3] == "1",
                                  _time(apt, number, "apt 목록 시각") if apt else None)
            continue
        if kind == "inventory":
            raise InvalidInventory(f"줄 {number}: 머리가 두 번")
        if kind == "section":
            if len(cells) != 4:
                raise InvalidInventory(f"줄 {number}: section 칸이 {len(cells)}개(4개여야 함)")
            name = cells[1]
            if not _SECTION.match(name):
                raise InvalidInventory(f"줄 {number}: 구역 이름 모양이 다름")
            if name in inventory.sections:
                raise InvalidInventory(f"줄 {number}: 같은 구역이 두 번")
            if cells[2] not in STATUSES:
                raise InvalidInventory(f"줄 {number}: 구역 상태가 ok·failed·skipped가 아님")
            entry: dict = {"status": cells[2]}
            reason = _field(cells[3], number, "사유", optional=True, limit=MAX_REASON_CHARS)
            if reason:
                entry["reason"] = reason
            inventory.sections[name] = entry
        elif kind == "component":
            if len(cells) != 6:
                raise InvalidInventory(f"줄 {number}: component 칸이 {len(cells)}개(6개여야 함)")
            raw_components.append((number, cells))
        elif kind == "pending":
            if len(cells) != 6:
                raise InvalidInventory(f"줄 {number}: pending 칸이 {len(cells)}개(6개여야 함)")
            raw_pending.append((number, cells))
        elif kind == "changelog":
            if len(cells) != 4:
                raise InvalidInventory(f"줄 {number}: changelog 칸이 {len(cells)}개(4개여야 함)")
            raw_changelog.append((number, cells))
        else:
            raise InvalidInventory(f"줄 {number}: 모르는 줄 종류")
    if inventory is None:
        raise InvalidInventory("머리(inventory) 줄이 없음")

    if not inventory.host_included:
        for name in HOST_SECTIONS:
            if inventory.sections.get(name, {}).get("status") == "ok":
                raise InvalidInventory(f"호스트 구역 포함이 0인데 {name} 구역이 ok")
    seen: set[tuple[str, str, str, str]] = set()
    for number, cells in raw_components:
        source = cells[1]
        if inventory.sections.get(source, {}).get("status") != "ok":
            raise InvalidInventory(f"줄 {number}: component의 구역이 ok인 section 줄에 없음")
        if cells[2] not in ECOSYSTEMS:
            raise InvalidInventory(f"줄 {number}: 모르는 생태계")
        name = _field(cells[3], number, "이름")
        version = _field(cells[4], number, "버전")
        origin = _field(cells[5], number, "원본", optional=cells[2] not in NEEDS_ORIGIN)
        key = (source, cells[2], name, version)
        if key in seen:
            continue
        seen.add(key)
        inventory.components.append((source, cells[2], name, version, origin))
    if raw_pending and inventory.sections.get("host", {}).get("status") != "ok":
        raise InvalidInventory("pending 줄이 있는데 ok인 host 구역이 없음")
    packages: set[tuple[str, str]] = set()
    for number, cells in raw_pending:
        package = _field(cells[1], number, "패키지")
        arch = _field(cells[2], number, "아키텍처", optional=True) or ""
        if (package, arch) in packages:
            raise InvalidInventory(f"줄 {number}: 같은 보류 패키지가 두 번")
        packages.add((package, arch))
        repos = _field(cells[5], number, "저장소")
        inventory.pending.append((package, arch, _field(cells[3], number, "설치 버전"), _field(cells[4], number, "후보 버전"),
                                  repos, is_security(repos)))
    if raw_changelog and inventory.sections.get("host", {}).get("status") != "ok":
        raise InvalidInventory("changelog 줄이 있는데 ok인 host 구역이 없음")
    cves: set[tuple[str, str, str]] = set()
    for number, cells in raw_changelog:
        row = (_field(cells[1], number, "패키지"), _field(cells[2], number, "버전"), cells[3].strip())
        if not _CVE.match(row[2]):
            raise InvalidInventory(f"줄 {number}: CVE 번호 모양이 다름")
        if row in cves:
            continue
        cves.add(row)
        inventory.changelog.append(row)

    counts: dict[str, int] = {}
    for source, *_ in inventory.components:
        counts[source] = counts.get(source, 0) + 1
    for name, entry in inventory.sections.items():
        if entry["status"] == "ok":
            entry["count"] = counts.get(name, 0)
            if name == "host":
                entry["pending"] = len(inventory.pending)
                if inventory.changelog:
                    entry["changelog"] = len(inventory.changelog)
    return inventory


def summary(inventory: Inventory) -> str:
    """건수 한 줄(버전 없음)."""
    statuses = [entry["status"] for entry in inventory.sections.values()]
    security = sum(1 for row in inventory.pending if row[5])
    failed = sorted(name for name, entry in inventory.sections.items() if entry["status"] == "failed")
    line = (f"버전 목록 받음 — 구역 {len(statuses)}(ok {statuses.count('ok')}·failed {statuses.count('failed')}·"
            f"skipped {statuses.count('skipped')}) · 구성 요소 {len(inventory.components)} · 보류 {len(inventory.pending)}(보안 {security})")
    if inventory.changelog:
        line += f" · 변경 기록 CVE {len(inventory.changelog)}"
    return line + (f" · 실패 구역 {', '.join(failed)}" if failed else "")


def main(stdin=None, stdout=None, stderr=None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    try:
        inventory = parse(stdin.read())
    except InvalidInventory as exc:
        print(f"버전 목록을 받지 않음(아무것도 쓰지 않음) — {exc}", file=stderr)
        return EXIT_INVALID
    except UnicodeDecodeError:
        print("버전 목록을 받지 않음(아무것도 쓰지 않음) — UTF-8이 아님", file=stderr)
        return EXIT_INVALID
    try:
        store.replace_env_inventory({
            "collected_at": inventory.collected_at, "host_included": inventory.host_included,
            "apt_lists_at": inventory.apt_lists_at, "sections": inventory.sections,
            "components": inventory.components, "pending": inventory.pending, "changelog": inventory.changelog,
        })
    except Exception as exc:  # noqa: BLE001
        print(f"버전 목록을 저장하지 못함 — {type(exc).__name__}", file=stderr)
        return EXIT_STORE
    finally:
        store.close_pool()
    print(summary(inventory), file=stdout)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
