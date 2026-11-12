"""
sidecar/reap.py
강제 상한을 넘긴 요청의 브라우저를 찾아 끝냅니다 (ADR 0026 덧붙임 2026-11-13, QA-416).

페이지가 메인 스레드를 붙잡으면 드라이버의 호출(``page.evaluate``·``page.content()``·마우스)이 돌아오지 않습니다. 드라이버의 동기 API는 다른
스레드에서 부를 수 없어 '닫아 달라'고 할 길이 없으므로, 그 요청의 브라우저 **프로세스**를 직접 끝냅니다 — 그러면 붙잡혀 있던 호출이 바로
오류로 돌아옵니다(이미지의 patchright 1.64.4 + Chrome에서 확인).

  - **무엇이 그 요청의 브라우저인가**: 드라이버는 요청마다 필터 프록시를 새로 열고(sidecar.egress — 루프백의 빈 포트) Chrome을 그 주소로만
    내보냅니다. 그래서 명령줄에 ``--proxy-server=http://127.0.0.1:<그 요청의 포트>``를 인자 하나로 가진 프로세스가 그 요청의 Chrome이고
    (브라우저 프로세스 하나뿐 — 렌더러 등 자식의 명령줄에는 없음), 그 자손이 렌더러·GPU·zygote입니다. 프로세스 표(``/proc``)에서 찾습니다.
  - **그 밖의 것은 끝내지 않습니다**: 이 프로세스 자신과 그 조상(uvicorn·xvfb-run·init), 형제(Xvfb), 다른 포트의 프록시 인자를 가진 프로세스는
    대상이 아닙니다. 인자는 통째로 같아야 합니다(포트 앞머리가 같은 것·다른 인자 안에 들어 있는 것은 아님).
  - 브라우저를 끝내도 호출이 돌아오지 않는 경우(드라이버 프로세스가 멎음)를 위해, 그 브라우저를 띄운 부모가 이 프로세스의 **직접 자식**이면
    (요청마다 뜨는 드라이버 프로세스) 그 번호도 알려 줍니다. 그것을 끝낼지는 부르는 쪽(driver)이 정합니다.
  - 강제로 끝난 Chrome은 프로필 폴더에 잠금 링크(``SingletonLock`` → ``호스트이름-pid``)를 남깁니다. 같은 컨테이너에서는 다음 Chrome이 스스로
    치우지만, 컨테이너가 다시 만들어져 호스트 이름이 바뀌면 다음 Chrome이 '다른 컴퓨터에서 쓰는 프로필'로 보고 뜨지 않습니다(확인함).
    그래서 끝낸 뒤 주인이 없는 잠금 링크를 치웁니다(:func:`clear_stale_lock`).

표준 라이브러리만 씁니다. 리눅스의 ``/proc``가 없으면 아무것도 찾지 못합니다(브라우저 컨테이너는 리눅스). 브라우저 드라이버를 가져오지 않습니다.
"""
from __future__ import annotations

import logging
import os
import signal
import socket
from dataclasses import dataclass
from typing import Callable, Iterable

logger = logging.getLogger("sidecar.reap")

PROC_ROOT = "/proc"
PROXY_SWITCH = "--proxy-server="
# Chrome이 프로필 폴더에 두는 '이 프로필을 쓰는 중' 링크 셋.
SINGLETON_LINKS = ("SingletonLock", "SingletonSocket", "SingletonCookie")

Send = Callable[[int, int], None]


@dataclass(frozen=True)
class _Row:
    parent: int
    state: str
    arguments: tuple[bytes, ...]


@dataclass(frozen=True)
class Found:
    """그 요청의 브라우저 — 브라우저 프로세스(프록시 인자를 가진 것), 그 자손, 그리고 브라우저를 띄운 드라이버 프로세스."""

    browsers: tuple[int, ...] = ()
    descendants: tuple[int, ...] = ()
    launchers: tuple[int, ...] = ()

    @property
    def processes(self) -> tuple[int, ...]:
        """끝낼 순서대로 — 브라우저 프로세스 먼저(자식을 다시 띄우지 못하게), 그다음 자손."""
        return (*self.browsers, *self.descendants)


def _table(proc_root: str) -> dict[int, _Row]:
    """프로세스 표 — 번호 → (부모, 상태 글자, 명령줄 인자들). 읽는 사이에 사라진 프로세스는 건너뜁니다."""
    table: dict[int, _Row] = {}
    try:
        names = os.listdir(proc_root)
    except OSError:
        return table
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open(os.path.join(proc_root, name, "stat"), "rb") as handle:
                stat = handle.read()
            with open(os.path.join(proc_root, name, "cmdline"), "rb") as handle:
                arguments = tuple(part for part in handle.read().split(b"\0") if part)
            # "번호 (이름) 상태 부모 …" — 이름에는 공백·괄호가 들 수 있어 마지막 ')' 뒤부터 읽습니다.
            fields = stat[stat.rindex(b")") + 1:].split()
            table[int(name)] = _Row(parent=int(fields[1]), state=fields[0].decode("ascii", "replace"), arguments=arguments)
        except (OSError, ValueError, IndexError):
            continue
    return table


def _lineage(pid: int, table: dict[int, _Row]) -> set[int]:
    """그 프로세스와 조상들."""
    seen: set[int] = set()
    while pid > 0 and pid not in seen:
        seen.add(pid)
        row = table.get(pid)
        if row is None:
            break
        pid = row.parent
    return seen


def find_browser(proxy_url: str, *, proc_root: str = PROC_ROOT, own_pid: int | None = None) -> Found:
    """
    ``proxy_url``(그 요청의 필터 프록시 주소)로만 나가게 띄운 브라우저를 프로세스 표에서 찾습니다. 없으면 빈 :class:`Found`.

    이 프로세스·그 조상·init(1번)은 어떤 경우에도 결과에 들지 않습니다.
    """
    own = os.getpid() if own_pid is None else own_pid
    table = _table(proc_root)
    protected = _lineage(own, table) | {own, 1}
    wanted = (PROXY_SWITCH + proxy_url).encode("utf-8")
    browsers = sorted(pid for pid, row in table.items() if wanted in row.arguments and pid not in protected)
    if not browsers:
        return Found()

    children: dict[int, list[int]] = {}
    for pid, row in table.items():
        children.setdefault(row.parent, []).append(pid)
    seen = set(browsers)
    descendants: list[int] = []
    queue = list(browsers)
    while queue:
        for child in sorted(children.get(queue.pop(0), ())):
            if child not in seen and child not in protected:
                seen.add(child)
                descendants.append(child)
                queue.append(child)

    launchers = sorted({table[pid].parent for pid in browsers} - seen - protected)
    launchers = [pid for pid in launchers if pid in table and table[pid].parent == own]
    return Found(browsers=tuple(browsers), descendants=tuple(descendants), launchers=tuple(launchers))


def children_of_this_process(pids: Iterable[int], *, proc_root: str = PROC_ROOT, own_pid: int | None = None) -> tuple[int, ...]:
    """``pids`` 가운데 **지금도** 이 프로세스의 직접 자식인 것 — 찾은 뒤 시간이 지나 번호가 다른 프로세스의 것이 됐을 수 있어 끝내기 전에 다시 봅니다."""
    own = os.getpid() if own_pid is None else own_pid
    table = _table(proc_root)
    return tuple(pid for pid in pids if pid in table and table[pid].parent == own and pid not in (own, 1))


def end(pids: Iterable[int], *, send: Send = os.kill) -> list[int]:
    """프로세스들을 바로 끝냅니다(SIGKILL) → 신호를 보낸 번호들. 이미 사라진 것은 건너뛰고, 보내지 못하면(권한 등) 경고만 남기고 이어 갑니다."""
    ended: list[int] = []
    for pid in pids:
        try:
            send(pid, signal.SIGKILL)
        except ProcessLookupError:
            continue
        except OSError as exc:
            logger.warning("브라우저 프로세스 %d을 끝내지 못함(%s)", pid, type(exc).__name__)
            continue
        ended.append(pid)
    return ended


def clear_stale_lock(profile_dir: str, *, ended: Iterable[int] = (), proc_root: str = PROC_ROOT, hostname: str | None = None) -> bool:
    """
    프로필 폴더의 주인 없는 잠금 링크를 치웁니다 → 치웠으면 True.

    잠금(``SingletonLock`` → ``호스트이름-pid``)의 주인이 **이 컨테이너에서 살아 있는 프로세스**면 손대지 않습니다. 주인이 방금 끝낸 프로세스
    (``ended``)거나, 이미 없거나, 다른 호스트 이름(다시 만들어지기 전의 컨테이너)이면 링크 셋을 지웁니다.
    """
    lock = os.path.join(profile_dir, SINGLETON_LINKS[0])
    try:
        owner = os.readlink(lock)
    except OSError:
        return False                                # 잠금이 없음(또는 링크가 아님 — 손대지 않음)
    host, _, number = owner.rpartition("-")
    here = socket.gethostname() if hostname is None else hostname
    if host == here and number.isdigit() and int(number) not in set(ended):
        row = _table(proc_root).get(int(number))
        if row is not None and row.state not in ("Z", "X"):
            return False                            # 이 컨테이너에서 살아 있는 프로세스의 잠금
    for name in SINGLETON_LINKS:
        try:
            os.unlink(os.path.join(profile_dir, name))
        except OSError:
            pass
    return True
